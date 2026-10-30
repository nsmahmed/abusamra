"""HTTP helpers with retries. Overpass and the elevation bucket are public and rate-limited."""

from __future__ import annotations

import time
import urllib.error
import urllib.parse
import urllib.request

from abu_samra.config import USER_AGENT

RETRY_STATUS = {429, 500, 502, 503, 504}


def _request(req: urllib.request.Request, timeout: float, attempts: int) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in RETRY_STATUS or attempt == attempts - 1:
                raise
            delay = _retry_delay(exc, attempt)
            print(f"[abu-samra] HTTP {exc.code} from {req.full_url}; retrying in {delay:.0f}s")
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last_error = exc
            if attempt == attempts - 1:
                raise
            delay = 5 * (attempt + 1)
            print(f"[abu-samra] {type(exc).__name__} from {req.full_url}; retrying in {delay:.0f}s")
            time.sleep(delay)
    raise RuntimeError(f"request failed: {last_error}")


def _retry_delay(exc: urllib.error.HTTPError, attempt: int) -> float:
    header = exc.headers.get("Retry-After") if exc.headers else None
    if header:
        try:
            return max(1.0, float(header))
        except ValueError:
            pass
    return float(10 * (attempt + 1))


def get_bytes(url: str, timeout: float = 180, attempts: int = 3) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return _request(req, timeout, attempts)


def post_form(url: str, fields: dict[str, str], timeout: float = 180, attempts: int = 3) -> bytes:
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "Accept": "application/json",
        },
    )
    return _request(req, timeout, attempts)
