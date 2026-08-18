#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
export GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
export NANO_RPC_URL="https://rpc.nano.to"
export NANO_RPC_KEY="${NANO_RPC_KEY:-$(cat /opt/vela/.nano_rpc_key 2>/dev/null || echo RPC-KEY-117F783C1058455E862910E98265678B37CC70EDAB334FD8B1A68903F2A5F76F)}"
# FROST key store: presence of group_pubkey files switches pool addresses
# to threshold custody per denomination.
export FROST_DATA_DIR=/opt/vela/data/frost
mkdir -p data data/frost
exec python3 -m src.vela_indexer
