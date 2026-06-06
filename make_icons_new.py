"""Generate distinct 20x20 icons for the three new Power BI custom visuals.
Each is drawn supersampled (4x) on the same dark-space background as the other
visuals, then downscaled with Lanczos for crisp anti-aliased edges.

  asteroid-cluster-map   -> two colour-grouped dot clusters inside error ellipses
  asteroid-value-scatter -> X/Y axes with scattered dots of varying size
  asteroid-impact-table  -> a planet struck by an incoming red asteroid (impact flash)
"""
from PIL import Image, ImageDraw
import math

S = 4                      # supersample factor
SIZE = 20
BG = (5, 5, 16, 255)       # dark space background, matches the other icons


def new_canvas():
    img = Image.new("RGBA", (SIZE * S, SIZE * S), BG)
    return img, ImageDraw.Draw(img)


def dot(d, x, y, r, fill):
    d.ellipse([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], fill=fill)


def ring(d, x0, y0, x1, y1, outline, width=1):
    d.ellipse([x0 * S, y0 * S, x1 * S, y1 * S], outline=outline, width=max(1, width * S))


def line(d, x0, y0, x1, y1, fill, width=1):
    d.line([x0 * S, y0 * S, x1 * S, y1 * S], fill=fill, width=max(1, width * S))


def save(img, path):
    img.resize((SIZE, SIZE), Image.LANCZOS).save(path)
    print("wrote", path)


# --------------------------------------------------------------------------
# 1. Cluster map — two distinct clusters, each ringed by a 1-sigma error ellipse
# --------------------------------------------------------------------------
img, d = new_canvas()
BLUE = (79, 195, 247, 255)
ORNG = (255, 138, 101, 255)
# Cluster A (blue, upper-left) — fewer, smaller, well-separated dots in a wide ellipse
ring(d, 1.5, 1.5, 11, 10, (79, 195, 247, 170), 1)
for (x, y) in [(3.7, 4), (7.2, 3.3), (5.2, 7.2)]:
    dot(d, x, y, 0.9, BLUE)
# Cluster B (orange, lower-right)
ring(d, 9, 10, 18.5, 18.5, (255, 138, 101, 170), 1)
for (x, y) in [(11.5, 12.5), (15.2, 13), (13, 16.3)]:
    dot(d, x, y, 0.9, ORNG)
save(img, "asteroid-cluster-map/assets/icon.png")

# --------------------------------------------------------------------------
# 2. Value scatter — L-shaped axes + scattered dots trending up-right
# --------------------------------------------------------------------------
img, d = new_canvas()
AX = (140, 160, 210, 255)
line(d, 4, 3, 4, 16, AX, 1)        # y-axis
line(d, 4, 16, 17, 16, AX, 1)      # x-axis
pts = [
    (6.5, 13.5, 1.0, (128, 222, 234, 255)),
    (9, 7.5, 1.3, (255, 138, 101, 255)),
    (11, 12, 1.0, (255, 255, 255, 255)),
    (13, 5, 1.5, (255, 138, 101, 255)),
    (15.5, 9.5, 1.1, (128, 222, 234, 255)),
    (8, 11, 0.9, (79, 195, 247, 255)),
    (12.5, 9, 1.0, (255, 200, 80, 255)),
    (16, 13.5, 1.1, (255, 255, 255, 255)),
]
for (x, y, r, c) in pts:
    dot(d, x, y, r, c)
save(img, "asteroid-value-scatter/assets/icon.png")

# --------------------------------------------------------------------------
# 3. Impact table — a planet struck by an incoming red asteroid + impact flash
# --------------------------------------------------------------------------
img, d = new_canvas()
# Planet (lower-left), blue with a green landmass hint
pcx, pcy, pr = 7.5, 13, 4.2
dot(d, pcx, pcy, pr, (46, 125, 208, 255))
dot(d, pcx - 1.2, pcy + 0.8, 1.6, (63, 125, 58, 255))   # land patch
dot(d, pcx + 1.5, pcy - 1.4, 1.1, (90, 160, 230, 255))  # highlight
# Incoming asteroid (upper-right) with a motion streak toward the planet
ax, ay = 15.5, 4.5
# impact point on the planet's upper-right edge (45 deg)
ix, iy = pcx + pr * 0.707, pcy - pr * 0.707
line(d, ax, ay, ix, iy, (255, 120, 110, 220), 1)
dot(d, ax, ay, 1.6, (255, 77, 77, 255))
# Impact flash burst at the planet edge
for k in range(8):
    a = k * math.pi / 4
    line(d, ix, iy, ix + math.cos(a) * 2.4, iy + math.sin(a) * 2.4, (255, 224, 120, 230), 1)
dot(d, ix, iy, 1.2, (255, 245, 200, 255))
save(img, "asteroid-impact-table/assets/icon.png")

print("done")
