#!/bin/bash
set -e

# Deploy VELA v2 to Hostinger VPS
VPS_HOST="srv1906844.hstgr.cloud"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/vela_test}"

SSH="ssh -i $SSH_KEY"
RSYNC=(rsync -e "ssh -i $SSH_KEY")

echo "=== Deploying VELA v2 to $VPS_HOST ==="

# Sync code
"${RSYNC[@]}" -avz --exclude=venv --exclude=node_modules --exclude=.git --exclude=data --exclude=.next \
    /Users/mac/verifyXNOPrivacyProtocol/ root@$VPS_HOST:/opt/vela/

# Run setup on VPS
$SSH root@$VPS_HOST 'bash /opt/vela/scripts/setup_vps.sh'

# Install Python deps on VPS
$SSH root@$VPS_HOST 'cd /opt/vela && python3 -m venv venv && venv/bin/pip install -r requirements.txt'

# Install npm deps on VPS (for snarkjs if needed)
$SSH root@$VPS_HOST 'cd /opt/vela && npm install'

# Install systemd services
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
echo "Tor hidden service hostnames:"
$SSH root@$VPS_HOST 'cat /var/lib/tor/vela_indexer/hostname 2>/dev/null; echo; cat /var/lib/tor/vela_guardian/hostname 2>/dev/null; echo'
