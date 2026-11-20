# Where is the AI in WASL?

WASL (وصل, "we connect you to your vision": Watch, Anticipate, Simulate, Lead) is a digital twin of Abu Samra land port. It has three layers, and all of them come from the port's own data:

```
GAC extracts (gate passes, declarations, OGA)  ── portinfo/reports, never leaves the machine
        │  ml/learn.py   (pandas + scikit-learn)
        ▼
learned.json  ── aggregates and synthetic trucks only, no real plate or declaration
        │
        ├── 1. Synthetic truck generator  (Gaussian mixtures)      → every truck in the 3D scene
        ├── 2. Delay-risk model           (gradient boosting)      → each truck's risk and its reasons
        ├── 3. Demand model               (growth + elasticity)    → trucks/day, surge presets, 2030
        │
        ▼  view/twin/portmodel.js  (runs in the browser)
        ├── 4. Calibrated queueing model  (M/M/c + fluid backlog)   → what-if: hours from lanes, docks, bays
        ├── 5. Bottleneck and pattern mining (share + lift)        → "what is the bottleneck, who is stuck there"
        └── 6. Goal seeking (inverse search + ablation + costing)  → plans that reach a target and what they cost
```

## Data preparation (as in the bottleneck report)

- **Rows.** 1,375,315 rows, deduplicated to 1,372,877 and rolled up to one row per truck: 198,665 commercial trucks plus 1,484 courier trucks.
- **Stay filter.** Stays of 0 or less, or over 7 days, are dropped.
- **Stages.** Each truck's time splits into consecutive stages: entry, declaration submitted, X-ray image and decision, inspection start, inspection end, release, exit. Each milestone is clamped between the previous one and exit, so the stages add up to the stay.
- **Categories.** Goods category is the ramp a truck goes to:
  - **Health & Food:** the declaration appears in the OGA food file.
  - **OGA:** another-agency flag set, not food.
  - **Chemical & Others:** everything else.
- **Plate country.** Read from the plate format: Qatar 40%, Saudi Arabia 38%, Kuwait 8%, Oman 8%, UAE 6%, Türkiye 1%.
- **Windows.** "Today" is the last 90 days of data: 66,460 trucks, median stay 5.64 h, P90 17.5 h.
- **Medians.** Every figure shown is a median or a percentile, never a mean. The only mean is inside Little's law, which needs it.

## 1. Synthetic truck generator: unsupervised density estimation

- **What it does.** It makes trucks that behave like the real ones without copying any real truck.
- **Model.** `sklearn.mixture.GaussianMixture` with full covariance, fitted on log(1 + minutes) of the six stage durations.
  - It is fitted separately for each segment: (Chemical, OGA, Health) × (X-ray or not).
  - The number of components (3–6) is picked by **BIC**.
  - Full covariance keeps the correlation between stages. A truck that waits long for its declaration also tends to wait long for inspection.
- **Attributes.** Arrival hour, number of declarations, shared declaration and plate country are resampled from the same segment. They are rank-coupled to the stage times, so night arrivals are the slow ones, as in the data.
- **Output.** 4,000 synthetic trucks in `learned.json`. Every inbound truck in the 3D scene is one of them, with a plate drawn in its country's real format (`plates.js`).
- **Validation.** Two-sample Kolmogorov–Smirnov distance between real and synthetic stays in each segment is **0.025 to 0.113**. Medians match within 0.1 to 0.7 h (`ml/metrics.json`).

## 2. Delay-risk model: supervised classification

- **Question.** Will this truck stay more than 8 hours? (Base rate 35%.)
- **Model.** `HistGradientBoostingClassifier`: 250 trees, 31 leaves each, native categorical splits.
- **Features.** Arrival hour, weekday, category, X-ray, number of declarations, shared declaration, plate country, pre-filed, and the day's load.
- **Validation.** Split by time, with the last 60 days held out: 152,134 trucks to train, 46,531 to test. **ROC AUC 0.70.**
- **Explainability.** Permutation importance, measured as AUC drop on the hold-out:
  - arrival hour (0.10)
  - inspection category (0.05)
  - shared declaration (0.04)
  - plate country (0.03)
- **In the app.** Each synthetic truck carries its risk and its top drivers. Click any truck in the twin to see "Delay risk 70%, driven by arrival hour, shared declaration".

## 3. Demand model: regression on time series

