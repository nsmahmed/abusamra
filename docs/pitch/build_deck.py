"""Builds the AI Accelerate 2.0 pitch deck for WASL: python docs/pitch/build_deck.py

Bright, executive-level deck. Main part follows the jury format (problem 1 slide, live demo,
value 1 slide); the appendix explains each AI part with a picture plus a one-line model card.
Figures come from the learned port model (view/twin/portmodel.js, tests/model_test.py).
Icons are Font Awesome Free (pip install fontawesomefree), rendered to PNG at build time.
"""
import os
import re
import random
import tempfile
import qrcode
import fontawesomefree
from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "WASL_AI_Accelerate_pitch.pptx")
SITE = "https://nsmahmed.github.io/abusamra/"  # the live twin; links and the QR point here
QR_URL = SITE + "view/twin/?m=1"                # phones scanning the QR get the simple phone view
LINK_TXT = "Open the WASL live twin"           # what the audience reads (no account name on screen)

# friendly palette, a touch deeper so it is easy on the eyes
BG = "F5F7FA"; WHITE = "FFFFFF"; INK = "152C44"; INK2 = "3A5068"; MUTED = "72839A"; LINE = "D3DDE7"
TEAL = "0E8E8E"; TEAL_D = "0A6B6B"; TEAL_T = "DCEFEE"
CORAL = "E8684A"; CORAL_T = "FAE3DA"
SUN = "E5A823"; SUN_T = "F8EDCF"
GRAPE = "6B5BD9"; GRAPE_T = "E6E3F8"
MINT = "1FA676"; MINT_T = "D9EFE5"
F = "Calibri"; FAR = "Segoe UI"

# ---------- icons (Font Awesome Free, solid) ----------
FA = os.path.join(os.path.dirname(fontawesomefree.__file__), "static", "fontawesomefree")
FA_TTF = os.path.join(FA, "webfonts", "fa-solid-900.ttf")
_css = open(os.path.join(FA, "css", "all.css"), encoding="utf8").read()
GLYPH = {}
for _n, _cp in re.findall(r'\.fa-([a-z0-9-]+)::before\s*\{\s*content:\s*"\\([0-9a-f]+)"', _css):
    GLYPH.setdefault(_n, chr(int(_cp, 16)))
ICON_DIR = os.path.join(tempfile.gettempdir(), "wasl_deck_icons")
os.makedirs(ICON_DIR, exist_ok=True)
_font = ImageFont.truetype(FA_TTF, 200)


def icon_png(name, color):
    path = os.path.join(ICON_DIR, f"{name}_{color}.png")
    if not os.path.exists(path):
        im = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        l, t, r, b = d.textbbox((0, 0), GLYPH[name], font=_font)
        d.text(((256 - (r - l)) / 2 - l, (256 - (b - t)) / 2 - t), GLYPH[name], font=_font, fill="#" + color)
        im.save(path)
    return path


prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]


def rgb(h):
    return RGBColor.from_string(h)


def new(notes="", bg=BG):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = rgb(bg)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def alpha(shape, pct):
    """Make a solid fill pct% opaque."""
    clr = shape.fill._xPr.find(qn("a:solidFill"))[0]
    a = etree.SubElement(clr, qn("a:alpha")); a.set("val", str(int(pct * 1000)))


def shp(s, kind, x, y, w, h, fill=None, line=None, lw=1.25, name=None, radius=None, rot=0):
    sh = s.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    if fill:
        sh.fill.solid(); sh.fill.fore_color.rgb = rgb(fill)
    else:
        sh.fill.background()
    if line:
        sh.line.color.rgb = rgb(line); sh.line.width = Pt(lw)
    else:
        sh.line.fill.background()
    if radius is not None and kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        sh.adjustments[0] = radius
    if rot:
        sh.rotation = rot
    sh.shadow.inherit = False
    if name:
        sh.name = name
    return sh


def card(s, x, y, w, h, fill=WHITE, line=LINE, radius=0.1):
    return shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, fill=fill, line=line, radius=radius)


def text(s, x, y, w, h, runs, size=16, color=INK, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, font=F, spacing=None, link=None):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
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
        for t, o in (para if isinstance(para, list) else [(para, {})]):
            r = p.add_run()
            r.text = t
            f = r.font
            f.name = o.get("font", font); f.size = Pt(o.get("size", size))
            f.bold = o.get("bold", bold); f.italic = o.get("italic", False)
            f.color.rgb = rgb(o.get("color", color))
            if o.get("link", link):
                r.hyperlink.address = o.get("link", link)
    return tb


def pic(s, path, x, y, w, h=None, name=None):
    p = s.shapes.add_picture(path, Inches(x), Inches(y), Inches(w), Inches(h if h else w))
    if name:
        p.name = name
    return p


def icon(s, x, y, d, name, color, mode="solid", halo=None):
    """Icon in a circle. solid: coloured disc, white glyph. soft: white disc, coloured glyph.
    ring: white disc with a coloured ring. bare: glyph only."""
    if halo:
        shp(s, MSO_SHAPE.OVAL, x - d * 0.12, y - d * 0.12, d * 1.24, d * 1.24, fill=halo)
    if mode == "solid":
        shp(s, MSO_SHAPE.OVAL, x, y, d, d, fill=color)
        g = icon_png(name, WHITE)
    elif mode == "soft":
        shp(s, MSO_SHAPE.OVAL, x, y, d, d, fill=WHITE)
        g = icon_png(name, color)
    elif mode == "ring":
        shp(s, MSO_SHAPE.OVAL, x, y, d, d, fill=WHITE, line=color, lw=4)
        g = icon_png(name, color)
    else:
        g = icon_png(name, color)
        return pic(s, g, x, y, d, name=f"icon {name}")
    k = 0.5
    return pic(s, g, x + d * (1 - k) / 2, y + d * (1 - k) / 2, d * k, name=f"icon {name}")


def dot(s, x, y, d, fill):
    return shp(s, MSO_SHAPE.OVAL, x - d / 2, y - d / 2, d, d, fill=fill)


def line(s, x1, y1, x2, y2, color=LINE, w=2, dash=False):
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = rgb(color); c.line.width = Pt(w)
    if dash:
        c.line.dash_style = 4
    return c


def kicker(s, label, color=TEAL):
    text(s, 0.7, 0.5, 9, 0.3, label.upper(), size=12, color=color, bold=True)


