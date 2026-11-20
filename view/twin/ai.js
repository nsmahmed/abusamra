/* The twin's two AI services, reached through the local server (view/serve.py), which holds the
   keys. On a static host (GitHub Pages) the endpoints do not exist and both report "off"; every
   AI feature hides itself and the twin works as before.

   chat()   Azure OpenAI chat completions (the WASL assistant)
   decide() Microsoft Decision 1.1 /score: calibrated probabilities over named options */

const API = new URL("../../api/", import.meta.url).href;

export const ai = {
  status: { llm: false, decision: false },
  ready: null,

  check() {
    this.ready ??= fetch(API + "ai", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s && typeof s === "object") this.status = { ...this.status, ...s };
        return this.status;
      })
      .catch(() => this.status);
    return this.ready;
  },

  async post(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || data?.detail?.[0]?.msg || `AI service error ${r.status}`);
    return data;
  },

  chat(messages, tools) {
    return this.post("chat", { messages, tools });
  },

  decide(state, questions) {
    return this.post("decide", { state, questions });
  },
};
