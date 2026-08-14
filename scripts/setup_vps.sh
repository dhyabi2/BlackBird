#!/bin/bash
set -e

echo "=== VELA v2 VPS Setup ==="

# Update system
apt-get update
apt-get install -y curl wget git tor python3 python3-venv python3-pip nodejs npm build-essential

# Create app directory
mkdir -p /opt/vela

# Generate guardian seed if not exists
if [ ! -f /opt/vela/.guardian_seed ]; then
    python3 -c "import os; print(os.urandom(32).hex())" > /opt/vela/.guardian_seed
    chmod 600 /opt/vela/.guardian_seed
fi

# Tor hidden services
mkdir -p /var/lib/tor/vela_indexer /var/lib/tor/vela_guardian
chown -R debian-tor:debian-tor /var/lib/tor/vela_indexer /var/lib/tor/vela_guardian
chmod 700 /var/lib/tor/vela_indexer /var/lib/tor/vela_guardian

cat >> /etc/tor/torrc <<'EOF'
HiddenServiceDir /var/lib/tor/vela_indexer
HiddenServicePort 80 127.0.0.1:8080
HiddenServicePort 22 127.0.0.1:22

HiddenServiceDir /var/lib/tor/vela_guardian
HiddenServicePort 80 127.0.0.1:8081
EOF

systemctl restart tor

echo "Setup complete. Deploy code to /opt/vela and run start scripts."
