#!/usr/bin/env python3
"""Build demo/stopcheck-demo-v2.mp4 from real screen captures in demo/v2/raw.

Inputs (all real captures, nothing drawn over the numbers):
  raw/app_dialog_22oct_from_v1.png  dreamDEX TP/SL dialog, 22 Oct (frame of the v1 video)
  raw/page_network.png              live page, "Network today", 5 Nov
  raw/page_typed.png                live page with the demo address pasted
  raw/page_result_full.png          live page result for 0x84326A...BF21, 5 Nov
  raw/tx_stop_zoom.png              explorer, stop tx 0x5d01311d...8e1db6
  raw/tx_keeper_zoom.png            explorer, keeper tx 0x13c80f38...e28ec3
  ../keeper-2026-11-05-eth.log      keeper log, shown as a terminal

Usage: python3 build.py [path/to/ffmpeg]
Writes ../stopcheck-demo-v2.mp4 and one still per scene to frames/.
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
FRAMES = os.path.join(HERE, "frames")
OUT = os.path.join(HERE, "..", "stopcheck-demo-v2.mp4")
LOG = os.path.join(HERE, "..", "keeper-2026-11-05-eth.log")
FFMPEG = sys.argv[1] if len(sys.argv) > 1 else "ffmpeg"

W, H, FPS = 1920, 1080, 30
BAR = 190                 # caption bar height
CH = H - BAR              # content height
FADE = 0.5                # crossfade seconds
BG = (14, 15, 20)
ACCENT = (139, 128, 255)
AMBER = (240, 168, 48)
GREEN = (60, 207, 122)
RED = (235, 87, 87)
GREY = (166, 166, 179)

HN = "/System/Library/Fonts/HelveticaNeue.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"
def font(size, idx=0): return ImageFont.truetype(HN, size, index=idx)
def mono(size, bold=False): return ImageFont.truetype(MENLO, size, index=1 if bold else 0)
BOLD, MED, REG = 1, 10, 0

_img_cache = {}
def load(name):
    if name not in _img_cache:
        _img_cache[name] = Image.open(os.path.join(RAW, name)).convert("RGB")
    return _img_cache[name]

def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)

def wrap(draw, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= maxw: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

# ---------- caption bar ----------
_cap_cache = {}
def caption_bar(text):
    if text in _cap_cache: return _cap_cache[text]
    im = Image.new("RGB", (W, BAR), (8, 8, 12))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 3], fill=ACCENT)
    size = 50
    while True:
        f = font(size, MED)
        lines = wrap(d, text, f, W - 160)
        if len(lines) <= 2 or size <= 38: break
        size -= 2
    lh = int(size * 1.25)
    y = 3 + (BAR - 3 - lh * len(lines)) // 2
    for ln in lines:
        tw = d.textlength(ln, font=f)
        d.text(((W - tw) / 2, y), ln, font=f, fill=(255, 255, 255))
        y += lh
    _cap_cache[text] = im
    return im

# ---------- screenshot with pan/zoom ----------
_mask_cache = {}
def rounded_mask(size, r=18):
    if size not in _mask_cache:
        m = Image.new("L", size, 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], r, fill=255)
        _mask_cache[size] = m
    return _mask_cache[size]

def shot(name, box0, box1, pad=34):
    """Pan/zoom from box0 to box1 (same aspect) inside the content area."""
    src = load(name)
    bw, bh = box0[2] - box0[0], box0[3] - box0[1]
    scale = min((W - 2 * pad) / bw, (CH - 2 * pad) / bh)
    ow, oh = int(bw * scale), int(bh * scale)
    ox, oy = (W - ow) // 2, (CH - oh) // 2
    def render(t, dur):
        k = ease(t / dur)
        b = [box0[i] + (box1[i] - box0[i]) * k for i in range(4)]
        sx, sy = (b[2] - b[0]) / ow, (b[3] - b[1]) / oh
        part = src.transform((ow, oh), Image.AFFINE, (sx, 0, b[0], 0, sy, b[1]), resample=Image.BICUBIC)
        canvas = Image.new("RGB", (W, CH), BG)
        canvas.paste(part, (ox, oy), rounded_mask((ow, oh)))
        return canvas
    return render

def static(img):
    def render(t, dur): return img
    return render

# ---------- cards ----------
def card_hook():
    im = Image.new("RGB", (W, CH), BG); d = ImageDraw.Draw(im)
    d.text((140, 210), "DREAMDEX PERPS  ·  SOMNIA TOKYO TESTNET", font=font(30, BOLD), fill=ACCENT)
    f = font(92, BOLD); y = 290
    for ln in wrap(d, "Your “Entire” stop loss on dreamDEX can cover half your position.", f, W - 280):
        d.text((140, y), ln, font=f, fill=(255, 255, 255)); y += 112
    d.text((140, y + 40), "StopCheck finds it. A small bot closes the gap.", font=font(44, REG), fill=GREY)
    return im

def card_runs():
    im = Image.new("RGB", (W, CH), BG); d = ImageDraw.Draw(im)
    d.text((140, 80), "3 live runs, 2 markets", font=font(76, BOLD), fill=(255, 255, 255))
    d.text((140, 180), "Somnia Tokyo testnet, account 0x84326A92...6599BF21", font=font(34, REG), fill=GREY)
    cols = [140, 420, 640, 1120, 1600]
    hdr = ["date", "market", "account's own stop", "keeper bot close", "gap"]
    y = 290
    for x, h in zip(cols, hdr): d.text((x, y), h.upper(), font=font(26, BOLD), fill=GREY)
    d.line([140, y + 46, W - 140, y + 46], fill=(50, 52, 64), width=2)
    rows = [
        ("22 Oct", "BTC-PERP", "0x2db1fbb6...825178", "0x8524c1fb...67abc2", "3 s"),
        ("26 Oct", "BTC-PERP", "0x9b13ce9e...2eda2aee", "0x01a5d298...eccbcc12", "15 s"),
        ("5 Nov", "ETH-PERP", "0x5d01311d...8e1db6", "0x13c80f38...e28ec3", "18 s"),
    ]
    y += 80
    for r in rows:
        d.text((cols[0], y), r[0], font=font(40, MED), fill=(255, 255, 255))
        d.text((cols[1], y), r[1], font=font(40, MED), fill=(255, 255, 255))
        d.text((cols[2], y + 4), r[2], font=mono(32), fill=(220, 220, 230))
        d.text((cols[3], y + 4), r[3], font=mono(32), fill=GREEN)
        d.text((cols[4], y), r[4], font=font(40, BOLD), fill=GREEN)
        y += 104
        d.line([140, y - 30, W - 140, y - 30], fill=(36, 38, 48), width=1)
    d.text((140, y + 20), "Full hashes and explorer links: README, “Judges start here”", font=font(32, REG), fill=GREY)
    return im

def card_close():
    im = Image.new("RGB", (W, CH), BG); d = ImageDraw.Draw(im)
    def center(text, f, y, fill):
        tw = d.textlength(text, font=f); d.text(((W - tw) / 2, y), text, font=f, fill=fill)
    center("CHECK YOUR ADDRESS  ·  READ-ONLY  ·  NOTHING TO SIGN", font(32, BOLD), 220, ACCENT)
    center("dmitriytopka.github.io/stopcheck", font(100, BOLD), 300, (255, 255, 255))
    center("Code, keeper logs and tx hashes:", font(40, REG), 500, GREY)
    center("github.com/DmitriyTopka/stopcheck", mono(48, True), 560, (220, 220, 230))
    center("Built for the dreamDEX Perps Builder Bounty", font(34, REG), 700, GREY)
    return im

# ---------- terminal ----------
def terminal(reveal):
    """reveal: list of (time_s, line_index) - line becomes visible at time."""
    raw = [l.rstrip("\n") for l in open(LOG, encoding="utf-8") if l.strip()]
    lines = [("# demo/keeper-2026-11-05-eth.log  (ETH-PERP, 5 Nov 2026)", "comment")]
    for i in (0, 1, 2, 3): lines.append((raw[i], "log"))
    lines.append(("   ... %d more lines like these while the mark moves ..." % (len(raw) - 7), "comment"))
    for i in (len(raw) - 3, len(raw) - 2, len(raw) - 1): lines.append((raw[i], "log"))
    f = mono(25); fb = mono(25, True)
    tx, ty, tw, th = 90, 40, W - 180, CH - 80
    base = Image.new("RGB", (W, CH), BG); d = ImageDraw.Draw(base)
    d.rounded_rectangle([tx, ty, tx + tw, ty + th], 20, fill=(23, 24, 31), outline=(42, 43, 53), width=2)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse([tx + 28 + i * 34, ty + 24, tx + 48 + i * 34, ty + 44], fill=c)
    d.text((tx + 150, ty + 20), "gap keeper  ·  linked bot key 0x13f05c8e...018a55", font=font(26, MED), fill=GREY)

    def draw_line(d, x, y, text, kind):
        if kind == "comment":
            d.text((x, y), text, font=f, fill=(120, 122, 140)); return
        segs = []
        if "STOP FIRED" in text:
            a, b = text.split("| STOP FIRED"); segs = [(a, (230, 230, 236), f), ("| STOP FIRED", AMBER, fb)]
        elif text.startswith("ETH-PERP: gap close"):
            segs = [(text, GREEN, fb)]
        elif "stop covers 50.0%" in text:
            a, b = text.split("stop covers 50.0%"); segs = [(a, (230, 230, 236), f), ("stop covers 50.0%", AMBER, fb), (b, (230, 230, 236), f)]
        else:
            segs = [(text, (230, 230, 236), f)]
        for s, col, ff in segs:
            d.text((x, y), s, font=ff, fill=col); x += d.textlength(s, font=ff)

    def render(t, dur):
        im = base.copy(); d = ImageDraw.Draw(im)
        y = ty + 90
        for idx, (text, kind) in enumerate(lines):
            vis = [rt for rt, li in reveal if li == idx]
            if vis and t >= vis[0]:
                draw_line(d, tx + 40, y, text, kind)
            y += 62
        return im
    return render

# ---------- timeline ----------
SEG = [
    # (duration, renderer, caption, still name)
    (6.0, static(card_hook()), "Real screens and real testnet transactions. No sound needed.", "01_hook"),
    (8.0, shot("app_dialog_22oct_from_v1.png", (640, 280, 1280, 1010), (670, 300, 1250, 962)),
     "dreamDEX app, 22 Oct: long 0.00018 BTC, TP/SL set to “Entire”, then we added 0.00018 more.", "02_dialog"),
    (9.0, shot("app_dialog_22oct_from_v1.png", (685, 405, 1245, 1044), (700, 425, 1230, 1030)),
     "Now 0.00036 BTC (shown as 0.0004) and still “Entire”. Yet the -2.06 USDso loss estimate is for half: the full size would lose 4.12.", "03_dialog_sl"),
    (6.0, shot("page_network.png", (380, 40, 1540, 920), (400, 60, 1520, 910)),
     "StopCheck, the live page today. Every day it scans all dreamDEX accounts with pending stops.", "04_network"),
    (8.0, shot("page_network.png", (300, 215, 1620, 802), (360, 240, 1560, 773)),
     "5 Nov scan of 453 accounts: 12 with a stop loss covering only part of a position, 317 orphan stops, 97% of new stops with a fixed size.", "05_network_numbers"),
    (5.0, shot("page_typed.png", (410, 300, 1510, 789), (440, 330, 1480, 792)),
     "Paste any address. Nothing is signed, the page only reads the chain.", "06_typed"),
    (8.0, shot("page_result_full.png", (380, 740, 1540, 1620), (400, 750, 1520, 1599)),
     "Our demo account, live right now: its stop loss covers 50% of the position.", "07_result_card"),
    (8.0, shot("page_result_full.png", (380, 1100, 1540, 1980), (380, 1296, 1540, 2176)),
     "Per position: a 0.00036 BTC long whose stop loss is for 0.00018. The rest has no stop.", "08_per_position"),
    (6.0, terminal([(0.3, 0), (0.8, 1), (1.6, 2), (2.4, 3)]),
     "5 Nov, ETH-PERP, same trap. Our keeper bot, linked with Link a bot, sees the stop covers 50.0%.", "09_keeper_a"),
    (5.0, terminal([(0, 0), (0, 1), (0, 2), (0, 3), (0.4, 4), (1.4, 5), (2.4, 6)]),
     "The stop is moved to 2,410.5 in the app. It still covers 0.0061 of 0.0122 ETH.", "10_keeper_b"),
    (6.0, terminal([(0, i) for i in range(7)] + [(0.6, 7), (2.0, 8)]),
     "The mark crosses 2,410.5: the stop fires and closes half. The keeper sends a close for the other 0.0061.", "11_keeper_c"),
    (8.0, shot("tx_stop_zoom.png", (420, 150, 1770, 971), (440, 380, 1700, 1146)),
     "09:23:45 UTC: the account's own stop loss closes 0.0061 ETH.", "12_tx_stop"),
    (9.0, shot("tx_keeper_zoom.png", (420, 160, 1770, 981), (440, 400, 1700, 1166)),
     "18 seconds later, the bot closed the rest: 09:24:03 UTC, sent from the linked bot key 0x13f05c8e...", "13_tx_keeper"),
    (10.0, static(card_runs()),
     "Each time the account's stop closed half and the keeper closed the rest seconds later.", "14_runs"),
    (9.0, static(card_close()), "Check your address: dmitriytopka.github.io/stopcheck", "15_close"),
]

def main():
    for s in SEG:
        for ch in (chr(0x2014), chr(0x2013)):
            assert ch not in s[2], "dash in caption: " + s[2]
    starts, t = [], 0.0
    for i, s in enumerate(SEG):
        starts.append(t); t += s[0] - (FADE if i < len(SEG) - 1 else 0)
    total = t
    nframes = int(round(total * FPS))
    os.makedirs(FRAMES, exist_ok=True)

    def seg_frame(i, tt):
        dur, rend, cap, _ = SEG[i]
        fr = Image.new("RGB", (W, H), BG)
        fr.paste(rend(max(0.0, min(dur, tt)), dur), (0, 0))
        fr.paste(caption_bar(cap), (0, CH))
        return fr

    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    saved = set()
    for n in range(nframes):
        T = n / FPS
        active = [i for i in range(len(SEG)) if starts[i] <= T < starts[i] + SEG[i][0]]
        if not active: active = [len(SEG) - 1]
        if len(active) == 1:
            i = active[0]; fr = seg_frame(i, T - starts[i])
        else:
            a, b = active[0], active[1]
            k = (T - starts[b]) / FADE
            fr = Image.blend(seg_frame(a, T - starts[a]), seg_frame(b, T - starts[b]), ease(k))
        # still per scene at 60% of its own time (no crossfade)
        for i in active:
            if i not in saved and len(active) == 1 and T - starts[i] >= SEG[i][0] * 0.6:
                fr.save(os.path.join(FRAMES, SEG[i][3] + ".png")); saved.add(i)
        p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()
    print("total %.2f s, %d frames -> %s" % (total, nframes, OUT))
    t = 0.0
    for i, s in enumerate(SEG):
        print("%6.1f-%6.1f  %s  | %s" % (starts[i], starts[i] + s[0], s[3], s[2]))

if __name__ == "__main__":
    main()
