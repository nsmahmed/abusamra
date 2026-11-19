"""Builds the AI Accelerate 2.0 pitch deck for WASL: python docs/pitch/build_deck.py

Main deck follows the jury format (problem 1 slide, live demo, value 1 slide, Q&A); the
appendix carries the AI detail for judges. Figures are from the learned port model
(view/twin/portmodel.js, tests/model_test.py) and docs/AI.md.
"""
import os
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "WASL_AI_Accelerate_pitch.pptx")
SITE = "https://nsmahmed.github.io/abusamra/"  # the GitHub Pages address; the QR slide points here

BG = "0B1016"; CARD = "151C26"; CARD2 = "1B2430"; LINE = "26313F"
INK = "EEF0F2"; INK2 = "C4CAD2"; MUTED = "8A94A3"
TEAL = "5FE0D8"; TEAL_D = "1D6F6B"; GOLD = "D6B47A"; ROSE = "FF8E99"; GOOD = "6FE3C8"; MAROON = "8A1538"; VIOLET = "A08BFF"
F = "Calibri"; FAR = "Segoe UI"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]


def rgb(h):
    return RGBColor.from_string(h)


def new(notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = rgb(BG)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def box(s, x, y, w, h, fill=CARD, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08, name=None):
    sh = s.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if fill:
        sh.fill.solid(); sh.fill.fore_color.rgb = rgb(fill)
    else:
        sh.fill.background()
    if line:
        sh.line.color.rgb = rgb(line); sh.line.width = Pt(1)
    else:
        sh.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        sh.adjustments[0] = radius
    sh.shadow.inherit = False
    if name:
        sh.name = name
    return sh


def text(s, x, y, w, h, runs, size=16, color=INK, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, font=F, spacing=None, name=None):
    """runs: str, or list of paragraphs; a paragraph is a str or a list of (text, {opts})."""
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        tb.name = name
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    paras = runs if isinstance(runs, list) else [runs]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = Pt(spacing)
        parts = para if isinstance(para, list) else [(para, {})]
        for t, o in parts:
            r = p.add_run()
            r.text = t
            f = r.font
            f.name = o.get("font", font)
            f.size = Pt(o.get("size", size))
            f.bold = o.get("bold", bold)
            f.italic = o.get("italic", False)
            f.color.rgb = rgb(o.get("color", color))
    return tb


def bullets(s, x, y, w, h, items, size=15, color=INK2, gap=8, dot=TEAL):
    paras = [[("●  ", {"color": dot, "size": size - 5}), *([(i, {})] if isinstance(i, str) else i)] for i in items]
    return text(s, x, y, w, h, paras, size=size, color=color, spacing=gap)


def kicker(s, label, letter=None, x=0.6, y=0.45):
    if letter:
        b = box(s, x, y - 0.02, 0.34, 0.34, fill=TEAL, radius=0.2)
        text(s, x, y - 0.02, 0.34, 0.34, letter, size=13, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        x += 0.46
    text(s, x, y, 9, 0.3, label.upper(), size=11, color=MUTED, bold=True)


def title(s, t, y=0.85, size=34, w=12.1, color=INK):
    return text(s, 0.6, y, w, 1.2, t, size=size, color=color, bold=True)


def stat(s, x, y, w, big, unit, label, color=INK, size=44, card=True, h=1.45):
    if card:
        box(s, x, y, w, h, fill=CARD)
    text(s, x + 0.25, y + 0.15, w - 0.4, 0.8, [[(big, {"size": size, "bold": True, "color": color}), (f" {unit}" if unit else "", {"size": 18, "color": MUTED})]])
    text(s, x + 0.25, y + h - 0.5, w - 0.4, 0.4, label, size=12.5, color=INK2)


def footer(s, t="WASL · Abu Samra land port digital twin · AI Accelerate 2.0"):
    text(s, 0.6, 7.05, 9, 0.3, t, size=10, color=MUTED)


def chart_style(ch, colors=None, labels=True, fmt='0.0', legend=False):
    ch.font.size = Pt(12); ch.font.name = F; ch.font.color.rgb = rgb(INK2)
    ch.has_legend = legend
    if legend:
        ch.legend.position = XL_LEGEND_POSITION.BOTTOM; ch.legend.include_in_layout = False
        ch.legend.font.color.rgb = rgb(INK2); ch.legend.font.size = Pt(12)
    try:
        va = ch.value_axis
        va.major_gridlines.format.line.color.rgb = rgb(LINE)
        va.format.line.fill.background()
        va.tick_labels.font.color.rgb = rgb(MUTED); va.tick_labels.font.size = Pt(11)
        ca = ch.category_axis
        ca.format.line.color.rgb = rgb(LINE)
        ca.tick_labels.font.color.rgb = rgb(INK2); ca.tick_labels.font.size = Pt(12)
    except Exception:
        pass
    plot = ch.plots[0]
    if labels:
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.number_format = fmt; dl.number_format_is_linked = False
        dl.font.size = Pt(13); dl.font.bold = True; dl.font.color.rgb = rgb(INK)
    return plot


def logo_mark(s, x, y, size=0.9, word=True):
    """Concept A, the chosen mark: an arch that connects W to L (today to the vision)."""
    box(s, x, y, size, size, fill=TEAL_D, radius=0.22)
    arc = s.shapes.add_shape(MSO_SHAPE.BLOCK_ARC, Inches(x + size * 0.17), Inches(y + size * 0.16), Inches(size * 0.66), Inches(size * 0.66))
    arc.fill.solid(); arc.fill.fore_color.rgb = rgb(GOLD); arc.line.fill.background()
    arc.adjustments[2] = 0.11
    dot = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x + size * 0.72), Inches(y + size * 0.43), Inches(size * 0.13), Inches(size * 0.13))
    dot.fill.solid(); dot.fill.fore_color.rgb = rgb(TEAL); dot.line.fill.background()
    text(s, x, y + size * 0.56, size, size * 0.3, "WASL", size=size * 12, color=INK, bold=True, align=PP_ALIGN.CENTER)


# ============================== MAIN DECK ==============================

