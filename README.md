# Hermes Typewriter

E-ink optimized chat interface for hermes-agent. Designed for Kindle browsers with full session history support.

## Features

- **Session History**: Browse and resume past conversations from `~/.hermes/sessions/`
- **E-Ink Optimized**: High contrast, no animations, system fonts, 48px touch targets
- **Real-Time Streaming**: SSE streaming with visual typing indicator
- **Tool Call Display**: Shows tool invocations with truncated output
- **Multi-Tunnel**: Auto-detects Tailscale Funnel, Ngrok, or Cloudflare Tunnel
- **Zero Config**: Works out of the box with hermes-agent

## Quick Start

```bash
# Clone and run
git clone https://github.com/gwyneth/hermes-typewriter-app.git
cd hermes-typewriter-app
./serve.sh
```

The script auto-detects available tunnels:
1. **Tailscale Funnel** (preferred) — stable `*.ts.net` URL
2. **Ngrok** — free tier, dashboard at `localhost:4040`
3. **Cloudflare Tunnel** — quick start, no account needed

## Requirements

- Python 3.7+
- hermes-agent running on `localhost:8642` (or set `HERMES_URL`)
- Optional: `tailscale`, `ngrok`, or `cloudflared` for tunneling

## Configuration

Settings are stored in browser localStorage after entering in the UI:

| Setting | Description | Default |
|---------|-------------|---------|
| Server URL | Hermes API endpoint | Current origin |
| API Key | Bearer token for auth | None |
| Streaming | Enable SSE streaming | True |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /sessions` | List session files with metadata |
| `GET /sessions/:id/messages` | Get messages from session |
| `POST /v1/chat/completions` | Proxy to hermes-agent |
| `GET /health` | Health check |

## Session Format

Sessions are stored as JSONL files in `~/.hermes/sessions/`:

```
YYYYMMDD_HHMMSS_<id>.jsonl
```

Each line is a JSON object:
- `role: "session_meta"` — metadata (platform, model, tools)
- `role: "user"` — user message
- `role: "assistant"` — assistant message (may have `tool_calls`)
- `role: "tool"` — tool output (merged into assistant display)

## Kindle Compatibility

Built for Chromium-based Kindle browser (firmware 5.16.4+):

- ✅ ES2019 JavaScript (no optional chaining, no nullish coalescing)
- ✅ CSS Variables, Flexbox (margins instead of `gap`), Grid
- ✅ System fonts only (Arial, Georgia, Courier New)
- ✅ No animations or transitions
- ✅ 48px minimum touch targets
- ❌ No emojis (use ASCII: `[OK]`, `[X]`, etc.)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Kindle    │────▶│  server.py  │────▶│   hermes    │
│   Browser   │     │   (proxy)   │     │   agent     │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  sessions/  │
                    │   JSONL     │
                    └─────────────┘
```

## Security

- API key stored in localStorage only (not in config)
- `/config.js` blocked server-side (404)
- No inline scripts, all external

## Development

```bash
# Run locally without tunnel
python server.py 8643

# Test tunnel modes
tailscale funnel 8643      # Tailscale
ngrok http 8643            # Ngrok
cloudflared tunnel --url http://localhost:8643  # Cloudflare
```

## License

MIT
