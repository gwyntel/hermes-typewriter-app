import http.server
import http.client
import socketserver
import urllib.parse
import threading
import os
import sys
import json
import glob
from datetime import datetime
from pathlib import Path

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8643
HERMES_URL = os.environ.get("HERMES_URL", "http://localhost:8642")
SESSIONS_DIR = Path(os.environ.get("HERMES_SESSIONS_DIR", "~/.hermes/sessions")).expanduser()
API_KEY = os.environ.get("HERMES_API_KEY", "")
DEFAULT_TURNS = 15  # Number of turns to return by default

# --- SESSION HELPERS ---
def parse_session_filename(filename):
    """Parse session filename to extract metadata.
    Format: YYYYMMDD_HHMMSS_<id>.jsonl"""
    stem = Path(filename).stem
    basename = Path(filename).name  # Keep the .jsonl extension
    parts = stem.split("_")
    if len(parts) >= 3:
        date_str = parts[0]
        time_str = parts[1]
        session_id = "_".join(parts[2:])
        try:
            started_at = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
            return {
                "id": basename,  # Include .jsonl for correct URL construction
                "session_id": session_id,
                "started_at_iso": started_at.isoformat(),
                "started_at_unix": started_at.timestamp()
            }
        except ValueError:
            pass
    return {"id": basename, "session_id": stem, "started_at_iso": None, "started_at_unix": 0}

def read_session_messages(session_file, turns=DEFAULT_TURNS):
    """Read messages from a JSONL session file."""
    all_entries = []
    tool_outputs = {}  # Map tool_call_id -> output content
    
    try:
        with open(session_file, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    # Skip session_meta entries
                    if entry.get("role") == "session_meta":
                        continue
                    
                    # Collect tool outputs separately
                    if entry.get("role") == "tool":
                        tool_call_id = entry.get("tool_call_id")
                        if tool_call_id:
                            # Truncate tool output for display
                            output = entry.get("content", "")
                            if len(output) > 200:
                                output = output[:200] + "..."
                            tool_outputs[tool_call_id] = output
                        continue
                    
                    all_entries.append(entry)
                except json.JSONDecodeError as e:
                    print(f"  [session parse error] Line {line_num}: {e}")
                    continue
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"  [session read error] {e}")
        return []
    
    # Process entries and merge tool outputs into assistant messages
    messages = []
    for entry in all_entries:
        msg = {
            "role": entry.get("role", "unknown"),
            "content": entry.get("content", ""),
            "timestamp": entry.get("timestamp", ""),
            "tools": []
        }
        
        # Handle assistant messages with tool calls
        if entry.get("role") == "assistant" and entry.get("tool_calls"):
            for tc in entry.get("tool_calls", []):
                fn = tc.get("function", {})
                tool_name = fn.get("name", "unknown")
                tool_args = fn.get("arguments", "")
                tool_id = tc.get("id", "")
                
                # Truncate args for display
                if isinstance(tool_args, str) and len(tool_args) > 50:
                    tool_args = tool_args[:50] + "..."
                
                # Get tool output if available
                tool_output = tool_outputs.get(tool_id, "")
                
                msg["tools"].append({
                    "name": tool_name,
                    "args": tool_args,
                    "output": tool_output
                })
        
        messages.append(msg)
    
    # Return last N turns (user+assistant pairs count as turns)
    # For simplicity, return last N*2 messages to cover turn pairs
    if len(messages) > turns * 2:
        messages = messages[-(turns * 2):]
    
    return messages

def get_session_preview(session_file):
    """Extract title and preview from first user message."""
    title = ""
    preview = ""
    try:
        with open(session_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get("role") == "user" and entry.get("content"):
                        content = entry.get("content", "")
                        # Title: first 50 chars, stripped
                        title = content[:50].strip().replace('\n', ' ')
                        # Preview: first 100 chars
                        preview = content[:100].strip().replace('\n', ' ')
                        break
                except:
                    continue
    except:
        pass
    return title, preview

def list_sessions(limit=50, source=None):
    """List all available sessions, optionally filtered by source."""
    sessions = []
    pattern = str(SESSIONS_DIR / "*.jsonl")
    
    for filepath in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
        meta = parse_session_filename(filepath)
        
        # Get message count and detect source
        msg_count = 0
        detected_source = None
        detected_model = None
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        if entry.get("role") == "session_meta":
                            detected_source = entry.get("platform", "unknown")
                            detected_model = entry.get("model", "unknown")
                        elif entry.get("role") in ("user", "assistant"):
                            msg_count += 1
                    except:
                        continue
        except:
            continue
        
        # Get title and preview from first user message
        title, preview = get_session_preview(filepath)
        
        meta["message_count"] = msg_count
        meta["source"] = detected_source or "unknown"
        meta["model"] = detected_model
        meta["title"] = title
        meta["preview"] = preview
        
        # Filter by source if requested
        if source and meta["source"] != source:
            continue
        
        sessions.append(meta)
        
        if len(sessions) >= limit:
            break
    
    return sessions

def check_auth(headers):
    """Check if request has valid API key."""
    if not API_KEY:
        return True  # No auth required if no key set
    auth_header = headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:] == API_KEY
    return headers.get("X-API-Key") == API_KEY