def title(s, t, size=36, y=0.85, w=11.9):
    return text(s, 0.7, y, w, 1.0, t, size=size, color=INK, bold=True)


def logo(s, x, y, d=1.0, tile=TEAL):
    """The WASL mark: the arch (bracket) joins today, on the left, to the vision, on the right.
    The vision end is a target: WASL aims you at it."""
    shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, d, d, fill=tile, radius=0.28, name="WASL logo tile")
    arc = shp(s, MSO_SHAPE.BLOCK_ARC, x + d * 0.17, y + d * 0.27, d * 0.62, d * 0.62, fill=SUN, name="WASL arch")
    arc.adjustments[2] = 0.15
    ey = y + d * 0.58
    dot(s, x + d * 0.217, ey, d * 0.14, WHITE)
    tx = x + d * 0.743
    dot(s, tx, ey, d * 0.27, CORAL)
    dot(s, tx, ey, d * 0.18, WHITE)
    dot(s, tx, ey, d * 0.09, CORAL)


def footer(s):
    text(s, 0.7, 7.0, 8, 0.3, "WASL · AI Accelerate 2.0", size=10, color=MUTED)


def model_card(s, items, y=5.78, h=1.08):
    """One strip under an AI slide: model, what it learns, how we checked it."""
    card(s, 0.7, y, 11.95, h, fill=WHITE, line=LINE, radius=0.18)
    w = 11.95 / len(items)
    for i, (lab, body, c) in enumerate(items):
        x = 0.7 + i * w
        if i:
            line(s, x, y + 0.18, x, y + h - 0.18, color=LINE, w=1)
        text(s, x + 0.25, y + 0.13, w - 0.45, 0.25, lab.upper(), size=10, color=c, bold=True)
        text(s, x + 0.22, y + 0.37, w - 0.36, h - 0.42, body, size=11.5, color=INK)


# ================================ MAIN ================================

# 1 Cover
s = new("Open with a smile: WASL connects the port of today to the vision of tomorrow. Thirty seconds.")
shp(s, MSO_SHAPE.OVAL, 8.4, -1.6, 7.0, 7.0, fill=TEAL_T)
shp(s, MSO_SHAPE.OVAL, 10.6, 4.3, 4.0, 4.0, fill=SUN_T)
logo(s, 9.7, 1.75, 2.6)
logo(s, 0.7, 0.6, 0.8)
text(s, 0.7, 2.0, 8, 1.6, "WASL", size=110, color=TEAL_D, bold=True)
text(s, 0.75, 3.75, 1.4, 0.6, "وصل", size=30, color=CORAL, bold=True, font=FAR)
text(s, 2.05, 3.8, 7, 0.6, "We connect you to your vision", size=28, color=INK)
text(s, 0.75, 4.7, 8, 0.5, [[("Watch", {"color": TEAL, "bold": True}), ("  ·  ", {"color": MUTED}), ("Anticipate", {"color": CORAL, "bold": True}), ("  ·  ", {"color": MUTED}), ("Simulate", {"color": GRAPE, "bold": True}), ("  ·  ", {"color": MUTED}), ("Lead", {"color": MINT, "bold": True})]], size=22)
text(s, 0.75, 5.6, 8, 0.5, "The AI digital twin of Abu Samra land port", size=18, color=INK2)
text(s, 0.75, 6.75, 8, 0.4, "AI Accelerate 2.0 · Malomatia", size=12, color=MUTED)

# 2 Team
s = new("One line each: name, role, what they built. Replace each circle with a photo: right-click > Change Picture, or insert a picture and Crop to Shape > Oval.")
kicker(s, "The team")
title(s, "The people behind WASL")
tints = [(TEAL, TEAL_T), (CORAL, CORAL_T), (GRAPE, GRAPE_T), (MINT, MINT_T)]
for i, (c, t) in enumerate(tints):
    x = 0.7 + i * 3.02
    card(s, x, 2.15, 2.78, 4.35, fill=t, line=None)
    shp(s, MSO_SHAPE.OVAL, x + 0.59, 2.5, 1.6, 1.6, fill=WHITE, line=c, lw=3, name=f"Photo {i + 1}")
    icon(s, x + 1.04, 2.95, 0.7, "user", c, mode="bare")
    text(s, x + 0.2, 4.4, 2.38, 0.45, "Full name", size=20, color=INK, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 4.9, 2.38, 0.4, "Title", size=15, color=c, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 5.4, 2.38, 0.8, "Role in WASL", size=13, color=INK2, align=PP_ALIGN.CENTER)
footer(s)

# 3 The name: each letter and its meaning only
s = new("Four letters, four promises. Read them out: Watch, Anticipate, Simulate, Lead.")
kicker(s, "The name")
title(s, "WASL means connection")
text(s, 6.6, 0.8, 1.6, 0.8, "وصل", size=36, color=CORAL, bold=True, font=FAR)
letters = [("W", "Watch", "see the port live", TEAL, TEAL_T), ("A", "Anticipate", "see 2030 coming", CORAL, CORAL_T), ("S", "Simulate", "try before you build", GRAPE, GRAPE_T), ("L", "Lead", "decide with evidence", MINT, MINT_T)]
for i, (L, w, d, c, t) in enumerate(letters):
    x = 0.7 + i * 3.02
    card(s, x, 2.2, 2.78, 4.2, fill=t, line=None)
    shp(s, MSO_SHAPE.OVAL, x + 0.64, 2.6, 1.5, 1.5, fill=c)
    text(s, x + 0.64, 2.6, 1.5, 1.5, L, size=64, color=WHITE, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x + 0.2, 4.45, 2.38, 0.6, w, size=28, color=INK, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.2, 5.15, 2.38, 0.5, d, size=17, color=INK2, align=PP_ALIGN.CENTER)
footer(s)

