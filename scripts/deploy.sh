#!/bin/bash
set -e

# Deploy VELA v2 to Hostinger VPS
VPS_IP="187.127.123.229"

echo "=== Deploying VELA v2 to $VPS_IP ==="

# Sync code
rsync -avz --exclude=venv --exclude=node_modules --exclude=.git --exclude=data \
    /Users/mac/verifyXNOPrivacyProtocol/ root@$VPS_IP:/opt/vela/

# Run setup on VPS
ssh root@$VPS_IP 'bash /opt/vela/scripts/setup_vps.sh'

# Install Python deps on VPS
ssh root@$VPS_IP 'cd /opt/vela && python3 -m venv venv && venv/bin/pip install -r requirements.txt'

# Install npm deps on VPS (for snarkjs if needed)
ssh root@$VPS_IP 'cd /opt/vela && npm install'

# Install systemd services
ssh root@$VPS_IP '
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
ssh root@$VPS_IP 'cat /var/lib/tor/vela_indexer/hostname 2>/dev/null; echo; cat /var/lib/tor/vela_guardian/hostname 2>/dev/null; echo'
