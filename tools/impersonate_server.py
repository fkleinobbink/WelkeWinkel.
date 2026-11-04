# Kleine lokale proxy die verzoeken doet met de TLS-vingerafdruk van een echte browser (curl_cffi).
# De Node-crawler gebruikt hem voor winkels met engine "impersonate".
#   python3 tools/impersonate_server.py 8765
# POST /fetch  {"url": "...", "method": "GET", "headers": {}, "body": null, "impersonate": "chrome", "timeout": 30}
import json, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from curl_cffi import requests as cr

# Pool van hergebruikte sessies per browserprofiel: houdt TLS-verbindingen en cookies vast
# (voorheen nieuwe sessie per verzoek = elke keer een nieuwe TLS-handshake, erg traag).
import queue
POOLS = {}
POOL_LOCK = threading.Lock()

def pool(imp):
    with POOL_LOCK:
        if imp not in POOLS:
            q = queue.Queue()
            for _ in range(8):
                q.put(cr.Session(impersonate=imp))
            POOLS[imp] = q
        return POOLS[imp]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n))
        try:
            q = pool(req.get("impersonate") or "chrome")
            s = q.get()
            try:
                r = s.request(req.get("method") or "GET", req["url"], headers=req.get("headers") or {}, data=req.get("body"),
                              timeout=req.get("timeout") or 30, allow_redirects=True)
            finally:
                q.put(s)
            body = r.content
            self.send_response(200)
            self.send_header("x-status", str(r.status_code))
            self.send_header("x-final-url", r.url)
            ct = r.headers.get("content-type")
            if ct:
                self.send_header("x-content-type", ct)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            msg = str(e).encode()[:2000]
            self.send_response(599)
            self.send_header("content-length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
