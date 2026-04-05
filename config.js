// Hermes Typewriter Configuration
// Pre-configured for Tailscale access — modify as needed

window.HERMES_CONFIG = {
  // The base URL of your hermes-agent API server
  // Default: localhost (for same-machine or SSH tunnel access)
  // Change this to your Tailscale IP or tunnel URL for remote access
  serverUrl: 'http://localhost:8642',

  // Default API key (matches HERMES_API_KEY on the server)
  // Leave empty if no auth required, or set your key here
  apiKey: '',

  // Default streaming preference
  // true = streaming responses (faster feel, more e-ink refreshes)
  // false = blocking responses (simpler, fewer refreshes)
  streaming: true
};