- **Today's demand.** The median day of the last 90 days: about 740 trucks.
- **Hourly profile.** From arrival times, so the scene follows the real daily rhythm.
- **Surge presets.** The slider's clickable marks come from the data:
  - a busy day (1 in 10)
  - the busiest week of 2026
  - the 2026 peak day
  - the March-to-October growth
  - named events can be added in `config.json` → `surge.events`.
- **Growth to 2030.** The compound annual growth of food declarations, 2023–2026, is 43%. It is halved each year after 2026, so 2030 comes to about 1.46× today (about 1,080 trucks/day).
- **Elasticity.** A log-log regression of each stage's weekly median on weekly volume:
  - The declaration wait rises 0.24% per 1% more trucks (R² 0.26).
  - The inspection queue is flat (−0.08).
  - The weekly median stay barely moves (0.04), even though 2026 volume went from 350 to 840 trucks/day. Most of today's wait is therefore process, not capacity.

## 4. Calibrated queueing model: the what-if engine (`portmodel.js`)

- **Queues.** The X-ray lanes and each category's docks are each an **M/M/c queue**, using the Sakasegawa approximation, run hour by hour over a warm-up day plus a week.
  - A fluid backlog carries queues across hours and days when demand passes capacity. That is how the 2029–2030 knee appears.
- **Capacity by hour.** Read from the data. Inspection starts collapse at 06:00, 13:00–14:00 and 21:00–22:00 (shift handovers).
- **Calibration.**
  - Service times are solved so the model reproduces today's median waits: X-ray cycle about 7.6 minutes, dock occupancy about 2.2 h.
  - Today's dock split by category is inferred from the waits, since it is not in the data: 54 chemical, 37 OGA, 39 health and food.
- **Congestion share.** Only 25% of today's X-ray and dock waits is congestion; the rest is process latency (`congestionShare`). This value is fitted so a +14% week gives 6.1 h, as the busiest real weeks did (6.0–6.4 h).
- **Per-truck evaluation.** Each synthetic truck's stages are rescaled by the scenario, so results stay distributions, reported as median, P90 and share over 12 h.
- **Parking.** Little's law with a peak-hour factor. Trucks that find the yard full wait at the gate.
- **Smart split.** Docks are shared across categories by **square-root staffing** (Halfin–Whitt): docks = load + β·√load.
- **Self-check.** `python tests/model_test.py` checks three things:
  - Today's synthetic median stays within 0.6 h of the real one (5.9 vs 5.64 h).
  - More capacity never makes things worse.
  - Goal seeking always returns plans.

## 5. Bottleneck and pattern mining

- **The bottleneck.** The stage with the largest share of all truck-hours, together with the resource running hottest.
- **Who is stuck there.** Lift: an attribute's share among the slowest quarter of trucks at that stage, divided by its share overall. For example, "Chemical & others, 1.9×: 93% of the slowest quarter vs 50% of all trucks".
- **Where it shows.** It updates with every what-if change, on the dashboard, the planner and the executive board.

## 6. Goal seeking: reverse engineering a target

- **Search.** Given a target (say a 3.5 h median in 2030), the model is run in reverse.
  - A grid of about 3,400 combinations covers X-ray lanes, docks (with the smart split), pre-arrival filing, green channel and shift overlap.
  - Parking is sized so the yard never overflows.
  - Every combination is evaluated by the calibrated model. This takes about 7 s in the browser.
- **The three plans it keeps:**
  - **Cost-smart:** the cheapest plan that reaches the goal.
  - **Resilient:** the cheapest plan that still holds the goal in a week like the busiest of 2026 (+16%).
  - **Best result:** the lowest time for at most 1.5× the cheapest budget.
- **Explanation by ablation.** Each lever is removed from the plan in turn. The time the plan loses is that lever's contribution.
- **Cost.** Arithmetic on the model's output: units changed × unit cost (capex, plus opex × 5 years). The unit costs are public benchmarks converted to QAR (1 USD = 3.64 QAR), in `config.json` → `costs`:

