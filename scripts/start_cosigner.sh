#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export FROST_ID=$(cat /opt/vela/.frost_id)
export COSIGNER_API_KEY=$(cat /opt/vela/.cosigner_api_key)
export FROST_DATA_DIR=/opt/vela/data/frost
export FROST_GUARDIAN_BIN=/opt/vela/bin/frost-guardian
export INDEXER_URL=$(cat /opt/vela/.indexer_url)
export NANO_RPC_URL="https://rpc.nano.to"
export NANO_RPC_KEY="$(cat /opt/vela/.nano_rpc_key)"
export COSIGNER_PORT=8082
mkdir -p data/frost
exec python3 -m src.vela_cosigner
