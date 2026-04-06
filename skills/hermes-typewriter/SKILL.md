---
name: hermes-typewriter
description: Serve the Hermes Typewriter frontend, establish a Cloudflare tunnel for Kindle access, and automatically configure the hermes-agent backend API.
version: 1.0.0
metadata:
  hermes:
    tags: [typewriter, kindle, e-ink, deployment, tunnel]
---

# Hermes Typewriter: Remote Kindle Access

Use this skill to deploy the typewriter frontend and ensure the hermes-agent backend is correctly configured for API access.

## Prerequisites

- `cloudflared` must be installed (or the skill will attempt to auto-download via `./serve.sh`)
- Repository: `hermes-typewriter-app` (where `./serve.sh` and `server.py` reside)

## Workflow

Follow these 4 steps to get the typewriter live on a Kindle:

### Phase 1: Backend Configuration

1. **Check Backend Status**: Verify if the hermes-agent API server is enabled.
   - Read `~/.hermes/.env` (if it exists) and look for `API_SERVER_ENABLED=true` and `API_SERVER_KEY`.
   - If not enabled, inform the user you will add these lines:
     ```bash
     API_SERVER_ENABLED=true
     API_SERVER_KEY=donthackme
     ```
   - *Security Note*: Use the existing key if found, otherwise suggest 'donthackme'.

2. **Ensure Gateway is Running**:
   - Check if the gateway is running (`lsof -ti :8642` or similar).
   - If not, start it in the background: `hermes gateway &`

### Phase 2: Serves the Frontend

1. **Start the Proxy + Tunnel**:
   - Navigate to the `hermes-typewriter-app` directory.
   - Run the serve script and capture output to find the tunnel URL:
     ```bash
     ./serve.sh 8643
     ```
2. **Monitor the Log**:
   - The script will output a `.trycloudflare.com` URL. Listen for this URL.

### Phase 3: Reporting & Connection

1. **Inform the User**:
   - Provide the **Tunnel URL** clearly.
   - Instruct the user to navigate to this URL on their Kindle.
   - Remind them to check the `[CONNECTED]` status in the header.
   - Since the proxy handles the `Authorization` header, they should leave the API key blank in the browser settings UNLESS they change it.

### Phase 4: Verification

1. **Confirm Health**:
   - Use `curl -H "Authorization: Bearer donthackme" http://localhost:8643/v1/models` to verify the proxy is talking to the gateway.
   - If it returns JSON, the setup is successful.

## Reporting

When complete, provide a summary like:

> [!TIP]
> **Hermes Typewriter is Live!**
> 
> **Access URL**: `https://efforts-promised-rapids-jenny.trycloudflare.com`
> 
> **Instructions for Kindle**:
> 1. Open the Experimental Browser.
> 2. Go to the URL above.
> 3. Verify the `[CONNECTED]` status.
> 
> **Inference Status**: Online via Gateway (8642)

---

## Companion Skills

If you or the user would like to modify the frontend itself — adding new UI elements, adjusting the layout, changing the CSS design system, or extending JavaScript functionality — load the **`kindle-web-development`** skill first.

That skill contains an exhaustive, battle-tested reference for every browser constraint you will encounter: the ES2019 JavaScript ceiling, the flexbox `gap` bug, the animation ghosting problem, the 64 MB localStorage hard limit, touch target sizing, and much more. Any changes to `index.html`, `style.css`, or `app.js` **must** comply with those constraints or the Kindle browser will silently fail or crash.

```
skill: kindle-web-development
```
