#!/bin/bash
set -e
cd /opt/vela
source venv/bin/activate
export FROST_ID=$(cat /opt/vela/.frost_id)
export COSIGNER_API_KEY=$(cat /opt/vela/.cosigner_api_key)
# Overridable so a cosigner can share a host with the guardian: both read
# "<dir>/<denom>/key_package", but they must hold DIFFERENT shares, so they
# cannot share one directory. Single-host deployments point this at a second
# tree (e.g. /opt/vela/data/frost2) via /opt/vela/.frost_data_dir.
export FROST_DATA_DIR="${FROST_DATA_DIR:-$(cat /opt/vela/.frost_data_dir 2>/dev/null || echo /opt/vela/data/frost)}"
export FROST_GUARDIAN_BIN=/opt/vela/bin/frost-guardian
export INDEXER_URL=$(cat /opt/vela/.indexer_url)
# NANO_RPC_URL intentionally unset: src/nano_rpc.py uses rpc.nano.to, the one and only endpoint (no fallback node).
export NANO_RPC_KEY="$(cat /opt/vela/.nano_rpc_key)"
export COSIGNER_PORT=8082
# Bind beyond localhost only where a firewall restricts 8082 to the
# coordinator's IP (see setup_cosigner_vps.sh ufw rules).
export COSIGNER_BIND="${COSIGNER_BIND:-$(cat /opt/vela/.cosigner_bind 2>/dev/null || echo 127.0.0.1)}"
mkdir -p "$FROST_DATA_DIR"
exec python3 -m src.vela_cosigner
