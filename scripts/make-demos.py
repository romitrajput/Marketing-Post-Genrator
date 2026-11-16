"""Generate the synthetic demo creatives shipped in public/demo/.

They are original, programmatically drawn images (no third-party photos), so they
can be shipped freely. Run:  python3 scripts/make-demos.py
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "demo")
os.makedirs(OUT, exist_ok=True)
FONT_DIR = "/usr/share/fonts/truetype/dejavu/"


def font(size, bold=True, serif=False):
    name = ("DejaVuSerif" if serif else "DejaVuSans") + ("-Bold" if bold else "") + ".ttf"
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def vgrad(w, h, top, bottom):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img


def shaded_ellipse(size, base, light=(255, 255, 255), strength=0.55):
    """Radially shaded ellipse with alpha, gives a 3-D-ish object."""
    w, h = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    px = layer.load()
    cx, cy = w * 0.38, h * 0.32
    for y in range(h):
        for x in range(w):
            nx, ny = (x - w / 2) / (w / 2), (y - h / 2) / (h / 2)
            if nx * nx + ny * ny <= 1:
                dist = math.hypot((x - cx) / w, (y - cy) / h)
                t = max(0.0, 1 - dist * 1.6) * strength
                c = tuple(int(base[i] * (1 - t) + light[i] * t) for i in range(3))
                px[x, y] = c + (255,)
    return layer


def drop_shadow(canvas, mask, offset=(18, 22), blur=18, opacity=110):
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    a = mask.split()[-1].point(lambda v: opacity if v > 0 else 0)
    sh.putalpha(a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(sh, offset)


def centered(d, cx, y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text((cx - w / 2, y), text, font=f, fill=fill)


W, H = 1080, 1350

# 1 Fashion poster: dress silhouette on warm gradient ---------------------------
img = vgrad(W, H, (246, 222, 205), (232, 180, 160)).convert("RGBA")
fig = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(fig)
cx = 560
d.ellipse([cx - 55, 300, cx + 55, 420], fill=(120, 78, 60))  # head
d.rectangle([cx - 20, 410, cx + 20, 450], fill=(120, 78, 60))  # neck
d.polygon([(cx - 95, 450), (cx + 95, 450), (cx + 70, 640), (cx - 70, 640)], fill=(150, 20, 60))  # bodice
d.polygon([(cx - 70, 630), (cx + 70, 630), (cx + 250, 1180), (cx - 250, 1180)], fill=(170, 25, 70))  # skirt
for i in range(7):  # skirt folds
    x = cx - 180 + i * 60
    d.line([(cx - 40 + i * 13, 650), (x, 1175)], fill=(140, 15, 55), width=6)
d.polygon([(cx - 95, 455), (cx - 140, 700), (cx - 115, 705), (cx - 75, 500)], fill=(120, 78, 60))  # arm L
d.polygon([(cx + 95, 455), (cx + 140, 700), (cx + 115, 705), (cx + 75, 500)], fill=(120, 78, 60))  # arm R
d.ellipse([cx - 75, 280, cx + 75, 360], fill=(40, 28, 24))  # hair
drop_shadow(img, fig, (25, 20), 22, 90)
img.alpha_composite(fig)
d = ImageDraw.Draw(img)
d.text((70, 70), "NEW SEASON", font=font(84), fill=(60, 30, 40))
d.text((70, 170), "Autumn Edit 2026", font=font(44, bold=False, serif=True), fill=(90, 50, 60))
d.rounded_rectangle([70, 1210, 470, 1295], 40, fill=(60, 30, 40))
d.text((112, 1228), "SHOP NOW", font=font(42), fill=(255, 240, 230))
d.ellipse([860, 70, 1010, 220], outline=(60, 30, 40), width=6)
centered(d, 935, 112, "30%", font(46), (60, 30, 40))
centered(d, 935, 166, "OFF", font(26), (60, 30, 40))
img.convert("RGB").save(os.path.join(OUT, "fashion-poster.jpg"), quality=92)

# 2 Product ad: bottle on flat teal, logo top-left -----------------------------
img = Image.new("RGBA", (W, H), (20, 120, 128, 255))
d = ImageDraw.Draw(img)
d.ellipse([-200, 850, 1280, 1600], fill=(16, 100, 108))  # floor
bottle = Image.new("RGBA", (W, H), (0, 0, 0, 0))
bd = ImageDraw.Draw(bottle)
bx = 540
bd.rounded_rectangle([bx - 150, 520, bx + 150, 1120], 60, fill=(245, 190, 60))
bd.rectangle([bx - 55, 400, bx + 55, 530], fill=(245, 190, 60))
bd.rounded_rectangle([bx - 65, 350, bx + 65, 420], 14, fill=(40, 40, 46))
bd.rectangle([bx - 150, 700, bx + 150, 900], fill=(255, 250, 240))
bd.text((bx - 110, 740), "GLOW", font=font(70), fill=(20, 120, 128))
bd.text((bx - 100, 830), "vitamin C serum", font=font(24, bold=False), fill=(60, 60, 60))
hl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(hl).rounded_rectangle([bx - 120, 540, bx - 85, 1080], 18, fill=(255, 255, 255, 90))
bottle.alpha_composite(hl)
drop_shadow(img, bottle, (30, 25), 25, 120)
img.alpha_composite(bottle)
d = ImageDraw.Draw(img)
d.ellipse([60, 60, 160, 160], fill=(255, 250, 240))
centered(d, 110, 85, "G", font(54), (20, 120, 128))
d.text((180, 85), "glowlab", font=font(46), fill=(255, 250, 240))
centered(d, 540, 200, "Radiance in a drop", font(64), (255, 250, 240))
centered(d, 540, 1200, "Free shipping over Rs 999", font(40, bold=False), (230, 245, 245))
img.convert("RGB").save(os.path.join(OUT, "product-ad.jpg"), quality=92)

# 3 Restaurant post: plate with burger on dark wood ----------------------------
random.seed(3)
img = vgrad(W, H, (60, 38, 26), (36, 22, 15)).convert("RGBA")
d = ImageDraw.Draw(img)
for y in range(0, H, 9):  # wood grain
    d.line([(0, y + random.randint(-3, 3)), (W, y + random.randint(-3, 3))], fill=(70, 45, 30, 255), width=1)
food = Image.new("RGBA", (W, H), (0, 0, 0, 0))
fd = ImageDraw.Draw(food)
fd.ellipse([190, 520, 890, 1040], fill=(245, 245, 240))  # plate
fd.ellipse([250, 570, 830, 990], fill=(232, 232, 226))
fd.ellipse([330, 600, 750, 760], fill=(214, 140, 50))  # top bun
fd.rectangle([320, 700, 760, 740], fill=(90, 160, 60))  # lettuce
fd.rectangle([330, 735, 750, 800], fill=(110, 55, 30))  # patty
fd.rectangle([325, 795, 755, 815], fill=(250, 200, 40))  # cheese
fd.ellipse([335, 800, 745, 900], fill=(205, 130, 45))  # bottom bun
for _ in range(25):
    x, y = random.randint(400, 680), random.randint(620, 690)
    fd.ellipse([x, y, x + 8, y + 5], fill=(250, 235, 200))  # sesame
drop_shadow(img, food, (20, 30), 30, 140)
img.alpha_composite(food)
d = ImageDraw.Draw(img)
centered(d, 540, 90, "SMASH BURGER", font(96), (250, 200, 40))
centered(d, 540, 210, "Weekend special", font(48, bold=False, serif=True), (245, 235, 220))
d.rounded_rectangle([340, 1130, 740, 1230], 20, fill=(250, 200, 40))
centered(d, 540, 1150, "Rs 249", font(60), (36, 22, 15))
img.convert("RGB").save(os.path.join(OUT, "restaurant-post.jpg"), quality=92)

# 4 Event announcement: shapes + microphone -------------------------------------
img = Image.new("RGBA", (W, H), (24, 20, 60, 255))
d = ImageDraw.Draw(img)
d.ellipse([650, -150, 1250, 450], fill=(230, 60, 120))
d.polygon([(0, 1350), (0, 900), (420, 1350)], fill=(250, 190, 40))
d.rectangle([80, 980, 300, 1000], fill=(80, 200, 220))
mic = Image.new("RGBA", (W, H), (0, 0, 0, 0))
md = ImageDraw.Draw(mic)
md.rounded_rectangle([470, 380, 610, 620], 70, fill=(200, 200, 210))
for y in range(400, 610, 22):
    md.line([(480, y), (600, y)], fill=(150, 150, 165), width=5)
md.rectangle([525, 620, 555, 860], fill=(60, 60, 70))
md.ellipse([440, 840, 640, 900], fill=(60, 60, 70))
img.alpha_composite(mic)
d = ImageDraw.Draw(img)
d.text((80, 680), "OPEN MIC", font=font(110), fill=(255, 255, 255))
d.text((80, 820), "NIGHT", font=font(110), fill=(250, 190, 40))
d.text((80, 1040), "Fri 12 Dec  |  8 PM", font=font(44, bold=False), fill=(220, 220, 240))
d.text((80, 1110), "The Loft, Pune", font=font(44, bold=False), fill=(220, 220, 240))
img.convert("RGB").save(os.path.join(OUT, "event-announcement.jpg"), quality=92)

# 5 Text-heavy promo ----------------------------------------------------------------
img = Image.new("RGB", (W, H), (250, 247, 240))
d = ImageDraw.Draw(img)
d.rectangle([0, 0, W, 260], fill=(30, 60, 140))
centered(d, 540, 70, "MEGA SALE", font(110), (255, 255, 255))
lines = [
    ("Up to 60% off on all books", 52, True),
    ("Buy 2 get 1 free on comics", 44, False),
    ("Members get early access", 44, False),
    ("Free gift wrapping", 44, False),
    ("Valid till 31 December", 40, False),
]
y = 340
for t, s, b in lines:
    centered(d, 540, y, t, font(s, bold=b), (30, 30, 40))
    y += s + 60
d.rounded_rectangle([290, 1060, 790, 1170], 55, fill=(220, 50, 50))
centered(d, 540, 1085, "VISIT STORE", font(54), (255, 255, 255))
centered(d, 540, 1240, "www.example-books.test", font(34, bold=False), (90, 90, 100))
img.save(os.path.join(OUT, "text-heavy-promo.png"))

print("written to", os.path.abspath(OUT))
