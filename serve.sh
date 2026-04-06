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
  echo "[!] cloudflared not found Locally or in PATH."
  echo "    Attempting to auto-install cloudflared..."
  echo ""
  
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  
  if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
      TGZ_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
    else
      TGZ_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
    fi
    echo "[*] Downloading macOS binary: $TGZ_URL"
    curl -sL "$TGZ_URL" -o cloudflared.tgz
    tar -xzf cloudflared.tgz
    rm cloudflared.tgz
    chmod +x cloudflared 2>/dev/null || true
    xattr -d com.apple.quarantine cloudflared 2>/dev/null || true
    CLOUDFLARED="./cloudflared"
    HAS_TUNNEL=true
  elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      BIN_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    else
      BIN_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    fi
    echo "[*] Downloading Linux binary: $BIN_URL"
    curl -sL "$BIN_URL" -o cloudflared
    chmod +x cloudflared
    CLOUDFLARED="./cloudflared"
    HAS_TUNNEL=true
  else
    echo "[!] OS $OS not supported for auto-download."
    echo "    Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    echo ""
    echo "    Starting local server only (no tunnel)..."
    echo ""
    HAS_TUNNEL=false
  fi
fi

# --- Free the port if something is already using it ---
if lsof -ti :"$PORT" &>/dev/null; then
  echo "[!] Port $PORT is in use — killing existing process..."
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
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
  if [ "${TUNNEL_LOG:-}" ]; then
    rm -f "$TUNNEL_LOG"
  fi
  echo "[*] Done."
}
trap cleanup EXIT INT TERM

sleep 1

# --- Start Cloudflare Tunnel ---
if [ "${HAS_TUNNEL:-false}" = true ]; then
  echo "[*] Starting Cloudflare Tunnel..."

  # Temp log file to capture cloudflared output (stdout+stderr)
  TUNNEL_LOG=$(mktemp)

  # Launch cloudflared — the binary is already present at this point (downloaded above if needed)
  $CLOUDFLARED tunnel --url "http://localhost:${PORT}" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  # Wait until cloudflared process is confirmed alive before polling
  # (guards against the race where the process hasn't written anything yet)
  echo -n "[*] Waiting for tunnel to establish..."
  for _ in 1 2 3; do
    kill -0 "$TUNNEL_PID" 2>/dev/null && break
    sleep 1
  done

  # Poll up to 60s for the trycloudflare.com URL in the logs
  count=0
  TUNNEL_URL=""
  while [ $count -lt 60 ]; do
    # cloudflared may print the URL as a plain line or inside a log message
    TUNNEL_URL=$(grep -o 'https://[-0-9a-z]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1 || true)
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
    # Bail early if cloudflared itself died
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo ""
      echo "[!] cloudflared exited unexpectedly. Log:"
      cat "$TUNNEL_LOG"
      break
    fi
    echo -n "."
    sleep 1
    count=$((count+1))
  done

  if [ -n "$TUNNEL_URL" ]; then
    echo " ✅"
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:  http://localhost:${PORT}"
    echo "  Tunnel: $TUNNEL_URL"
    echo ""
    echo "  On your Kindle browser, navigate to:"
    echo "  $TUNNEL_URL"
    echo ""
    echo "  Then in Settings, set the Server URL to"
    echo "  your hermes-agent API address."
    echo "============================================"
  else
    echo " ❌"
    echo "[!] Could not detect tunnel URL after 60s."
    echo "    Dumping cloudflared log:"
    cat "$TUNNEL_LOG"
  fi
else
  echo "============================================"
  echo "  READY (local only)"
  echo "  http://localhost:${PORT}"
  echo "============================================"
fi

echo ""
echo "Press Ctrl+C to stop."

# Wait for background processes
wait
