"""Serve the project, the terrain tiles the 3D view needs, and the twin's AI endpoints.

Google and Esri imagery are requested by the browser directly. The terrain
tiles do not send a browser CORS header, so this server fetches them and
adds one. Run from anywhere:

    python view/serve.py          (port 8765)
    python view/serve.py 9000     (another port)
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ai_proxy import MAX_BODY, AzureAI  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
AI = AzureAI(ROOT / ".env")
DEM_CACHE = ROOT / "data" / "cache" / "terrarium"
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
PORT = 8765


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        tiles = self.path.startswith("/tiles/")
        self.send_header("Cache-Control", "public, max-age=86400" if tiles else "no-cache")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ai":
            self.send_json(200, json.dumps(AI.status()).encode())
            return
        if path.startswith("/tiles/terrarium/"):
            self.proxy_tile(path, ".png", DEM_CACHE, DEM_URL, "image/png", "MalCust-AbuSamra/1.0")
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/chat", "/api/decide"):
            self.send_error(404, "Not found")
            return
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BODY:
            self.send_json(413, b'{"error":{"message":"Request too large"}}')
            return
        try:
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, b'{"error":{"message":"Invalid JSON"}}')
            return
        status, body = AI.chat(payload) if path == "/api/chat" else AI.decide(payload)
        self.send_json(status, body)

    def send_json(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_tile(self, path: str, ext: str, cache_dir: Path, source: str, mime: str, agent: str) -> None:
        parts = [part for part in path.strip("/").split("/") if part]
        if len(parts) != 5 or not parts[4].endswith(ext):
            self.send_error(404, "Bad tile path")
            return
        z, x, y = parts[2], parts[3], parts[4][: -len(ext)]
        if not (z.isdigit() and x.isdigit() and y.isdigit()):
            self.send_error(404, "Bad tile path")
            return
        cache = cache_dir / z / x / f"{y}{ext}"
        try:
            if cache.exists() and cache.stat().st_size > 100:
                data = cache.read_bytes()
            else:
                url = source.format(z=z, x=x, y=y)
                request = urllib.request.Request(url, headers={"User-Agent": agent})
                with urllib.request.urlopen(request, timeout=40) as response:
                    data = response.read()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(data)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, f"Tile unavailable ({exc.code})")
            return
        except Exception as exc:
            self.send_error(502, str(exc))
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Abu Samra map:  http://127.0.0.1:{port}/view/", flush=True)
    print(f"Digital twin:   http://127.0.0.1:{port}/view/twin/", flush=True)
    ai = AI.status()
    print(f"AI services:    assistant {'on' if ai['llm'] else 'off'} · decision model {'on' if ai['decision'] else 'off'} (keys from .env)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
