#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
mkdir -p data
exec python3 -m src.vela_indexer
