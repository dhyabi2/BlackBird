#!/bin/bash
set -e

# Deploy the VELA FROST cosigner to a VPS.
# Usage: COSIGNER_HOST=root@1.2.3.4 [SSH_KEY=~/.ssh/vela_test] bash scripts/deploy_cosigner.sh

COSIGNER_HOST="${COSIGNER_HOST:?set COSIGNER_HOST=user@host}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/vela_test}"

SSH="ssh -i $SSH_KEY"
RSYNC=(rsync -e "ssh -i $SSH_KEY")

echo "=== Deploying VELA cosigner to $COSIGNER_HOST ==="

# Sync code; never copy local secrets, runtime data, or key material.
"${RSYNC[@]}" -avz \
    --exclude=venv \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=data \
    --exclude=web \
    --exclude=.next \
    --exclude=.env \
    --exclude=.env.local \
    --exclude='.env.*' \
    --exclude='*.seed' \
    --exclude='frost/target' \
    "$(dirname "$0")/../" "$COSIGNER_HOST":/opt/vela/

$SSH "$COSIGNER_HOST" 'cd /opt/vela && python3 -m venv venv && venv/bin/pip install -r requirements.txt'

# Node deps for the Groth16 verifier (snarkjs helper).
$SSH "$COSIGNER_HOST" 'cd /opt/vela && npm install'

# Build the frost-guardian CLI on the box (fetches the pinned signing crate
# from github.com/dhyabi2/trustlessXNOXMR).
$SSH "$COSIGNER_HOST" 'source $HOME/.cargo/env && cd /opt/vela/frost && cargo build --release && install -m 755 target/release/frost-guardian /opt/vela/bin/frost-guardian'

$SSH "$COSIGNER_HOST" '
    chmod 600 /opt/vela/.cosigner_api_key /opt/vela/.nano_rpc_key 2>/dev/null || true
    chmod +x /opt/vela/scripts/start_cosigner.sh
    cp /opt/vela/config/vela-cosigner.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable vela-cosigner
    systemctl restart vela-cosigner
    sleep 2
    systemctl --no-pager status vela-cosigner | head -8
'

echo "=== Cosigner deployment complete ==="
