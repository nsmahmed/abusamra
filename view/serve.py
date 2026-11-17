"""Serve the project and the terrain tiles the 3D view needs.

Google and Esri imagery are requested by the browser directly. The terrain
tiles do not send a browser CORS header, so this server fetches them and
adds one. Run from anywhere:

    python view/serve.py          (port 8765)
    python view/serve.py 9000     (another port)
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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
        if path.startswith("/tiles/terrarium/"):
            self.proxy_tile(path, ".png", DEM_CACHE, DEM_URL, "image/png", "MalCust-AbuSamra/1.0")
            return
        super().do_GET()

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
    server.serve_forever()


if __name__ == "__main__":
    main()
