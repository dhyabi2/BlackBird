#!/bin/bash
set -e

# Run as root on the VPS

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-venv python3-pip python3-dev build-essential libssl-dev curl git nodejs npm caddy

mkdir -p /opt/vela
cd /opt/vela
tar xzf /tmp/vela-backend.tar.gz

# Python virtualenv
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r /opt/vela/requirements.txt

# snarkjs for proof generation/verification
npm install -g snarkjs

# API key for the indexer
if [ ! -f /opt/vela/.vela_api_key ]; then
  openssl rand -hex 32 > /opt/vela/.vela_api_key
fi

# Guardian seed (32 bytes hex)
if [ ! -f /opt/vela/.guardian_seed ]; then
  openssl rand -hex 32 > /opt/vela/.guardian_seed
fi

# Env file for systemd
PUBLIC_IP=$(curl -s -4 ifconfig.me)
cat > /opt/vela/.env <<EOF
VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
VELA_GUARDIAN_URL=http://127.0.0.1:8081
NANO_RPC_URL=https://node.somenano.com/proxy,https://proxy.nanos.cc/proxy,https://rainstorm.city/api
GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
EOF

cat > /etc/systemd/system/vela-indexer.service <<EOF
[Unit]
Description=VELA v2 Indexer
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vela
EnvironmentFile=/opt/vela/.env
ExecStart=/opt/vela/venv/bin/python3 -m src.vela_indexer
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/vela-guardian.service <<EOF
[Unit]
Description=VELA v2 Guardian
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vela
EnvironmentFile=/opt/vela/.env
ExecStart=/opt/vela/venv/bin/python3 -m src.vela_guardian
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Caddy reverse proxy
hostname=$(hostname -f)
cat > /etc/caddy/Caddyfile <<EOF
${hostname} {
    reverse_proxy localhost:8080
}
EOF

systemctl daemon-reload
systemctl enable vela-indexer vela-guardian caddy
systemctl start vela-indexer vela-guardian caddy

echo "Setup complete. API key: $(cat /opt/vela/.vela_api_key)"
echo "Guardian pool address:"
/opt/vela/venv/bin/python3 - <<PY
import os
os.environ['GUARDIAN_SEED'] = open('/opt/vela/.guardian_seed').read().strip()
from src.vela_crypto import nano_seed_to_keypair, nano_address_from_pubkey
_, pub = nano_seed_to_keypair(bytes.fromhex(os.environ['GUARDIAN_SEED']))
print(nano_address_from_pubkey(pub))
PY
