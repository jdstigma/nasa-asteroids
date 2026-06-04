"""Generate a 20x20 icon for the 3D visual: the text '3D' on a dark space background."""
from PIL import Image, ImageDraw, ImageFont

SIZE = 20
img = Image.new("RGBA", (SIZE, SIZE), (5, 5, 16, 255))
d = ImageDraw.Draw(img)

# Try a bundled TrueType font for crisp text; fall back to default bitmap font
font = None
for path in [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
]:
    try:
        font = ImageFont.truetype(path, 12)
        break
    except Exception:
        continue
if font is None:
    font = ImageFont.load_default()

text = "3D"
# Center the text
try:
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    ox, oy = bbox[0], bbox[1]
except Exception:
    tw, th, ox, oy = d.textsize(text, font=font)[0], d.textsize(text, font=font)[1], 0, 0

x = (SIZE - tw) / 2 - ox
y = (SIZE - th) / 2 - oy
d.text((x, y), text, fill=(90, 200, 255, 255), font=font)

img.save("asteroid-orbital-3d/assets/icon.png")
print("3D icon written to asteroid-orbital-3d/assets/icon.png")
