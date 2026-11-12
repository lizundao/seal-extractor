/**
 * 印章「周边补色」工具（纯计算，无 DOM 依赖）
 *
 * 合同上的黑色签字 / 印刷文字经常压在红色印章上，把红笔画盖出黑洞；
 * 另外抗锯齿边缘若沿用原始黑色像素，透明底 PNG 会出现黑色毛边。
 * 这里沿 8 个方向搜索最近的红色像素，用「周边红」的加权均值补回去，
 * 只补深色像素（白色留白不会被误填），避免把章内空隙糊成实心块。
 */

export const DEFAULT_RENDER = {
  repair: true,      // 是否启用补色 / 去黑字
  radius: 6,         // 沿 8 个方向找红笔画的最大距离(px)，黑字越粗调越大
  darkMax: 170,      // 亮度低于此值视为黑字 / 深色干扰
  cleanDark: true,   // 清除红笔画附近、不构成笔画的黑杂点
  unifyColor: true   // 统一章色：所有保留的笔画用参考红输出，消除暗红/褐色噪点
};

// 8 个方向，索引 0/1、2/3、4/5、6/7 两两互为反向
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, -1], [1, -1], [-1, 1]
];
const OPPOSITE_PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7]];

/** 亮度（整数近似，0..255） */
export function luma(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/**
 * 以 (gx,gy) 为中心，沿 8 个方向找最近的红色掩膜像素，
 * 按 1/距离 加权平均得到周边红色。
 *
 * @param {Uint8Array|Uint8ClampedArray} data 原图 RGBA
 * @param {number} W 原图宽
 * @param {number} H 原图高
 * @param {Uint8Array} mask 红色掩膜（0 / 255）
 * @param {number} gx 目标点全局 x
 * @param {number} gy 目标点全局 y
 * @param {{x:number,y:number,w:number,h:number}} bounds 裁切区域（不越出当前印章）
 * @param {number} radius 搜索半径
 * @param {number} minR 参考红色的最低 R 分量（过滤暗褐红墨迹）
 * @param {number} minChroma 参考红色的最低「R - max(G,B)」（过滤灰黑墨迹）
 * @returns {{r:number,g:number,b:number,support:number,opposite:boolean}|null}
 */
export function surroundingRed(data, W, H, mask, gx, gy, bounds, radius, minR = 0, minChroma = 0) {
  let bits = 0;
  let sw = 0, sr = 0, sg = 0, sb = 0;
  const bx2 = bounds.x + bounds.w;
  const by2 = bounds.y + bounds.h;

  for (let d = 0; d < 8; d++) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    for (let s = 1; s <= radius; s++) {
      const x = gx + dx * s, y = gy + dy * s;
      if (x < bounds.x || y < bounds.y || x >= bx2 || y >= by2) break;
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      const idx = y * W + x;
      if (!mask[idx]) continue;
      const i = idx * 4;
      // 深色墨迹也可能落在红色掩膜里，不能拿它当补色样本
      if (data[i] < minR || data[i] - Math.max(data[i + 1], data[i + 2]) < minChroma) continue;
      const wt = 1 / s;
      sr += data[i] * wt;
      sg += data[i + 1] * wt;
      sb += data[i + 2] * wt;
      sw += wt;
      bits |= 1 << d;
      break;
    }
  }
  if (!sw) return null;

  let support = 0;
  for (let d = 0; d < 8; d++) if (bits & (1 << d)) support++;
  let opposite = false;
  for (const [a, b] of OPPOSITE_PAIRS) {
    if ((bits & (1 << a)) && (bits & (1 << b))) { opposite = true; break; }
  }
  return { r: sr / sw, g: sg / sw, b: sb / sw, support, opposite };
}

/** 是否把该深色像素判定为「被盖住的红笔画」并补色 */
export function isOccludedStroke(near) {
  return !!near && (near.opposite || near.support >= 3);
}

/**
 * 用当前印章框内最亮的 25% 红色像素算出「参考红」，作为自适应基准。
 * 扫描件常把黑色签字 / 印刷字扫成深褐红，这些像素会混进红色掩膜，
 * 但明显比印章本身暗、且红得不纯，据此可以把它们与真正的红笔画区分开。
 *
 * @returns {{r,g,b,luma,chroma,minR,minChroma,darkCut,chromaCut}|null}
 */
export function referenceRed(data, W, mask, bounds, darkMax = 170) {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const idx = y * W + x;
      if (!mask[idx]) continue;
      hist[data[idx * 4]]++;
      total++;
    }
  }
  if (!total) return null;

  let threshold = 255, acc = 0;
  const need = Math.max(1, Math.round(total * 0.25));
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= need) { threshold = v; break; }
  }
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const idx = y * W + x;
      if (!mask[idx]) continue;
      const i = idx * 4;
      if (data[i] < threshold) continue;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; cnt++;
    }
  }
  if (!cnt) return null;
  const r = sr / cnt, g = sg / cnt, b = sb / cnt;
  const chroma = r - Math.max(g, b);
  const lum = luma(r, g, b);
  return {
    r, g, b, luma: lum, chroma,
    minR: r * 0.7,
    minChroma: Math.max(15, chroma * 0.45),
    // 阈值相对参考红自适应：亮红章里偏棕的中深墨迹也要算杂色，
    // 但「红得不纯」这一条会保护真正的红笔画（包括浅红/深红章）
    darkCut: Math.max(darkMax * 0.9, lum * 1.15),
    chromaCut: Math.max(25, chroma * 0.85)
  };
}

/** 暗色杂墨：明显比参考红暗，且红色不纯（黑色签字、深褐红印刷字等） */
export function isMuddyInk(r, g, b, ref) {
  return !!ref && luma(r, g, b) < ref.darkCut &&
    (r - Math.max(g, b)) < ref.chromaCut;
}
