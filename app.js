(function() {
  'use strict';

  // === CONFIG DEFAULTS ===
  var CONFIG = window.HERMES_CONFIG || {};
  // Default to proxying through the app server itself (current origin)
  var DEFAULT_URL = CONFIG.serverUrl || window.location.origin;
  var DEFAULT_KEY = CONFIG.apiKey || '';
  var DEFAULT_STREAM = !!CONFIG.streaming;
  var TIMEOUT_MS = 120000;

  // Tool icon map (ASCII — no emoji on Kindle)
  var TOOL_ICONS = {
    terminal: '[>_]', shell: '[>_]', bash: '[>_]',
    search: '[?]', web_search: '[?]',
    file_read: '[~]', read_file: '[~]', view_file: '[~]',
    file_write: '[+]', write_file: '[+]', create_file: '[+]',
    memory: '[@]', recall: '[@]',
    skill: '[*]', default: '[*]'
  };

  // Emoji-to-ASCII for streaming tool indicators
  // Use actual emoji chars (surrogate pairs) — avoid \u{} syntax for Chromium 75
  var EMOJI_LIST = [
    ['\uD83D\uDCBB', '[>_]'],
    ['\uD83D\uDD0D', '[?]'],
    ['\uD83D\uDCC1', '[~]'],
    ['\uD83D\uDCDD', '[+]'],
    ['\uD83E\uDDE0', '[@]'],
    ['\u2699', '[*]'],
    ['\uD83D\uDD27', '[*]']
  ];

  // === STATE ===
  var state = {
    serverUrl: DEFAULT_URL,
    apiKey: DEFAULT_KEY,
    streaming: DEFAULT_STREAM,
    connected: false,
    threads: [],
    activeThread: null,
    messages: [],
    sending: false,
    latestResponseId: null,
    earliestResponseId: null,
    hasEarlier: false,
    loadingEarlier: false
  };

  // === DOM CACHE ===
  var E = {};
  function cacheDom() {
    var ids = [
      'status', 'threads-view', 'chat-view', 'threads-list', 'threads-empty',
      'new-thread-btn', 'new-thread-form', 'new-thread-input',
      'new-thread-cancel', 'new-thread-create',
      'rejoin-input', 'rejoin-btn',
      'settings-toggle', 'settings-panel', 'setting-url', 'setting-key',
      'test-connection-btn',
      'setting-stream', 'settings-save',
      'back-btn', 'thread-title',
      'load-earlier', 'load-earlier-btn',
      'messages', 'typing-indicator',
      'message-input', 'send-btn'
    ];
    for (var i = 0; i < ids.length; i++) {
      E[ids[i]] = document.getElementById(ids[i]);
    }
  }

  // === PERSISTENCE ===
  function save() {
    try {
      localStorage.setItem('hermes_tw', JSON.stringify({
        serverUrl: state.serverUrl,
        apiKey: state.apiKey,
        streaming: state.streaming,
        threads: state.threads
      }));
    } catch (e) { /* Kindle may wipe */ }
  }

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem('hermes_tw') || 'null');
      if (d) {
        state.serverUrl = d.serverUrl || DEFAULT_URL;
        state.apiKey = d.apiKey || '';
        state.streaming = !!d.streaming;
        state.threads = d.threads || [];
      }
    } catch (e) { /* use defaults */ }
  }

  // === HELPERS ===
  function replaceEmoji(text) {
    if (!text) return '';
    var result = text;
    for (var i = 0; i < EMOJI_LIST.length; i++) {
      result = result.split(EMOJI_LIST[i][0]).join(EMOJI_LIST[i][1]);
    }
    return result;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(text) {
    if (!text) return '';
    var h = escapeHtml(text);
    h = h.replace(/```([a-z]*)\n([\s\S]*?)```/g, function(_, lang, code) {
      return '<pre class="code-block">' + code.trim() + '</pre>';
    });
    h = h.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/([^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  function scrollToBottom() {
    window.scrollTo(0, document.body.scrollHeight);
  }

  // === THREADS ===
  function findThread(name) {
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].name === name) return state.threads[i];
    }
    return null;
  }

  function upsertThread(name) {
    var t = findThread(name);
    if (!t) {
      t = { name: name, lastResponseId: null, preview: '', time: Date.now() };
      state.threads.unshift(t);
    }
    return t;
  }

  function touchThread(name, preview, responseId) {
    var t = upsertThread(name);
    if (preview) t.preview = preview.substring(0, 80);
    if (responseId) t.lastResponseId = responseId;
    t.time = Date.now();
    // Move to top
    var idx = state.threads.indexOf(t);
    if (idx > 0) {
      state.threads.splice(idx, 1);
      state.threads.unshift(t);
    }
    save();
  }

  function deleteThread(name) {
    state.threads = state.threads.filter(function(t) { return t.name !== name; });
    save();
  }

  // === API ===
  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (state.apiKey) h['Authorization'] = 'Bearer ' + state.apiKey;
    return h;
  }

  function checkHealth(manual) {
    if (manual) E['test-connection-btn'].textContent = '[...]';
    var ctrl = new AbortController();
    var tid = setTimeout(function() { ctrl.abort(); }, 6000);
    // Always probe /health on the proxy itself (never the configured serverUrl which points at /v1)
    var healthUrl = window.location.origin + '/health';
    fetch(healthUrl, { signal: ctrl.signal })
      .then(function(r) {
        clearTimeout(tid);
        state.connected = r.ok;
        renderStatus();
        if (manual) E['test-connection-btn'].textContent = r.ok ? '[OK!]' : '[ERR ' + r.status + ']';
      })
      .catch(function() {
        clearTimeout(tid);
        state.connected = false;
        renderStatus();
        if (manual) E['test-connection-btn'].textContent = '[FAIL]';
      })
      .finally(function() {
        if (manual) setTimeout(function() { E['test-connection-btn'].textContent = '[TEST]'; }, 2500);
      });
  }


  function sendMessage(text) {
    if (state.sending || !text.trim()) return;
    state.sending = true;
    updateInputState();

    state.messages.push({ role: 'user', content: text, tools: [] });
    renderMessages();

    var body = {
      model: 'hermes-agent',
      input: text,
      store: true,
      instructions: "You are communicating with a user on an e-ink typewriter. DO NOT use modern native emojis, as they do not have an installed device font and will render as missing boxes (standard text unicode symbols are OK). Feel free to use standard markdown formatting for emphasis. Your text is being streamed live to the user's screen bead-by-bead."
    };
    if (state.activeThread) body.conversation = state.activeThread;
    if (state.streaming) {
      body.stream = true;
      doStreaming(body);
    } else {
      doBlocking(body);
    }
  }

  function doBlocking(body) {
    showTyping(true);
    var ctrl = new AbortController();
    var tid = setTimeout(function() { ctrl.abort(); }, TIMEOUT_MS);

    fetch(state.serverUrl + '/v1/responses', {
      method: 'POST', headers: headers(),
      body: JSON.stringify(body), signal: ctrl.signal
    })
    .then(function(r) {
      clearTimeout(tid);
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t); });
      return r.json();
    })
    .then(function(data) {
      var msg = parseResponseData(data);
      state.messages.push(msg);
      if (data.id) touchThread(state.activeThread, msg.content, data.id);
      renderMessages();
    })
    .catch(function(err) {
      state.messages.push({ role: 'error', content: err.message || String(err), tools: [] });
      renderMessages();
    })
    .finally(function() {
      state.sending = false;
      showTyping(false);
      updateInputState();
    });
  }

  function doStreaming(body) {
    showTyping(true);
    var ctrl = new AbortController();
    var tid = setTimeout(function() { ctrl.abort(); }, TIMEOUT_MS);
    var msg = { role: 'assistant', content: '', tools: [] };

    fetch(state.serverUrl + '/v1/responses', {
      method: 'POST', headers: headers(),
      body: JSON.stringify(body), signal: ctrl.signal
    })
    .then(function(r) {
      clearTimeout(tid);
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t); });
      
      var contentType = r.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') !== -1) {
        return r.json().then(function(data) {
          var parsedMsg = parseResponseData(data);
          state.messages.push(parsedMsg);
          if (data.id) touchThread(state.activeThread, parsedMsg.content, data.id);
          renderMessages();
        });
      }

      state.messages.push(msg);
      showTyping(false);
      renderMessages();
      return pumpStream(r, msg);
    })
    .catch(function(err) {
      state.messages.push({ role: 'error', content: err.message || String(err), tools: [] });
      renderMessages();
    })
    .finally(function() {
      state.sending = false;
      showTyping(false);
      updateInputState();
      removeCursor();
    });
  }

  function pumpStream(response, msg) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    function read() {
      return reader.read().then(function(result) {
        if (result.done) {
          if (buf.trim()) processSSE(buf.split('\n'), msg);
          touchThread(state.activeThread, msg.content, state.latestResponseId);
          renderMessages();
          return;
        }
        buf += decoder.decode(result.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        processSSE(lines, msg);
        return read();
      });
    }
    return read();
  }

  function processSSE(lines, msg) {
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line === 'data: [DONE]') continue;
      if (line.indexOf('data:') !== 0) continue;
      try {
        var dataStr = line.substring(5).trim();
        var d = JSON.parse(dataStr);
        
        // Responses API streaming events
        if (d.type === 'response.output_text.delta') {
          var txtDelta = '';
          if (typeof d.delta === 'string') txtDelta = d.delta;
          else if (d.delta && typeof d.delta.text === 'string') txtDelta = d.delta.text;
          else if (typeof d.text === 'string') txtDelta = d.text;
          
          if (txtDelta) {
            msg.content += replaceEmoji(txtDelta);
            updateLastMessage(msg);
          }
        } else if (d.type === 'response.completed' && d.response) {
          if (d.response.id) state.latestResponseId = d.response.id;
          
          // Re-parse the complete final response to fix any streamed vs final mismatch
          var finalMsg = parseResponseData(d.response);
          if (finalMsg.content) msg.content = finalMsg.content;
          if (finalMsg.tools && finalMsg.tools.length > 0) msg.tools = finalMsg.tools;
          updateLastMessage(msg);
        }
        
        // Chat Completions fallback
        if (d.choices && d.choices[0]) {
          if (d.choices[0].delta && d.choices[0].delta.content) {
            msg.content += replaceEmoji(d.choices[0].delta.content);
            updateLastMessage(msg);
          }
          if (d.choices[0].message && d.choices[0].message.content) {
            // Replace full content instead of appending if full message is provided
            msg.content = replaceEmoji(d.choices[0].message.content);
            updateLastMessage(msg);
          }
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  // === RESPONSE PARSING ===
  function parseResponseData(data) {
    var msg = { role: 'assistant', content: '', tools: [] };

    if (data.output && Array.isArray(data.output)) {
      for (var i = 0; i < data.output.length; i++) {
        var item = data.output[i];
        if (item.type === 'function_call') {
          var name = item.name || 'tool';
          var icon = TOOL_ICONS[name] || TOOL_ICONS['default'];
          var args = '';
          try {
            var p = JSON.parse(item.arguments || '{}');
            var k = Object.keys(p);
            if (k.length > 0) args = String(p[k[0]]).substring(0, 60);
          } catch (e) { args = (item.arguments || '').substring(0, 60); }
          msg.tools.push({ name: name, icon: icon, args: args, callId: item.call_id || '' });
        } else if (item.type === 'function_call_output') {
          for (var j = msg.tools.length - 1; j >= 0; j--) {
            if (msg.tools[j].callId === item.call_id) {
              msg.tools[j].output = (item.output || '').substring(0, 200);
              break;
            }
          }
        } else if (item.type === 'message') {
          if (Array.isArray(item.content)) {
            for (var k2 = 0; k2 < item.content.length; k2++) {
              if (item.content[k2].type === 'output_text') {
                msg.content += replaceEmoji(item.content[k2].text || '');
              }
            }
          } else if (typeof item.content === 'string') {
            msg.content += replaceEmoji(item.content);
          }
        }
      }
    }
    // Chat Completions fallback
    if (data.choices && data.choices[0] && data.choices[0].message) {
      msg.content = replaceEmoji(data.choices[0].message.content || '');
    }
    return msg;
  }

  // === LAZY LOADING ===
  function loadEarlier() {
    if (state.loadingEarlier || !state.earliestResponseId) return;
    state.loadingEarlier = true;
    E['load-earlier-btn'].textContent = '[Loading...]';

    fetch(state.serverUrl + '/v1/responses/' + state.earliestResponseId, { headers: headers() })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var msgs = responseToMessages(data);
        state.messages = msgs.concat(state.messages);
        state.earliestResponseId = data.previous_response_id || null;
        state.hasEarlier = !!state.earliestResponseId;
        renderMessages();
        updateLoadEarlier();
      })
      .catch(function() { /* silent */ })
      .finally(function() {
        state.loadingEarlier = false;
        E['load-earlier-btn'].textContent = '[Load earlier messages...]';
      });
  }

  function loadLatest(threadName) {
    var t = findThread(threadName);
    if (!t || !t.lastResponseId) {
      state.hasEarlier = false;
      updateLoadEarlier();
      return;
    }
    fetch(state.serverUrl + '/v1/responses/' + t.lastResponseId, { headers: headers() })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        state.messages = responseToMessages(data);
        state.latestResponseId = data.id;
        state.earliestResponseId = data.previous_response_id || null;
        state.hasEarlier = !!state.earliestResponseId;
        renderMessages();
        updateLoadEarlier();
      })
      .catch(function() { /* thread may be new */ });
  }

  function responseToMessages(data) {
    var msgs = [];
    if (data.input) {
      var txt = typeof data.input === 'string' ? data.input : '';
      if (Array.isArray(data.input)) {
        for (var i = 0; i < data.input.length; i++) {
          if (data.input[i].content) { txt = data.input[i].content; break; }
        }
      }
      if (txt) msgs.push({ role: 'user', content: txt, tools: [] });
    }
    if (data.output) {
      var m = parseResponseData(data);
      if (m.content || m.tools.length) msgs.push(m);
    }
    return msgs;
  }

  // === RENDERING ===
  function renderStatus() {
    E['status'].textContent = state.connected ? '[CONNECTED]' : '[OFFLINE]';
    E['status'].className = 'status status--' + (state.connected ? 'online' : 'offline');
  }

  function showView(name) {
    E['threads-view'].style.display = name === 'threads' ? '' : 'none';
    E['chat-view'].style.display = name === 'chat' ? '' : 'none';
    if (name === 'threads') renderThreadsList();
  }

  function renderThreadsList() {
    E['threads-list'].innerHTML = '';
    if (state.threads.length === 0) {
      E['threads-empty'].style.display = '';
      return;
    }
    E['threads-empty'].style.display = 'none';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.threads.length; i++) {
      var t = state.threads[i];
      var btn = document.createElement('button');
      btn.className = 'thread-item' + (t.name === state.activeThread ? ' thread-item--active' : '');

      var nm = document.createElement('span');
      nm.className = 'thread-name';
      nm.textContent = t.name;
      btn.appendChild(nm);

      if (t.preview) {
        var pv = document.createElement('span');
        pv.className = 'thread-preview';
        pv.textContent = t.preview;
        btn.appendChild(pv);
      }
      if (t.time) {
        var tm = document.createElement('span');
        tm.className = 'thread-time';
        tm.textContent = formatTime(t.time);
        btn.appendChild(tm);
      }
      btn.addEventListener('click', (function(n) {
        return function() { openThread(n); };
      })(t.name));
      frag.appendChild(btn);
    }
    E['threads-list'].appendChild(frag);
  }

  function renderMessages() {
    E['messages'].innerHTML = '';
    if (state.messages.length === 0) {
      var emp = document.createElement('div');
      emp.className = 'empty-state';
      emp.innerHTML = '<p class="muted">Start typing below.</p>';
      E['messages'].appendChild(emp);
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.messages.length; i++) {
      frag.appendChild(buildMessageEl(state.messages[i]));
    }
    E['messages'].appendChild(frag);
    scrollToBottom();
  }

  function buildMessageEl(msg) {
    var el = document.createElement('article');
    el.className = 'message message--' + msg.role;

    var role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Hermes' : 'Error';
    el.appendChild(role);

    if (msg.tools) {
      for (var i = 0; i < msg.tools.length; i++) {
        var ti = document.createElement('span');
        ti.className = 'tool-indicator';
        ti.textContent = msg.tools[i].icon + ' ' + msg.tools[i].name + (msg.tools[i].args ? ': ' + msg.tools[i].args : '');
        el.appendChild(ti);
        if (msg.tools[i].output) {
          var to = document.createElement('span');
          to.className = 'tool-output';
          to.textContent = msg.tools[i].output;
          el.appendChild(to);
        }
      }
    }
    if (msg.content) {
      var c = document.createElement('div');
      c.className = 'message-content';
      c.innerHTML = renderMarkdown(msg.content);
      el.appendChild(c);
    }
    return el;
  }

  function updateLastMessage(msg) {
    var all = E['messages'].querySelectorAll('.message');
    var last = all[all.length - 1];
    if (!last) { renderMessages(); return; }
    var c = last.querySelector('.message-content');
    if (!c) {
      c = document.createElement('div');
      c.className = 'message-content';
      last.appendChild(c);
    }
    c.innerHTML = renderMarkdown(msg.content) + '<span class="streaming-cursor">_</span>';
    scrollToBottom();
  }

  function removeCursor() {
    var cs = document.querySelectorAll('.streaming-cursor');
    for (var i = 0; i < cs.length; i++) cs[i].parentNode.removeChild(cs[i]);
  }

  function showTyping(on) {
    E['typing-indicator'].style.display = on ? '' : 'none';
    if (on) scrollToBottom();
  }

  function updateInputState() {
    E['message-input'].disabled = state.sending;
    E['send-btn'].disabled = state.sending;
    E['send-btn'].textContent = state.sending ? '[...]' : '[SEND]';
  }

  function updateLoadEarlier() {
    E['load-earlier'].style.display = state.hasEarlier ? '' : 'none';
  }

  // === THREAD ACTIONS ===
  function openThread(name) {
    upsertThread(name);
    state.activeThread = name;
    state.messages = [];
    state.latestResponseId = null;
    state.earliestResponseId = null;
    state.hasEarlier = false;
    E['thread-title'].textContent = name;
    showView('chat');
    updateLoadEarlier();
    loadLatest(name);
    E['message-input'].focus();
  }

  // === EVENT BINDING ===
  function bindEvents() {
    // New thread
    E['new-thread-btn'].addEventListener('click', function() {
      E['new-thread-form'].style.display = '';
      E['new-thread-input'].value = '';
      E['new-thread-input'].focus();
    });
    E['new-thread-cancel'].addEventListener('click', function() {
      E['new-thread-form'].style.display = 'none';
    });
    E['new-thread-create'].addEventListener('click', function() {
      var name = E['new-thread-input'].value.trim();
      if (!name) return;
      E['new-thread-form'].style.display = 'none';
      openThread(name);
    });
    E['new-thread-input'].addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        E['new-thread-create'].click();
      }
    });

    // Rejoin
    E['rejoin-btn'].addEventListener('click', function() {
      var name = E['rejoin-input'].value.trim();
      if (name) openThread(name);
    });
    E['rejoin-input'].addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); E['rejoin-btn'].click(); }
    });

    // Settings
    E['settings-toggle'].addEventListener('click', function() {
      var p = E['settings-panel'];
      p.style.display = p.style.display === 'none' ? '' : 'none';
    });
    E['settings-save'].addEventListener('click', function() {
      state.serverUrl = E['setting-url'].value.trim() || DEFAULT_URL;
      state.apiKey = E['setting-key'].value;
      state.streaming = E['setting-stream'].checked;
      save();
      checkHealth();
      E['settings-panel'].style.display = 'none';
    });

    E['test-connection-btn'].addEventListener('click', function() {
      var url = E['setting-url'].value.trim();
      if (!url) return;
      state.serverUrl = url; // Temporarily update to test
      checkHealth(true);
    });

    // Back
    E['back-btn'].addEventListener('click', function() { showView('threads'); });

    // Load earlier
    E['load-earlier-btn'].addEventListener('click', loadEarlier);

    // Send
    E['send-btn'].addEventListener('click', function() {
      var text = E['message-input'].value;
      if (text.trim()) {
        sendMessage(text.trim());
        E['message-input'].value = '';
        autoGrow();
      }
    });
    E['message-input'].addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        E['send-btn'].click();
      }
    });
    E['message-input'].addEventListener('input', autoGrow);
    E['message-input'].addEventListener('focus', function() {
      setTimeout(function() {
        E['message-input'].scrollIntoView({ behavior: 'instant', block: 'center' });
      }, 150);
    });
  }

  function autoGrow() {
    var el = E['message-input'];
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  // === INIT ===
  function init() {
    cacheDom();
    load();

    // Apply saved settings to UI
    E['setting-url'].value = state.serverUrl;
    E['setting-key'].value = state.apiKey;
    E['setting-stream'].checked = state.streaming;

    bindEvents();
    renderThreadsList();
    checkHealth();
    // Re-check health every 30s
    setInterval(checkHealth, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
