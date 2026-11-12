/**
 * 红色印章检测（纯计算，无 DOM 依赖）
 *
 * 输入 RGBA 像素 + 已初始化的 OpenCV.js 实例，输出印章候选框与红色掩膜。
 * 处理链：RGBA -> RGB -> HSV -> 双红区间阈值 -> 形态学闭运算 -> 轮廓 -> 规则筛选 -> 框合并。
 * 既可在浏览器里跑，也可在 Node 里直接跑（tests/detector.test.mjs）。
 */

export const DEFAULT_PARAMS = {
  satMin: 70,          // 红色饱和度下限，扫描件褪色时可降到 40
  valMin: 55,          // 明度下限
  hueLow: 12,          // 低红区上界（OpenCV H: 0..179）
  hueHigh: 165,        // 高红区下界
  minSize: null,       // 印章最小边长(px)，null = 按图像尺寸自适应
  maxAspect: 2.6,      // 宽高比上限
  minDensity: 0.045,   // 框内红色像素占比下限
  minSolidity: 0.18,   // 闭运算后轮廓实心度下限
  closeRatio: 0.16,    // 闭运算核 / minSize
  mergeIou: 0.32,      // 重叠框合并阈值
  denoise: false,      // 3x3 开运算去孤立噪点
  padRatio: 0.06       // 裁切时四周留白比例
};

/** 建议的最小印章边长：按短边自适应，避免不同分辨率下参数失效 */
export function suggestMinSize(width, height) {
  const short = Math.min(width, height);
  return Math.max(40, Math.min(160, Math.round(short * 0.055)));
}

