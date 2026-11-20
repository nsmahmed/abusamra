"""Server-side calls to the Azure AI services used by the twin.

The browser never sees a key. It posts to the local server, which adds the key from .env (kept
out of git) and forwards only two kinds of request:

    /api/chat    the WASL assistant: chat completions with tool definitions, fixed model
    /api/decide  fact check: Microsoft Decision 1.1 (/v1/systemone), fixed model

Nothing about real trucks is sent: the browser sends the user's question and the outputs of the
calibrated port model (aggregates and scenario results). Without a .env the endpoints report that
AI is off and the twin works as before.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

MAX_BODY = 400_000
MAX_TOKENS = 2000


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


class AzureAI:
    def __init__(self, env_path: Path):
        env = load_env(env_path)
        self.key = env.get("AZURE_API_KEY", "")
        self.llm_base = env.get("AZURE_LLM_BASE_URL", "").rstrip("/")
        self.llm_model = env.get("AZURE_LLM_MODEL", "")
        self.dec_base = env.get("AZURE_DECISION_BASE_URL", "").rstrip("/")
        self.dec_model = env.get("AZURE_DECISION_MODEL", "")

    def status(self) -> dict:
        return {
            "llm": bool(self.key and self.llm_base and self.llm_model),
            "decision": bool(self.key and self.dec_base and self.dec_model),
            "llmModel": self.llm_model or None,
            "decisionModel": self.dec_model or None,
        }

    def _post(self, url: str, body: dict, timeout: int = 90) -> tuple[int, bytes]:
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", "api-key": self.key, "Authorization": f"Bearer {self.key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()
        except Exception as exc:  # network, timeout
            return 502, json.dumps({"error": {"message": f"AI service unreachable: {exc.__class__.__name__}"}}).encode()

    def chat(self, payload: dict) -> tuple[int, bytes]:
        if not self.status()["llm"]:
            return 503, b'{"error":{"message":"Assistant not configured (.env)"}}'
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 60:
            return 400, b'{"error":{"message":"messages must be a list of 1-60 items"}}'
        body = {"model": self.llm_model, "messages": messages, "max_completion_tokens": MAX_TOKENS}
        tools = payload.get("tools")
        if isinstance(tools, list) and tools:
            body["tools"] = tools[:20]
            body["tool_choice"] = "auto"
        return self._post(f"{self.llm_base}/chat/completions", body)

    def decide(self, payload: dict) -> tuple[int, bytes]:
        if not self.status()["decision"]:
            return 503, b'{"error":{"message":"Decision model not configured (.env)"}}'
        state = payload.get("state")
        questions = payload.get("questions")
        if not isinstance(state, str) or not state or len(state) > 60_000 or not isinstance(questions, dict) or not 1 <= len(questions) <= 10:
            return 400, b'{"error":{"message":"state (text) and 1-10 questions required"}}'
        return self._post(f"{self.dec_base}/v1/systemone", {"model": self.dec_model, "state": state, "questions": questions}, timeout=60)
