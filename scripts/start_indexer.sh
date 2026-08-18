#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
export GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
export NANO_RPC_URL="https://rpc.nano.to"
export NANO_RPC_KEY="${NANO_RPC_KEY:-$(cat /opt/vela/.nano_rpc_key 2>/dev/null || true)}"
# FROST key store: presence of group_pubkey files switches pool addresses
# to threshold custody per denomination.
export FROST_DATA_DIR=/opt/vela/data/frost
mkdir -p data data/frost
exec python3 -m src.vela_indexer
