#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export GUARDIAN_SEED=$(cat /opt/vela/.guardian_seed)
mkdir -p data
exec python3 -m src.vela_guardian