# 1 Cover
s = new("Open strong: WASL is an AI digital twin that tells customs leaders where Abu Samra will break as trade grows, and which costed actions get them to their target fastest. Thirty seconds, then hand to the team slide.")
logo_mark(s, 0.6, 0.6, 1.0)
text(s, 0.6, 2.15, 9, 1.4, "WASL", size=96, color=TEAL, bold=True)
text(s, 0.6, 3.5, 1.3, 0.65, "وصل", size=30, color=GOLD, font=FAR)
text(s, 1.85, 3.55, 8, 0.6, "We connect you to your vision", size=26, color=INK)
text(s, 0.6, 4.35, 10, 0.5, [[("W", {"color": TEAL, "bold": True}), ("atch  ·  ", {}), ("A", {"color": TEAL, "bold": True}), ("nticipate  ·  ", {}), ("S", {"color": TEAL, "bold": True}), ("imulate  ·  ", {}), ("L", {"color": TEAL, "bold": True}), ("ead", {})]], size=20, color=INK2)
text(s, 0.6, 5.35, 10, 0.9, ["An AI digital twin for Abu Samra land port", "Predicts congestion to 2030 and prescribes the costed actions that keep trucks moving"], size=16, color=MUTED, spacing=4)
text(s, 0.6, 6.75, 8, 0.35, "AI Accelerate 2.0 · Malomatia · Executive showcase", size=12, color=MUTED)
# decorative network of nodes on the right (connection motif)
pts = [(10.2, 1.6), (11.4, 2.5), (10.6, 3.6), (11.9, 4.4), (10.9, 5.5), (12.2, 6.1)]
for (ax, ay), (bx, by) in zip(pts, pts[1:]):
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(ax + 0.1), Inches(ay + 0.1), Inches(bx + 0.1), Inches(by + 0.1))
    c.line.color.rgb = rgb(LINE); c.line.width = Pt(2)
for i, (ax, ay) in enumerate(pts):
    d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(ax), Inches(ay), Inches(0.2), Inches(0.2))
    d.fill.solid(); d.fill.fore_color.rgb = rgb(GOLD if i == len(pts) - 1 else TEAL); d.line.fill.background()
ring = s.shapes.add_shape(MSO_SHAPE.DONUT, Inches(11.95), Inches(5.85), Inches(0.7), Inches(0.7))
ring.fill.solid(); ring.fill.fore_color.rgb = rgb(GOLD); ring.line.fill.background(); ring.adjustments[0] = 0.08

# 2 Team
s = new("Introduce each member in one line: name, role, what they built. Replace the photo circles with pictures (right-click > Change Picture, or insert and crop to circle).")
kicker(s, "The team")
title(s, "Four people, one port, one vision")
for i in range(4):
    x = 0.6 + i * 3.08
    box(s, x, 2.3, 2.85, 4.1, fill=CARD)
    ph = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x + 0.67), Inches(2.65), Inches(1.5), Inches(1.5))
    ph.fill.solid(); ph.fill.fore_color.rgb = rgb(CARD2); ph.line.color.rgb = rgb(TEAL); ph.line.width = Pt(1.5)
    ph.name = f"Photo {i + 1}"
    text(s, x + 0.67, 3.2, 1.5, 0.4, "Photo", size=12, color=MUTED, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 4.45, 2.45, 0.45, f"Member {i + 1} name", size=18, color=INK, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 4.95, 2.45, 0.4, "Title / role", size=13, color=TEAL, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 5.45, 2.45, 0.7, "One line on what they built", size=12, color=MUTED, align=PP_ALIGN.CENTER)
footer(s)

# 3 Name
s = new("WASL means connection in Arabic. The name is the product: we connect today's port to the leadership's vision, through four verbs that are also the four parts of the app.")
kicker(s, "The name")
title(s, "WASL means connection")
text(s, 6.15, 0.8, 1.6, 0.8, "وصل", size=34, color=GOLD, bold=True, font=FAR)
text(s, 0.6, 1.75, 11.5, 0.5, "We connect you to your vision. Each letter is a capability you will see live in the twin.", size=17, color=INK2)
caps = [
    ("W", "Watch", "A live 3D twin of Abu Samra. Every truck is synthetic and follows the patterns learned from 198,665 real ones.", TEAL),
    ("A", "Anticipate", "Forecasts truck volume to 2030 and the year each resource breaks: the bottleneck, and which trucks it traps.", GOLD),
    ("S", "Simulate", "What-if on X-ray lanes, ramps, parking and process levers. Goal seek works backwards from a target.", VIOLET),
    ("L", "Lead", "Costed, explained plans, compared before and after, so leaders decide with evidence.", GOOD),
]
for i, (L, name, desc, c) in enumerate(caps):
    x = 0.6 + i * 3.08
    box(s, x, 2.65, 2.85, 3.7, fill=CARD)
    box(s, x + 0.3, 2.95, 0.9, 0.9, fill=c, radius=0.22)
    text(s, x + 0.3, 2.95, 0.9, 0.9, L, size=40, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x + 0.3, 4.05, 2.4, 0.5, name, size=22, color=INK, bold=True)
    text(s, x + 0.3, 4.6, 2.35, 1.7, desc, size=13.5, color=INK2)
footer(s)

# 4 Business problem (1 slide)
s = new("About one minute. Pain: trucks spend about six hours in the port, and half of it is waiting for paperwork, not for inspection. Vision: clear trucks in hours as trade grows. Volume: +46% by 2030. If nothing changes, the median time doubles. KPIs we steer by are on the right.")
kicker(s, "01 · Business problem")
title(s, "Trucks wait 6 hours, and traffic grows 46% by 2030", size=32)
text(s, 0.6, 1.95, 6, 0.4, "TODAY (BASELINE)", size=11, color=MUTED, bold=True)
stat(s, 0.6, 2.35, 2.9, "738", "", "trucks a day, median day")
stat(s, 3.65, 2.35, 2.9, "5.9", "h", "median time in port")
stat(s, 0.6, 3.95, 2.9, "51", "%", "of truck-hours waiting for the declaration", color=GOLD)
stat(s, 3.65, 3.95, 2.9, "0", "%", "declarations filed before arrival, ~100% red lane", color=GOLD)
text(s, 6.95, 1.95, 6, 0.4, "2030 IF NOTHING CHANGES", size=11, color=MUTED, bold=True)
stat(s, 6.95, 2.35, 2.9, "1,077", "", "trucks a day (+46%)", color=ROSE)
stat(s, 10.0, 2.35, 2.75, "12.6", "h", "median time in port", color=ROSE)
stat(s, 6.95, 3.95, 2.9, "53", "%", "of trucks stay over 12 hours", color=ROSE)
stat(s, 10.0, 3.95, 2.75, "112", "%", "main parking at peak", color=ROSE)
box(s, 0.6, 5.65, 12.15, 1.2, fill=CARD2)
text(s, 0.85, 5.8, 5.6, 1.0, [[("Strategic vision  ", {"color": TEAL, "bold": True}), ("A land port that clears trucks in hours, not days, while trade with the GCC grows.", {})]], size=14, color=INK2)
text(s, 6.95, 5.8, 5.7, 1.0, [[("KPIs we steer by  ", {"color": TEAL, "bold": True}), ("median and P90 time in port · share over 12 h · sustainable trucks per day · cost per hour saved", {})]], size=14, color=INK2)
footer(s, "Figures: WASL port model learned from 2026 GAC gate-pass and declaration extracts (synthetic, medians). Growth: food declarations 2023-2026, damped.")

