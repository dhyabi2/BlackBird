#!/bin/bash
set -e

# Deploy VELA v2 to Hostinger VPS
VPS_HOST="srv1906844.hstgr.cloud"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/vela_test}"

SSH="ssh -i $SSH_KEY"
RSYNC=(rsync -e "ssh -i $SSH_KEY")

echo "=== Deploying VELA v2 to $VPS_HOST ==="

# Sync code, but never copy local secrets or runtime data.
"${RSYNC[@]}" -avz \
    --exclude=venv \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=data \
    --exclude=.next \
    --exclude=.vercel \
    --exclude=.env \
    --exclude=.env.local \
    --exclude=.env.* \
    --exclude='*.seed' \
    --exclude='web/test-wallets.json' \
    --exclude='web/nano-wallet.dat' \
    /Users/mac/verifyXNOPrivacyProtocol/ root@$VPS_HOST:/opt/vela/

# Install Python deps on VPS
$SSH root@$VPS_HOST 'cd /opt/vela && python3 -m venv venv && venv/bin/pip install -r requirements.txt'

# Install npm deps on the VPS (for snarkjs helpers)
$SSH root@$VPS_HOST 'cd /opt/vela && npm install'

# Compile the proof-of-work generator used by the indexer work service
$SSH root@$VPS_HOST 'mkdir -p /opt/vela/bin && (gcc -O3 -march=native -o /opt/vela/bin/workgen /opt/vela/src/workgen.c 2>/dev/null || gcc -O3 -o /opt/vela/bin/workgen /opt/vela/src/workgen.c)'

# Rotate guardian seed if requested. Existing deposits to the old pool addresses will be
# unreachable, so only do this when the pools are empty.
if [ "${ROTATE_GUARDIAN_SEED:-0}" = "1" ]; then
    echo "=== Rotating guardian seed ==="
    $SSH root@$VPS_HOST '
        if [ -f /opt/vela/.guardian_seed ]; then
            cp /opt/vela/.guardian_seed /opt/vela/.guardian_seed.old.$(date +%s)
        fi
        openssl rand -hex 32 > /opt/vela/.guardian_seed
        chmod 600 /opt/vela/.guardian_seed
        echo "New guardian seed generated. Old seed backed up."
    '
fi

# Ensure key files have restrictive permissions
$SSH root@$VPS_HOST '
    chmod 600 /opt/vela/.guardian_seed 2>/dev/null || true
    chmod 600 /opt/vela/.vela_api_key 2>/dev/null || true
'

# Install systemd services and restart
$SSH root@$VPS_HOST '
    cp /opt/vela/config/vela-indexer.service /etc/systemd/system/
    cp /opt/vela/config/vela-guardian.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable vela-indexer vela-guardian
    systemctl restart vela-indexer vela-guardian
'

echo "=== Deployment complete ==="
echo "Indexer: http://127.0.0.1:8080"
echo "Guardian: http://127.0.0.1:8081"
