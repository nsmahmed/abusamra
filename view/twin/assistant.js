/* Ask WASL: a question box for the twin, in Arabic or English.

   The language model (Azure OpenAI, through view/serve.py) does not know the port and does not
   produce numbers. It reads the question, calls the twin's own functions as tools (the
   calibrated port model, the goal seek, the camera) and explains what they return. Every figure
   in an answer comes from a tool result; the tool calls are listed under each answer.

   What is sent to the service: the conversation and the tool results, which are model outputs
   and aggregates. No real truck, plate or declaration exists in the browser to send. */

import { ai } from "./ai.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const NAME = {
  xray: "X-ray lanes", chem: "Chemical & Others docks", oga: "OGA docks", health: "Health & Food docks", parking: "main parking",
  gate: "waiting at the entry gate (parking full)", decl: "declaration and paperwork", xq: "X-ray queue and scan", iq: "waiting for inspection", insp: "physical inspection", exit: "release and exit",
  night: "trucks arriving at night (22:00-06:00)", afternoon: "trucks arriving 13:00-15:00",
};
const CAT_NAME = { chem: "Chemical & Others goods", oga: "OGA goods (need another government authority)", health: "Health & Food goods" };
const nm = (k) => NAME[k] || CAT_NAME[k] || k;
/* goods categories, as opposed to the docks that inspect them */
const goods = (k) => CAT_NAME[k] || NAME[k] || k;
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : null);