# 5 Live demo cue
s = new("Switch to the browser: WASL twin, press Demo (next to Tour) for the 90-second guided run, then drive the planner live: load increase marks, X-ray lanes, ramps, goal seek to 3.5 h, Visualize, executive board. Five minutes.")
text(s, 0.6, 2.4, 12.1, 1.2, "Live demo", size=60, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.6, 3.6, 12.1, 0.6, [[("W", {"color": TEAL, "bold": True}), ("atch the port   →   ", {}), ("A", {"color": TEAL, "bold": True}), ("nticipate 2030   →   ", {}), ("S", {"color": TEAL, "bold": True}), ("imulate a goal   →   ", {}), ("L", {"color": TEAL, "bold": True}), ("ead with a costed plan", {})]], size=20, color=INK2, align=PP_ALIGN.CENTER)
text(s, 0.6, 4.5, 12.1, 0.4, "nsmahmed.github.io/abusamra", size=14, color=MUTED, align=PP_ALIGN.CENTER)

# 6 Value realization (1 slide)
s = new("About two minutes. One decision moves 2030 from 12.6 hours to 3.3, for QAR 42 million over five years, mostly process changes, not concrete. At today's traffic the same levers save 2.5 hours per truck. The value estimate uses ATRI's 2024 truck operating cost of US$90.89 per hour (about QAR 330) and counts only truck time. Fill the adoption box with the pilot numbers before the event.")
kicker(s, "03 · Value realization")
title(s, "One decision: 12.6 h → 3.3 h in 2030, for QAR 42 M", size=32)
cd = CategoryChartData()
cd.categories = ["Today", "2030 as is", "2030 with WASL plan"]
cd.add_series("Median time in port (h)", (5.9, 12.6, 3.3))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.95), Inches(5.6), Inches(4.0), cd)
ch = gf.chart
ch.has_title = True; ch.chart_title.text_frame.text = "Median time in port, hours"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(13); ch.chart_title.text_frame.paragraphs[0].runs[0].font.color.rgb = rgb(INK2)
plot = chart_style(ch)
plot.gap_width = 70
for i, c in enumerate([MUTED, ROSE, TEAL]):
    pt = plot.series[0].points[i]
    pt.format.fill.solid(); pt.format.fill.fore_color.rgb = rgb(c)
ch.value_axis.maximum_scale = 14; ch.value_axis.has_major_gridlines = True
stat(s, 6.55, 1.95, 3.0, "9.3", "h", "saved per truck in 2030", color=GOOD, h=1.3)
stat(s, 9.75, 1.95, 3.0, "3.7 M", "", "truck-hours a year avoided by 2030", color=GOOD, h=1.3)
stat(s, 6.55, 3.4, 3.0, "~QAR 1.2 B", "", "a year of truck time (QAR 330/h)", color=GOLD, size=34, h=1.3)
stat(s, 9.75, 3.4, 3.0, "7 s", "", "to cost 3,402 scenarios (was weeks)", color=TEAL, h=1.3)
box(s, 6.55, 4.85, 6.2, 1.1, fill=CARD2, line=TEAL)
text(s, 6.8, 4.95, 5.8, 0.95, [[("Adoption and usage  ", {"color": TEAL, "bold": True}), ("pilot users: ___ · planning sessions: ___ · decisions supported: ___", {})], "Fill in from the test phase before the showcase."], size=13, color=INK2, spacing=3)
text(s, 0.6, 6.15, 12.1, 0.8, [[("Today's traffic: ", {"bold": True, "color": INK}), ("the same levers take 5.9 h to 3.4 h (2.5 h per truck, ~670k truck-hours a year) for QAR 29 M over 5 years. The plan is mostly process: pre-arrival filing, a green channel for low-risk chemicals and overlapping shift handovers.", {})]], size=13, color=INK2)
footer(s, "Value = hours saved × trucks × 365 × QAR 330 per truck-hour (ATRI 2024 operating cost US$90.89/h). Costs: public unit benchmarks, 5 years, see appendix.")

# 7 Added value
s = new("What is new compared with a BI dashboard: it predicts, it prescribes, it explains every number, and it is safe to share because no real truck is ever shown.")
kicker(s, "Added value")
title(s, "From reporting the past to prescribing the future")
cards = [
    ("Predictive", "Sees the 2029 breaking point and the bottleneck before it happens.", TEAL),
    ("Prescriptive", "Goal seeking returns three costed plans for any target, not just charts.", GOLD),
    ("Explainable", "Every figure says why: lever contributions, bottleneck patterns, risk drivers.", VIOLET),
    ("Privacy-safe", "Synthetic trucks and aggregates only. No real plate or declaration leaves GAC.", GOOD),
    ("Zero infrastructure", "Runs in any browser, Arabic and English. Deployed as a static web app.", TEAL),
    ("Reusable", "The same pipeline learns any port's data: sea, air cargo or another border.", GOLD),
]
for i, (h, d, c) in enumerate(cards):
    cx = 0.6 + (i % 3) * 4.1
    cy = 2.1 + (i // 3) * 2.35
    box(s, cx, cy, 3.85, 2.1, fill=CARD)
    o = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx + 0.3), Inches(cy + 0.3), Inches(0.5), Inches(0.5))
    o.fill.solid(); o.fill.fore_color.rgb = rgb(c); o.line.fill.background()
    text(s, cx + 0.3, cy + 0.3, 0.5, 0.5, str(i + 1), size=16, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, cx + 1.0, cy + 0.33, 2.7, 0.5, h, size=19, color=INK, bold=True)
    text(s, cx + 0.3, cy + 1.0, 3.3, 1.0, d, size=14, color=INK2)
footer(s)