# 4 Business problem: the nine questions, as a road
s = new("About one minute. Trucks wait about six hours at Abu Samra, mostly for paperwork, and traffic keeps growing. A port leader has nine questions, from the pain point to a before-and-after check, and today none of them has a quick, evidence-based answer. That is the friction WASL removes.")
kicker(s, "01 · Business problem", color=CORAL)
title(s, "Nine questions a port leader asks. Today, no answers.", size=34)
qs = [
    ("Pain point", "Trucks wait hours. Why?", "hourglass-half"),
    ("Strategic vision", "Where must we be by 2030?", "binoculars"),
    ("KPIs", "Which numbers prove progress?", "gauge-high"),
    ("Volume prediction", "How many trucks are coming?", "chart-line"),
    ("Actions", "What must change to get there?", "screwdriver-wrench"),
    ("Value", "Is each action worth its cost?", "sack-dollar"),
    ("Recommendations", "What is the fastest way?", "compass"),
    ("Simulation", "How is the port doing right now?", "desktop"),
    ("Before & after", "What if we just carry on?", "scale-balanced"),
]
cols = [(TEAL, TEAL_T), (CORAL, CORAL_T), (GRAPE, GRAPE_T)]
pos = []
for i in range(len(qs)):
    r, c = i // 3, i % 3
    cc = c if r % 2 == 0 else 2 - c          # snake order, like a road
    pos.append((0.7 + cc * 4.05, 2.0 + r * 1.62))
for i in range(len(pos) - 1):
    (ax, ay), (bx, by) = pos[i], pos[i + 1]
    line(s, ax + 1.85, ay + 0.65, bx + 1.85, by + 0.65, color=SUN, w=4, dash=True)
for i, ((h, q, e), (x, y)) in enumerate(zip(qs, pos)):
    c, t = cols[i // 3]
    card(s, x, y, 3.75, 1.3, fill=t, line=None, radius=0.22)
    icon(s, x + 0.22, y + 0.27, 0.76, e, c)
    text(s, x + 1.15, y + 0.2, 2.5, 0.4, f"{i + 1} · {h}", size=15, color=c, bold=True)
    text(s, x + 1.15, y + 0.6, 2.5, 0.6, q, size=15, color=INK)
text(s, 0.7, 6.95, 12, 0.35, [[("Today: ", {"bold": True, "color": CORAL}), ("about 6 hours per truck in port, and half of it is waiting for paperwork.", {})]], size=14, color=INK2)

# 5 Live demo (clickable link)
s = new("Click the white button to open the live twin. Press Demo next to Tour for the guided story, then drive the planner live. Five minutes.", bg=TEAL_D)
shp(s, MSO_SHAPE.OVAL, -1.5, 4.2, 5.0, 5.0, fill="0C7A7A")
shp(s, MSO_SHAPE.OVAL, 10.4, -1.4, 4.5, 4.5, fill="0C7A7A")
logo(s, 6.17, 1.0, 1.0, tile=TEAL)
text(s, 0.7, 2.25, 11.9, 1.2, "Live demo", size=66, color=WHITE, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.7, 3.55, 11.9, 0.6, "Watch  →  Anticipate  →  Simulate  →  Lead", size=24, color=SUN, bold=True, align=PP_ALIGN.CENTER)
pill = shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, 3.92, 4.6, 5.5, 0.85, fill=WHITE, radius=0.5)
pill.click_action.hyperlink.address = SITE
ic = icon(s, 4.35, 4.8, 0.45, "arrow-up-right-from-square", TEAL_D, mode="bare")
ic.click_action.hyperlink.address = SITE
text(s, 5.0, 4.6, 4.2, 0.85, [[(LINK_TXT, {"link": SITE, "color": TEAL_D, "bold": True})]], size=22, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.7, 5.7, 11.9, 0.4, "click to open it in the browser", size=14, color="CBE6E5", align=PP_ALIGN.CENTER)

# 6 Value realization (one slide)
s = new("About two minutes. Continuing as is, the median truck needs 12.6 hours in 2030. With the plan WASL recommends, 3.3 hours, for QAR 42 million over five years: mostly smarter process, not concrete. The yearly value counts only truck time at QAR 330 an hour (ATRI 2024). Fill the adoption line with your test-phase numbers.")
kicker(s, "03 · Value realization", color=MINT)
title(s, "One decision gives 2030 back its hours")
bars = [("Today", 5.9, MUTED, "5.9 h"), ("2030 if we carry on", 12.6, CORAL, "12.6 h"), ("2030 with WASL's plan", 3.3, MINT, "3.3 h")]
for i, (lab, v, c, t) in enumerate(bars):
    y = 2.1 + i * 1.05
    text(s, 0.7, y + 0.12, 2.6, 0.5, lab, size=16, color=INK2, bold=i == 2)
    w = 5.0 * v / 12.6
    shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, 3.35, y, w, 0.7, fill=c, radius=0.5)
    text(s, 3.35 + w + 0.15, y + 0.08, 1.6, 0.6, t, size=24, color=c, bold=True)