const SCENARIO_PROPS = {
  year: { type: "integer", enum: [2026, 2027, 2028, 2029, 2030], description: "Demand year. 2026 is today; later years apply the learned growth." },
  load_increase_pct: { type: "number", description: "Extra trucks on top of the year's demand, in percent (e.g. 16 for a week like the busiest of 2026)." },
  xray_lanes: { type: "integer", description: "Drive-through X-ray lanes (today 2)." },
  inspection_docks: { type: "integer", description: "Import inspection docks in total (today 130)." },
  parking_bays: { type: "integer", description: "Main parking bays (today 700)." },
  shift_overlap: { type: "boolean", description: "Overlap inspector shift handovers so inspection does not collapse at 06:00, 13:00 and 21:00." },
  dock_split: { type: "string", enum: ["today", "smart"], description: "How docks are shared between the goods categories: today's split, or the smart split sized to each category's load." },
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "port_status",
      description: "Key figures for today's port, or for the scenario currently shown in the twin: time in port (median, P90, share over 12 h), trucks per day, sustainable capacity, the bottleneck and who is stuck there, how busy each resource is, time at each stage, median by goods category.",
      parameters: { type: "object", properties: { which: { type: "string", enum: ["today", "current"], description: "today = no change; current = the scenario on screen." } }, required: ["which"] },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate_scenario",
      description: "Run a what-if through the calibrated port model without changing the screen. Unspecified settings stay at today's values. Returns the scenario's figures and the same figures with no change under the same demand.",
      parameters: { type: "object", properties: SCENARIO_PROPS },
    },
  },
  {
    type: "function",
    function: {
      name: "show_scenario",
      description: "Put a scenario on screen: the planner and the 3D twin switch to it and the camera visits each change. Use when the user asks to see or apply something.",
      parameters: { type: "object", properties: SCENARIO_PROPS },
    },
  },
  {
    type: "function",
    function: {
      name: "find_plans",
      description: "Goal seek: search combinations of X-ray lanes, docks, parking and shift overlap for plans that reach a target time in port, cost each one, then test them in 9 futures (demand low/expected/high x how much of the waiting capacity can remove). Returns the cheapest, resilient and best-result plans and the robust choice. Takes a few seconds and opens the planner.",
      parameters: {
        type: "object",
        properties: {
          target_hours: { type: "number", description: "Target time in port in hours." },
          measure: { type: "string", enum: ["median", "p90"] },
          year: { type: "integer", enum: [2026, 2030] },
        },
        required: ["target_hours"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_place",
      description: "Fly the 3D camera to a place in the port.",
      parameters: { type: "object", properties: { place: { type: "string", enum: ["overview", "gates", "parking", "xray", "ramps", "booths", "chemical_docks", "oga_docks", "health_docks"] } }, required: ["place"] },
    },
  },
  {
    type: "function",
    function: {
      name: "about_the_model",
      description: "What the twin's numbers rest on: the data behind them, the learned models (synthetic trucks, delay-risk model and its accuracy), the main assumptions and their values, and what is synthetic.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const SYSTEM = (lang) => `You are WASL, the assistant inside the digital twin of Abu Samra land port (Qatar's land border with Saudi Arabia), run by the General Authority of Customs. You help executives and planners understand the port and test decisions.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent figures, costs or dates. If no tool gives it, say the twin does not model it.
- The figures are from a calibrated planning model built on 2026 data; trucks on screen are synthetic. Say "the model expects" for scenarios, not "will".
- Assumptions matter: when you give a forecast or a plan, name the main assumption it rests on (growth to 2030, or how much of the waiting capacity can remove) if the tool reports it.
- Prefer showing over telling: when the user asks to see something, or an answer is about a place or a scenario, call show_place or show_scenario.
- Executive style: lead with the answer in one sentence, then at most 3 short bullets. Under 70 words. No headings, no preamble, no offers of further help. Hours with one decimal.
- Demand: use today (year 2026) unless the user names a year. "Traffic grows X%" means load_increase_pct = X on today's demand.
- When you show a scenario, quote the figures of that same scenario; do not mix in figures from a different year or setting.
- Report what the data shows; do not add causes or explanations the tool results do not contain.
- For a what-if, compare it with no change under the same demand (both are in the tool result).
- Use the human names the tools give, never internal ids. Keep stages (e.g. declaration and paperwork), resources (e.g. Chemical & Others docks) and goods categories distinct; do not merge them in one claim.
- "AUC" is not accuracy: it is how well the model ranks a slow truck above a fast one (0.5 = chance, 1 = perfect). Say so if asked about accuracy.
- You cannot see individual real trucks or declarations; there are none in the twin.`;

export function mountAssistant(api) {
  const btn = document.getElementById("ask-btn");
  const root = document.getElementById("ask");
  if (!btn || !root) return null;
  const T = (en, ar) => (api.lang() === "ar" ? ar : en);
  const history = [];
  let busy = false;

  root.innerHTML = `
    <header class="ask-h"><div><b>Ask WASL</b> <span class="ai-tag">AI</span><small id="ask-sub"></small></div><button type="button" class="ib" id="ask-x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
    <div class="ask-log" id="ask-log"></div>
    <div class="ask-sugg" id="ask-sugg"></div>
    <form class="ask-in" id="ask-form"><textarea id="ask-q" rows="1" maxlength="600"></textarea><button type="submit" id="ask-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button></form>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const log = $("ask-log");

  const paintStatic = () => {
    $("ask-sub").textContent = T("Answers from the port model · fact-checked", "إجابات من نموذج المنفذ · مُتحقق منها");
    $("ask-q").placeholder = T("Ask a question…", "اطرح سؤالًا…");
    const sugg = api.lang() === "ar"
      ? ["أين عنق الزجاجة اليوم؟", "ماذا لو زادت الشاحنات 20% مع مسار أشعة إضافي؟", "خطط تبقي 2030 عند 6 ساعات", "على ماذا تعتمد الأرقام؟"]
      : ["Where is the bottleneck today?", "+20% trucks and one more X-ray lane?", "Plans to keep 2030 at 6 hours", "What are the numbers based on?"];
    $("ask-sugg").innerHTML = history.length ? "" : sugg.map((q) => `<button type="button">${esc(q)}</button>`).join("");
    $("ask-sugg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
    root.dir = api.lang() === "ar" ? "rtl" : "ltr";
  };

  /* ---------- tools: thin wrappers over the twin ---------- */
  const pm = api.pm;
  const stateFrom = (a = {}) => {
    const t = pm.today;
    const lim = pm.limits();
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));
    const s = { ...t, alloc: { ...t.alloc } };
    if (Number.isFinite(a.year)) s.year = Math.min(2030, Math.max(2026, a.year));
    if (Number.isFinite(a.load_increase_pct)) s.surge = Math.max(0, Math.min(lim.surge[1], a.load_increase_pct));
    if (Number.isFinite(a.xray_lanes)) s.xray = clamp(a.xray_lanes, lim.xray);
    if (Number.isFinite(a.inspection_docks)) s.docks = clamp(a.inspection_docks, lim.docks);
    if (Number.isFinite(a.parking_bays)) s.parking = clamp(a.parking_bays, lim.parking);
    if (typeof a.shift_overlap === "boolean") s.overlap = a.shift_overlap ? 1 : 0;
    if (a.dock_split === "smart") s.alloc = pm.smartAlloc(s.docks, s);
    else if (s.docks !== t.docks) {
      const k = s.docks / t.docks;
      const keys = Object.keys(t.alloc);
      keys.forEach((c) => (s.alloc[c] = Math.max(2, Math.round(t.alloc[c] * k))));
      s.alloc[keys[0]] += s.docks - keys.reduce((n, c) => n + s.alloc[c], 0);
    }
    const clipped = [];
    if (Number.isFinite(a.xray_lanes) && s.xray !== a.xray_lanes) clipped.push(`X-ray lanes limited to ${s.xray}`);
    if (Number.isFinite(a.inspection_docks) && s.docks !== a.inspection_docks) clipped.push(`docks limited to ${s.docks}`);
    if (Number.isFinite(a.parking_bays) && s.parking !== a.parking_bays) clipped.push(`parking limited to ${s.parking}`);
    return { s, clipped };
  };
  const figures = (r) => ({
    trucks_per_day: r0(r.lamDay),
    median_time_in_port_h: r1(r.median),
    p90_time_in_port_h: r1(r.p90),
    over_12h_pct: r1(r.over12),
    sustainable_trucks_per_day: r0(r.capacity),
    capacity_limited_by: nm(r.limit),
    queues_grow_without_limit: !!r.unstable,
    parking_peak_occupancy_pct: r0((r.peakYard / r.s.parking) * 100),
  });
  const detail = (r) => ({
    ...figures(r),
    bottleneck: r.bottleneck && {
      stage_with_most_truck_hours: nm(r.bottleneck.stage),
      share_of_all_truck_hours_pct: r0(r.bottleneck.share),
      busiest_resource: nm(r.bottleneck.resource),
      busiest_resource_load_pct: r0(r.bottleneck.util * 100),
      over_represented_among_slowest_quarter_at_that_stage: (r.bottleneck.pattern || []).slice(0, 3).map((p) => ({ group: goods(p.key), times_over_represented: r1(p.lift), share_of_slowest_pct: r0(p.inSlow), share_of_all_trucks_pct: r0(p.overall) })),
    },
    resource_load_pct: Object.fromEntries(Object.entries(r.util || {}).map(([k, v]) => [nm(k), r0(v * 100)])),
    stage_median_minutes: Object.fromEntries(Object.entries(r.stages || {}).map(([k, v]) => [nm(k), r0(v.median)])),
    median_time_in_port_h_by_goods_category: Object.fromEntries(Object.entries(r.byCat || {}).map(([k, v]) => [goods(k), r1(v)])),
  });
  const settings = (s) => ({ year: s.year, load_increase_pct: s.surge, xray_lanes: s.xray, inspection_docks: s.docks, docks_by_goods_category: Object.fromEntries(Object.entries(s.alloc).map(([k, v]) => [goods(k), v])), parking_bays: s.parking, shift_overlap: !!s.overlap });

  const run = {
    port_status({ which }) {
      const s = which === "current" ? api.planner.state : pm.today;
      return { which, settings: settings(s), ...detail(pm.evaluate(s)) };
    },
    evaluate_scenario(a) {
      const { s, clipped } = stateFrom(a);
      const r = pm.evaluate(s);
      const base = pm.evaluate({ ...pm.today, year: s.year, surge: s.surge });
      return { settings: settings(s), clipped_to_limits: clipped, scenario: detail(r), no_change_settings: settings({ ...pm.today, year: s.year, surge: s.surge }), no_change_same_demand: detail(base), today_2026: figures(pm.baseRun) };
    },
    show_scenario(a) {
      const { s, clipped } = stateFrom(a);
      api.showScenario(s);
      const base = pm.evaluate({ ...pm.today, year: s.year, surge: s.surge });
      return { shown_on_screen: true, settings: settings(s), clipped_to_limits: clipped, scenario: detail(pm.evaluate(s)), no_change_settings: settings({ ...pm.today, year: s.year, surge: s.surge }), no_change_same_demand: detail(base), today_2026: figures(pm.baseRun) };
    },
    async find_plans({ target_hours, measure = "median", year = 2030 }) {
      const g = await api.findPlans(target_hours, measure, year);
      const rb = g.robust;
      const row = (s) => rb && rb.rows.find((x) => JSON.stringify(x.s) === JSON.stringify(s));
      const plan = (name, p) => {
        const r = row(p.s);
        return { name, adds: (p.items || []).map((i) => i.label), five_year_cost_qar_million: r1(p.cost / 1e6), in_service_months: p.lead, expected_h: r1(p.value), busy_week_h: r1(p.stress), reaches_goal_in_futures: r ? `${r.held} of ${rb.futures.length}` : null, worst_case_h: r ? r1(r.worst) : null };
      };
      return {
        target_h: target_hours, measure, year, plans_searched: g.searched, plans_reaching_goal: g.feasible, goal_reachable: g.reached,
        plans: g.plans.map((p) => plan(p.name, p)),
        robust_choice: rb ? { ...plan("Robust choice", { ...rb.pick, value: rb.pick.expected }), rule: "cheapest plan that reaches the goal in the most futures" } : null,
        no_change: rb ? { expected_h: r1(rb.rows[0].expected), reaches_goal_in_futures: `${rb.rows[0].held} of ${rb.futures.length}` } : null,
        futures_tested: rb ? rb.futures.map((f) => `${f.demand.label} / ${f.kappa.label}`) : [],
        note: "Costs are unit-cost benchmarks from config.json, not procurement figures.",
      };
    },
    show_place({ place }) {
      api.showPlace(place);
      return { shown: place };
    },
    about_the_model() {
      const L = pm.L;
      const c = pm.cfg.model || {};
      return {
        data: "GAC 2026 gate-pass data and 2022-2026 food/OGA declaration extracts: 198,665 commercial trucks; 'today' is the last 90 days.",
        today_median_h: r1(L.current?.kpis?.medianStayH ?? pm.baseRun.median),
        learned_models: {
          synthetic_trucks: "Gaussian mixture models per goods category and X-ray, fitted to the real stage times; every truck on screen is synthetic, none is a real one.",
          delay_risk: L.risk
            ? {
                question: "will a truck stay over 8 hours",
                method: "gradient-boosted decision trees",
                trained_on: `${(L.risk.trainTrucks || 0).toLocaleString("en")} trucks that arrived before the last 60 days`,
                tested_on: `${(L.risk.testTrucks || 0).toLocaleString("en")} trucks from the last 60 days, never seen in training`,
                auc: L.risk.auc,
                auc_meaning: "not accuracy: the chance the model ranks a truck that overstayed above one that did not (0.5 = coin flip, 1 = perfect). 0.70 is useful for triage, not for predicting a single truck.",
                base_rate_pct: r0(L.risk.baseRate * 100),
                strongest_factors: (L.risk.importance || []).slice(0, 4).map((i) => i.feature),
              }
            : null,
        },
        what_if_engine: "Queueing model (M/M/c, hour by hour) calibrated so it reproduces today's real waits.",
        assumptions: {
          congestion_share: { value: c.congestionShare, meaning: "share of today's X-ray and dock waiting that more capacity can remove; the rest is process (paperwork, agency review)" },
          growth_to_2030: { learned_cagr_pct: r0(pm.cagr * 100), damping: pm.damping, factor_2030: r1(pm.growthFactor(2030)) },
          costs: "public unit-cost benchmarks in config.json, not GAC procurement figures",
        },
      };
    },
  };

  /* ---------- the conversation ---------- */
  const md = (text) =>
    esc(text)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/^\s*[-•]\s+(.*)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>");
  const TOOL_LABEL = {
    port_status: ["Port figures", "أرقام المنفذ"],
    evaluate_scenario: ["What-if", "ماذا لو"],
    show_scenario: ["Scenario shown", "عرض السيناريو"],
    find_plans: ["Plans", "الخطط"],
    show_place: ["Camera", "الكاميرا"],
    about_the_model: ["Model basis", "أساس النموذج"],
  };

  /* ---------- fact check: Microsoft Decision 1.1 gates every answer that states figures ----------
     The language model writes; the decision model judges one yes/no question: does every number
     and fact in the answer match the model's tool results? It sees the same tool results the
     language model saw (this answer's and the last few turns'), so an invented or misattributed
     figure is caught. Thresholds were set on test answers with planted errors: correct answers
     scored 0.74-0.98; wrong, invented, swapped or misattributed figures 0.001-0.03. Verified is
     0.6 and above, "Check figures" 0.3-0.6, "Not verified" below 0.3. */
  const evidence = [];
  const CHECK = {
    type: "noul",
    criteria: {
      true: "Every number stated in the answer appears in the tool results for the same quantity and the same scenario (rounding allowed), or is simple arithmetic on them.",
      false: "At least one number in the answer is absent from the tool results, differs from them beyond rounding, or is given for the wrong quantity or scenario.",
    },
  };
  const badge = (p) => {
    if (p == null) return `<span class="ask-chk wait">${T("Checking…", "جارٍ التحقق…")}</span>`;
    const pct = Math.round(p * 100);
    const tip = T(`Microsoft Decision 1.1: figures match the model (${pct}%)`, `Microsoft Decision 1.1: تطابق الأرقام مع النموذج (${pct}%)`);
    if (p >= 0.6) return `<span class="ask-chk ok" title="${esc(tip)}">✓ ${T("Verified", "تم التحقق")}</span>`;
    if (p >= 0.3) return `<span class="ask-chk mid" title="${esc(tip)}">◐ ${T("Check figures", "راجع الأرقام")}</span>`;
    return `<span class="ask-chk bad" title="${esc(tip)}">⚠ ${T("Not verified", "غير مؤكد")}</span>`;
  };
  async function factCheck(answer, footer, fresh) {
    if (!ai.status.decision || !/[\d٠-٩]/.test(answer)) {
      footer.querySelector(".ask-chk")?.remove();
      return;
    }
    /* the results this answer was written from: this question's tools, else the recent ones,
       flattened to one "quantity = value" line each, which the decision model reads far more
       reliably than nested JSON */
    const basis = fresh.length ? fresh : evidence.slice(-3);
    const flat = (o, pre, out) => {
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) flat(v, Array.isArray(o) ? `${pre} #${Number(k) + 1}` : `${pre}${pre ? " › " : ""}${k.replace(/_/g, " ")}`, out);
      } else out.push(`${pre} = ${o}`);
      return out;
    };
    const lines = basis.flatMap((b) => flat(b.result, "", []).map((l) => `[${b.tool}] ${l}`));
    let facts = lines.join("\n");
    if (facts.length > 50000) facts = facts.slice(0, 50000);
    const state = `TOOL RESULTS (facts from the port model):\n${facts}\n\nANSWER TO CHECK:\n${answer}`;
    try {
      const res = await ai.decide(state, { grounded: CHECK });
      footer.querySelector(".ask-chk").outerHTML = badge(res.answers.grounded.noul);
    } catch {
      footer.querySelector(".ask-chk")?.remove();
    }
  }
  const add = (cls, html) => {
    const el = document.createElement("div");
    el.className = `ask-m ${cls}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  async function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    $("ask-q").value = "";
    $("ask-sugg").innerHTML = "";
    add("me", esc(text));
    const pending = add("bot wait", `<i></i><i></i><i></i>`);
    const used = [];
    const fresh = [];
    history.push({ role: "user", content: text });
    try {
      /* answer in the language of this question, whatever came before */
      const arabic = /[؀-ۿ]/.test(text);
      const messages = [{ role: "system", content: `${SYSTEM(api.lang())}
- Reply in ${arabic ? "Arabic" : "English"}: that is the language of the user's latest question.` }, ...history.slice(-16)];
      for (let round = 0; round < 6; round += 1) {
        const res = await ai.chat(messages, TOOLS);
        const msg = res.choices?.[0]?.message;
        if (!msg) throw new Error("Empty reply");
        messages.push(msg);
        if (!msg.tool_calls?.length) {
          history.push({ role: "assistant", content: msg.content || "" });
          pending.className = "ask-m bot";
          pending.innerHTML = `${md(msg.content || "")}<div class="ask-foot">${used.map((u) => `<span class="ask-tool">${esc(u)}</span>`).join("")}${badge(null)}</div>`;
          factCheck(msg.content || "", pending.querySelector(".ask-foot"), fresh);
          break;
        }
        for (const call of msg.tool_calls) {
          const name = call.function?.name;
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {}
          let out;
          try {
            out = run[name] ? await run[name](args) : { error: `unknown tool ${name}` };
          } catch (e) {
            out = { error: e.message };
          }
          const lab = TOOL_LABEL[name];
          if (lab && !used.includes(T(...lab))) used.push(T(...lab));
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out).slice(0, 12000) });
          if (name !== "show_place") {
            fresh.push({ tool: name, result: out });
            evidence.push({ tool: name, result: out });
            if (evidence.length > 6) evidence.shift();
          }
        }
        if (round === 5) throw new Error(T("The question needed too many steps; try a narrower one.", "احتاج السؤال خطوات كثيرة؛ جرّب سؤالًا أضيق."));
      }
    } catch (e) {
      history.pop();
      pending.className = "ask-m bot err";
      pending.textContent = e.message;
    }
    busy = false;
    log.scrollTop = log.scrollHeight;
  }

  $("ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("ask-q").value);
  });
  $("ask-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send($("ask-q").value);
    }
    e.stopPropagation();
  });
  const setOpen = (on) => {
    root.classList.toggle("open", on);
    btn.classList.toggle("on", on);
    if (on) {
      paintStatic();
      setTimeout(() => $("ask-q").focus(), 50);
    }
  };
  btn.addEventListener("click", () => setOpen(!root.classList.contains("open")));
  $("ask-x").addEventListener("click", () => setOpen(false));
  btn.hidden = false;
  paintStatic();
  return { setOpen, send, relabel: paintStatic, get open() { return root.classList.contains("open"); } };
}