# 8 Try it yourself (QR)
import qrcode
qr_path = os.path.join(HERE, "qr_wasl.png")
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=16, border=2)
qr.add_data(SITE); qr.make(fit=True)
qr.make_image(fill_color="#0B1016", back_color="white").save(qr_path)
s = new("Invite the jury to scan and try it on their phones while you take questions: press Demo for the guided story, or open the planner and move a lever.")
kicker(s, "Try it yourself")
title(s, "Scan and run the port yourself")
box(s, 0.6, 2.0, 4.6, 4.6, fill="FFFFFF", radius=0.06)
s.shapes.add_picture(qr_path, Inches(0.85), Inches(2.25), Inches(4.1), Inches(4.1)).name = "QR code to the live twin"
text(s, 5.75, 2.05, 7.0, 0.5, SITE.replace("https://", "").rstrip("/"), size=24, color=TEAL, bold=True)
text(s, 5.75, 2.6, 7.0, 0.4, "Runs in any browser · phone, tablet or laptop · Arabic and English", size=14, color=MUTED)
tries = [
    ("Demo", "Press Demo next to Tour: the 90-second WASL story plays inside the twin."),
    ("Planner", "Open the planner, click a load-increase mark (busiest week, 2026 peak) and watch the hours move."),
    ("Goal seek", "Set a target such as 3.5 h and let the model find three costed plans."),
    ("Ride along", "Click any truck: its plate, its expected journey and its delay risk."),
]
for i, (h, d) in enumerate(tries):
    cy = 3.3 + i * 0.85
    o = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5.75), Inches(cy), Inches(0.5), Inches(0.5))
    o.fill.solid(); o.fill.fore_color.rgb = rgb(TEAL); o.line.fill.background()
    text(s, 5.75, cy, 0.5, 0.5, str(i + 1), size=15, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 6.45, cy - 0.02, 6.3, 0.75, [[(h + "  ", {"bold": True, "color": INK}), (d, {})]], size=14.5, color=INK2)
footer(s)

# 9 Thank you
s = new("Close with the slogan and open for questions. The appendix holds the AI detail; jump to it when the jury asks where the AI is.")
logo_mark(s, 6.17, 1.2, 1.0)
text(s, 0.6, 2.55, 12.1, 1.2, "Thank you", size=60, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.6, 3.65, 12.1, 0.6, "وصل", size=26, color=GOLD, font=FAR, align=PP_ALIGN.CENTER)
text(s, 0.6, 4.2, 12.1, 0.5, "We connect you to your vision", size=22, color=INK2, align=PP_ALIGN.CENTER)
text(s, 0.6, 4.8, 12.1, 0.5, "Watch · Anticipate · Simulate · Lead", size=17, color=MUTED, align=PP_ALIGN.CENTER)
text(s, 0.6, 5.6, 12.1, 0.4, "Questions welcome · appendix: AI architecture, each model, data, scaling", size=13, color=MUTED, align=PP_ALIGN.CENTER)

# ============================== APPENDIX ==============================

s = new("Appendix divider.")
text(s, 0.6, 2.8, 12.1, 1.0, "Appendix", size=54, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.6, 3.8, 12.1, 0.6, "Where is the AI · each model · the problem in data · costs · scaling · questions", size=18, color=MUTED, align=PP_ALIGN.CENTER)

# A1 Logo concepts
s = new("Side task: four logo directions. A is used in this deck. All are built from simple shapes, so a designer can refine them.")
kicker(s, "Appendix · brand")
title(s, "Logo concepts: connection, vision, smart planning")
concepts = [
    ("A · The Bridge", "An arch joins W to L: today's port to the vision. The dot is the truck arriving."),
    ("B · Waypoints", "Nodes on a rising path to a target ring: data → plan → goal."),
    ("C · Arabic monogram", "The Arabic word in a rounded tile with an arrow: bilingual and direct."),
    ("D · The Lens", "An eye (watch) with a rising horizon line (anticipate)."),
]
for i, (h, d) in enumerate(concepts):
    cx = 0.6 + i * 3.08
    box(s, cx, 2.1, 2.85, 3.5, fill=CARD)
    ox, oy = cx + 0.72, 2.45
    if i == 0:
        logo_mark(s, ox, oy, 1.4)
    elif i == 1:
        box(s, ox, oy, 1.4, 1.4, fill=CARD2, radius=0.22)
        nodes = [(0.2, 1.05), (0.5, 0.8), (0.8, 0.62), (1.07, 0.32)]
        for (ax, ay), (bx, by) in zip(nodes, nodes[1:]):
            c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(ox + ax + 0.06), Inches(oy + ay + 0.06), Inches(ox + bx + 0.06), Inches(oy + by + 0.06))
            c.line.color.rgb = rgb(TEAL); c.line.width = Pt(2.5)
        for ax, ay in nodes[:-1]:
            d_ = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(ox + ax), Inches(oy + ay), Inches(0.13), Inches(0.13))
            d_.fill.solid(); d_.fill.fore_color.rgb = rgb(TEAL); d_.line.fill.background()
        r_ = s.shapes.add_shape(MSO_SHAPE.DONUT, Inches(ox + 0.98), Inches(oy + 0.18), Inches(0.36), Inches(0.36))
        r_.fill.solid(); r_.fill.fore_color.rgb = rgb(GOLD); r_.line.fill.background(); r_.adjustments[0] = 0.12
    elif i == 2:
        box(s, ox, oy, 1.4, 1.4, fill=GOLD, radius=0.22)
        text(s, ox, oy + 0.18, 1.4, 0.8, "وصل", size=36, color=BG, bold=True, align=PP_ALIGN.CENTER, font=FAR)
        a_ = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(ox + 0.45), Inches(oy + 1.02), Inches(0.5), Inches(0.2))
        a_.fill.solid(); a_.fill.fore_color.rgb = rgb(BG); a_.line.fill.background()
    else:
        box(s, ox, oy, 1.4, 1.4, fill=CARD2, radius=0.22)
        e_ = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(ox + 0.15), Inches(oy + 0.42), Inches(1.1), Inches(0.56))
        e_.fill.background(); e_.line.color.rgb = rgb(TEAL); e_.line.width = Pt(2.5)
        p_ = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(ox + 0.55), Inches(oy + 0.55), Inches(0.3), Inches(0.3))
        p_.fill.solid(); p_.fill.fore_color.rgb = rgb(GOLD); p_.line.fill.background()
        c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(ox + 0.2), Inches(oy + 1.18), Inches(ox + 1.2), Inches(oy + 1.0))
        c.line.color.rgb = rgb(GOLD); c.line.width = Pt(2.5)
    text(s, cx + 0.25, 4.15, 2.4, 0.45, h, size=16, color=INK, bold=True)
    text(s, cx + 0.25, 4.65, 2.4, 1.6, d, size=13, color=INK2)
footer(s)