tiles = [("9.3 h", "saved per truck", MINT, MINT_T), ("QAR 42 M", "plan cost, 5 years", TEAL, TEAL_T), ("~QAR 1.2 B", "truck time saved / year", SUN, SUN_T), ("7 sec", "to find the plan", GRAPE, GRAPE_T)]
for i, (b, l, c, t) in enumerate(tiles):
    x = 9.45 + (i % 2) * 1.75
    y = 2.0 + (i // 2) * 1.75
    card(s, x, y, 1.6, 1.55, fill=t, line=None, radius=0.15)
    text(s, x + 0.1, y + 0.25, 1.4, 0.6, b, size=20 if len(b) > 6 else 24, color=c, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.1, y + 0.9, 1.4, 0.55, l, size=12, color=INK2, align=PP_ALIGN.CENTER)
card(s, 0.7, 5.6, 11.95, 0.95, fill=SUN_T, line=None, radius=0.3)
icon(s, 0.95, 5.77, 0.6, "users", SUN)
text(s, 1.8, 5.6, 10.6, 0.95, [[("Adoption:  ", {"bold": True, "color": INK}), ("___ users  ·  ___ planning sessions  ·  ___ decisions supported", {})]], size=17, color=INK2, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.7, 6.8, 12, 0.4, "Model figures (medians). Value = hours saved × trucks × 365 × QAR 330 per truck-hour (ATRI 2024 truck operating cost, US$90.89/h).", size=11, color=MUTED)

# 7 Added value: one word or number + one line
s = new("Six reasons WASL is different. Read the big word, say the line.")
kicker(s, "Added value", color=GRAPE)
title(s, "Why WASL is different")
vals = [
    ("2029", "We see the breaking year before it arrives.", TEAL, TEAL_T),
    ("3 plans", "Costed options for any goal, not just charts.", CORAL, CORAL_T),
    ("7 sec", "3,402 futures tested while you watch.", GRAPE, GRAPE_T),
    ("Why?", "Every number explains itself.", SUN, SUN_T),
    ("0", "real trucks exposed: all synthetic, all safe.", MINT, MINT_T),
    ("Any port", "The same AI learns sea, air or land.", TEAL, TEAL_T),
]
for i, (b, d, c, t) in enumerate(vals):
    x = 0.7 + (i % 3) * 4.05
    y = 2.1 + (i // 3) * 2.4
    card(s, x, y, 3.8, 2.15, fill=t, line=None, radius=0.15)
    text(s, x + 0.35, y + 0.3, 3.2, 0.9, b, size=44, color=c, bold=True)
    text(s, x + 0.35, y + 1.3, 3.2, 0.7, d, size=16, color=INK)
footer(s)

# 8 Try it yourself (QR)
qr_path = os.path.join(HERE, "qr_wasl.png")
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=16, border=2)
qr.add_data(QR_URL); qr.make(fit=True)
qr.make_image(fill_color="#152C44", back_color="white").save(qr_path)
s = new("Invite the jury to scan and play while you take questions.")
shp(s, MSO_SHAPE.OVAL, 10.9, 5.0, 4.5, 4.5, fill=SUN_T)
kicker(s, "Try it yourself", color=CORAL)
title(s, "Scan, and run the port yourself")
card(s, 0.7, 2.0, 4.6, 4.6, fill=WHITE, line=LINE, radius=0.06)
pic(s, qr_path, 0.95, 2.25, 4.1, name="QR code to the live twin")
icon(s, 5.9, 2.08, 0.42, "arrow-up-right-from-square", TEAL_D, mode="bare")
text(s, 6.45, 2.0, 6.5, 0.55, LINK_TXT, size=26, color=TEAL_D, bold=True, link=SITE)
tries = [("play", "Press Demo", "the WASL story in 90 seconds", TEAL), ("sliders", "Open the planner", "click a busy-week mark", CORAL), ("crosshairs", "Goal seek", "set 3.5 h, get three plans", GRAPE), ("truck", "Click a truck", "see its plate, journey and risk", MINT)]
for i, (e, h, d, c) in enumerate(tries):
    y = 2.95 + i * 0.9
    icon(s, 5.9, y, 0.66, e, c)
    text(s, 6.8, y, 5.8, 0.66, [[(h, {"bold": True, "color": INK}), ("   " + d, {"color": INK2})]], size=17, anchor=MSO_ANCHOR.MIDDLE)
footer(s)

# 9 Thank you
s = new("Close with the slogan, then questions.")
shp(s, MSO_SHAPE.OVAL, -2.0, -2.0, 6.0, 6.0, fill=TEAL_T)
shp(s, MSO_SHAPE.OVAL, 10.0, 4.0, 5.5, 5.5, fill=CORAL_T)
logo(s, 5.92, 0.9, 1.5)
text(s, 0.7, 2.75, 11.9, 1.2, "Thank you", size=72, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.7, 4.05, 11.9, 0.6, "وصل", size=30, color=CORAL, bold=True, font=FAR, align=PP_ALIGN.CENTER)
text(s, 0.7, 4.7, 11.9, 0.6, "We connect you to your vision", size=26, color=TEAL_D, align=PP_ALIGN.CENTER)
text(s, 0.7, 5.4, 11.9, 0.5, "Watch · Anticipate · Simulate · Lead", size=18, color=MUTED, align=PP_ALIGN.CENTER)

# ================================ APPENDIX ================================

s = new("Appendix: how WASL works, in pictures.", bg=TEAL_T)
logo(s, 6.17, 1.7, 1.0)
text(s, 0.7, 2.95, 11.9, 1.0, "Appendix", size=56, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.7, 4.0, 11.9, 0.6, "How WASL thinks, in pictures", size=22, color=INK2, align=PP_ALIGN.CENTER)

# A1 How WASL thinks
s = new("Three steps, like a good planner: learn from the past, test the future in a safe copy of the port, recommend the best move.")
kicker(s, "Appendix · the big picture")
title(s, "How WASL thinks: learn, simulate, recommend")
steps = [("database", "Learn", "from 198,665 real truck journeys", TEAL, TEAL_T), ("flask", "Simulate", "the port in a safe digital copy", GRAPE, GRAPE_T), ("bullseye", "Recommend", "the cheapest way to the goal", CORAL, CORAL_T)]
for i, (e, h, d, c, t) in enumerate(steps):
    x = 0.7 + i * 4.15
    card(s, x, 2.2, 3.7, 3.6, fill=t, line=None, radius=0.12)
    icon(s, x + 1.25, 2.6, 1.2, e, c, halo=WHITE)
    text(s, x + 0.3, 4.05, 3.1, 0.6, h, size=28, color=c, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.3, 4.7, 3.1, 0.8, d, size=17, color=INK, align=PP_ALIGN.CENTER)
    if i < 2:
        shp(s, MSO_SHAPE.RIGHT_ARROW, x + 3.78, 3.75, 0.3, 0.4, fill=SUN)
text(s, 0.7, 6.2, 12, 0.5, "Six AI parts sit inside these three steps: the next slides show each one.", size=15, color=INK2)
footer(s)

# A1b Where the AI is: all six models on one page
s = new("One page for the question 'where is the AI?'. Six models in three steps. Learn: a clustering model makes realistic trucks, a boosted-tree classifier predicts each truck's delay. Simulate: a forecast projects traffic to 2030, a calibrated queueing model turns resources into waiting hours. Recommend: pattern mining finds the bottleneck, goal seeking searches every mix of changes and returns three costed plans.")
kicker(s, "Appendix · where the AI is")
title(s, "Six models, one decision")
ai = [
    ("Learn", TEAL, TEAL_T, [
        ("diagram-project", "Truck patterns", "Gaussian mixture model", "Unsupervised · clustering", "Groups similar trucks and creates 4,000 realistic new ones", "Every truck in the twin, no real data shown"),
        ("triangle-exclamation", "Delay risk", "Gradient-boosted trees", "Supervised · classification", "Predicts each truck's chance of staying over 8 h, with reasons", "Who will be late, and why (AUC 0.70)"),
    ]),
    ("Simulate", GRAPE, GRAPE_T, [
        ("chart-line", "Traffic forecast", "Growth trend + regression", "Time series · regression", "Projects trucks a day to 2030 and how waits react to volume", "When the port breaks: 2029"),
        ("gears", "Twin engine", "Calibrated queueing model", "Simulation · fitted to data", "Turns lanes, docks and parking into waiting hours, hour by hour", "Any what-if answered in a blink"),
    ]),
    ("Recommend", CORAL, CORAL_T, [
        ("magnifying-glass-chart", "Bottleneck finder", "Share and lift analysis", "Pattern mining", "Finds the stage that eats the hours and who is trapped there", "Aims the plan at the real problem"),
        ("route", "Goal seeking", "Inverse search + ablation", "Optimisation · prescriptive", "Tries 3,402 mixes of changes, prices them, keeps three plans", "A target becomes a costed decision"),
    ]),
]
for ci, (step, c, t, models) in enumerate(ai):
    x = 0.7 + ci * 4.05
    shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, x, 1.8, 3.8, 0.36, fill=c, radius=0.5)
    text(s, x, 1.8, 3.8, 0.36, f"{ci + 1} · {step}", size=13, color=WHITE, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    if ci < 2:
        shp(s, MSO_SHAPE.RIGHT_ARROW, x + 3.84, 1.86, 0.18, 0.24, fill=SUN)
    for ri, (ic, name, model, kind, does, gives) in enumerate(models):
        y = 2.32 + ri * 2.27
        card(s, x, y, 3.8, 2.12, fill=t, line=None, radius=0.1)
        icon(s, x + 0.2, y + 0.2, 0.62, ic, c)
        text(s, x + 0.97, y + 0.17, 2.7, 0.35, name, size=16, color=INK, bold=True)
        text(s, x + 0.97, y + 0.5, 2.7, 0.3, model, size=12.5, color=c, bold=True)
        pill_w = 0.12 + len(kind) * 0.068
        shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, x + 0.2, y + 0.92, pill_w, 0.27, fill=WHITE, radius=0.5)
        text(s, x + 0.2, y + 0.92, pill_w, 0.27, kind, size=10, color=c, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x + 0.2, y + 1.27, 3.45, 0.45, does, size=11.5, color=INK2)
        text(s, x + 0.2, y + 1.72, 3.45, 0.3, [[("→ ", {"color": c, "bold": True}), (gives, {"bold": True})]], size=11.5, color=INK)
