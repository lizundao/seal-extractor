/**
 * 补色修复回归测试：合成一枚红色圆章，用粗黑签字笔画压在章上，
 * 验证「周边补色」能把被盖住的红色笔画补回、清掉章内黑杂点，
 * 且不把远离红笔画的黑字误改成红色。
 * 运行：npm run test:repair
 */
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildSealImage } from '../src/exporter.js';
import { DEFAULT_RENDER, luma } from '../src/repair.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tests', 'out');
fs.mkdirSync(outDir, { recursive: true });

/* ---------- 极简 PNG 编码 ---------- */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cc = Buffer.alloc(4); cc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, cc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
/** 把 RGBA 平铺到白底，便于人眼查看透明底结果 */
function flatten(img) {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    out[i] = out[i] * a + 255 * (1 - a);
    out[i + 1] = out[i + 1] * a + 255 * (1 - a);
    out[i + 2] = out[i + 2] * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

/* ---------- 合成：白底 + 红圆章 + 黑色签字压章 ---------- */
const W = 260, H = 260;
const data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  data[i * 4] = 250; data[i * 4 + 1] = 249; data[i * 4 + 2] = 246; data[i * 4 + 3] = 255;
}
const RED = [236, 82, 84];        // 扫描件里常见的亮红章色
const MAROON = [110, 65, 70];     // 黑色签字被扫成深褐红，会混进红色掩膜
const BLACK = [30, 32, 38];       // 纯黑印刷字
const put = (x, y, c) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
};
const cx = 130, cy = 130;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = Math.hypot(x - cx, y - cy);
  if (d >= 96 && d <= 104) put(x, y, RED);       // 章圈，8px 粗
}
for (let i = 0; i < 5; i++) {                      // 章内五角星横画
  for (let x = 108; x < 152; x++) put(x, 126 + i, RED);
}
// 压章的签字：竖笔深褐红（会被 HSV 当成红色掩膜）、横笔纯黑，各 7px
for (let y = 18; y < 242; y++) for (let t = 0; t < 7; t++) put(127 + t, y, MAROON);
for (let x = 18; x < 242; x++) for (let t = 0; t < 7; t++) put(x, 127 + t, BLACK);
// 远离红笔画的黑字（章心空白处），不应被补成红色 / 被清除
for (let x = 150; x < 186; x++) for (let t = 0; t < 4; t++) put(x, 80 + t, BLACK);

// 模拟 HSV 红色掩膜：亮红笔画、深褐红签字都会命中，纯黑 / 白底不会
const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
  if (r > 85 && r - Math.max(g, b) > 20) mask[i] = 255;
}
const page = { image: { data, width: W, height: H }, result: { mask } };
const box = { x: 24, y: 24, w: 212, h: 212, id: 1 };

const on = { ...DEFAULT_RENDER, radius: 8 };
const off = { ...DEFAULT_RENDER, repair: false };
const beforeT = buildSealImage(page, box, 'transparent', 0, off);
const afterT = buildSealImage(page, box, 'transparent', 0, on);
const beforeC = buildSealImage(page, box, 'crop', 0, off);
const afterC = buildSealImage(page, box, 'crop', 0, on);
const cleanC = buildSealImage(page, box, 'clean', 0, on);

fs.writeFileSync(path.join(outDir, 'repair-before.png'), encodePNG(beforeC.width, beforeC.height, beforeC.data));
fs.writeFileSync(path.join(outDir, 'repair-after.png'), encodePNG(afterC.width, afterC.height, afterC.data));
fs.writeFileSync(path.join(outDir, 'repair-clean.png'), encodePNG(cleanC.width, cleanC.height, cleanC.data));
fs.writeFileSync(path.join(outDir, 'repair-transparent.png'), encodePNG(afterT.width, afterT.height, flatten(afterT)));

// 黑色墨迹：三个通道都暗；深红色章（R 很高）不算黑字
const isInk = (d, i) =>
  d[i + 3] > 200 &&
  Math.max(d[i], d[i + 1], d[i + 2]) < 120 &&
  luma(d[i], d[i + 1], d[i + 2]) < 90;
const isRedInk = (d, i) =>
  d[i + 3] > 200 && d[i] > 120 && d[i + 1] < 120 && d[i + 2] < 120;

const countRedOpaque = (img) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (isRedInk(img.data, i)) n++;
  return n;
};
const countDark = (img) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (isInk(img.data, i)) n++;
  return n;
};
/** 紧贴红笔画的黑色干扰像素（黑字压章的位置） */
const countDarkNearRed = (img, rad = 3) => {
  const { width: w, height: h, data: d } = img;
  const isRed = (i) => isRedInk(d, i);
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!isInk(d, i)) continue;
    let near = false;
    for (let dy = -rad; dy <= rad && !near; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (isRed((yy * w + xx) * 4)) { near = true; break; }
      }
    }
    if (near) n++;
  }
  return n;
};
/** 章心那行黑字所在区域（远离红色笔画），用于确认没有被误清除/误补色 */
const centerDark = (img) => {
  let n = 0;
  for (let y = 54; y < 63; y++) for (let x = 124; x < 164; x++) {
    const i = (y * img.width + x) * 4;
    if (isInk(img.data, i)) n++;
  }
  return n;
};

const redBefore = countRedOpaque(beforeT);
const redAfter = countRedOpaque(afterT);
const nearBefore = countDarkNearRed(beforeC);
const nearAfter = countDarkNearRed(afterC);
const inkBeforeT = countDark(beforeT);   // 混进掩膜的深褐红签字在透明底里可见
const inkAfterT = countDark(afterT);
const darkClean = countDark(cleanC);
const farBefore = centerDark(beforeC);
const farAfter = centerDark(afterC);

console.log(`透明底红色笔画像素：修复前 ${redBefore} → 修复后 ${redAfter}（+${redAfter - redBefore}）`);
console.log(`紧贴红笔画的黑色干扰：修复前 ${nearBefore} → 修复后 ${nearAfter}（-${nearBefore - nearAfter}）`);
console.log(`透明底里的暗色杂墨：修复前 ${inkBeforeT} → 修复后 ${inkAfterT}`);
console.log(`去黑字裁切模式剩余黑像素：${darkClean}`);
console.log(`远离红笔画的黑字：修复前 ${farBefore} → 修复后 ${farAfter}`);
console.log(`补色 ${afterT.stats.filled} px，清除黑杂点 ${afterT.stats.cleaned} px`);

let ok = true;
const check = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) ok = false; };
check(redAfter > redBefore * 1.05, '被黑字盖住的红笔画被周边红色补回');
check(nearAfter < nearBefore * 0.6, '红笔画上的黑色干扰明显减少');
check(inkAfterT < inkBeforeT * 0.15, '混进红色掩膜的深褐红签字被清除');
check(darkClean <= 5, '去黑字裁切模式清除了黑色签字');
check(Math.abs(farAfter - farBefore) <= 2, '原图裁切下远离红笔画的黑字没有被误改');
check(afterT.stats.filled > 100, '补色像素数量合理');
console.log(ok ? '\n全部通过' : '\n存在失败项');
process.exit(ok ? 0 : 1);
