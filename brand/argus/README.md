# Argus brand (archived)

The Argus eye and ΛRGUS wordmark, kept here for use elsewhere after the bot was renamed
Aegis. Traced as vector art from the original artwork.

| File | What |
| --- | --- |
| `argus-logo.svg` | Eye + wordmark, off-white on transparent |
| `favicon.svg`, `icon-32.png` | Browser tab icon (eye on a dark rounded square) |
| `apple-touch-icon.png` | iPhone home screen, 180 px |
| `icon-192.png`, `icon-512.png` | Rounded square, for Android and desktop installs |
| `icon-maskable-512.png` | Full bleed, eye inside the safe circle (Android adaptive icons) |
| `build-icons.mjs` | Rebuilds all of the above from the shapes in the script |

Rebuild: `/opt/node24/bin/node brand/argus/build-icons.mjs` (uses the repo's Playwright).
Colours: off-white `#f3efe8` on near-black `#0b1114`. The wordmark's A has no crossbar.