# A2 Architecture
s = new("Where is the AI: six parts. Three are learned offline from GAC data (generator, risk model, demand). Three run live in the browser on top of them (queueing twin, bottleneck mining, goal seeking).")
kicker(s, "Appendix · where is the AI")
title(s, "Six AI parts, from raw extracts to a costed decision")
box(s, 0.6, 2.05, 2.6, 4.3, fill=CARD2)
text(s, 0.8, 2.25, 2.25, 4.0, [[("GAC extracts", {"bold": True, "color": INK, "size": 16})], "1.37 M rows of gate passes, declarations, OGA", "Cleaned as in the bottleneck report", "198,665 trucks, 7 stages", [("Raw data never leaves GAC", {"color": GOLD})]], size=13, color=INK2, spacing=8)
parts = [
    ("1", "Synthetic truck generator", "Gaussian mixtures by category × X-ray, BIC", "Learned offline", TEAL),
    ("2", "Delay-risk model", "Gradient-boosted trees, AUC 0.70", "Learned offline", TEAL),
    ("3", "Demand & elasticity", "Growth + log-log regression", "Learned offline", TEAL),
    ("4", "Queueing digital twin", "M/M/c by hour, calibrated", "Live in browser", GOLD),
    ("5", "Bottleneck mining", "Truck-hour share + lift", "Live in browser", GOLD),
    ("6", "Goal seeking", "Inverse search, ablation, costing", "Live in browser", GOLD),
]
for i, (n, h, d, where, c) in enumerate(parts):
    col, row = i // 3, i % 3
    cx = 3.6 + col * 4.65
    cy = 2.05 + row * 1.47
    box(s, cx, cy, 4.4, 1.3, fill=CARD)
    o = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx + 0.22), Inches(cy + 0.38), Inches(0.52), Inches(0.52))
    o.fill.solid(); o.fill.fore_color.rgb = rgb(c); o.line.fill.background()
    text(s, cx + 0.22, cy + 0.38, 0.52, 0.52, n, size=16, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, cx + 0.95, cy + 0.18, 3.3, 0.4, h, size=16, color=INK, bold=True)
    text(s, cx + 0.95, cy + 0.56, 3.3, 0.35, d, size=12.5, color=INK2)
    text(s, cx + 0.95, cy + 0.88, 3.3, 0.3, where, size=11, color=c)
for yy in (2.7, 4.17, 5.64):
    a_ = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(3.25), Inches(yy - 0.1), Inches(0.28), Inches(0.2))
    a_.fill.solid(); a_.fill.fore_color.rgb = rgb(LINE); a_.line.fill.background()
text(s, 0.6, 6.55, 12.1, 0.4, "Output on screen: learned.json (aggregates + 4,000 synthetic trucks) → 3D twin, dashboard, what-if planner, goal seek, executive board", size=13, color=MUTED)
footer(s)

# A3 Generator
s = new("The generator is unsupervised learning: it learns the joint distribution of stage times, so synthetic trucks behave like real ones without copying any. KS distance under 0.12 in every segment.")
kicker(s, "Appendix · AI part 1")
title(s, "Synthetic trucks that behave like the real ones")
bullets(s, 0.6, 2.0, 6.0, 4.2, [
    [("Model  ", {"bold": True, "color": INK}), ("Gaussian mixture, full covariance, on log(1+minutes) of 6 stage times", {})],
    [("Segments  ", {"bold": True, "color": INK}), ("one per goods category (chemical, OGA, health) × X-ray or not; 3-6 components chosen by BIC", {})],
    [("Coupling  ", {"bold": True, "color": INK}), ("arrival hour, declarations, plate country resampled and rank-coupled, so night arrivals stay slow", {})],
    [("Output  ", {"bold": True, "color": INK}), ("4,000 synthetic trucks; every truck in the 3D scene is one, with a plate in its country's format", {})],
    [("Why  ", {"bold": True, "color": INK}), ("realism without exposing a single real truck or plate", {})],
], size=14)
rows = [("Segment", "Real median", "Synthetic", "KS"), ("Chemical", "5.0 h", "5.4 h", "0.058"), ("Chemical + X-ray", "5.4 h", "5.6 h", "0.046"), ("Health & food", "5.1 h", "5.4 h", "0.050"), ("Health + X-ray", "6.3 h", "6.3 h", "0.113"), ("OGA", "7.7 h", "8.1 h", "0.025"), ("OGA + X-ray", "8.4 h", "9.0 h", "0.106")]
tb = s.shapes.add_table(len(rows), 4, Inches(7.0), Inches(2.0), Inches(5.75), Inches(3.6)).table
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        cell = tb.cell(r, c)
        cell.fill.solid(); cell.fill.fore_color.rgb = rgb(CARD2 if r == 0 else CARD)
        cell.text = v
        p = cell.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.LEFT if c == 0 else PP_ALIGN.RIGHT
        f = p.runs[0].font; f.size = Pt(13); f.name = F; f.bold = r == 0; f.color.rgb = rgb(MUTED if r == 0 else INK)
text(s, 7.0, 5.8, 5.75, 0.6, "Validation: two-sample Kolmogorov-Smirnov distance between real and synthetic stays, per segment (lower is closer).", size=12, color=MUTED)
footer(s)

# A4 Risk model
s = new("Supervised: will this truck stay more than 8 hours? Trained on time order and tested on the last 60 days. Arrival hour is the strongest driver, which links straight to the shift-handover finding.")
kicker(s, "Appendix · AI part 2")
title(s, "Delay-risk model: which trucks will be stuck, and why")
bullets(s, 0.6, 2.0, 5.4, 4.3, [
    [("Target  ", {"bold": True, "color": INK}), ("stay over 8 hours (35% of trucks)", {})],
    [("Model  ", {"bold": True, "color": INK}), ("histogram gradient-boosted trees, 250 iterations, native categorical splits", {})],
    [("Validation  ", {"bold": True, "color": INK}), ("time split: 152k trucks train, last 60 days (46.5k) test, ROC AUC 0.70", {})],
    [("Explainability  ", {"bold": True, "color": INK}), ("permutation importance on the hold-out", {})],
    [("In the twin  ", {"bold": True, "color": INK}), ("click any truck: \"Delay risk 60%, driven by arrival hour, shared declaration\"", {})],
], size=14)
cd = CategoryChartData()
feat = [("Arrival hour", 0.103), ("Goods category", 0.051), ("Shared declaration", 0.040), ("Plate country", 0.033), ("Declarations", 0.011), ("X-ray", 0.005), ("Weekday", 0.004)]
cd.categories = [f for f, _ in reversed(feat)]
cd.add_series("AUC drop", [v for _, v in reversed(feat)])
gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, Inches(6.4), Inches(1.95), Inches(6.35), Inches(4.4), cd)
ch = gf.chart
ch.has_title = True; ch.chart_title.text_frame.text = "Feature importance (AUC drop when shuffled)"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(13); ch.chart_title.text_frame.paragraphs[0].runs[0].font.color.rgb = rgb(INK2)
plot = chart_style(ch, fmt='0.000')
plot.gap_width = 60
plot.series[0].format.fill.solid(); plot.series[0].format.fill.fore_color.rgb = rgb(TEAL)
footer(s)