footer(s)

# A2 AI 1: clustering picture
s = new("The first AI groups similar trucks together, like sorting marbles by colour, then creates brand-new trucks that behave like each group. Technically a Gaussian mixture model: each group is one soft, stretched cloud, and the stretch is what keeps a slow declaration and a slow inspection together.")
kicker(s, "Appendix · AI 1 · learning truck patterns")
title(s, "It groups similar trucks, then creates new realistic ones")
random.seed(7)
card(s, 0.7, 1.95, 6.6, 3.7, fill=WHITE, line=LINE, radius=0.06)
clusters = [(2.2, 3.05, 0.5, 0.33, TEAL, "Quick chemical trucks"), (4.3, 4.55, 0.65, 0.3, CORAL, "Night arrivals"), (5.65, 3.05, 0.48, 0.33, GRAPE, "Agency-checked goods")]
for cx, cy, sx, sy, c, lab in clusters:
    el = shp(s, MSO_SHAPE.OVAL, cx - sx * 2.1, cy - sy * 2.1, sx * 4.2, sy * 4.2, fill=c)
    alpha(el, 14)
    for _ in range(30):
        gx, gy = random.gauss(0, 1), random.gauss(0, 1)
        k = max(1.0, (gx * gx + gy * gy) ** 0.5 / 1.8)   # keep every dot inside its cloud
        dot(s, cx + sx * gx / k, cy + sy * gy / k, 0.1, c)
    dot(s, cx, cy, 0.2, WHITE); dot(s, cx, cy, 0.13, c)   # the cloud's centre
for cx, cy, sx, sy, c, lab in clusters:
    text(s, cx - 1.3, cy - sy * 2.1 - 0.3, 2.6, 0.3, lab, size=12, color=c, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.95, 5.3, 6.1, 0.3, "←  paperwork time        inspection time  →", size=11, color=MUTED, align=PP_ALIGN.CENTER)
