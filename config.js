// Hermes Typewriter Configuration
// Pre-configured for Tailscale access — modify as needed

window.HERMES_CONFIG = {
  // The base URL of your hermes-agent API server
  // Leave empty to use the proxy built into server.py (recommended)
  // Set only if you want to bypass the proxy and connect directly
  serverUrl: '',

  // Default API key (matches HERMES_API_KEY on the server)
  // Leave empty if no auth required, or set your key here
  apiKey: '',

  // Default streaming preference
  // true = streaming responses (faster feel, more e-ink refreshes)
  // false = blocking responses (simpler, fewer refreshes)
  streaming: true
};
