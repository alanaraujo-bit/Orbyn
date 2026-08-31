#!/usr/bin/env node
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Draws the Orbyn app icons.
 *
 *   node scripts/generate-icons.mjs
 *
 * The panel has no logo asset and no image toolchain, so the icons are drawn
 * here instead of being checked in as opaque binaries: the mark is a ring with
 * one orbiting dot, in the same accent the sidebar uses. Re-run this after
 * changing --color-accent in globals.css so the installed app and the panel
 * stay in step.
 *
 * PNG is written by hand (zlib is in Node's standard library) to keep this a
 * zero-dependency script. Every shape is drawn at 4x and box-filtered down,
 * which is what gives the curves clean edges.
 */

const OUT_DIR = path.resolve(process.cwd(), 'public/icons');
const SUPERSAMPLE = 4;

/** Accent from globals.css, so there is a single source of truth for the hue. */
const ACCENT_OKLCH = [0.52, 0.15, 258];
const FOREGROUND = [255, 255, 255];

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/** oklch -> sRGB bytes. The panel speaks oklch; PNG only speaks sRGB. */
function oklchToRgb([L, C, hDeg]) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return linear.map((channel) => {
    const clamped = Math.min(Math.max(channel, 0), 1);
    const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixel bytes as a PNG. One filter byte (none) per scanline. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Renders one icon.
 *
 * @param size      final edge length in pixels
 * @param radius    corner radius as a fraction of the edge; 0.5 is a circle,
 *                  0 a square. Maskable icons pass 0 and let the platform cut.
 * @param markScale how much of the edge the ring occupies. Maskable icons keep
 *                  this inside the 80% safe zone Android may crop to.
 */
function drawIcon(size, { radius, markScale }) {
  const accent = oklchToRgb(ACCENT_OKLCH);
  const s = size * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);

  const corner = radius * s;
  const centre = s / 2;
  const ringOuter = (markScale * s) / 2;
  const ringInner = ringOuter * 0.66;
  // The orbiting dot sits on the ring's centreline, up and to the right.
  const dotAngle = -Math.PI / 4;
  const dotRadius = ringOuter * 0.26;
  const dotX = centre + Math.cos(dotAngle) * ((ringOuter + ringInner) / 2);
  const dotY = centre + Math.sin(dotAngle) * ((ringOuter + ringInner) / 2);
  // Gap in the ring behind the dot, so the dot reads as a separate body.
  const gapRadius = dotRadius * 1.55;

  const insideRoundedSquare = (x, y) => {
    if (corner <= 0) return true;
    const dx = Math.max(corner - x, x - (s - corner), 0);
    const dy = Math.max(corner - y, y - (s - corner), 0);
    return dx * dx + dy * dy <= corner * corner;
  };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px * SUPERSAMPLE + sx + 0.5;
          const y = py * SUPERSAMPLE + sy + 0.5;
          if (!insideRoundedSquare(x, y)) continue;

          const distance = Math.hypot(x - centre, y - centre);
          const toDot = Math.hypot(x - dotX, y - dotY);
          const onRing = distance <= ringOuter && distance >= ringInner;
          const foreground = toDot <= dotRadius || (onRing && toDot > gapRadius);
          const [cr, cg, cb] = foreground ? FOREGROUND : accent;

          r += cr;
          g += cg;
          b += cb;
          covered += 1;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      // Colour is averaged over covered samples only, so the rounded corners
      // fade in alpha rather than towards black.
      pixels[offset] = covered === 0 ? 0 : Math.round(r / covered);
      pixels[offset + 1] = covered === 0 ? 0 : Math.round(g / covered);
      pixels[offset + 2] = covered === 0 ? 0 : Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }

  return encodePng(size, size, pixels);
}

const TARGETS = [
  // Rounded square: browsers and desktops that show the icon as-is.
  { file: 'icon-192.png', size: 192, radius: 0.22, markScale: 0.58 },
  { file: 'icon-512.png', size: 512, radius: 0.22, markScale: 0.58 },
  // Full bleed, mark inside the 80% safe zone: Android applies its own mask.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, markScale: 0.46 },
  // iOS masks the square itself and ignores transparency.
  { file: 'apple-touch-icon.png', size: 180, radius: 0, markScale: 0.56 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const target of TARGETS) {
  const png = drawIcon(target.size, target);
  writeFileSync(path.join(OUT_DIR, target.file), png);
  process.stdout.write(`${target.file}  ${target.size}x${target.size}  ${png.length} bytes\n`);
}
