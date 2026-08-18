#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
export VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
export NANO_RPC_URL="https://rpc.nano.to"
export NANO_RPC_KEY="${NANO_RPC_KEY:-$(cat /opt/vela/.nano_rpc_key 2>/dev/null || true)}"
# FROST threshold-signing coordinator config (guardian id 1). Inert until
# the DKG ceremony installs group_pubkey files under FROST_DATA_DIR.
export FROST_DATA_DIR=/opt/vela/data/frost
export FROST_ID=1
export FROST_GUARDIAN_BIN=/opt/vela/bin/frost-guardian
export FROST_COSIGNERS="$(cat /opt/vela/.frost_cosigners 2>/dev/null || true)"
export COSIGNER_API_KEY="$(cat /opt/vela/.cosigner_api_key 2>/dev/null || true)"
mkdir -p data data/frost
exec python3 -m src.vela_guardian