| Resource | Unit cost used | Basis |
|---|---|---|
| Drive-through X-ray lane | QAR 16.4 M + 1.9 M/yr | Fixed high-energy portal US$3–6 M (vendor ranges, US CBP awards; [FreightWaves](https://www.freightwaves.com), [CBO 51478](https://www.cbo.gov/publication/51478)); 9 operators × QAR 12.5k/month + 5% maintenance |
| Inspection dock | QAR 290k + 540k/yr | Dock position US$20–36k ([Terrapin, 2026](https://terrapincg.com)) + canopy share; 3.6 inspector FTE ([Naukrigulf](https://www.naukrigulf.com), [Paylab Qatar](https://www.paylab.com/qa) inspector pay QAR 8.3–12.5k/month) |
| Value of one truck-hour | QAR 330 | [ATRI Operational Costs of Trucking, 2025 update](https://truckingresearch.org/atri-research/operational-costs-of-trucking): US$90.89 per hour in 2024 |
| Truck parking bay | QAR 91k + 2k/yr | Paving only, about US$25k (the [ATRI](https://www.ttnews.com) full-build median of US$93.5k includes land) |
| Pre-arrival filing (per 10 points) | QAR 0.8 M + 0.25 M/yr | Broker onboarding, API, incentives (estimate) |
| Green channel (per 10 points) | QAR 1.2 M + 0.6 M/yr | Risk rules and post-clearance audit staff (estimate) |
| Shift overlap | QAR 0.1 M + 0.9 M/yr | One paid overlap hour per inspector shift (estimate) |

Replace these with GAC procurement figures before using the numbers for a decision.

## Assumptions to state when asked

- `congestionShare` 0.25: the share of X-ray and dock waits that capacity can remove. It is fitted to the busiest 2026 weeks.
- `prefileFactor` 0.1: a pre-filed truck keeps about 9 minutes of declaration wait.
- `growthDamping` 0.5: the learned 43% growth is halved each year.
- `peakFactor` 1.2: peak-hour parking over the daily mean.
- The figures on screen are **synthetic**. They are produced by the learned models to behave like the port; they are not a report of it.

## 7. Robust decision: testing plans against what the model is unsure of (`portmodel.js` → `robust`)

- **Why.** Two inputs carry most of the uncertainty: future demand (the 2030 growth is an assumption) and the congestion share (how much of today's waiting more capacity can remove, fitted to one set of weeks). A plan that only works if both guesses are right is not a safe recommendation.
- **How.** After a goal seek, up to 30 distinct candidate plans (the three named plans, the cheapest that reach the goal, the best results) are re-run in 9 futures:
  - **Demand:** low, expected or high. After 2026 that is half, the same or one and a half times the growth; in 2026 itself, a quiet stretch (−8%) or a week like the busiest of 2026.
  - **Congestion share:** 0.6×, 1× or 1.6× the calibrated value. The model is recalibrated for each.
- **Rule.** The **robust choice** is the cheapest plan that reaches the goal in the most futures; ties go to the better worst case. The table shows, for every plan, the 5-year cost, the expected value, the worst case and the futures it holds in.
- **What it is.** Decision analysis under uncertainty over the calibrated model. Plain arithmetic, about 0.5 s in the browser, every number traceable.

## 8. Priority fit: Microsoft Decision 1.1 (Azure AI Foundry)

- **The gap it fills.** The model computes the options; it cannot know what the decision maker values. Executives state priorities in words ("keep spending low", "never break in a surge").
- **How.** The planner sends Decision 1.1 a text description of the compared plans, with the model's own figures for each (levers, 5-year cost, expected and worst-case time, futures held), plus the priority as written. Decision 1.1's `/score` endpoint returns calibrated probabilities over the plans (a `choice` question).
- **Output.** Which plan fits the priority, with how sure it is. When the top two are within 30 points, the planner says it is a close call: the priority does not separate the plans.
- **What it does not do.** It produces no figures and searches nothing; it only weighs the computed options against the stated priority. Only model outputs are sent.

## 9. Ask WASL: language model with the twin's model as tools (Azure OpenAI)

- **Why a language model.** Executives ask in natural language, in Arabic and English. That is a language job.
- **How.** The model (GPT-5.1 on Azure OpenAI) receives the question and six tools that call the twin itself:
  - `port_status`
  - `evaluate_scenario`
  - `show_scenario`
  - `find_plans` (goal seek plus the robust test)
  - `show_place` (camera)
  - `about_the_model` (data, learned models, assumptions)

  It answers from the tool results and can drive the twin to show what it says. Each answer lists the tools it used.
- **Guard rails (system prompt).** Every number must come from a tool result; it reports what the data shows without adding causes; it names the assumption a forecast rests on; it explains that AUC is not accuracy. It replies in the language of the latest question.
- **Data.** Only the conversation and the tool results (model outputs and aggregates) are sent. There is no real truck, plate or declaration in the browser.

## Keys and hosting

The keys live in `.env` (ignored by git). `view/serve.py` reads them and forwards only two requests: `/api/chat` (fixed model, token cap) and `/api/decide` (fixed model). The browser never sees a key. On GitHub Pages there is no server, so the AI features hide themselves and everything else works.
