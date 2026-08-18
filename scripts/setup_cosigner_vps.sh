#!/bin/bash
# One-time setup for a FROST cosigner VPS (guardian id 2 or 3).
# Run as root on a fresh Debian/Ubuntu box: bash setup_cosigner_vps.sh <frost_id>
set -e

FROST_ID="${1:?usage: setup_cosigner_vps.sh <frost_id (2 or 3)>}"

echo "=== VELA FROST Cosigner Setup (id $FROST_ID) ==="

apt-get update
apt-get install -y curl wget git tor python3 python3-venv python3-pip nodejs npm build-essential

mkdir -p /opt/vela/data/frost /opt/vela/bin

echo "$FROST_ID" > /opt/vela/.frost_id

# Shared cosigner API key: paste the SAME value used on the coordinator.
if [ ! -f /opt/vela/.cosigner_api_key ]; then
    echo "Enter COSIGNER_API_KEY (shared with the coordinator):"
    read -r KEY
    printf '%s' "$KEY" > /opt/vela/.cosigner_api_key
    chmod 600 /opt/vela/.cosigner_api_key
fi

if [ ! -f /opt/vela/.nano_rpc_key ]; then
    echo "Enter NANO_RPC_KEY (rpc.nano.to key for this box's own ledger view):"
    read -r KEY
    printf '%s' "$KEY" > /opt/vela/.nano_rpc_key
    chmod 600 /opt/vela/.nano_rpc_key
fi

if [ ! -f /opt/vela/.indexer_url ]; then
    echo "Enter INDEXER_URL (e.g. the indexer Tor onion or https URL):"
    read -r URL
    printf '%s' "$URL" > /opt/vela/.indexer_url
fi

# Rust toolchain to build the frost-guardian CLI from source on this box.
if ! command -v cargo >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    source "$HOME/.cargo/env"
fi

# Tor hidden service so the coordinator can reach this cosigner without
# exposing a public port (coordinator uses the .onion via its local Tor).
mkdir -p /var/lib/tor/vela_cosigner
chown -R debian-tor:debian-tor /var/lib/tor/vela_cosigner
chmod 700 /var/lib/tor/vela_cosigner
TORRC=/etc/tor/torrc
if ! grep -q "HiddenServiceDir /var/lib/tor/vela_cosigner" "$TORRC"; then
    cat >> "$TORRC" <<'EOF'
HiddenServiceDir /var/lib/tor/vela_cosigner
HiddenServicePort 80 127.0.0.1:8082
EOF
fi
systemctl restart tor
sleep 3
echo "Cosigner onion address:"
cat /var/lib/tor/vela_cosigner/hostname || true

echo "Setup complete. Now run scripts/deploy_cosigner.sh from the dev machine."