shp(s, MSO_SHAPE.RIGHT_ARROW, 7.55, 3.55, 0.5, 0.45, fill=SUN)
card(s, 8.3, 1.95, 4.35, 3.7, fill=MINT_T, line=None, radius=0.08)
text(s, 8.6, 2.15, 3.8, 0.5, "4,000 new trucks", size=24, color=MINT, bold=True)
text(s, 8.6, 2.65, 3.8, 0.4, "drawn from the groups", size=15, color=INK2)
for k in range(15):
    icon(s, 8.65 + (k % 5) * 0.76, 3.15 + (k // 5) * 0.48, 0.4, "truck", [TEAL, CORAL, GRAPE][k % 3], mode="bare")
text(s, 8.6, 4.65, 3.8, 0.9, [[("As real as the data, ", {"bold": True, "color": INK}), ("yet no real truck or plate is ever shown.", {})]], size=14, color=INK2)
model_card(s, [
    ("Model", "Gaussian mixture model with full covariance: 3–6 soft groups per goods type, the number picked by BIC", TEAL),
    ("What it learns", "the six stage times of 198,665 trucks and how they move together, plus arrival hour, plate country and declarations", CORAL),
    ("How we check it", "synthetic vs real stays per segment: KS distance 0.03–0.11; medians within 0.7 h", MINT),
])
footer(s)

# A3 AI 2: delay risk gauge
s = new("The second AI looks at a truck as it arrives and gives the chance it will be stuck more than 8 hours, with the reasons. It is many small decision trees, each correcting the last. Arrival hour matters most, because shift changes slow inspection.")
kicker(s, "Appendix · AI 2 · predicting delays")
title(s, "Every truck gets a delay risk, and the reasons")
card(s, 0.7, 1.95, 5.2, 3.7, fill=CORAL_T, line=None, radius=0.08)
g = shp(s, MSO_SHAPE.BLOCK_ARC, 1.8, 2.25, 2.7, 2.7, fill="F2C6B8")
g.adjustments[2] = 0.17
g2 = shp(s, MSO_SHAPE.BLOCK_ARC, 1.8, 2.25, 2.7, 2.7, fill=CORAL)
g2.adjustments[0] = 108; g2.adjustments[1] = 172.8; g2.adjustments[2] = 0.17   # 180° to 288°: 60% of the dial
text(s, 1.8, 2.95, 2.7, 0.7, "60%", size=44, color=CORAL, bold=True, align=PP_ALIGN.CENTER)
text(s, 1.0, 3.8, 4.6, 0.4, "chance this truck waits over 8 h", size=15, color=INK, align=PP_ALIGN.CENTER)
text(s, 1.0, 4.4, 4.6, 0.9, "Saudi plate · arrived at 2 a.m. · shared paperwork", size=13, color=INK2, align=PP_ALIGN.CENTER)
text(s, 6.4, 2.0, 6.2, 0.5, "What pushes the risk up", size=20, color=INK, bold=True)
reasons = [("Arrival hour (shift changes)", 1.0), ("Type of goods", 0.5), ("Shared paperwork", 0.39), ("Plate country", 0.32), ("Number of declarations", 0.11)]
for i, (lab, v) in enumerate(reasons):
    y = 2.6 + i * 0.6
    text(s, 6.4, y, 3.0, 0.45, lab, size=15, color=INK2, anchor=MSO_ANCHOR.MIDDLE)
    shp(s, MSO_SHAPE.ROUNDED_RECTANGLE, 9.4, y + 0.07, 3.2 * v, 0.3, fill=CORAL if i == 0 else "F4A893", radius=0.5)
model_card(s, [
    ("Model", "gradient-boosted decision trees (250 trees), a supervised classifier", TEAL),
    ("What it learns", "which facts known at arrival predict a stay over 8 h; reasons ranked by permutation importance", CORAL),
    ("How we check it", "trained on older trucks, tested on the last 60 days it never saw (46,531 trucks): ROC AUC 0.70", MINT),
])
footer(s)

# A4 AI 3: forecast chart
s = new("The third AI forecasts traffic from the real growth of food imports; the twin then shows when the port breaks: 2029. With the plan, the line stays flat.")
kicker(s, "Appendix · AI 3 · forecasting 2030")
title(s, "Traffic grows 46%, and in 2029 the port breaks")
cd = CategoryChartData()
cd.categories = ["2026", "2027", "2028", "2029", "2030"]
cd.add_series("If we carry on", (5.9, 6.4, 7.1, 9.5, 12.6))
cd.add_series("With WASL's plan", (3.2, 3.2, 3.2, 3.2, 3.3))
gf = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.7), Inches(1.9), Inches(8.0), Inches(3.8), cd)
ch = gf.chart
ch.font.name = F; ch.font.size = Pt(12); ch.font.color.rgb = rgb(INK2)
ch.has_legend = True; ch.legend.position = XL_LEGEND_POSITION.BOTTOM; ch.legend.include_in_layout = False; ch.legend.font.size = Pt(13)
ch.has_title = True; ch.chart_title.text_frame.text = "Hours a truck spends in the port (median)"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14); ch.chart_title.text_frame.paragraphs[0].runs[0].font.color.rgb = rgb(INK)
va = ch.value_axis; va.major_gridlines.format.line.color.rgb = rgb(LINE); va.format.line.fill.background(); va.tick_labels.font.color.rgb = rgb(MUTED); va.maximum_scale = 14
ch.category_axis.format.line.color.rgb = rgb(LINE)
plot = ch.plots[0]
plot.has_data_labels = True; plot.data_labels.number_format = '0.0" h"'; plot.data_labels.number_format_is_linked = False
plot.data_labels.font.size = Pt(12); plot.data_labels.font.bold = True; plot.data_labels.font.color.rgb = rgb(INK)
for ser, c in zip(plot.series, [CORAL, MINT]):
    ser.format.line.color.rgb = rgb(c); ser.format.line.width = Pt(4); ser.smooth = True
    ser.marker.size = 9; ser.marker.format.fill.solid(); ser.marker.format.fill.fore_color.rgb = rgb(c); ser.marker.format.line.color.rgb = rgb(c)
facts = [("738 → 1,077", "trucks a day, 2026 → 2030", TEAL, TEAL_T), ("+43% / yr", "food imports growth, slowing", SUN, SUN_T), ("2029", "the year queues stop clearing", CORAL, CORAL_T)]
for i, (b, d, c, t) in enumerate(facts):
    y = 1.95 + i * 1.27
    card(s, 9.0, y, 3.65, 1.15, fill=t, line=None, radius=0.15)
    text(s, 9.25, y + 0.13, 3.2, 0.55, b, size=24, color=c, bold=True)
    text(s, 9.25, y + 0.68, 3.2, 0.4, d, size=13, color=INK2)
model_card(s, [
    ("Model", "compound-growth trend on food declarations, plus a log-log regression of waits on weekly volume", TEAL),
    ("What it learns", "growth of 43% a year (2023–26), halved each year → +46% by 2030; +1% trucks adds 0.24% paperwork wait", CORAL),
    ("How we check it", "2026 traffic more than doubled while weekly waits stayed flat; the model reproduces that", MINT),
])
footer(s)

# A5 AI 4: the twin engine as a journey
s = new("The fourth part is the engine of the twin: it turns lanes, ramps and parking into waiting hours, station by station, hour by hour, tuned so the busiest real weeks come out right.")
kicker(s, "Appendix · AI 4 · the digital-twin engine")
title(s, "It turns lanes, ramps and parking into waiting time")
stations = [("square-parking", "Parking", "0 min", TEAL), ("file-lines", "Paperwork", "104 min", CORAL), ("x-ray", "X-ray", "93 min", GRAPE), ("magnifying-glass", "Inspection", "146 min", SUN), ("circle-check", "Release", "15 min", MINT)]
line(s, 1.6, 2.85, 11.7, 2.85, color=LINE, w=6)
for i, (e, h, m, c) in enumerate(stations):
    x = 0.95 + i * 2.55
    icon(s, x, 2.15, 1.4, e, c, mode="ring")
    text(s, x - 0.4, 3.7, 2.2, 0.45, h, size=19, color=INK, bold=True, align=PP_ALIGN.CENTER)
    text(s, x - 0.4, 4.15, 2.2, 0.45, m, size=17, color=c, bold=True, align=PP_ALIGN.CENTER)