# A5 Demand and 2030
s = new("Demand is learned, not assumed: today's median day, the hourly rhythm, presets from the real daily series and growth from food declarations. The knee: the port copes until 2028, then queues carry over from day to day.")
kicker(s, "Appendix · AI part 3")
title(s, "Volume prediction to 2030: the port breaks in 2029")
cd = CategoryChartData()
cd.categories = ["2026", "2027", "2028", "2029", "2030"]
cd.add_series("As is", (5.9, 6.4, 7.1, 9.5, 12.6))
cd.add_series("With the Resilient plan", (3.2, 3.2, 3.2, 3.2, 3.3))
gf = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.6), Inches(1.95), Inches(7.2), Inches(4.4), cd)
ch = gf.chart
ch.has_title = True; ch.chart_title.text_frame.text = "Median time in port, hours"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(13); ch.chart_title.text_frame.paragraphs[0].runs[0].font.color.rgb = rgb(INK2)
plot = chart_style(ch, legend=True)
for ser, c in zip(plot.series, [ROSE, TEAL]):
    ser.format.line.color.rgb = rgb(c); ser.format.line.width = Pt(3); ser.smooth = False
    ser.marker.format.fill.solid(); ser.marker.format.fill.fore_color.rgb = rgb(c); ser.marker.format.line.color.rgb = rgb(c)
bullets(s, 8.2, 2.0, 4.6, 4.4, [
    [("Today  ", {"bold": True, "color": INK}), ("738 trucks/day (median of the last 90 days)", {})],
    [("Growth  ", {"bold": True, "color": INK}), ("food declarations +43%/yr (2023-26), halved each year: 1,077/day in 2030", {})],
    [("Elasticity  ", {"bold": True, "color": INK}), ("declaration wait +0.24% per 1% trucks; inspection queue flat", {})],
    [("Surge marks  ", {"bold": True, "color": INK}), ("busy day, busiest week (+16%), 2026 peak day (+30%): one click in the planner", {})],
    [("Check  ", {"bold": True, "color": INK}), ("busiest real weeks ran 6.0-6.4 h; the model gives 6.1 h", {})],
], size=14)
footer(s)

# A6 Queueing twin
s = new("The what-if engine. Queueing theory, calibrated to the data, turns lanes, docks and bays into hours. The calibration is fitted so the busiest real weeks are reproduced.")
kicker(s, "Appendix · AI part 4")
title(s, "The digital-twin engine: capacity in, hours out")
steps = [
    ("Arrivals by hour", "learned daily profile × scenario load"),
    ("X-ray lanes", "M/M/c queue, 7.6 min cycle (calibrated)"),
    ("Docks by category", "M/M/c, 2.2 h per truck; split inferred from waits"),
    ("Shift handovers", "capacity dips at 06, 13-14, 21-22 from data"),
    ("Parking", "Little's law × 1.2 peak; overflow waits at the gate"),
    ("Per-truck stages", "4,000 synthetic trucks rescaled → median, P90"),
]
for i, (h, d) in enumerate(steps):
    cx = 0.6 + i * 2.06
    box(s, cx, 2.15, 1.9, 2.3, fill=CARD)
    text(s, cx + 0.18, 2.3, 1.6, 0.35, f"{i + 1:02d}", size=13, color=GOLD, bold=True)
    text(s, cx + 0.18, 2.7, 1.6, 0.7, h, size=15, color=INK, bold=True)
    text(s, cx + 0.18, 3.4, 1.6, 1.0, d, size=12, color=INK2)
box(s, 0.6, 4.75, 12.15, 1.95, fill=CARD2)
text(s, 0.85, 4.9, 11.7, 1.7, [
    [("Key insight from the data  ", {"bold": True, "color": TEAL}), ("2026 volume went from 350 to 840 trucks a day while the weekly median stayed at 5-6 h. So only about 25% of today's X-ray and dock wait is congestion; the rest is process latency. That is why the winning plans are process levers first.", {})],
    [("Smart ramp split  ", {"bold": True, "color": TEAL}), ("docks per category = load + β·√load (square-root staffing, Halfin-Whitt), so extra ramps go where the queue is.", {})],
], size=14, color=INK2, spacing=8)
footer(s)

# A7 Bottleneck + goal seek
s = new("Two live analytics. Bottleneck mining names the stage and the trucks over-represented in it. Goal seeking is reverse engineering: it searches every lever combination, keeps three distinct plans, and explains each by ablation.")
kicker(s, "Appendix · AI parts 5 and 6")
title(s, "Bottleneck mining and goal seeking")
box(s, 0.6, 2.0, 5.9, 4.6, fill=CARD)
text(s, 0.85, 2.2, 5.5, 4.3, [
    [("Bottleneck mining", {"bold": True, "color": INK, "size": 18})],
    "The stage with the largest share of truck-hours, plus the hottest resource.",
    [("Lift  ", {"bold": True, "color": GOLD}), ("share of an attribute among the slowest quarter ÷ its share overall", {})],
    [("Today  ", {"bold": True, "color": GOLD}), ("waiting for the declaration, 51% of truck-hours. Night arrivals are 2.8× over-represented; OGA goods 1.4×.", {})],
    [("2030 as is  ", {"bold": True, "color": GOLD}), ("queue for inspection; chemical-docks trucks 1.9×; parking 112%.", {})],
], size=14, color=INK2, spacing=10)
box(s, 6.85, 2.0, 5.9, 4.6, fill=CARD)
text(s, 7.1, 2.2, 5.5, 4.3, [
    [("Goal seeking (inverse simulation)", {"bold": True, "color": INK, "size": 18})],
    "Target in, plans out: 3,402 combinations of X-ray lanes, docks and split, parking, pre-filing, green channel and shift overlap, in about 7 s.",
    [("Cost-smart  ", {"bold": True, "color": GOOD}), ("cheapest plan that reaches the goal", {})],
    [("Resilient  ", {"bold": True, "color": GOLD}), ("cheapest that still holds in the busiest week (+16%)", {})],
    [("Best result  ", {"bold": True, "color": TEAL}), ("lowest time for ≤ 1.5× the cheapest budget", {})],
    [("Explained by ablation  ", {"bold": True, "color": INK}), ("remove each lever, measure the hours lost", {})],
], size=14, color=INK2, spacing=8)
footer(s)