function odd(n) {
  return Math.max(3, Math.min(41, (n % 2 === 0 ? n + 1 : n)));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function overlap(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** 合并同一枚印章被拆散的框，以及闭运算后重复出现的框 */
function mergeBoxes(list, threshold) {
  const sorted = list.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  const result = [];
  for (const box of sorted) {
    let target = null;
    for (const kept of result) {
      const iou = overlap(box, kept);
      const smallInBig = box.w * box.h < kept.w * kept.h * 0.65 &&
        overlap(box, kept) > 0.12;
      if (iou > threshold || smallInBig) { target = kept; break; }
    }
    if (!target) { result.push({ ...box }); continue; }
    const x = Math.min(target.x, box.x);
    const y = Math.min(target.y, box.y);
    const r = Math.max(target.x + target.w, box.x + box.w);
    const b = Math.max(target.y + target.h, box.y + box.h);
    target.x = x; target.y = y; target.w = r - x; target.h = b - y;
    target.area = Math.max(target.area, box.area);
    target.density = Math.max(target.density, box.density);
    target.solidity = Math.max(target.solidity, box.solidity);
  }
  return result;
}

/**
 * @param {object} cv    OpenCV.js 实例
 * @param {{data: Uint8Array|Uint8ClampedArray, width: number, height: number}} image RGBA
 * @param {object} params 见 DEFAULT_PARAMS
 * @returns {{boxes: Array, mask: Uint8Array, width: number, height: number, contourCount: number, minSize: number}}
 */
export function detectSeals(cv, image, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const W = image.width;
  const H = image.height;
  // 空图 / 超大图直接返回空结果，避免 new cv.Mat(0,0) 或超大分配把引擎拖崩
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0 ||
      W * H > 40_000_000 || !image.data || image.data.length < W * H * 4) {
    return { boxes: [], mask: new Uint8Array(W > 0 && H > 0 ? W * H : 0), width: W, height: H, contourCount: 0, minSize: 0 };
  }
  const minSize = Math.round(p.minSize > 0 ? p.minSize : suggestMinSize(W, H));
  const mats = [];
  const keep = (m) => { mats.push(m); return m; };

  try {
    // 1. RGBA -> RGB -> HSV
    const src = keep(new cv.Mat(H, W, cv.CV_8UC4));
    src.data.set(image.data);
    const rgb = keep(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = keep(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

    // 2. 红色在 HSV 里跨 0 度，需要两个区间取并集
    const low1 = keep(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(0, p.satMin, p.valMin, 0)));
    const high1 = keep(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(p.hueLow, 255, 255, 0)));
    const low2 = keep(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(p.hueHigh, p.satMin, p.valMin, 0)));
    const high2 = keep(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(179, 255, 255, 0)));
    const m1 = keep(new cv.Mat());
    const m2 = keep(new cv.Mat());
    cv.inRange(hsv, low1, high1, m1);
    cv.inRange(hsv, low2, high2, m2);
    const maskMat = keep(new cv.Mat());
    cv.bitwise_or(m1, m2, maskMat);

    let work = maskMat;
    if (p.denoise) {
      const k = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
      const opened = keep(new cv.Mat());
      cv.morphologyEx(maskMat, opened, cv.MORPH_OPEN, k);
      work = opened;
    }

    // 3. 大核闭运算：把印章内部断裂的笔画连成整块；红色横线/小字只会形成细长条
    const kSize = odd(Math.round(minSize * p.closeRatio));
    const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize)));
    const closed = keep(new cv.Mat());
    cv.morphologyEx(work, closed, cv.MORPH_CLOSE, kernel);

    // 4. 轮廓
    const contours = keep(new cv.MatVector());
    const hierarchy = keep(new cv.Mat());
    cv.findContours(keep(closed.clone()), contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const contourCount = contours.size();
    const mask = maskMat.data.slice();

    const candidates = [];
    for (let i = 0; i < contourCount; i++) {
      const c = contours.get(i);
      let r;
      try { r = cv.boundingRect(c); } catch { continue; }
      const w = r.width, h = r.height;
      if (w < minSize * 0.55 || h < minSize * 0.55) continue;
      if (w * h < minSize * minSize * 0.5) continue;
      if (w > W * 0.92 && h > H * 0.92) continue;      // 整页偏红
      if (w * h > W * H * 0.55) continue;               // 大块红色背景

      const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
      if (aspect > p.maxAspect) continue;               // 红色横线、竖排细字

      let area = 0;
      try { area = cv.contourArea(c); } catch { /* 忽略异常轮廓 */ }
      const solidity = area / (w * h);
      if (solidity < p.minSolidity) continue;

      // 原始红色像素密度：区分「真印章」和闭运算误连出来的大块空心区域
      let red = 0;
      for (let y = r.y; y < r.y + h; y += 2) {
        const row = y * W;
        for (let x = r.x; x < r.x + w; x += 2) {
          if (mask[row + x]) red++;
        }
      }
      const sampled = Math.ceil(h / 2) * Math.ceil(w / 2);
      const density = red / sampled;
      if (density < p.minDensity) continue;
      if (red < minSize * minSize * 0.01) continue;

      candidates.push({
        x: Math.max(0, r.x), y: Math.max(0, r.y),
        w: Math.min(W - r.x, w), h: Math.min(H - r.y, h),
        area, density, solidity, aspect
      });
    }

    let boxes = mergeBoxes(candidates, p.mergeIou);
    boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    boxes = boxes.map((b, i) => {
      const typical = minSize * minSize * 4;
      const sizeFit = 1 - clamp(Math.abs(Math.log(Math.max(1, b.w * b.h) / typical)) / Math.log(8), 0, 1);
      const score = Math.round(
        38 * clamp(b.density / 0.18, 0, 1) +
        32 * clamp(b.solidity / 0.6, 0, 1) +
        18 / Math.max(1, b.aspect) +
        12 * sizeFit
      );
      return { ...b, id: i + 1, score: clamp(score, 1, 99) };
    });

    return { boxes, mask, width: W, height: H, contourCount, minSize };
  } finally {
    for (const m of mats) {
      try { m.delete(); } catch { /* 已释放 */ }
    }
  }
}
