import http.server
import http.client
import socketserver
import urllib.parse
import threading
import os
import sys
import json
import sqlite3
from datetime import datetime
from pathlib import Path

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8644
HERMES_URL = os.environ.get("HERMES_URL", "http://localhost:8642")

def get_hermes_host():
    return urllib.parse.urlparse(HERMES_URL).netloc

def get_hermes_scheme():
    return urllib.parse.urlparse(HERMES_URL).scheme

def get_hermes_home():
    """Get the Hermes home directory."""
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))

def get_recent_sessions(limit=20, source_filter=None):
    """Query the Hermes session database for recent sessions."""
    db_path = get_hermes_home() / "state.db"
    if not db_path.exists():
        return []
    
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        
        query = """
            SELECT id, title, source, started_at, message_count, model
            FROM sessions
            ORDER BY started_at DESC
            LIMIT ?
        """
        params = [limit]
        
        if source_filter:
            query = """
                SELECT id, title, source, started_at, message_count, model
                FROM sessions
                WHERE source = ?
                ORDER BY started_at DESC
                LIMIT ?
            """
            params = [source_filter, limit]
        
        cursor = conn.cursor()
        cursor.execute(query, params)
        
        sessions = []
        for row in cursor.fetchall():
            r = dict(row)
            if r['started_at']:
                r['started_at_iso'] = datetime.fromtimestamp(r['started_at']).isoformat()
            if not r.get('title'):
                r['preview'] = f"Session {r['id'][:8]}..."
            sessions.append(r)
        
        conn.close()
        return sessions
    except Exception as e:
        print(f"[sessions] Error: {e}")
        return []

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    # Silence request logs to avoid noise (comment out to debug)
    def log_message(self, format, *args):
        print("  %s - %s" % (self.address_string(), format % args))

    def do_GET(self):
        if self.path.startswith("/v1/") or self.path in ("/health", "/v1/health"):
            self.proxy_request("GET")
        elif self.path == "/sessions" or self.path.startswith("/sessions?"):
            self.handle_sessions()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/v1/") or self.path in ("/health", "/v1/health"):
            self.proxy_request("POST")
        else:
            self.send_error(404)
    
    def handle_sessions(self):
        """Serve recent session list as JSON for the typewriter frontend."""
        # Require auth - same as completions API
        auth_header = self.headers.get('Authorization', '')
        expected_key = os.environ.get('API_SERVER_KEY', '')
        
        # Auth is REQUIRED - fail closed, not open
        # If no key is configured, still require the header to match empty string
        # (This prevents accidental unprotected endpoints in production)
        if not auth_header.startswith('Bearer ') or auth_header[7:] != expected_key:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Unauthorized'}).encode('utf-8'))
            return
        
        # Parse query params
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        limit = int(params.get('limit', [15])[0])
        source = params.get('source', [None])[0]
        
        sessions = get_recent_sessions(limit=limit, source_filter=source)
        
        response = {
            "sessions": sessions,
            "count": len(sessions),
            "timestamp": datetime.now().isoformat()
        }
        
        body = json.dumps(response, indent=2, default=str).encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

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
        
        # Inject API key from environment if not present in request
        if "Authorization" not in headers and "API_SERVER_KEY" in os.environ:
            headers["Authorization"] = "Bearer " + os.environ["API_SERVER_KEY"]
            
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

            content_type = res.getheader('Content-Type', '')
            is_sse = 'text/event-stream' in content_type

            if is_sse:
                # SSE: read line-by-line, flush after every complete event (\n\n)
                # This prevents all tokens from batching into one browser chunk.
                buf = b''
                while True:
                    byte = res.read(1)
                    if not byte:
                        break
                    buf += byte
                    # Flush on SSE event boundary (double newline)
                    if buf.endswith(b'\n\n'):
                        try:
                            self.wfile.write(buf)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        buf = b''
                # Flush any remainder
                if buf:
                    try:
                        self.wfile.write(buf)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            else:
                # Non-SSE: efficient 4096-byte chunks
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
        print(f"[*] Sessions endpoint: /sessions?limit=20&source=discord")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
