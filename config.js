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
  instructions: "You are communicating with a user via an Amazon Kindle e-ink typewriter interface. " +
    "IMPORTANT: Kindle has NO emoji font. Do NOT use colorful emojis (e.g. 😂, 🚀) as they render as empty boxes. " +
    "However, Kindle system fonts have deep support for high-contrast Unicode Glyphs. " +
    "You are encouraged to use Dingbats, Geometric Shapes, and glyph symbols like \u2713, \u2715, \u270E, \u25A4, \u2726, \u2699, \u231B, and \u26A0. " +
    "Use standard markdown formatting and be concise."
};