def get_hermes_host():
    return urllib.parse.urlparse(HERMES_URL).netloc

def get_hermes_scheme():
    return urllib.parse.urlparse(HERMES_URL).scheme

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    # Silence request logs to avoid noise (comment out to debug)
    def log_message(self, format, *args):
        print("  %s - %s" % (self.address_string(), format % args))

    def send_json(self, data, status=200):
        """Helper to send JSON responses."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def do_GET(self):
        # Block config.js for security (info disclosure)
        if self.path == '/config.js' or self.path == '/config':
            self.send_error(404, 'Not found')
            return
        
        # Check auth for session endpoints
        if self.path.startswith("/sessions"):
            if not check_auth(self.headers):
                self.send_json({"error": "Unauthorized"}, 401)
                return
            
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            path_parts = parsed.path.strip("/").split("/")
            
            # /sessions - list all sessions
            if path_parts == ["sessions"]:
                limit = int(query.get("limit", [50])[0])
                source = query.get("source", [None])[0]
                sessions = list_sessions(limit=limit, source=source)
                self.send_json({"sessions": sessions, "total": len(sessions)})
                return
            
            # /sessions/:id/messages - get messages for a session
            if len(path_parts) == 3 and path_parts[1].endswith(".jsonl") and path_parts[2] == "messages":
                session_id = path_parts[1]
                turns = int(query.get("turns", [DEFAULT_TURNS])[0])
                session_file = SESSIONS_DIR / f"{session_id}"
                if not session_file.exists():
                    self.send_json({"error": "Session not found"}, 404)
                    return
                messages = read_session_messages(session_file, turns=turns)
                self.send_json({"session_id": session_id, "messages": messages, "turns": turns})
                return
            
            # /sessions/:id - get session info
            if len(path_parts) == 2 and path_parts[1].endswith(".jsonl"):
                session_id = path_parts[1]
                session_file = SESSIONS_DIR / f"{session_id}"
                if not session_file.exists():
                    self.send_json({"error": "Session not found"}, 404)
                    return
                meta = parse_session_filename(session_file)
                messages = read_session_messages(session_file, turns=1)  # Just peek
                meta["message_count"] = len(read_session_messages(session_file, turns=1000))
                self.send_json(meta)
                return
            
            self.send_json({"error": "Invalid session endpoint"}, 400)
            return
        
        # Proxy other requests
        if self.path.startswith("/v1/") or self.path in ("/health", "/v1/health"):
            self.proxy_request("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/v1/") or self.path in ("/health", "/v1/health"):
            self.proxy_request("POST")
        else:
            self.send_error(404)

    def proxy_request(self, method):
        hermes_host = get_hermes_host()
        hermes_scheme = get_hermes_scheme()

        # Normalize path: strip /v1 prefix duplication if any
        path = self.path
        if path == "/v1/health":
            path = "/health"

        # Forward relevant headers, add auth passthrough
        skip = {"host", "connection", "accept-encoding", "transfer-encoding"}
        headers = {k: v for k, v in self.headers.items() if k.lower() not in skip}
        headers["Host"] = hermes_host

        body = None
        if method == "POST":
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length else None

        try:
            if hermes_scheme == "https":
                conn = http.client.HTTPSConnection(hermes_host, timeout=120)
            else:
                conn = http.client.HTTPConnection(hermes_host, timeout=120)

            conn.request(method, path, body, headers)
            res = conn.getresponse()

            # Forward response headers
            self.send_response(res.status)
            skip_resp = {"transfer-encoding", "content-encoding", "connection", "keep-alive"}
            for k, v in res.getheaders():
                if k.lower() not in skip_resp:
                    self.send_header(k, v)
            # Ensure connection closes cleanly
            self.send_header("Connection", "close")
            self.end_headers()

            # Stream response body in chunks
            while True:
                chunk = res.read(4096)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break

            conn.close()

        except (ConnectionRefusedError, OSError) as e:
            print(f"  [proxy error] {e}")
            try:
                self.send_error(502, f"Cannot reach Hermes at {HERMES_URL}: {e}")
            except Exception:
                pass


# Use threading so long-running SSE/streaming requests don't block
class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    with ThreadedHTTPServer(("", PORT), ProxyHandler) as httpd:
        print(f"[*] Hermes Proxy Server running on port {PORT}")
        print(f"[*] Proxying /v1/* and /health to {HERMES_URL}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
