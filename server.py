import http.server
import http.client
import socketserver
import urllib.parse
import threading
import os
import sys

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8643
HERMES_URL = os.environ.get("HERMES_URL", "http://localhost:8642")

def get_hermes_host():
    return urllib.parse.urlparse(HERMES_URL).netloc

def get_hermes_scheme():
    return urllib.parse.urlparse(HERMES_URL).scheme

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    # Silence request logs to avoid noise (comment out to debug)
    def log_message(self, format, *args):
        print("  %s - %s" % (self.address_string(), format % args))

    def do_GET(self):
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