card(s, 0.7, 4.75, 11.95, 0.85, fill=SUN_T, line=None, radius=0.3)
icon(s, 0.92, 4.87, 0.6, "lightbulb", SUN)
text(s, 1.75, 4.75, 10.7, 0.85, [[("Key finding: ", {"bold": True, "color": INK}), ("traffic doubled in 2026 but waits stayed flat, so most waiting is process, not too few ramps.", {})]], size=15, color=INK2, anchor=MSO_ANCHOR.MIDDLE)
model_card(s, [
    ("Model", "hour-by-hour queueing model (M/M/c) for X-ray lanes and ramps, with a backlog carried across days", TEAL),
    ("What it learns", "service times solved from real waits (X-ray 7.6 min, inspection 2.2 h) and the shift-change dips by hour", CORAL),
    ("How we check it", "a +14% week gives 6.1 h, as the busiest real weeks did (6.0–6.4 h); today's median within 0.3 h", MINT),
])
footer(s)

# A6 AI 5: bottleneck
s = new("The fifth part finds the bottleneck: the step that eats the most hours, and which trucks get trapped there.")
kicker(s, "Appendix · AI 5 · finding the bottleneck")
title(s, "Half of all waiting is paperwork")
parts = [("Paperwork", 51, CORAL), ("Inspection queue", 35, SUN), ("X-ray", 5, GRAPE), ("Other", 9, MUTED)]
x = 0.7
for lab, v, c in parts:
    w = 11.95 * v / 100
    shp(s, MSO_SHAPE.RECTANGLE, x, 2.05, w - 0.04, 1.05, fill=c)
    if v >= 9:
        text(s, x + 0.15, 2.1, w - 0.2, 0.95, [[(f"{v}%", {"size": 28, "bold": True, "color": WHITE})], [(lab, {"size": 13, "color": WHITE})]], anchor=MSO_ANCHOR.MIDDLE)
    else:
        text(s, x - 0.4, 3.15, w + 0.8, 0.3, f"{lab} {v}%", size=11, color=c, bold=True, align=PP_ALIGN.CENTER)
    x += w
text(s, 0.7, 3.2, 8, 0.35, "share of all the hours trucks spend in the port", size=12, color=MUTED)
who = [("moon", "Night arrivals", "3× more likely to be among the slowest", GRAPE, GRAPE_T), ("building-columns", "Agency-checked goods", "1.4× more likely to be stuck", CORAL, CORAL_T), ("arrows-rotate", "Shift changes", "inspections drop by up to 75% at 6, 13 and 21 h", TEAL, TEAL_T)]
for i, (e, h, d, c, t) in enumerate(who):
    x = 0.7 + i * 4.05
    card(s, x, 3.8, 3.8, 1.8, fill=t, line=None, radius=0.12)
    icon(s, x + 0.25, 4.0, 0.7, e, c)
    text(s, x + 1.1, 4.12, 2.6, 0.5, h, size=17, color=c, bold=True)
    text(s, x + 0.25, 4.85, 3.35, 0.7, d, size=14, color=INK)
model_card(s, [
    ("Method", "share of all truck-hours per stage, then lift: how over-represented a group is among the slowest quarter", TEAL),
    ("What it learns", "which stage eats the hours and who gets trapped there, by goods type, hour, plate and paperwork", CORAL),
    ("How we use it", "it re-runs on every what-if change, so the bottleneck moves as you change the port", MINT),
])
footer(s)