# A8 Costs
s = new("Costs are arithmetic on the model output: units changed × public unit cost, capex plus 5 years of opex, converted at 3.64 QAR per USD. Replace with GAC procurement figures for a real decision.")
kicker(s, "Appendix · cost model")
title(s, "Every plan is costed from public unit benchmarks")
rows = [("Resource", "Unit cost (QAR)", "Lead", "Basis"),
        ("Drive-through X-ray lane", "16.4 M + 1.9 M/yr", "12 mo", "LINAC portal US$3-6 M; 9 operators"),
        ("Inspection dock (ramp)", "290 k + 540 k/yr", "6 mo", "Dock US$20-36 k (Terrapin 2026); 3.6 inspectors"),
        ("Truck parking bay", "91 k + 2 k/yr", "6 mo", "Paving only (ATRI US$93.5 k full build)"),
        ("Pre-arrival filing, per 10 pts", "0.8 M + 0.25 M/yr", "4 mo", "Broker onboarding, API (estimate)"),
        ("Green channel, per 10 pts", "1.2 M + 0.6 M/yr", "6 mo", "Risk rules, audit staff (estimate)"),
        ("Shift overlap", "0.1 M + 0.9 M/yr", "1 mo", "One paid overlap hour per shift"),
        ("Truck time (value)", "330 per truck-hour", "-", "ATRI 2024: US$90.89/h operating cost")]
tb = s.shapes.add_table(len(rows), 4, Inches(0.6), Inches(2.0), Inches(12.15), Inches(4.3)).table
widths = [3.2, 2.6, 1.1, 5.25]
for c, wv in enumerate(widths):
    tb.columns[c].width = Inches(wv)
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        cell = tb.cell(r, c)
        cell.fill.solid(); cell.fill.fore_color.rgb = rgb(CARD2 if r == 0 else CARD)
        cell.text = v
        p = cell.text_frame.paragraphs[0]
        f = p.runs[0].font; f.size = Pt(13); f.name = F; f.bold = r == 0; f.color.rgb = rgb(MUTED if r == 0 else (INK if c < 2 else INK2))
text(s, 0.6, 6.45, 12.1, 0.5, "Sources: vendor ranges and US CBP awards, CBO 51478, Terrapin 2026, ATRI (truck parking; Operational Costs of Trucking 2025), Naukrigulf and Paylab Qatar salaries.", size=11, color=MUTED)
footer(s)

# A9 Problem deep dive
s = new("The problem in data. Half the time is paperwork; a third is the inspection queue, which waits on agency review as much as on docks. Shift handovers cut inspection starts by up to 75%.")
kicker(s, "Appendix · the problem in data")
title(s, "Where a truck's time goes today")
cd = CategoryChartData()
cd.categories = ["Inspection", "Release and exit", "Queue for X-ray", "Queue for inspection", "Wait for declaration"]
cd.add_series("Share of truck-hours", (0.042, 0.044, 0.05, 0.349, 0.514))
gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, Inches(0.6), Inches(1.95), Inches(6.3), Inches(4.4), cd)
ch = gf.chart
ch.has_title = True; ch.chart_title.text_frame.text = "Share of all truck-hours by stage"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(13); ch.chart_title.text_frame.paragraphs[0].runs[0].font.color.rgb = rgb(INK2)
plot = chart_style(ch, fmt='0%')
plot.gap_width = 60
ch.value_axis.maximum_scale = 0.6
plot.series[0].format.fill.solid(); plot.series[0].format.fill.fore_color.rgb = rgb(GOLD)
bullets(s, 7.3, 2.0, 5.45, 4.4, [
    [("Goods categories  ", {"bold": True, "color": INK}), ("chemical & others 50%, OGA 25%, health & food 25%; inspection queue median 99, 189, 174 min", {})],
    [("Process, not concrete  ", {"bold": True, "color": INK}), ("0% pre-filed and ~100% red lane: every truck waits for paperwork, then for inspection", {})],
    [("Shift handovers  ", {"bold": True, "color": INK}), ("inspection starts drop to 25-65% of normal at 06:00, 13-14:00 and 21-22:00", {})],
    [("Night arrivals  ", {"bold": True, "color": INK}), ("2.8× over-represented among the slowest trucks", {})],
    [("Plates  ", {"bold": True, "color": INK}), ("Qatar 40%, Saudi Arabia 38%, Kuwait 8%, Oman 8%, UAE 6%", {})],
], size=14)
footer(s, "Synthetic figures from the WASL port model; medians, following the bottleneck report's filtering.")

# A10 Data and governance
s = new("How we treated the data, and why the twin is safe to share: the raw extracts stay on the GAC machine; only aggregates and synthetic trucks reach the app.")
kicker(s, "Appendix · data and governance")
title(s, "Clean data in, synthetic data out")
flow = [("1.37 M rows", "gate passes, declarations, OGA extracts"), ("Deduplicate", "→ 1,372,877 rows"), ("One row per truck", "198,665 commercial + 1,484 courier"), ("Filter", "drop stays ≤ 0 or > 7 days"), ("7 stages", "milestones clamped in order"), ("Medians only", "as in the bottleneck report")]
for i, (h, d) in enumerate(flow):
    cx = 0.6 + i * 2.06
    box(s, cx, 2.1, 1.9, 1.9, fill=CARD)
    text(s, cx + 0.18, 2.3, 1.6, 0.6, h, size=15, color=TEAL, bold=True)
    text(s, cx + 0.18, 2.95, 1.6, 0.95, d, size=12, color=INK2)
    if i < len(flow) - 1:
        a_ = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(cx + 1.91), Inches(2.95), Inches(0.14), Inches(0.2))
        a_.fill.solid(); a_.fill.fore_color.rgb = rgb(LINE); a_.line.fill.background()
bullets(s, 0.6, 4.45, 12.1, 2.4, [
    [("Privacy by design  ", {"bold": True, "color": INK}), ("no real plate, declaration or truck appears anywhere in the app; plates are generated in each country's format", {})],
    [("Reproducible  ", {"bold": True, "color": INK}), ("one script (ml/learn.py) rebuilds every model; metrics are saved for audit (ml/metrics.json)", {})],
    [("Tested  ", {"bold": True, "color": INK}), ("automated check: today's synthetic median within 0.6 h of the real one; more capacity never makes things worse", {})],
], size=14)
footer(s)

