#!/bin/bash
set -e

# Run as root on the VPS for a fresh install.

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

# Dedicated non-root user
if ! id -u vela &>/dev/null; then
  useradd --system --home-dir /opt/vela --shell /usr/sbin/nologin vela
fi

# API key for the indexer
if [ ! -f /opt/vela/.vela_api_key ]; then
  openssl rand -hex 32 > /opt/vela/.vela_api_key
fi

# Guardian seed (32 bytes hex)
if [ ! -f /opt/vela/.guardian_seed ]; then
  openssl rand -hex 32 > /opt/vela/.guardian_seed
fi

# Restrict permissions
chmod 600 /opt/vela/.guardian_seed /opt/vela/.vela_api_key
chown -R vela:vela /opt/vela
chmod 700 /opt/vela

# Caddy reverse proxy with automatic HTTPS
hostname=$(hostname -f)
cat > /etc/caddy/Caddyfile <<EOF
${hostname} {
    reverse_proxy localhost:8080
}
EOF

systemctl daemon-reload
systemctl enable vela-indexer vela-guardian caddy
systemctl restart vela-indexer vela-guardian caddy

echo "Setup complete."
echo "Guardian pool addresses:"
/opt/vela/venv/bin/python3 - <<PY
import os
os.environ['GUARDIAN_SEED'] = open('/opt/vela/.guardian_seed').read().strip()
from src.vela_crypto import pool_address
for d in sorted([10**29, 10**30, 10**31, 10**32]):
    print(f"  {d}: {pool_address(d)}")
PY
