"""Serve the project and the terrain tiles the 3D view needs.

Google and Esri imagery are requested by the browser directly. The terrain
tiles do not send a browser CORS header, so this server fetches them and
adds one. Run from anywhere:

    python view/serve.py
"""

from __future__ import annotations

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
        self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/tiles/terrarium/"):
            self.proxy_dem(path)
            return
        super().do_GET()

    def proxy_dem(self, path: str) -> None:
        parts = [part for part in path.strip("/").split("/") if part]
        if len(parts) != 5 or not parts[4].endswith(".png"):
            self.send_error(404, "Bad terrain tile path")
            return
        z, x, y = parts[2], parts[3], parts[4][:-4]
        if not (z.isdigit() and x.lstrip("-").isdigit() and y.lstrip("-").isdigit()):
            self.send_error(404, "Bad terrain tile path")
            return
        cache = DEM_CACHE / z / x / f"{y}.png"
        try:
            if cache.exists() and cache.stat().st_size > 100:
                data = cache.read_bytes()
            else:
                url = DEM_URL.format(z=z, x=x, y=y)
                request = urllib.request.Request(url, headers={"User-Agent": "MalCust-AbuSamra/1.0"})
                with urllib.request.urlopen(request, timeout=40) as response:
                    data = response.read()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(data)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, f"Terrain tile unavailable ({exc.code})")
            return
        except Exception as exc:
            self.send_error(502, str(exc))
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Abu Samra map: http://127.0.0.1:{PORT}/view/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
