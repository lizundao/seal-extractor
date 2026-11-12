/**
 * 算法回归测试：合成一张含多枚印章、红色干扰线的合同图，
 * 在 Node 里直接加载离线 OpenCV.js 验证检测效果，无需浏览器。
 * 运行：npm test
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { detectSeals, suggestMinSize } from '../src/detector.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- 极简 PNG 编码，用于生成测试夹具与结果图 ---------- */
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 合成合同图 ---------- */
const W = 1000, H = 1400;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  img[i * 4] = 250; img[i * 4 + 1] = 249; img[i * 4 + 2] = 246; img[i * 4 + 3] = 255;
}
const RED = [198, 24, 40];
const PALE_RED = [205, 122, 126];
const INK = [45, 48, 55];
const LIGHT_INK = [120, 124, 132];

function px(x, y, c, alpha = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = alpha;
}

function rect(x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(xx, yy, c);
}

function ring(cx, cy, rx, ry, thickness, c) {
  const steps = 1400;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    for (let t = 0; t < thickness; t++) {
      const f = 1 - t / (rx * 2);
      px(cx + Math.cos(a) * (rx - t), cy + Math.sin(a) * (ry - t * ry / rx), c);
    }
  }
}

function hline(x1, x2, y, thickness, c) {
  for (let x = x1; x <= x2; x++) for (let t = 0; t < thickness; t++) px(x, y + t, c);
}

// 正文黑字（用横条模拟）与表格线
for (let i = 0; i < 22; i++) {
  const y = 80 + i * 56;
  hline(70, 880 - (i % 4) * 90, y, 4, i % 5 === 0 ? INK : LIGHT_INK);
}
rect(70, 640, 860, 2, LIGHT_INK);
rect(70, 1290, 860, 2, LIGHT_INK);

// 章 1：圆形公章（中心 250,300，直径 200）
ring(250, 300, 100, 100, 6, RED);
ring(250, 300, 78, 78, 2, RED);
hline(190, 310, 285, 7, RED);
hline(205, 295, 315, 7, RED);
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  for (let t = 0; t < 26; t++) px(250 + Math.cos(a) * (58 + t), 300 + Math.sin(a) * (58 + t), RED);
}

// 章 2：椭圆章（中心 720,430）
ring(720, 430, 112, 72, 6, RED);
hline(660, 780, 420, 6, RED);
hline(680, 760, 448, 6, RED);

// 章 3：矩形章（500,960 起 170x100）
for (let t = 0; t < 6; t++) {
  hline(415, 585, 950 + t, 1, RED);
  hline(415, 585, 1050 - t, 1, RED);
  for (let y = 950; y < 1050; y++) { px(415 + t, y, RED); px(585 - t, y, RED); }
}
hline(440, 560, 990, 7, RED);
hline(450, 550, 1015, 7, RED);

// 章 4：褪色浅红章（760,1150，直径 160）
ring(760, 1150, 80, 80, 6, PALE_RED);
hline(710, 810, 1140, 7, PALE_RED);
hline(720, 800, 1168, 7, PALE_RED);

// 干扰：红色细横线、红色小字块、红色竖线
hline(90, 910, 720, 3, RED);
for (let i = 0; i < 16; i++) rect(100 + i * 26, 790, 12, 14, RED);
for (let y = 1180; y < 1280; y++) px(90, y, RED);

const fixtureDir = path.join(root, 'tests', 'fixtures');
const outDir = path.join(root, 'tests', 'out');
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'contract.png'), encodePNG(W, H, img));

/* ---------- 运行检测 ---------- */
// 项目是 ESM，Node 会把 public/opencv.js 当 ESM 解析；复制成 .cjs 以便按 CommonJS 加载
const cvPath = path.join(root, '.tmp', 'opencv-node.cjs');
fs.mkdirSync(path.dirname(cvPath), { recursive: true });
fs.copyFileSync(path.join(root, 'public', 'opencv.js'), cvPath);
const cv = await require(cvPath);
const image = { data: img, width: W, height: H };
const t0 = Date.now();
const result = detectSeals(cv, image, { satMin: 55 });
const ms = Date.now() - t0;

console.log(`图像 ${W}x${H}，自适应最小边长 ${result.minSize}px，轮廓 ${result.contourCount} 个，耗时 ${ms}ms`);
console.log(`检测到 ${result.boxes.length} 枚印章：`);
for (const b of result.boxes) {
  console.log(`  #${b.id}  (${b.x}, ${b.y}) ${b.w}x${b.h}  红密度=${(b.density * 100).toFixed(1)}%  实心度=${b.solidity.toFixed(2)}  形状比=${b.aspect.toFixed(2)}  置信=${b.score}`);
}

// 结果可视化：把检测框画到合成图上
for (const b of result.boxes) {
  const c = [0, 150, 60];
  for (let t = 0; t < 4; t++) {
    hline(b.x, b.x + b.w, b.y + t, 1, c);
    hline(b.x, b.x + b.w, b.y + b.h - t, 1, c);
    for (let y = b.y; y < b.y + b.h; y++) { px(b.x + t, y, c); px(b.x + b.w - t, y, c); }
  }
}
fs.writeFileSync(path.join(outDir, 'detected.png'), encodePNG(W, H, img));

/* ---------- 断言 ---------- */
const targets = [
  { name: '圆形公章', x: 250, y: 300 },
  { name: '椭圆章', x: 720, y: 430 },
  { name: '矩形章', x: 500, y: 1000 },
  { name: '褪色章', x: 760, y: 1150 }
];
const hit = (t) => result.boxes.some(b => t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h);
let ok = true;
for (const t of targets) {
  const found = hit(t);
  console.log(`${found ? 'PASS' : 'FAIL'}  ${t.name}`);
  if (!found) ok = false;
}
const stray = result.boxes.filter(b => b.w > 700 && b.h < 30);
console.log(`${stray.length === 0 ? 'PASS' : 'FAIL'}  红色细线未误报为印章`);
if (stray.length) ok = false;
console.log(`${result.boxes.length <= 6 ? 'PASS' : 'FAIL'}  候选数量未爆炸（${result.boxes.length} <= 6）`);
if (result.boxes.length > 6) ok = false;

console.log(ok ? '\n全部通过' : '\n存在失败项');
process.exit(ok ? 0 : 1);
