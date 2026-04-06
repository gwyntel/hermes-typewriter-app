#!/usr/bin/env bash
# serve.sh — Lightweight static server + Tunnel (Cloudflare or Ngrok) for Kindle access
# Usage: ./serve.sh [port] [--tunnel cloudflare|ngrok]

set -euo pipefail

PORT="8644"
TUNNEL_TYPE="auto" # Default: Detect available tunnel

# --- Argument Parsing ---
while [ $# -gt 0 ]; do
  case $1 in
    --port)
      PORT="$2"
      shift 2
      ;;
    --tunnel)
      TUNNEL_TYPE="$2"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      # Fallback for positional port argument: ./serve.sh 8644
      PORT="$1"
      shift
      ;;
  esac
done

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  HERMES TYPEWRITER"
echo "  Port:   $PORT"
echo "  Tunnel: $TUNNEL_TYPE"
echo "============================================"
echo ""

HAS_TUNNEL=false
TUNNEL_BIN=""

# --- Tunnel Provider Setup ---
if [ "$TUNNEL_TYPE" = "auto" ] || [ "$TUNNEL_TYPE" = "cloudflare" ]; then
  # 1. Cloudflare Detection
  if [ -f "./cloudflared" ]; then
    TUNNEL_BIN="./cloudflared"
    TUNNEL_TYPE="cloudflare"
    HAS_TUNNEL=true
  elif command -v cloudflared > /dev/null 2>&1; then
    TUNNEL_BIN="cloudflared"
    TUNNEL_TYPE="cloudflare"
    HAS_TUNNEL=true
  elif [ "$TUNNEL_TYPE" = "cloudflare" ]; then
    echo "[*] cloudflared not found. Attempting auto-install..."
    OS="$(uname -s)"
    ARCH="$(uname -m)"
    if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then CF_ARCH="arm64"; else CF_ARCH="amd64"; fi
    URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CF_ARCH.tgz"
      curl -sL "$URL" -o cf.tgz && tar -xzf cf.tgz && rm cf.tgz
      chmod +x cloudflared && xattr -d com.apple.quarantine cloudflared 2>/dev/null || true
      TUNNEL_BIN="./cloudflared"
      HAS_TUNNEL=true
    elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then CF_ARCH="arm64"; else CF_ARCH="amd64"; fi
    URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH"
      curl -sL "$URL" -o cloudflared && chmod +x cloudflared
      TUNNEL_BIN="./cloudflared"
      HAS_TUNNEL=true
    fi
  fi
fi

# 2. Ngrok Fallback (if cloudflare not found or auto skipped)
if [ "$HAS_TUNNEL" = false ]; then
  if [ "$TUNNEL_TYPE" = "auto" ] || [ "$TUNNEL_TYPE" = "ngrok" ]; then
    if command -v ngrok > /dev/null 2>&1; then
      TUNNEL_BIN="ngrok"
      TUNNEL_TYPE="ngrok"
      HAS_TUNNEL=true
    elif [ "$TUNNEL_TYPE" = "ngrok" ]; then
      echo "[!] ngrok not found in PATH. Please install it: https://ngrok.com/download"
      HAS_TUNNEL=false
    fi
  fi
fi

# --- Free the port ---
if lsof -ti :"$PORT" &>/dev/null; then
  echo "[!] Port $PORT is in use — killing existing process..."
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# --- Start Proxy + Static server ---
echo "[*] Starting proxy server on http://localhost:${PORT}..."

# Load API key if present in hermes-agent config
if [ -f "$HOME/.hermes/.env" ]; then
  # Extract key manually to avoid accidental shell execution of .env
  EXTRACTED_KEY=$(grep '^API_SERVER_KEY=' "$HOME/.hermes/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  if [ -n "$EXTRACTED_KEY" ]; then
    export API_SERVER_KEY="$EXTRACTED_KEY"
    echo "[*] Loaded API key from ~/.hermes/.env"
  fi
fi

export HERMES_URL="${HERMES_URL:-http://localhost:8642}"
python3 server.py "$PORT" &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "[*] Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "${TUNNEL_LOG:-}" ] && rm -f "$TUNNEL_LOG"
  echo "[*] Done."
}
trap cleanup EXIT INT TERM

sleep 1

# --- Start Tunnel ---
if [ "$HAS_TUNNEL" = true ]; then
  TUNNEL_LOG=$(mktemp)
  echo -n "[*] Starting $TUNNEL_TYPE tunnel..."
  
  if [ "$TUNNEL_TYPE" = "cloudflare" ]; then
    $TUNNEL_BIN tunnel --url "http://localhost:${PORT}" > "$TUNNEL_LOG" 2>&1 &
  else
    # ngrok log format is different; we use --log=stdout
    $TUNNEL_BIN http "$PORT" --log=stdout > "$TUNNEL_LOG" 2>&1 &
  fi
  TUNNEL_PID=$!

  # Wait for URL
  TUNNEL_URL=""
  echo -n "[*] Waiting for tunnel to establish..."
  i=1
  while [ $i -le 60 ]; do
    # --- 1. Try Programmatic API Check (Cloudflare 20241-20245 / Ngrok 4040) ---
    if [ "$TUNNEL_TYPE" = "cloudflare" ]; then
      if command -v curl > /dev/null 2>&1; then
        for port in 20241 20242 20243 20244 20245; do
          JSON=$(curl -s --max-time 1 "http://localhost:$port/quicktunnel" || true)
          # Use grep for portable glob matching
          if echo "$JSON" | grep -q "hostname"; then
            HOST=$(echo "$JSON" | grep -o '"hostname":"[^"]*"' | cut -d'"' -f4)
            if [ -n "$HOST" ]; then
              TUNNEL_URL="https://$HOST"
              break
            fi
          fi
        done
      fi
    elif [ "$TUNNEL_TYPE" = "ngrok" ]; then
      if command -v curl > /dev/null 2>&1; then
        TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[a-z0-9-]*\.ngrok-free\.app' | head -n 1 || true)
        if [ -z "$TUNNEL_URL" ]; then
          TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[a-z0-9-]*\.ngrok\.io' | head -n 1 || true)
        fi
      fi
    fi

    if [ -n "$TUNNEL_URL" ]; then break; fi

    # --- 2. Parallel Fallback: Scrape Logs if API not ready yet ---
    if [ "$TUNNEL_TYPE" = "cloudflare" ]; then
      TUNNEL_URL=$(grep -o 'https://[-0-9a-z]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)
    else
      TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.ngrok-free\.app' "$TUNNEL_LOG" | head -n 1 || true)
      if [ -z "$TUNNEL_URL" ]; then
        TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.ngrok\.io' "$TUNNEL_LOG" | head -n 1 || true)
      fi
    fi

    if [ -n "$TUNNEL_URL" ]; then break; fi
    
    # Check if process is still alive while waiting
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo " ❌"
      echo "[!] Tunnel process exited unexpectedly. Log:"
      cat "$TUNNEL_LOG"
      exit 1
    fi

    echo -n "."
    sleep 1
    i=$((i + 1))
  done


  if [ -n "$TUNNEL_URL" ]; then
    echo " ✅"
    echo ""
    echo "============================================"
    echo "  READY"
    echo "  Local:  http://localhost:${PORT}"
    echo "  Tunnel: $TUNNEL_URL"
    echo "============================================"
  else
    echo " ❌ (Timeout)"
    cat "$TUNNEL_LOG"
  fi
else
  echo "[!] No tunnel active. Local only: http://localhost:${PORT}"
fi

echo ""
echo "Press Ctrl+C to stop."
wait
