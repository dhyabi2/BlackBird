#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export FROST_ID=$(cat /opt/vela/.frost_id)
export COSIGNER_API_KEY=$(cat /opt/vela/.cosigner_api_key)
export FROST_DATA_DIR=/opt/vela/data/frost
export FROST_GUARDIAN_BIN=/opt/vela/bin/frost-guardian
export INDEXER_URL=$(cat /opt/vela/.indexer_url)
# NANO_RPC_URL intentionally unset: src/nano_rpc.py defaults to rpc.nano.to (keyed primary) with rpc.nano-gpt.com as the sole keyless fallback.
export NANO_RPC_KEY="$(cat /opt/vela/.nano_rpc_key)"
export COSIGNER_PORT=8082
# Bind beyond localhost only where a firewall restricts 8082 to the
# coordinator's IP (see setup_cosigner_vps.sh ufw rules).
export COSIGNER_BIND="${COSIGNER_BIND:-$(cat /opt/vela/.cosigner_bind 2>/dev/null || echo 127.0.0.1)}"
mkdir -p data/frost
exec python3 -m src.vela_cosigner
