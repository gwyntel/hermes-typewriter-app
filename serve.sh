#!/usr/bin/env bash
# serve.sh — Lightweight static server + Cloudflare Tunnel for Kindle access
# Usage: ./serve.sh [port]

set -euo pipefail

PORT="${1:-8643}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  HERMES TYPEWRITER"
echo "  Static server + Cloudflare Tunnel"
echo "============================================"
echo ""

# --- Check for cloudflared ---
if [ -f "./cloudflared" ]; then
  CLOUDFLARED="./cloudflared"
  HAS_TUNNEL=true
elif command -v cloudflared &> /dev/null; then
  CLOUDFLARED="cloudflared"
  HAS_TUNNEL=true
else
  echo "[!] cloudflared not found."
  echo "    Install: brew install cloudflared"
  echo "    Or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo ""
  echo "    Starting local server only (no tunnel)..."
  echo ""
  HAS_TUNNEL=false
fi

# --- Start Proxy + Static server ---
echo "[*] Starting proxy server on http://localhost:${PORT}"
echo "    Proxying /v1/* to ${HERMES_URL:-http://localhost:8642}"
echo "    Serving Frontend: ${DIR}"
echo ""

# Use custom proxy server to handle API calls
export HERMES_URL="${HERMES_URL:-http://localhost:8642}"
python3 server.py "$PORT" &
SERVER_PID=$!

# Cleanup on exit
cleanup() {
  echo ""
  echo "[*] Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  if [ "${TUNNEL_PID:-}" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  echo "[*] Done."
}
trap cleanup EXIT INT TERM

sleep 1

# --- Start Cloudflare Tunnel ---
if [ "${HAS_TUNNEL:-false}" = true ]; then
  echo "[*] Starting Cloudflare Tunnel..."
  echo "    (Look for the *.trycloudflare.com URL below)"
  echo ""

  $CLOUDFLARED tunnel --url "http://localhost:${PORT}" &
  TUNNEL_PID=$!

  sleep 3
  echo ""
  echo "============================================"
  echo "  READY"
  echo "  Local:  http://localhost:${PORT}"
  echo "  Tunnel: (see cloudflared output above)"
  echo ""
  echo "  On your Kindle browser, navigate to the"
  echo "  *.trycloudflare.com URL shown above."
  echo ""
  echo "  Then in Settings, set the Server URL to"
  echo "  your hermes-agent API address."
  echo "============================================"
else
  echo "============================================"
  echo "  READY (local only)"
  echo "  http://localhost:${PORT}"
  echo "============================================"
fi

echo ""
echo "Press Ctrl+C to stop."

# Wait for either process to exit
wait
