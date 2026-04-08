#!/usr/bin/env bash
# serve.sh — Lightweight static server + Tunnel for Kindle access
# Usage: ./serve.sh [port]
#
# Tunnel priority: Tailscale Funnel > Ngrok > Cloudflare Tunnel > Local only

set -euo pipefail

PORT="${1:-8643}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  HERMES TYPEWRITER"
echo "  Static server + Tunnel"
echo "============================================"
echo ""

# --- Detect tunnel method ---
TUNNEL_METHOD=""
TUNNEL_CMD=""

# Check for Tailscale Funnel first (preferred - stable URL)
if command -v tailscale &> /dev/null; then
  # Check if funnel is available (requires tailscale up + funnel enabled)
  if tailscale funnel 2>&1 | grep -q "Usage:" 2>/dev/null || tailscale funnel --help &>/dev/null; then
    TUNNEL_METHOD="tailscale"
    TUNNEL_CMD="tailscale funnel"
    echo "[*] Found Tailscale Funnel"
  fi
fi

# Check for ngrok second (good free tier)
if [ -z "$TUNNEL_METHOD" ]; then
  if command -v ngrok &> /dev/null; then
    TUNNEL_METHOD="ngrok"
    TUNNEL_CMD="ngrok http"
    echo "[*] Found Ngrok"
  fi
fi

# Fall back to Cloudflare Tunnel
if [ -z "$TUNNEL_METHOD" ]; then
  if [ -f "./cloudflared" ]; then
    CLOUDFLARED="./cloudflared"
    TUNNEL_METHOD="cloudflare"
    TUNNEL_CMD="$CLOUDFLARED tunnel --url"
    echo "[*] Found Cloudflare Tunnel (cloudflared)"
  elif command -v cloudflared &> /dev/null; then
    CLOUDFLARED="cloudflared"
    TUNNEL_METHOD="cloudflare"
    TUNNEL_CMD="$CLOUDFLARED tunnel --url"
    echo "[*] Found Cloudflare Tunnel (cloudflared)"
  fi
fi

if [ -z "$TUNNEL_METHOD" ]; then
  echo "[!] No tunnel available."
  echo "    Install one of:"
  echo "      - Tailscale: https://tailscale.com (then: tailscale funnel --setup)"
  echo "      - Ngrok:     https://ngrok.com (then: ngrok config add-authtoken)"
  echo "      - Cloudflare: brew install cloudflared"
  echo ""
  echo "    Starting local server only..."
fi

# --- Start Proxy + Static server ---
echo ""
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
  # Ngrok runs in background, kill via pkill
  if [ "$TUNNEL_METHOD" = "ngrok" ]; then
    pkill -f "ngrok http" 2>/dev/null || true
  fi
  echo "[*] Done."
}
trap cleanup EXIT INT TERM

sleep 1

# --- Start Tunnel ---
if [ "$TUNNEL_METHOD" = "tailscale" ]; then
  echo "[*] Starting Tailscale Funnel on port ${PORT}..."
  echo "    (Look for the URL below or check: tailscale status)"
  echo ""
  
  # Tailscale funnel syntax: tailscale funnel <port>
  $TUNNEL_CMD "$PORT" &
  TUNNEL_PID=$!
  
  sleep 2
  
  # Get the tailscale hostname
  TS_HOSTNAME=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null || echo "")
  if [ -n "$TS_HOSTNAME" ]; then
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:   http://localhost:${PORT}"
    echo "  Tunnel:  https://${TS_HOSTNAME}"
    echo ""
    echo "  On your Kindle browser, navigate to:"
    echo "  https://${TS_HOSTNAME}"
    echo ""
    echo "  Note: Tailscale Funnel requires:"
    echo "    - Tailscale running (tailscale up)"
    echo "    - Funnel enabled (tailscale funnel --setup)"
    echo "============================================"
  else
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:  http://localhost:${PORT}"
    echo "  Tunnel: https://<your-tailscale-hostname>"
    echo "          (check: tailscale status)"
    echo "============================================"
  fi
  
elif [ "$TUNNEL_METHOD" = "ngrok" ]; then
  echo "[*] Starting Ngrok on port ${PORT}..."
  echo "    (Look for the URL below or check: http://localhost:4040)"
  echo ""
  
  # Ngrok syntax: ngrok http <port>
  $TUNNEL_CMD "$PORT" --log=stdout > /tmp/ngrok.log 2>&1 &
  TUNNEL_PID=$!
  
  # Wait for ngrok to start and get the public URL
  sleep 3
  
  # Try to get the public URL from ngrok API
  NGROK_URL=""
  for i in {1..10}; do
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[0].public_url // empty' 2>/dev/null || echo "")
    if [ -n "$NGROK_URL" ]; then
      break
    fi
    sleep 1
  done
  
  if [ -n "$NGROK_URL" ]; then
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:   http://localhost:${PORT}"
    echo "  Tunnel:  ${NGROK_URL}"
    echo ""
    echo "  On your Kindle browser, navigate to:"
    echo "  ${NGROK_URL}"
    echo ""
    echo "  Ngrok dashboard: http://localhost:4040"
    echo "============================================"
  else
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:  http://localhost:${PORT}"
    echo "  Tunnel: https://<ngrok-url>"
    echo "          (check: http://localhost:4040)"
    echo "============================================"
  fi
  
elif [ "$TUNNEL_METHOD" = "cloudflare" ]; then
  echo "[*] Starting Cloudflare Tunnel..."
  echo "    (Look for the *.trycloudflare.com URL below)"
  echo ""
  
  $TUNNEL_CMD "http://localhost:${PORT}" 2>&1 | tee /tmp/cloudflared.log &
  TUNNEL_PID=$!
  
  sleep 3
  
  # Try to extract URL from log
  CF_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cloudflared.log 2>/dev/null | head -1 || echo "")
  
  echo ""
  echo "============================================"
  echo "  READY"
  echo "  Local:  http://localhost:${PORT}"
  if [ -n "$CF_URL" ]; then
    echo "  Tunnel: ${CF_URL}"
    echo ""
    echo "  On your Kindle browser, navigate to:"
    echo "  ${CF_URL}"
  else
    echo "  Tunnel: (see cloudflared output above)"
    echo ""
    echo "  On your Kindle browser, navigate to the"
    echo "  *.trycloudflare.com URL shown above."
  fi
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
