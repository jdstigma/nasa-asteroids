"""Generate a visible 20x20 icon for the Power BI custom visual:
a small solar-system glyph — sun + orbit ring + asteroid dot."""
from PIL import Image, ImageDraw
import math

SIZE = 20
img = Image.new("RGBA", (SIZE, SIZE), (5, 5, 16, 255))   # dark space background
d = ImageDraw.Draw(img)

cx, cy = SIZE / 2, SIZE / 2

# Orbit ring (ellipse)
d.ellipse([2, 5, 18, 15], outline=(120, 140, 200, 255), width=1)

# Sun at center
d.ellipse([cx - 2.5, cy - 2.5, cx + 2.5, cy + 2.5], fill=(255, 210, 90, 255))

# Hazardous asteroid dot on the orbit (red)
ax, ay = cx + 6.5, cy - 2
d.ellipse([ax - 1.6, ay - 1.6, ax + 1.6, ay + 1.6], fill=(255, 70, 70, 255))

# Second asteroid dot (gray)
bx, by = cx - 6, cy + 2.5
d.ellipse([bx - 1.2, by - 1.2, bx + 1.2, by + 1.2], fill=(180, 180, 180, 255))

img.save("asteroid-orbital-visual/assets/icon.png")
print("Icon written to asteroid-orbital-visual/assets/icon.png")
