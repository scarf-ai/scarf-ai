# Prepares the site's images and fonts from brand/ (run after new poses/views are added to brand/):
#   python3 site/tools/prep_assets.py
# Mascot views → WebP 720 px; three-quarter is mirrored into three-quarter-left; poses pose-*.png → WebP;
# brand fonts → WOFF2 (Latin, Cyrillic, arrows, subscript digits).
import glob, os, subprocess
from PIL import Image, ImageOps
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'site', 'src', 'assets')
os.makedirs(OUT, exist_ok=True)
M = os.path.join(ROOT, 'brand', 'mascot')
def webp(src, name, mirror=False, size=720):
    im = Image.open(src).convert('RGBA').resize((size, size), Image.LANCZOS)
    if mirror: im = ImageOps.mirror(im)
    im.save(os.path.join(OUT, name), 'WEBP', quality=84, method=6)
views = {'front': 'scarf-front.png', 'right': 'scarf-three-quarter.png', 'profile-right': 'scarf-profile.png', 'profile-left': 'scarf-profile-left.png'}
for k, f in views.items(): webp(os.path.join(M, f), f'view-{k}.webp')
webp(os.path.join(M, 'scarf-three-quarter.png'), 'view-left.webp', mirror=True)
for f in glob.glob(os.path.join(ROOT, 'brand', 'cards', 'assets', 'pose-*.png')):
    webp(f, os.path.basename(f).replace('.png', '.webp'))
F = os.path.join(ROOT, 'brand', 'cards', 'fonts')
UNI = 'U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2010-2027,U+2030-203A,U+2190-2193,U+2212,U+2080-2089,U+25B2,U+25BC,U+00A2,U+20AC,U+0400-045F'
for f in ['Archivo-Black.ttf', 'SpaceGrotesk-Medium.ttf', 'SpaceGrotesk-Bold.ttf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf']:
    subprocess.run(['pyftsubset', os.path.join(F, f), f'--unicodes={UNI}', '--flavor=woff2', '--layout-features=*',
                    f'--output-file={os.path.join(OUT, f.replace(".ttf", ".woff2"))}'], check=True)
for f in ['scarf-mark.svg']:
    p = os.path.join(ROOT, 'brand', 'logo', f)
    if os.path.exists(p): open(os.path.join(OUT, f), 'wb').write(open(p, 'rb').read())
im = Image.open(os.path.join(ROOT, 'brand', 'logo', 'scarf-mark-64.png')).convert('RGBA').resize((32, 32), Image.LANCZOS)
im.save(os.path.join(OUT, 'favicon.png'))
print('\n'.join(f'{n}: {os.path.getsize(os.path.join(OUT, n)) // 1024} KB' for n in sorted(os.listdir(OUT))))
