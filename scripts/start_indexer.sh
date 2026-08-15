#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export VELA_API_KEY=$(cat /opt/vela/.vela_api_key)
mkdir -p data
exec python3 -m src.vela_indexer
