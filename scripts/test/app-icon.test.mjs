import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { describe, it } from 'node:test';
import { sourceFiles } from '@fivvi/design-tokens/source';
import { decodePng, renderIcons } from '../app-icon.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
// Every file this test reads: turbo caches `//#test:root` by its `inputs`, so each must be one of them (last test below).
const reads = new Set();
const read = (path) => {
  reads.add(path);
  return readFileSync(join(ROOT, path));
};
const text = (path) => read(path).toString('utf8');

const IOS_ICON = 'apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/AppIcon.png';
const PLAY_ICON = 'apps/android/app/src/main/ic_launcher-playstore.png';
const RES = 'apps/android/app/src/main/res';

// The colours the icon takes from the design tokens (light values, packages/design-tokens/tokens).
const tokenColour = (name) =>
  text('packages/design-tokens/generated/web/tokens.css').match(
    new RegExp(`--th-color-${name}: (#[0-9a-f]{6});`),
  )[1];
const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const pixel = (png, x, y) => [
  ...png.pixels.subarray((y * png.width + x) * 3, (y * png.width + x) * 3 + 3),
];

describe('E017 AC8: the app icon is generated from the design tokens', () => {
  it('the committed icon files are what the script generates', async () => {
    const files = await renderIcons(ROOT);

    assert.ok(files.size >= 7, [...files.keys()].join(', '));
    for (const [path, content] of files) {
      assert.ok(existsSync(join(ROOT, path)), `${path} is missing: run pnpm app-icon`);
      if (path.endsWith('.png')) {
        const committed = decodePng(read(path));
        const generated = decodePng(content);
        assert.deepEqual(
          [committed.width, committed.height, committed.colorType],
          [generated.width, generated.height, generated.colorType],
          path,
        );
        assert.ok(committed.pixels.equals(generated.pixels), `${path} is stale: run pnpm app-icon`);
      } else {
        assert.equal(text(path), content, `${path} is stale: run pnpm app-icon`);
      }
    }
  });

  it('the App Store icon is 1024 px square without transparency, in the colours of the primary action', () => {
    const png = decodePng(read(IOS_ICON));

    assert.deepEqual([png.width, png.height], [1024, 1024]);
    assert.equal(
      png.colorType,
      2,
      'RGB without an alpha channel: the App Store refuses transparency',
    );
    assert.deepEqual(pixel(png, 2, 2), rgb(tokenColour('action-primary-bg')));
    assert.deepEqual(
      pixel(png, 512, 512),
      rgb(tokenColour('action-primary-fg')),
      'the mark is in the centre',
    );
  });

  it('the Play Store icon is 512 px square', () => {
    const png = decodePng(read(PLAY_ICON));

    assert.deepEqual([png.width, png.height, png.colorType], [512, 512, 2]);
    assert.deepEqual(pixel(png, 2, 2), rgb(tokenColour('action-primary-bg')));
  });

  it('the asset catalog declares the icon, and the project builds it', () => {
    const contents = JSON.parse(
      text('apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/Contents.json'),
    );

    assert.deepEqual(
      contents.images.map(({ filename, size, platform }) => [filename, size, platform]),
      [['AppIcon.png', '1024x1024', 'ios']],
    );
    assert.match(
      text('apps/ios/FivviPro.xcodeproj/project.pbxproj'),
      /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/,
    );
  });

  it('the Android icon is adaptive, with a background, a foreground and a monochrome layer for themed icons', () => {
    const icon = text(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`);

    for (const layer of ['background', 'foreground', 'monochrome']) {
      const drawable = icon.match(new RegExp(`<${layer} android:drawable="@drawable/(\\w+)"`))?.[1];
      assert.ok(drawable, `no ${layer} layer`);
      assert.ok(
        existsSync(join(ROOT, `${RES}/drawable/${drawable}.xml`)),
        `${drawable}.xml is missing`,
      );
    }
    assert.match(
      text('apps/android/app/src/main/AndroidManifest.xml'),
      /android:icon="@mipmap\/ic_launcher"/,
    );
  });

  it('the Android mark stays inside the 66 dp safe zone of the 108 dp icon, whatever shape the launcher cuts', () => {
    for (const layer of ['foreground', 'monochrome']) {
      const path = text(`${RES}/drawable/ic_launcher_${layer}.xml`).match(
        /android:pathData="([^"]+)"/,
      )[1];
      const points = [...path.matchAll(/([HV]?)(-?[\d.]+)(?:,(-?[\d.]+))?/g)];
      assert.ok(points.length > 3, layer);
      let [x, y] = [0, 0];
      for (const [, command, a, b] of points) {
        if (command === 'H') x = Number(a);
        else if (command === 'V') y = Number(a);
        else if (b !== undefined) [x, y] = [Number(a), Number(b)];
        assert.ok(
          Math.hypot(x - 54, y - 54) <= 33,
          `${layer}: (${x}, ${y}) is outside the safe zone`,
        );
      }
    }
  });
});

describe('E017 AC8: a change to what the icon depends on is not served from the test cache', () => {
  it('turbo.json lists as inputs of the root tests every file the icon test and the generator read', () => {
    const { inputs } = JSON.parse(text('turbo.json')).tasks['//#test:root'];
    // What the generator reads that the test does not read itself: the token source files (as the token package names
    // them), the package's `./source` export and the script.
    const depends = new Set([
      ...reads,
      ...[
        sourceFiles.palette,
        sourceFiles.light,
        sourceFiles.dark,
        ...sourceFiles.shared,
        sourceFiles.contrastPairs,
      ].map((file) => `packages/design-tokens/${file}`),
      'packages/design-tokens/src/source.ts',
      'packages/design-tokens/package.json',
      'scripts/app-icon.mjs',
    ]);
    // turbo.json itself needs no entry: a task's definition is part of its hash.
    depends.delete('turbo.json');

    const uncovered = [...depends].filter(
      (file) => !inputs.some((input) => matchesGlob(file, input)),
    );
    assert.deepEqual(uncovered, [], 'add these to the inputs of //#test:root in turbo.json');
  });
});
