#!/usr/bin/env node
// The app icon of Fivvi Pro on both platforms, generated from one source (E017 AC8, decision 6: a placeholder until a
// designed icon exists). The source is the mark below (an "F" on a 108 x 108 grid, the size of an Android adaptive
// icon layer) and the colours of the primary action in packages/design-tokens (`color.action.primary.bg` and `.fg`).
//
//   node scripts/app-icon.mjs            write every icon file (pnpm app-icon); scripts/test/app-icon.test.mjs fails when a
//                                        committed file differs from what the source generates
//
// Output (generated, never edited by hand):
//   apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/AppIcon.png   1024 px, RGB without alpha (App Store)
//   apps/android/app/src/main/res/drawable/ic_launcher_{background,foreground,monochrome}.xml, vector layers
//   apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml   the adaptive icon with its monochrome layer
//   apps/android/app/src/main/ic_launcher-playstore.png                512 px, RGB (Google Play listing)
//
// A designed icon replaces the placeholder by changing MARK and the tokens here, or this script. No dependency: the PNG
// is rasterised and encoded with Node's zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { readTokenSource } from '@fivvi/design-tokens/source';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The grid of an Android adaptive icon layer; the launcher shows the middle 66 x 66 whatever shape it cuts. */
const GRID = 108;
/** The mark: an "F", one closed outline on the grid, centred and inside the safe zone (radius 33 around 54, 54). */
const MARK = [
  [37, 30],
  [71, 30],
  [71, 42],
  [49, 42],
  [49, 48],
  [64, 48],
  [64, 58],
  [49, 58],
  [49, 78],
  [37, 78],
];
/** The store icons have no launcher mask around the mark, so it is drawn larger there. */
const STORE_SCALE = 1.3;

/** The token `path` of the light palette with references (`{color.base.white}`) followed, as `#rrggbb`. */
function colour(tree, path) {
  let value = path.split('.').reduce((node, key) => node?.[key], tree)?.$value;
  while (typeof value === 'string' && value.startsWith('{')) {
    value = value
      .slice(1, -1)
      .split('.')
      .reduce((node, key) => node?.[key], tree)?.$value;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(value ?? ''))
    throw new Error(`token ${path} is not a #rrggbb colour: ${value}`);
  return value.toLowerCase();
}

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const argb = (hex) => `#FF${hex.slice(1).toUpperCase()}`;

/** Whether the point is inside the polygon (even-odd rule). */
function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A `size` px square of `background` with the mark in `foreground`, anti-aliased with 4 x 4 samples per pixel. */
function raster(size, background, foreground) {
  const scale = size / GRID;
  const grow = STORE_SCALE * scale;
  const polygon = MARK.map(([x, y]) => [
    (x - GRID / 2) * grow + size / 2,
    (y - GRID / 2) * grow + size / 2,
  ]);
  const [minX, maxX] = [
    Math.min(...polygon.map((p) => p[0])),
    Math.max(...polygon.map((p) => p[0])),
  ];
  const [minY, maxY] = [
    Math.min(...polygon.map((p) => p[1])),
    Math.max(...polygon.map((p) => p[1])),
  ];
  const [from, to] = [rgb(background), rgb(foreground)];
  const pixels = Buffer.alloc(size * size * 3);
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      if (x + 1 > minX && x < maxX && y + 1 > minY && y < maxY) {
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) {
            if (inside(polygon, x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) covered++;
          }
        }
      }
      const share = covered / (samples * samples);
      for (let channel = 0; channel < 3; channel++) {
        pixels[(y * size + x) * 3 + channel] = Math.round(
          from[channel] + (to[channel] - from[channel]) * share,
        );
      }
    }
  }
  return pixels;
}

/** The PNG file of an RGB (colour type 2, 8 bit, no alpha) image. */
function encodePng(size, pixels) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reads a PNG written by this script (filter type 0 on every row): its size, colour type and RGB pixels. */
export function decodePng(file) {
  let offset = 8;
  let header;
  const data = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = body;
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  const colorType = header[9];
  const channels = colorType === 2 ? 3 : 4;
  const rows = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const start = y * (width * channels + 1);
    if (rows[start] !== 0) throw new Error('only PNGs without row filters are supported');
    rows.copy(pixels, y * width * channels, start + 1, start + 1 + width * channels);
  }
  return { width, height, colorType, pixels };
}

const markPath = `M${MARK.map(([x, y], i) => (i === 0 ? `${x},${y}` : y === MARK[i - 1][1] ? `H${x}` : `V${y}`)).join('')}Z`;

const vector = (name, fill, shape) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/app-icon.mjs (${name}); never edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${GRID}dp"
    android:height="${GRID}dp"
    android:viewportWidth="${GRID}"
    android:viewportHeight="${GRID}">
    <path
        android:fillColor="${fill}"
        android:pathData="${shape}" />
</vector>
`;

/** Every icon file as a map from its path in the repo to its content (a string or a Buffer). */
export async function renderIcons(root = ROOT) {
  const { light } = await readTokenSource(join(root, 'packages/design-tokens'));
  const background = colour(light, 'color.action.primary.bg');
  const foreground = colour(light, 'color.action.primary.fg');
  const res = 'apps/android/app/src/main/res';
  return new Map([
    [
      'apps/ios/FivviPro/Assets.xcassets/Contents.json',
      '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n',
    ],
    [
      'apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/Contents.json',
      `${JSON.stringify(
        {
          images: [
            { filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
          ],
          info: { author: 'xcode', version: 1 },
        },
        null,
        2,
      )}\n`,
    ],
    [
      'apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/AppIcon.png',
      encodePng(1024, raster(1024, background, foreground)),
    ],
    [
      'apps/android/app/src/main/ic_launcher-playstore.png',
      encodePng(512, raster(512, background, foreground)),
    ],
    [
      `${res}/drawable/ic_launcher_background.xml`,
      vector('background', argb(background), `M0,0H${GRID}V${GRID}H0Z`),
    ],
    [
      `${res}/drawable/ic_launcher_foreground.xml`,
      vector('foreground', argb(foreground), markPath),
    ],
    [`${res}/drawable/ic_launcher_monochrome.xml`, vector('monochrome', '#FF000000', markPath)],
    [
      `${res}/mipmap-anydpi-v26/ic_launcher.xml`,
      `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/app-icon.mjs; never edit by hand. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`,
    ],
  ]);
}

async function main(argv) {
  const files = await renderIcons();
  if (argv.length > 0) {
    console.error('Usage: node scripts/app-icon.mjs');
    return 2;
  }
  for (const [path, content] of files) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), content);
    console.log(`wrote ${path}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