# A7 AI 6: goal seeking
s = new("The sixth part works backwards. Tell it the goal, it tries every combination of changes, prices each one, and hands back three different plans.")
kicker(s, "Appendix · AI 6 · goal seeking")
title(s, "Tell it the goal, it finds the plan")
card(s, 0.7, 1.95, 3.2, 3.7, fill=SUN_T, line=None, radius=0.1)
icon(s, 1.75, 2.25, 1.1, "bullseye", SUN, halo=WHITE)
text(s, 0.9, 3.6, 2.8, 0.7, "3.5 h", size=40, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 0.9, 4.35, 2.8, 0.8, "the goal for 2030", size=16, color=INK2, align=PP_ALIGN.CENTER)
shp(s, MSO_SHAPE.RIGHT_ARROW, 4.05, 3.55, 0.45, 0.45, fill=SUN)
card(s, 4.65, 1.95, 3.3, 3.7, fill=WHITE, line=LINE, radius=0.1)
random.seed(3)
for k in range(140):
    gx, gy = 4.97 + (k % 14) * 0.205, 2.25 + (k // 14) * 0.21
    dot(s, gx, gy, 0.1, MINT if random.random() < 0.08 else "C5D0DB")
text(s, 4.85, 4.4, 2.9, 0.55, "3,402 tries", size=26, color=INK, bold=True, align=PP_ALIGN.CENTER)
text(s, 4.85, 4.98, 2.9, 0.45, "257 reach the goal", size=15, color=MINT, bold=True, align=PP_ALIGN.CENTER)
shp(s, MSO_SHAPE.RIGHT_ARROW, 8.1, 3.55, 0.45, 0.45, fill=SUN)
plans = [("Cost-smart", "cheapest", "QAR 38 M", MINT, MINT_T), ("Resilient", "holds in a busy week", "QAR 42 M", CORAL, CORAL_T), ("Best result", "fastest trucks", "QAR 47 M", TEAL, TEAL_T)]
for i, (h, d, cst, c, t) in enumerate(plans):
    y = 1.95 + i * 1.27
    card(s, 8.7, y, 3.95, 1.16, fill=t, line=None, radius=0.15)
    text(s, 8.95, y + 0.14, 2.4, 0.45, h, size=19, color=c, bold=True)
    text(s, 8.95, y + 0.62, 2.4, 0.45, d, size=14, color=INK2)
    text(s, 10.85, y + 0.3, 1.65, 0.6, cst, size=18, color=INK, bold=True, align=PP_ALIGN.RIGHT)
model_card(s, [
    ("Method", "inverse search: every mix of X-ray lanes, ramps, pre-filing, green channel and shift overlap, each run through the twin", TEAL),
    ("How it explains", "ablation: each change is removed in turn, and the hours the plan loses are that change's share", CORAL),
    ("How we check it", "an automatic test confirms more capacity never makes things worse and a plan is always found", MINT),
])
footer(s)

# A8 Pricing
s = new("Costs are simple maths on the AI's answer: what changes, times its public price, over five years.")
kicker(s, "Appendix · pricing a plan")
title(s, "Plan cost = what changes × its price")
prices = [("x-ray", "X-ray lane", "QAR 16 M", "+ 1.9 M a year", GRAPE, GRAPE_T), ("warehouse", "Inspection ramp", "QAR 290 k", "+ 540 k a year", CORAL, CORAL_T), ("square-parking", "Parking bay", "QAR 91 k", "+ 2 k a year", TEAL, TEAL_T), ("file-lines", "Pre-filing, per 10%", "QAR 0.8 M", "+ 0.25 M a year", SUN, SUN_T)]
for i, (e, h, p, o, c, t) in enumerate(prices):
    x = 0.7 + i * 3.02
    card(s, x, 2.1, 2.78, 3.3, fill=t, line=None, radius=0.12)
    icon(s, x + 0.94, 2.4, 0.9, e, c)
    text(s, x + 0.15, 3.5, 2.48, 0.45, h, size=17, color=INK, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.15, 4.0, 2.48, 0.55, p, size=26, color=c, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.15, 4.6, 2.48, 0.45, o, size=14, color=INK2, align=PP_ALIGN.CENTER)
card(s, 0.7, 5.75, 11.95, 0.85, fill=MINT_T, line=None, radius=0.3)
icon(s, 0.92, 5.87, 0.6, "stopwatch", MINT)
text(s, 1.75, 5.75, 10.7, 0.85, [[("One truck-hour = QAR 330 ", {"bold": True, "color": INK}), ("of truck time (ATRI 2024). Prices are public benchmarks; swap in GAC figures anytime.", {})]], size=15, color=INK2, anchor=MSO_ANCHOR.MIDDLE)
footer(s)

# A9 Safe by design
s = new("Raw data never leaves GAC; the app only holds summaries and made-up trucks.")
kicker(s, "Appendix · safe by design")
title(s, "Real data in, nothing sensitive out")
safe = [("lock", "Raw data stays home", "the GAC extracts never leave the authority's machine", TEAL, TEAL_T), ("masks-theater", "Every truck is synthetic", "realistic plates in each country's format, never real ones", GRAPE, GRAPE_T), ("shield-halved", "Checked automatically", "a test proves the copy behaves like the real port", MINT, MINT_T)]
for i, (e, h, d, c, t) in enumerate(safe):
    x = 0.7 + i * 4.05
    card(s, x, 2.1, 3.8, 3.9, fill=t, line=None, radius=0.12)
    icon(s, x + 1.35, 2.5, 1.1, e, c, halo=WHITE)
    text(s, x + 0.3, 3.9, 3.2, 0.6, h, size=21, color=c, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.3, 4.6, 3.2, 1.0, d, size=15, color=INK, align=PP_ALIGN.CENTER)
footer(s)

# A10 Scaling
s = new("Five steps take WASL to any gateway: connect, map, learn, tune, pilot.")
kicker(s, "Appendix · scaling")
title(s, "From one land port to every gateway")
steps = [("plug", "Connect", "the port's data"), ("map", "Map", "the site in 3D"), ("brain", "Learn", "its truck patterns"), ("sliders", "Tune", "to its real waits"), ("rocket", "Pilot", "weekly with planners")]
line(s, 1.6, 3.05, 11.8, 3.05, color=SUN, w=4, dash=True)
for i, (e, h, d) in enumerate(steps):
    x = 0.85 + i * 2.5
    icon(s, x + 0.3, 2.35, 1.4, e, TEAL, halo=TEAL_T)
    text(s, x - 0.2, 4.0, 2.4, 0.5, h, size=21, color=TEAL_D, bold=True, align=PP_ALIGN.CENTER)
    text(s, x - 0.2, 4.5, 2.4, 0.5, d, size=15, color=INK2, align=PP_ALIGN.CENTER)
chips = [("anchor", "Hamad Port"), ("plane", "Airport cargo"), ("ship", "Ruwais port"), ("road", "Other borders")]
for i, (e, h) in enumerate(chips):
    x = 0.7 + i * 3.02
    card(s, x, 5.5, 2.78, 0.85, fill=CORAL_T, line=None, radius=0.5)
    icon(s, x + 0.35, 5.71, 0.43, e, CORAL, mode="bare")
    text(s, x + 0.95, 5.5, 1.8, 0.85, h, size=17, color=INK, bold=True, anchor=MSO_ANCHOR.MIDDLE)
footer(s)

# A11 What comes next
s = new("Where WASL goes next.")
kicker(s, "Appendix · next")
title(s, "What comes next")
nxt = [("satellite-dish", "Live data", "today's trucks, not synthetic ones"), ("camera", "Plate reading", "cameras log arrivals automatically"), ("calendar-days", "Arrival slots", "flatten the shift-change peaks"), ("comments", "Ask WASL", "\"what if traffic rises 20%?\""), ("leaf", "Smart green lane", "safe trucks skip the queue"), ("fire-extinguisher", "Crisis playbooks", "ready plans for disruptions")]
for i, (e, h, d) in enumerate(nxt):
    x = 0.7 + (i % 3) * 4.05
    y = 2.1 + (i // 3) * 2.35
    c, t = [(TEAL, TEAL_T), (CORAL, CORAL_T), (GRAPE, GRAPE_T)][i % 3]
    card(s, x, y, 3.8, 2.1, fill=t, line=None, radius=0.12)
    icon(s, x + 0.3, y + 0.35, 0.85, e, c)
    text(s, x + 1.4, y + 0.5, 2.3, 0.5, h, size=19, color=c, bold=True)
    text(s, x + 0.3, y + 1.4, 3.3, 0.6, d, size=15, color=INK)
footer(s)

# links in the deck's teal instead of Office blue: set the theme's hyperlink colours
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
theme = prs.slide_masters[0].part.part_related_by(RT.THEME)
xml = theme.blob.decode("utf8")
for tag in ("hlink", "folHlink"):
    xml = re.sub(rf"<a:{tag}>.*?</a:{tag}>", f'<a:{tag}><a:srgbClr val="{TEAL_D}"/></a:{tag}>', xml, flags=re.S)
theme._blob = xml.encode("utf8")

prs.save(OUT)
print(OUT, len(prs.slides), "slides")
