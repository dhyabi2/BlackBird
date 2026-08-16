#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
export GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
export NANO_RPC_URL="https://rpc.nano.to"
export NANO_RPC_KEY="RPC-KEY-5038B8C975AC4C0492907B42E816931F0167B43D89C84189A59545F12CEE42B8"
mkdir -p data
exec python3 -m src.vela_indexer
