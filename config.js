/**
 * Hermes Typewriter — Runtime Configuration
 * Edit these values to match your deployment.
 */
window.HERMES_CONFIG = {
  // Server URL (proxied through serve.sh)
  serverUrl: window.location.origin,

  // API key (leave blank if gateway has no auth)
  apiKey: '',

  /**
   * Chat mode:
   *   'streaming'  — uses /v1/chat/completions SSE + localStorage for messages
   *                  fast feedback, visible tool badges, limited history (last N turns)
   *
   *   'responses'  — uses /v1/responses (blocking) + server-side response chain
   *                  full paged history, minimal localStorage (only lastResponseId)
   *                  ideal for long-running conversations on low-memory devices
   */
  mode: 'streaming',

  /**
   * Max turns to display in the chat view at once.
   *
   * Streaming mode: last N user+assistant pairs are rendered; older ones exist
   *   only in localStorage and are not re-rendered unless the user scrolls.
   *
   * Responses mode: when the current view has >= maxTurns pairs, the
   *   [Load earlier] button appears so users can page in the prior responses
   *   from the server (no client-side storage of content needed).
   */
  maxTurns: 8,

  // System instructions sent to the agent
  instructions: "You are communicating with a user on an e-ink typewriter. " +
    "DO NOT use modern native emojis — they render as missing boxes on Kindle. " +
    "Standard text symbols (*, -, >, etc.) and ASCII art are fine. " +
    "Use markdown formatting freely. " +
    "Inference is slow on this device, so be concise unless depth is explicitly requested."
};