# A11 Scaling
s = new("Scaling: the pipeline is port-agnostic. Five steps take it to another port in weeks, then the same twin serves a network view.")
kicker(s, "Appendix · scaling")
title(s, "From one land port to every Qatari gateway")
steps = [("Connect", "the port's gate-pass and declaration feed (same schema as GAC)"), ("Map", "rebuild the 3D scene from OpenStreetMap and the site plan"), ("Learn", "re-run ml/learn.py: generator, risk, demand"), ("Calibrate", "fit the queue model to that port's waits"), ("Pilot", "planners use it weekly; measure decisions and hours saved")]
for i, (h, d) in enumerate(steps):
    cx = 0.6 + i * 2.47
    box(s, cx, 2.1, 2.3, 2.3, fill=CARD)
    o = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx + 0.22), Inches(2.3), Inches(0.5), Inches(0.5))
    o.fill.solid(); o.fill.fore_color.rgb = rgb(TEAL); o.line.fill.background()
    text(s, cx + 0.22, 2.3, 0.5, 0.5, str(i + 1), size=15, color=BG, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, cx + 0.22, 2.95, 1.95, 0.45, h, size=17, color=INK, bold=True)
    text(s, cx + 0.22, 3.4, 1.95, 1.0, d, size=12.5, color=INK2)
box(s, 0.6, 4.7, 5.9, 1.95, fill=CARD2)
text(s, 0.85, 4.85, 5.5, 1.7, [[("Next gateways", {"bold": True, "color": GOLD, "size": 16})], "Hamad Port (sea containers)", "Hamad International Airport cargo", "Ruwais port and other border points"], size=14, color=INK2, spacing=4)
box(s, 6.85, 4.7, 5.9, 1.95, fill=CARD2)
text(s, 7.1, 4.85, 5.5, 1.7, [[("Network view", {"bold": True, "color": GOLD, "size": 16})], "One twin per gateway, one national dashboard", "Shift demand between gateways in a crisis", "Shared goal seek across the network"], size=14, color=INK2, spacing=4)
footer(s)

# A12 Roadmap
s = new("Ideas the jury may ask about. Each builds on what exists today.")
kicker(s, "Appendix · roadmap")
title(s, "What comes next")
ideas = [
    ("Live data feed", "Replace the synthetic arrivals with today's gate passes; the twin becomes an operations room."),
    ("Plate recognition", "Link our plate-reader work (ANPR) to log real arrival times automatically."),
    ("Truck appointments", "Use the hourly forecast to offer arrival slots and flatten the shift-handover peaks."),
    ("Ask WASL", "A language-model assistant: \"what if Saudi traffic rises 20% in Ramadan?\""),
    ("Risk-based green lane", "Use the delay-risk and inspection history to grow a safe green channel."),
    ("Crisis playbooks", "Pre-computed plans for corridor disruptions, ready in one click."),
]
for i, (h, d) in enumerate(ideas):
    cx = 0.6 + (i % 3) * 4.1
    cy = 2.05 + (i // 3) * 2.35
    box(s, cx, cy, 3.85, 2.1, fill=CARD)
    text(s, cx + 0.3, cy + 0.28, 3.3, 0.45, h, size=18, color=TEAL, bold=True)
    text(s, cx + 0.3, cy + 0.85, 3.3, 1.15, d, size=14, color=INK2)
footer(s)

# A13 Assumptions
s = new("Be upfront: these are the assumptions behind the numbers, each with its basis. Judges trust a team that knows its limits.")
kicker(s, "Appendix · assumptions")
title(s, "What the numbers rest on")
rows = [("Assumption", "Value", "Basis"),
        ("Share of X-ray and dock wait that is congestion", "25%", "Fitted: busiest 2026 weeks (+14%) ran 6.0-6.4 h"),
        ("Declaration wait kept by a pre-filed truck", "10%", "About 9 min to match and release on arrival"),
        ("Growth after 2026", "43%/yr, halved yearly", "Food declarations 2023-26; 2030 = 1.46× today"),
        ("Peak-hour parking over daily mean", "1.2×", "Hourly arrival profile"),
        ("Value of one truck-hour", "QAR 330", "ATRI 2024 operating cost, US$90.89/h"),
        ("Figures on screen", "synthetic", "Built to behave like the port, not to report it")]
tb = s.shapes.add_table(len(rows), 3, Inches(0.6), Inches(2.0), Inches(12.15), Inches(3.9)).table
for c, wv in enumerate([5.0, 2.6, 4.55]):
    tb.columns[c].width = Inches(wv)
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        cell = tb.cell(r, c)
        cell.fill.solid(); cell.fill.fore_color.rgb = rgb(CARD2 if r == 0 else CARD)
        cell.text = v
        f = cell.text_frame.paragraphs[0].runs[0].font; f.size = Pt(13); f.name = F; f.bold = r == 0; f.color.rgb = rgb(MUTED if r == 0 else (INK if c < 2 else INK2))
text(s, 0.6, 6.15, 12.1, 0.6, "Every assumption is a named setting in config.json: change it and the twin, the plans and the costs update.", size=13, color=MUTED)
footer(s)

# A14 Q&A
s = new("Short answers to likely jury questions.")
kicker(s, "Appendix · jury Q&A")
title(s, "Likely questions, short answers")
qa = [
    ("Where is the AI?", "Six parts: a generative model of trucks, a delay-risk classifier, a demand model, a calibrated queueing twin, bottleneck mining and goal seeking."),
    ("Are the numbers real?", "Shaped by 198,665 real trucks, shown as synthetic medians. Today's model median is within 0.3 h of the data."),
    ("Why process levers, not more X-ray?", "The data shows waits stayed flat while volume doubled: most of the wait is process, so process changes win per riyal."),
    ("How fast to deploy?", "Runs in any browser today. A live data feed and a weekly planning pilot are the next steps."),
    ("Is the data safe?", "Raw extracts never leave GAC. The app holds aggregates and synthetic trucks only."),
    ("Can it scale?", "Same pipeline for any port: connect, map, learn, calibrate, pilot."),
]
for i, (q, a) in enumerate(qa):
    cx = 0.6 + (i % 2) * 6.15
    cy = 2.0 + (i // 2) * 1.6
    box(s, cx, cy, 5.95, 1.45, fill=CARD)
    text(s, cx + 0.25, cy + 0.15, 5.5, 0.4, q, size=15, color=GOLD, bold=True)
    text(s, cx + 0.25, cy + 0.55, 5.5, 0.85, a, size=13, color=INK2)
footer(s)

prs.save(OUT)
print(OUT, len(prs.slides), "slides")
