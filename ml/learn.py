"""WASL learning pipeline: turns the GAC extracts in portinfo/reports into learned.json.

Run from the repo root:   python ml/learn.py
Inputs  (git-ignored):    portinfo/reports/Gatepass_Abusamara_vehicles_2026.xlsx
                          portinfo/reports/DECLARATION_OGA_START_END_GREATER_2022_Abusamara.xlsx
Output  (committed):      view/twin/learned.json   aggregates and model parameters only;
                          no declaration numbers, gate passes or real plates leave this script.
                          ml/metrics.json          validation figures quoted in docs/AI.md

Cleaning follows the bottleneck report: the two gate-pass sheets are one 2026 dataset with
duplicate rows removed; the unit is the truck (gate pass); a truck is ready when its last
declaration is submitted; X-ray and inspection run from the earliest start to the latest end
across its declarations; courier and commercial trucks are separated; stays over 7 days are
dropped; medians everywhere because stay times are heavily skewed.
"""
import json, os, re, sys, time, math
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REP = os.path.join(ROOT, "portinfo", "reports")
CACHE = os.path.join(ROOT, "portinfo", "cache")
OUT = os.path.join(ROOT, "view", "twin", "learned.json")
METRICS = os.path.join(ROOT, "ml", "metrics.json")
RNG = np.random.default_rng(2026)
STAGES = ["decl", "xq", "xd", "iq", "insp", "rel", "exit"]
STAGE_NAMES = {
    "decl": "Wait for declaration submission", "xq": "Queue for X-ray", "xd": "X-ray image decision",
    "iq": "Queue for inspection", "insp": "Inspection", "rel": "Inspection end to release", "exit": "Release to gate exit",
}
CATS = ["chem", "oga", "health"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- loading
def to_csv(xlsx, out, sheets=None):
    import openpyxl, csv
    wb = openpyxl.load_workbook(xlsx, read_only=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        head = False
        for ws in wb.worksheets:
            if (sheets and ws.title not in sheets) or (not sheets and ws.max_column < 5):
                continue
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i == 0:
                    if head:
                        continue
                    head = True
                w.writerow(["" if v is None else (v.isoformat(sep=" ") if hasattr(v, "isoformat") else v) for v in row])


def load():
    os.makedirs(CACHE, exist_ok=True)
    gp = os.path.join(CACHE, "gatepass.csv")
    og = os.path.join(CACHE, "oga.csv")
    if not os.path.exists(og):
        log("converting OGA workbook")
        to_csv(os.path.join(REP, "DECLARATION_OGA_START_END_GREATER_2022_Abusamara.xlsx"), og, ["Sheet2"])
    if not os.path.exists(gp):
        log("converting gate-pass workbook (a few minutes)")
        to_csv(os.path.join(REP, "Gatepass_Abusamara_vehicles_2026.xlsx"), gp)
    dates = ["DATE_OF_ENTRY", "VEHICLE_RELEASE", "DEC_SUBMITTED_DATE", "DEC_RELEASE_DATE", "CUSTOM_INSPECTION_START",
             "CUSTOM_INSPECTION_END", "X_RAY_OPERATE_DATE", "X_RAY_MESSAGE_TIME"]
    cols = ["GATE_PASS_NO", "VEHICLE_NO", "DECLARATION_NO", "IS_COURIER_DEC", "OGA_FLAG", "RISK_FINAL_LANE_AR"] + dates
    g = pd.read_csv(gp, dtype=str, usecols=cols)
    n0 = len(g)
    g = g.drop_duplicates()
    log(f"gate-pass rows {n0:,} -> {len(g):,} after removing duplicates")
    for c in dates:
        g[c] = pd.to_datetime(g[c], errors="coerce")
    o = pd.read_csv(og, dtype=str)
    for c in ["SUBMITTED_DATE", "UPDATED_DATE", "OGA_INSPECTION_START", "OGA_INSPECTION_END", "CUSTOM_INSPECTION_START"]:
        o[c] = pd.to_datetime(o[c], errors="coerce")
    return g, o


# ---------------------------------------------------------------- plates
PLATE_RULES = [  # (country, regex on the cleaned plate) - formats seen in VEHICLE_NO
    ("SA", r"^[؀-ۿ]( ?[؀-ۿ]){2} ?\d{3,4}$"),      # 3 Arabic letters + 4 digits
    ("OM", r"^\d{2,5} ?/?[؀-ۿ]( ?[؀-ۿ])?$"),        # digits + 1-2 Arabic letters
    ("KW", r"^\d{1,3}/\d{4,6}$"),                                     # governorate/number
    ("AE", r"^[A-Z]( ?[A-Z])? ?/ ?\d{4,6}$|^[A-Z]{1,2} \d{5}$|^[A-Z]\d{5}$"),  # emirate code + number
    ("TR", r"^\d{2} ?[A-Z]( ?[A-Z]){0,2} ?\d{2,4}$"),                 # province + letters + digits
    ("QA", r"^\d{1,7}$"),                                             # numbers only
]


def plate_country(p):
    s = re.sub(r"\s+", " ", str(p).strip().upper())
    for c, rx in PLATE_RULES:
        if re.match(rx, s):
            return c
    return "XX"


# ---------------------------------------------------------------- trucks
def trucks(g, o):
    food = set(o["DECLARATION_NO"].dropna().unique())
    g["courier"] = g["IS_COURIER_DEC"].eq("Y")
    g["food"] = g["DECLARATION_NO"].isin(food)
    g["oga"] = g["OGA_FLAG"].eq("Y")
    g["red"] = g["RISK_FINAL_LANE_AR"].eq("أحمر")
    shared = g.groupby("DECLARATION_NO")["GATE_PASS_NO"].nunique()
    g["shared"] = g["DECLARATION_NO"].map(shared).fillna(1) > 1
    agg = g.groupby("GATE_PASS_NO").agg(
        plate=("VEHICLE_NO", "first"), entry=("DATE_OF_ENTRY", "min"), exit=("VEHICLE_RELEASE", "max"),
        submit=("DEC_SUBMITTED_DATE", "max"), first_submit=("DEC_SUBMITTED_DATE", "min"),
        ximg=("X_RAY_MESSAGE_TIME", "min"), xdec=("X_RAY_OPERATE_DATE", "max"),
        istart=("CUSTOM_INSPECTION_START", "min"), iend=("CUSTOM_INSPECTION_END", "max"),
        release=("DEC_RELEASE_DATE", "max"), ndecl=("DECLARATION_NO", "nunique"),
        courier_all=("courier", "all"), courier_any=("courier", "any"), food=("food", "any"),
        oga=("oga", "any"), red=("red", "any"), shared=("shared", "any"),
    )
    t = agg[agg.entry.notna() & agg.exit.notna()].copy()
    t["stay"] = (t.exit - t.entry).dt.total_seconds() / 60
    kinds = np.where(t.courier_all, "courier", np.where(~t.courier_any, "commercial", "mixed"))
    t["kind"] = kinds
    n_all = len(t)
    t = t[(t.stay > 0) & (t.stay <= 7 * 1440)]
    log(f"trucks {n_all:,}; kept {len(t):,} with 0 < stay <= 7 days; kinds {t.kind.value_counts().to_dict()}")
    # consecutive stages: each milestone is clamped to [previous milestone, exit]
    m = t.entry.copy()
    def step(val, cond=None):
        nonlocal m
        v = val.where(val.notna(), m)
        if cond is not None:
            v = v.where(cond, m)
        v = v.where(v > m, m).where(v < t.exit, t.exit)
        d = (v - m).dt.total_seconds() / 60
        m = v
        return d
    t["xray"] = t.ximg.notna()
    t["inspected"] = t.istart.notna()
    t["s_decl"] = step(t.submit)
    t["s_xq"] = step(t.ximg, t.xray)
    t["s_xd"] = step(t.xdec, t.xray)
    t["s_iq"] = step(t.istart, t.inspected)
    t["s_insp"] = step(t.iend, t.inspected)
    t["s_rel"] = step(t.release)
    t["s_exit"] = (t.exit - m).dt.total_seconds() / 60
    t["cat"] = np.where(t.food, "health", np.where(t.oga, "oga", "chem"))
    t["hour"] = t.entry.dt.hour
    t["dow"] = t.entry.dt.day_of_week
    t["night"] = (t.hour >= 22) | (t.hour < 6)
    t["prefiled"] = t.submit < t.entry
    t["country"] = t.plate.map(plate_country)
    t["date"] = t.entry.dt.normalize()
    return t


# ---------------------------------------------------------------- helpers
def q(x, p):
    x = np.asarray(x, float)
    return float(np.quantile(x, p)) if len(x) else None


def r1(x, d=1):
    return None if x is None else round(float(x), d)


def stage_table(t):
    out = {}
    hours = {s: t[f"s_{s}"].sum() for s in STAGES}
    total = sum(hours.values())
    for s in STAGES:
        col = t[f"s_{s}"]
        sub = col[t.xray] if s in ("xq", "xd") else col[t.inspected] if s in ("iq", "insp") else col
        out[s] = {"name": STAGE_NAMES[s], "median": r1(q(sub, .5)), "p90": r1(q(sub, .9)), "share": r1(hours[s] / total * 100), "trucks": int(len(sub))}
    return out


def kpis(t):
    st = t.stay / 60
    return {
        "trucks": int(len(t)), "medianStayH": r1(q(st, .5), 2), "p90StayH": r1(q(st, .9), 2), "p95StayH": r1(q(st, .95), 2),
        "over12hPct": r1((st > 12).mean() * 100), "waitingSharePct": r1((t.s_decl + t.s_xq + t.s_iq).sum() / t.stay.sum() * 100),
        "redPct": r1(t.red.mean() * 100, 2), "ogaPct": r1(t.oga.mean() * 100), "xrayPct": r1(t.xray.mean() * 100),
        "prefiledPct": r1(t.prefiled.mean() * 100, 2), "multiDeclPct": r1((t.ndecl > 1).mean() * 100), "sharedPct": r1(t.shared.mean() * 100),
    }


def group_rows(t):
    groups = {
        "Restricted (OGA)": t.oga, "Not restricted": ~t.oga, "X-rayed": t.xray, "No X-ray": ~t.xray,
        "Night arrival (22-06)": t.night, "Day arrival (06-22)": ~t.night, "1 declaration": t.ndecl == 1,
        "2-5 declarations": t.ndecl.between(2, 5), "6+ declarations": t.ndecl >= 6, "Shared declaration": t.shared,
        "Chemical & others": t.cat == "chem", "OGA (non-food)": t.cat == "oga", "Health & food": t.cat == "health",
    }
    rows = []
    for name, m in groups.items():
        s = t[m]
        rows.append({"group": name, "trucks": int(len(s)), "medianStayH": r1(q(s.stay / 60, .5), 2), "p90H": r1(q(s.stay / 60, .9), 1),
                     "declMin": r1(q(s.s_decl, .5), 0), "iqMin": r1(q(s.s_iq[s.inspected], .5), 0)})
    return rows


# ---------------------------------------------------------------- models
def fit_generator(t, n_out=4000):
    """Gaussian mixture per segment (category x X-ray) on log1p stage minutes, full covariance so
    stages stay correlated. The exported population is drawn from the mixtures, not copied rows."""
    from sklearn.mixture import GaussianMixture
    dims = ["s_decl", "s_xq", "s_iq", "s_insp", "s_rel", "s_exit"]
    seg_w = t.groupby(["cat", "xray"]).size()
    seg_w = seg_w / seg_w.sum()
    pop = []
    comps = {}
    val = {}
    for (cat, xr), w in seg_w.items():
        s = t[(t.cat == cat) & (t.xray == xr)]
        X = np.log1p(s[dims].clip(lower=0).values)
        use = [i for i, d in enumerate(dims) if xr or d != "s_xq"]
        best = None
        for k in (3, 4, 5, 6):
            gm = GaussianMixture(k, covariance_type="full", random_state=0, max_iter=300).fit(X[:, use][:60000])
            bic = gm.bic(X[:, use][:60000])
            if best is None or bic < best[0]:
                best = (bic, k, gm)
        _, k, gm = best
        n = max(40, int(round(n_out * w)))
        Z, _ = gm.sample(n)
        Y = np.zeros((n, len(dims)))
        Y[:, use] = np.expm1(np.clip(Z, 0, None))
        # attributes come from real trucks of the same segment, resampled independently of the stages
        idx = RNG.integers(0, len(s), n)
        attrs = s.iloc[idx]
        # keep the stage pattern and attribute pattern linked through the arrival hour: reorder
        # samples so night arrivals get the longer declaration waits, as the data shows
        order_y = np.argsort(Y[:, 0])
        order_a = np.argsort(attrs.night.values + RNG.random(n) * 1.6)
        Y = Y[order_y][np.argsort(order_a)]
        for j in range(n):
            a = attrs.iloc[j]
            pop.append({"c": CATS.index(cat), "x": int(xr), "h": int(a.hour), "n": int(min(a.ndecl, 9)), "sh": int(a.shared), "co": a.country,
                        "pf": int(a.prefiled), "rd": int(a.red), "s": [round(float(v), 1) for v in Y[j]]})
        comps[f"{cat}|{int(xr)}"] = {"k": int(k), "weight": r1(w * 100, 2), "trucks": int(len(s))}
        real = s.stay.values / 60
        synth = Y.sum(1) / 60 + (s.s_xd.median() if xr else 0) / 60
        val[f"{cat}|{int(xr)}"] = {"realMedianH": r1(np.median(real), 2), "synthMedianH": r1(np.median(synth), 2),
                                   "realP90H": r1(q(real, .9), 1), "synthP90H": r1(q(synth, .9), 1), "ks": r1(ks(real, synth), 3)}
    RNG.shuffle(pop)
    return pop, comps, val


def ks(a, b):
    a = np.sort(a); b = np.sort(b)
    grid = np.concatenate([a, b])
    fa = np.searchsorted(a, grid, side="right") / len(a)
    fb = np.searchsorted(b, grid, side="right") / len(b)
    return float(np.max(np.abs(fa - fb)))


def fit_risk(t, pop):
    """Delay-risk classifier: P(stay > 8 h) from what is known at the gate. Gradient-boosted trees;
    validated on the last two months (time split, no leakage)."""
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    daily = t.groupby("date").size()
    def feats(df, load):
        return np.column_stack([df.hour, df.dow if "dow" in df else np.zeros(len(df)), df.cat.map({c: i for i, c in enumerate(CATS)}),
                                df.xray.astype(int), np.minimum(df.ndecl, 9), df.shared.astype(int), df.prefiled.astype(int),
                                df.country.map(COUNTRY_IDX).fillna(len(COUNTRY_IDX)), load])
    load = t.date.map(daily).values
    X = feats(t, load)
    y = (t.stay > 480).values
    cut = t.entry.max() - pd.Timedelta(days=60)
    tr = (t.entry < cut).values
    clf = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.08, max_leaf_nodes=31, categorical_features=[2, 7], random_state=0)
    clf.fit(X[tr], y[tr])
    auc = roc_auc_score(y[~tr], clf.predict_proba(X[~tr])[:, 1])
    base = y[~tr].mean()
    log(f"delay-risk model AUC {auc:.3f} on last 60 days (base rate {base:.2f})")
    # permutation importance on the hold-out
    names = ["Arrival hour", "Weekday", "Inspection category", "X-ray", "Declarations", "Shared declaration", "Pre-filed", "Plate country", "Daily load"]
    Xh, yh = X[~tr][:30000], y[~tr][:30000]
    ref = roc_auc_score(yh, clf.predict_proba(Xh)[:, 1])
    imp = []
    for j, nm in enumerate(names):
        Xp = Xh.copy(); Xp[:, j] = RNG.permutation(Xp[:, j])
        imp.append((nm, ref - roc_auc_score(yh, clf.predict_proba(Xp)[:, 1])))
    imp.sort(key=lambda r: -r[1])
    # score the synthetic population; drivers = features whose neutral value moves the risk most
    P = pd.DataFrame(pop)
    Pdf = pd.DataFrame({"hour": P.h, "dow": RNG.integers(0, 7, len(P)), "cat": P.c.map(lambda i: CATS[i]), "xray": P.x.astype(bool),
                        "ndecl": P.n, "shared": P.sh.astype(bool), "prefiled": P.pf.astype(bool), "country": P.co})
    Xs = feats(Pdf, np.full(len(P), daily.tail(90).median()))
    risk = clf.predict_proba(Xs)[:, 1]
    neutral = {0: 10, 3: 0, 4: 1, 5: 0, 6: 0}
    drivers = []
    for j, v in neutral.items():
        Xn = Xs.copy(); Xn[:, j] = v
        drivers.append(risk - clf.predict_proba(Xn)[:, 1])
    D = np.column_stack(drivers)
    keys = ["hour", "xray", "decl", "shared", "prefiled"]
    for i, p in enumerate(pop):
        p["r"] = round(float(risk[i]), 3)
        top = [keys[k] for k in np.argsort(-D[i]) if D[i, k] > 0.03][:2]
        if top:
            p["why"] = top
    return {"auc": round(auc, 3), "baseRate": round(float(base), 3), "trainTrucks": int(tr.sum()), "testTrucks": int((~tr).sum()),
            "importance": [{"feature": n, "aucDrop": round(float(v), 4)} for n, v in imp]}


def fit_elasticity(t):
    """Declaration wait against weekly volume: log-log least squares. The slope says how much the
    paperwork wait grows when volume grows (it is the stage where extra volume shows up)."""
    w = t.set_index("entry").resample("W")
    vol = w.size()
    dec = w.s_decl.median()
    iq = t[t.inspected].set_index("entry").resample("W").s_iq.median()
    m = (vol > 500)
    out = {}
    for name, y in (("decl", dec), ("iq", iq)):
        yy = y[m].dropna(); xx = vol[yy.index]
        X = np.log(xx.values); Y = np.log(yy.values.clip(1))
        b, a = np.polyfit(X, Y, 1)
        pred = a + b * X
        r2 = 1 - ((Y - pred) ** 2).sum() / ((Y - Y.mean()) ** 2).sum()
        out[name] = {"elasticity": round(float(b), 3), "r2": round(float(r2), 3), "weeks": int(len(yy))}
    log("elasticities", out)
    return out


def demand(t, o):
    daily = t.groupby("date").size()
    daily = daily[daily.index < daily.index.max()]  # last day is partial
    cur = daily.tail(90)
    base = float(cur.median())
    # surge episodes: 7-day median above the year's running level by a robust margin
    roll = daily.rolling(7, center=True, min_periods=4).median()
    trend = daily.rolling(56, center=True, min_periods=20).median()
    resid = (daily - trend)
    mad = float((resid - resid.median()).abs().median()) * 1.4826
    z = resid / mad
    episodes = []
    hot = z > 2.2
    i = 0
    idx = list(daily.index)
    while i < len(idx):
        if hot.iloc[i]:
            j = i
            while j + 1 < len(idx) and (hot.iloc[j + 1] or (j + 2 < len(idx) and hot.iloc[j + 2])):
                j += 1
            seg = daily.iloc[i:j + 1]
            episodes.append({"from": str(idx[i].date()), "to": str(idx[j].date()), "days": int(j - i + 1), "peak": int(seg.max()),
                             "medianTrucks": int(seg.median()), "vsTrend": round(float(seg.median() / trend.iloc[i:j + 1].median() - 1) * 100, 1),
                             "vsCurrent": round(float(seg.max() / base - 1) * 100, 1)})
            i = j + 1
        else:
            i += 1
    episodes.sort(key=lambda e: -e["vsCurrent"])
    monthly = t.groupby(t.entry.dt.to_period("M")).agg(trucks=("stay", "size"), days=("date", "nunique"), medStay=("stay", "median"),
                                                       p90=("stay", lambda s: s.quantile(.9)))
    months = [{"m": str(p), "perDay": round(r.trucks / r.days, 1), "medianStayH": round(r.medStay / 60, 2), "p90H": round(r.p90 / 60, 1)} for p, r in monthly.iterrows()]
    # yearly growth from the 2022-2026 food declarations (the only multi-year series): log-linear fit
    fo = o[o.IS_COURIER_DEC.eq("N")].drop_duplicates("DECLARATION_NO")
    yr = fo.groupby(fo.SUBMITTED_DATE.dt.year).size()
    span = fo.groupby(fo.SUBMITTED_DATE.dt.year).SUBMITTED_DATE.agg(lambda s: (s.max() - s.min()).days + 1)
    annual = (yr / span * 365).loc[2023:2026]
    b, a = np.polyfit(annual.index.values, np.log(annual.values), 1)
    g = float(math.exp(b) - 1)
    # month-on-month 2026 trend in trucks/day, Mar-Oct (full months after the Feb low)
    pdays = np.array([m["perDay"] for m in months])
    mm = np.arange(len(pdays))
    full = [k for k, m in enumerate(months) if "2026-03" <= m["m"] < str(daily.index.max().to_period("M"))]
    bm, am = np.polyfit(mm[full], np.log(pdays[full]), 1)
    months = [m for m in months if m["m"] >= "2026-01"]
    # busiest stretches: the highest 7-day and 28-day rolling medians of the year
    def busiest(win):
        r = daily.rolling(win, min_periods=win).median()
        end_ = r.idxmax()
        return {"from": str((end_ - pd.Timedelta(days=win - 1)).date()), "to": str(end_.date()), "medianTrucks": int(r.max()),
                "vsCurrent": round(float(r.max() / base - 1) * 100, 1)}
    week, month4 = busiest(7), busiest(28)
    hourly = t.groupby("hour").size() / daily.shape[0]
    starts = t[t.inspected].groupby(t.istart.dt.hour).size() / daily.shape[0]
    return {
        "currentPerDay": round(base), "currentWindow": [str(cur.index.min().date()), str(cur.index.max().date())],
        "p90PerDay": round(float(cur.quantile(.9))), "maxPerDay": int(cur.max()), "dailyMad": round(mad, 1),
        "episodes": episodes[:6], "busiestWeek": week, "busiest4Weeks": month4, "months": months,
        "marchToOctober": round(float(months[9]["perDay"] / months[2]["perDay"] - 1) * 100, 1),
        "growth": {"foodDeclPerYear": {int(k): int(v) for k, v in annual.items()}, "cagr": round(g, 3),
                   "monthlyTrend2026": round(float(math.exp(bm * 12) - 1), 3)},
        "hourly": [round(float(hourly.get(h, 0)), 2) for h in range(24)],
        "inspStarts": [round(float(starts.get(h, 0)), 2) for h in range(24)],
        "daily": [[str(d.date()), int(v)] for d, v in daily.items()],
    }


def oga_food(o):
    c = o[o.IS_COURIER_DEC.eq("N") & o.OGA_FLAG.eq("Y")].copy()
    per = c.groupby("DECLARATION_NO").agg(subm=("SUBMITTED_DATE", "min"), s=("OGA_INSPECTION_START", "min"), e=("OGA_INSPECTION_END", "max"),
                                          n=("OGA_ID", "nunique"), rel=("UPDATED_DATE", "max"), cs=("CUSTOM_INSPECTION_START", "min"))
    per = per[(per.rel - per.subm).dt.total_seconds().between(0, 7 * 86400)]
    rev = (per.e - per.s).dt.total_seconds() / 60
    gap = (per.cs - per.e).dt.total_seconds() / 60
    names = c.groupby("OGA_NAME").DECLARATION_NO.nunique().sort_values(ascending=False)
    return {"reviewMedianMin": r1(q(rev.dropna().clip(lower=0), .5), 0), "reviewP90Min": r1(q(rev.dropna().clip(lower=0), .9), 0),
            "toInspectionMedianMin": r1(q(gap.dropna().clip(lower=0), .5), 0), "twoAgencyPct": r1((per.n >= 2).mean() * 100),
            "agencies": [{"ar": k, "declarations": int(v)} for k, v in names.head(6).items()]}


COUNTRY_IDX = {c: i for i, c in enumerate(["QA", "SA", "OM", "KW", "AE", "TR", "XX"])}


def main():
    g, o = load()
    t = trucks(g, o)
    com = t[t.kind == "commercial"].copy()
    cou = t[t.kind == "courier"]
    end = com.entry.max()
    cur = com[com.entry >= end - pd.Timedelta(days=90)]
    log(f"commercial {len(com):,}  courier {len(cou):,}  current window {len(cur):,}")
    learned = {
        "_about": "Learned by ml/learn.py from the GAC 2026 gate-pass and 2022-2026 food/OGA extracts. Aggregates and model parameters only.",
        "source": {"gatepassRows": int(len(g)), "trucks": int(len(t)), "commercial": int(len(com)), "courier": int(len(cou)),
                   "from": str(com.entry.min().date()), "to": str(end.date())},
        "year": {"kpis": kpis(com), "stages": stage_table(com)},
        "current": {"kpis": kpis(cur), "stages": stage_table(cur)},
        "groups": group_rows(com),
        "cats": {c: {"share": r1((cur.cat == c).mean() * 100, 1), "iqMedian": r1(q(cur[(cur.cat == c) & cur.inspected].s_iq, .5), 0),
                     "stayMedianH": r1(q(cur[cur.cat == c].stay / 60, .5), 2), "xrayPct": r1(cur[cur.cat == c].xray.mean() * 100, 1)} for c in CATS},
        "countries": {k: r1(v * 100, 2) for k, v in cur.country.value_counts(normalize=True).items()},
        "courier": {"perDay": r1(len(cou) / cou.date.nunique(), 1), "medianStayH": r1(q(cou.stay / 60, .5), 2), "p90H": r1(q(cou.stay / 60, .9), 1)},
        "oga": oga_food(o),
    }
    learned["demand"] = demand(com, o)
    learned["elasticity"] = fit_elasticity(com)
    pop, comps, val = fit_generator(cur)
    risk = fit_risk(com, pop)
    learned["generator"] = {"method": "Gaussian mixture per (category x X-ray) segment on log1p stage minutes, BIC-selected k", "segments": comps,
                            "stages": ["decl", "xq", "iq", "insp", "rel", "exit"], "xdMedian": r1(q(cur[cur.xray].s_xd, .5), 1)}
    learned["risk"] = risk
    learned["population"] = pop
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(learned, f, ensure_ascii=False, separators=(",", ":"))
    with open(METRICS, "w", encoding="utf-8") as f:
        json.dump({"generatorValidation": val, "risk": risk, "elasticity": learned["elasticity"], "current": learned["current"]["kpis"],
                   "year": learned["year"]["kpis"]}, f, ensure_ascii=False, indent=1)
    log(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")
    print(json.dumps({k: learned[k] for k in ("source", "cats", "countries", "courier", "oga")}, ensure_ascii=False, indent=1))
    print(json.dumps(learned["current"], indent=1))
    print(json.dumps({k: v for k, v in learned["demand"].items() if k not in ("daily",)}, indent=1))
    print(json.dumps(val, indent=1))


if __name__ == "__main__":
    main()
