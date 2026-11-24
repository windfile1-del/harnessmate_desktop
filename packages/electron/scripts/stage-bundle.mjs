import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const repoDesktopRoot = path.resolve(electronRoot, '../..');

const resourcesDir = path.join(electronRoot, 'resources');
const daemonOutDir = path.join(resourcesDir, 'daemon');
const webOutDir = path.join(resourcesDir, 'web-dist');
const buildAssetsDir = path.join(electronRoot, 'build');

fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(daemonOutDir, { recursive: true });
fs.mkdirSync(webOutDir, { recursive: true });
fs.mkdirSync(buildAssetsDir, { recursive: true });

// 1. Bundle @harnessmate/daemon into a single self-contained CommonJS file
//    so the packaged app has zero pnpm symlink or external node_modules issues.
const daemonEntry = path.join(repoDesktopRoot, 'packages/daemon/dist/index.js');
if (!fs.existsSync(daemonEntry)) {
  throw new Error(`Missing daemon build at ${daemonEntry}. Run pnpm build first.`);
}

await esbuild.build({
  entryPoints: [daemonEntry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(daemonOutDir, 'daemon.cjs'),
  external: ['node:*'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// 1b. Stage AI Plugin Builder v2 runtime assets alongside daemon.cjs
const builderContextSrc = path.join(repoDesktopRoot, 'docs/plugin-api/ai-builder-context.md');
if (fs.existsSync(builderContextSrc)) {
  fs.copyFileSync(builderContextSrc, path.join(daemonOutDir, 'ai-builder-context.md'));
}

const sdkTestingSrc = path.join(repoDesktopRoot, 'packages/plugin-sdk/dist/testing.js');
if (fs.existsSync(sdkTestingSrc)) {
  await esbuild.build({
    entryPoints: [sdkTestingSrc],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: path.join(daemonOutDir, 'plugin-sdk-testing.mjs'),
    external: ['node:*'],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });
}

// 2. Copy built React frontend assets into resources/web-dist
const webDistSrc = path.join(repoDesktopRoot, 'packages/web/dist');
if (!fs.existsSync(webDistSrc)) {
  throw new Error(`Missing web build at ${webDistSrc}. Run pnpm build first.`);
}
fs.cpSync(webDistSrc, webOutDir, { recursive: true });

// 3. Generate Star Loom Atelier application icon (PNG + multi-size Windows ICO)
const sizes = [256, 64, 48, 32, 16];
const pngBuffers = sizes.map((size) => renderStarLoomPng(size));
fs.writeFileSync(path.join(buildAssetsDir, 'icon.png'), pngBuffers[0]);
fs.writeFileSync(path.join(buildAssetsDir, 'icon.ico'), packIco(sizes, pngBuffers));

console.log('Staged daemon.cjs, web-dist/, and build/icon.ico successfully.');

// ── Pure-Node Star Loom Icon Rasterizer + PNG/ICO Encoder ──────────────

function renderStarLoomPng(size) {
  const rgba = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const half = size / 2;
  const pad = size * 0.04;
  const radius = size * 0.24;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-square SDF
      const dx = Math.max(Math.abs(x - cx) - (half - pad - radius), 0);
      const dy = Math.max(Math.abs(y - cy) - (half - pad - radius), 0);
      const dist = Math.hypot(dx, dy) - radius;
      if (dist > 0.9) continue;

      const edgeAlpha = dist <= -0.5 ? 1 : Math.max(0, Math.min(1, 0.9 - dist));

      // Night Loom deep indigo gradient background
      const nx = x / size;
      const ny = y / size;
      let r = 14 + Math.round(12 * (1 - ny));
      let g = 18 + Math.round(14 * (1 - ny));
      let b = 32 + Math.round(24 * nx);

      // Hairline luminous rim
      if (dist > -size * 0.032) {
        r = Math.round(r * 0.5 + 124 * 0.5);
        g = Math.round(g * 0.5 + 140 * 0.5);
        b = Math.round(b * 0.5 + 255 * 0.5);
      }

      // Normalize coordinates to [-1, 1] for orbital rings + 4-point star
      const ux = (x - cx) / (size * 0.36);
      const uy = (y - cy) / (size * 0.36);

      // Dual rotated orbital ellipses
      const ringAlpha = Math.max(
        ellipseRingAlpha(ux, uy, -0.56, 0.96, 0.44, 0.09),
        ellipseRingAlpha(ux, uy, 0.56, 0.96, 0.44, 0.08) * 0.65,
      );
      if (ringAlpha > 0) {
        r = Math.round(r * (1 - ringAlpha) + 124 * ringAlpha);
        g = Math.round(g * (1 - ringAlpha) + 146 * ringAlpha);
        b = Math.round(b * (1 - ringAlpha) + 255 * ringAlpha);
      }

      // Central 4-point Star Loom diamond flare
      const ax = Math.abs(ux);
      const ay = Math.abs(uy);
      const starDist = Math.pow(ax, 0.58) + Math.pow(ay, 0.58);
      if (starDist < 0.72) {
        const starAlpha = Math.min(1, (0.72 - starDist) * 4.5);
        r = Math.round(r * (1 - starAlpha) + 245 * starAlpha);
        g = Math.round(g * (1 - starAlpha) + 196 * starAlpha);
        b = Math.round(b * (1 - starAlpha) + 88 * starAlpha);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(edgeAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function ellipseRingAlpha(x, y, angleRad, rx, ry, thickness) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const tx = x * cos - y * sin;
  const ty = x * sin + y * cos;
  const norm = Math.hypot(tx / rx, ty / ry);
  const d = Math.abs(norm - 1);
  if (d >= thickness) return 0;
  return 1 - d / thickness;
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // Filter type 0 (None)
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[y * stride + 1 + i] = v;
    });
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function packIco(sizes, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(sizes.length, 4);

  const entries = [];
  let offset = 6 + sizes.length * 16;

  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const png = pngs[i];
    const ent = Buffer.alloc(16);
    ent[0] = s >= 256 ? 0 : s;
    ent[1] = s >= 256 ? 0 : s;
    ent[2] = 0;
    ent[3] = 0;
    ent.writeUInt16LE(1, 4); // planes
    ent.writeUInt16LE(32, 6); // bpp
    ent.writeUInt32LE(png.length, 8);
    ent.writeUInt32LE(offset, 12);
    entries.push(ent);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngs]);
}
