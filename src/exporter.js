import JSZip from 'jszip';
import {
  DEFAULT_RENDER, luma, surroundingRed, isOccludedStroke,
  referenceRed, isMuddyInk
} from './repair.js';

export const isTauri = () =>
  typeof window !== 'undefined' &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__);

async function tauriModules() {
  if (!isTauri()) return null;
  try {
    const [core, dialog] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-dialog')
    ]);
    return { core, dialog };
  } catch {
    return null;
  }
}

function padBox(box, image, ratio) {
  const pad = Math.round(Math.max(box.w, box.h) * ratio);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const r = Math.min(image.width, box.x + box.w + pad);
  const b = Math.min(image.height, box.y + box.h + pad);
  return { x, y, w: r - x, h: b - y };
}

/**
 * 生成单枚印章的 RGBA 像素。
 *
 * mode: transparent(透明底) | white(白底) | crop(原图裁切) | clean(去黑字裁切)
 * render: 见 DEFAULT_RENDER
 *
 * 关键：扫描件里的黑色签字 / 印刷字常常被扫成「深褐红」，饱和度与色相都落在红区，
 * 因此会混进红色掩膜。这里先按印章自身最亮的红色算出参考红，把这类暗色杂墨
 * 与真正的红笔画区分开：夹在两侧红笔画之间的用周边红补齐，其余清除。
 */
export function buildSealImage(page, box, mode = 'transparent', padRatio = 0.06, render = {}) {
  const opt = { ...DEFAULT_RENDER, ...render };
  const image = page.image;
  const data = image.data;
  const mask = page.result.mask;
  const W = image.width, H = image.height;
  const fullPad = mode === 'crop' || mode === 'clean';
  const r = padBox(box, image, fullPad ? padRatio : padRatio * 0.6);
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const radius = opt.repair ? Math.max(1, Math.round(opt.radius)) : 0;
  const stats = { filled: 0, cleaned: 0 };

  // 自适应参考红：用本枚印章最亮的红色像素作为基准，兼容深红章、浅红章、偏色扫描件
  const ref = opt.repair ? referenceRed(data, W, mask, r, opt.darkMax) : null;
  // 原图裁切保留原始章色；其余模式统一成参考红，消除暗红/褐色噪点
  const unify = opt.repair && opt.unifyColor && !!ref && mode !== 'crop';
  const minR = ref ? ref.minR : 0;
  const minChroma = ref ? ref.minChroma : -Infinity;
  const trustedRed = (i) =>
    data[i] >= minR && data[i] - Math.max(data[i + 1], data[i + 2]) >= minChroma;

  // 复用同一个对象，避免逐像素分配
  const edge = { a: 0, r: 0, g: 0, b: 0, ok: false };
  const readEdge = (gx, gy) => {
    let sum = 0, sr = 0, sg = 0, sb = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const idx = yy * W + xx;
        const i = idx * 4;
        n++;
        if (!mask[idx] || !trustedRed(i)) continue;
        sum += 255;
        sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
      }
    }
    edge.a = n ? sum / n : 0;
    edge.ok = sum > 0;
    if (edge.ok) {
      const cnt = sum / 255;
      edge.r = sr / cnt; edge.g = sg / cnt; edge.b = sb / cnt;
      if (unify) { edge.r = ref.r; edge.g = ref.g; edge.b = ref.b; }
    }
  };

  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const gx = r.x + x, gy = r.y + y;
      const gi = gy * W + gx;
      const si = gi * 4;
      const oi = (y * r.w + x) * 4;
      const m = mask[gi];
      const R = data[si], G = data[si + 1], B = data[si + 2];
      const dark = luma(R, G, B) < opt.darkMax;
      const muddy = isMuddyInk(R, G, B, ref);
      let outR = R, outG = G, outB = B, alpha = 255;

      readEdge(gx, gy);
      let filled = false, clean = false;
      let near = null;
      if (opt.repair && muddy) {
        near = surroundingRed(data, W, H, mask, gx, gy, r, radius, minR, minChroma);
        if (isOccludedStroke(near)) {
          outR = unify ? ref.r : near.r;
          outG = unify ? ref.g : near.g;
          outB = unify ? ref.b : near.b;
          filled = true; stats.filled++;
        } else if (opt.cleanDark &&
                   (m || (near && near.support >= 1) || mode !== 'crop')) {
          clean = true; stats.cleaned++;
        }
      }

      if (filled) {
        alpha = 255;
      } else if (clean) {
        if (mode === 'transparent') {
          alpha = 0;
        } else {
          outR = outG = outB = 255;
          alpha = 255;
        }
      } else if (m) {
        // 真正的红笔画：统一成参考红，避免暗红/褐色噪点混在章面上
        if (unify) { outR = ref.r; outG = ref.g; outB = ref.b; }
        alpha = 255;
      } else if (mode === 'transparent') {
        // 抗锯齿边缘用邻近红色，而不是原始黑色像素
        if (edge.ok) { outR = edge.r; outG = edge.g; outB = edge.b; }
        alpha = edge.a;
      } else if (mode === 'white') {
        outR = outG = outB = 255;
        alpha = 255;
      } else {
        // crop / clean：保留原图；clean 模式把剩余深色黑字一并置白
        if (mode === 'clean' && dark) outR = outG = outB = 255;
        alpha = 255;
      }

      out[oi] = outR; out[oi + 1] = outG; out[oi + 2] = outB; out[oi + 3] = alpha;
    }
  }
  return { width: r.w, height: r.h, data: out, stats };
}

export async function toPNGBytes(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function downloadBytes(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Tauri 2 命令参数默认按 camelCase 取名：Rust 的 data_b64 对应 JS 的 dataB64 */
async function writeFileViaRust(t, path, bytes) {
  const written = await t.core.invoke('save_bytes', {
    path,
    dataB64: bytesToBase64(bytes)
  });
  if (Number(written) !== bytes.length) {
    throw new Error('写入字节数不一致，文件可能未完整保存');
  }
}

/** 桌面端弹保存对话框写文件；浏览器走下载；任何写入失败都明确抛错，不再静默吞掉 */
export async function saveBytes(name, bytes, ext = 'png') {
  const mime = ext === 'zip' ? 'application/zip' : 'image/png';
  const t = await tauriModules();
  if (t) {
    let path;
    try {
      path = await t.dialog.save({
        defaultPath: name,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      });
    } catch (e) {
      throw new Error(`无法打开保存对话框：${e?.message ?? e}`);
    }
    if (!path) return 'cancel';
    if (!path.toLowerCase().endsWith(`.${ext}`)) path += `.${ext}`;
    try {
      await writeFileViaRust(t, path, bytes);
    } catch (e) {
      const msg = String(e?.message ?? e);
      throw new Error(`写入失败：${msg}\n请改存到桌面/文档等可写目录，或关闭「受控文件夹访问」/杀毒软件拦截。`);
    }
    return 'saved';
  }
  downloadBytes(name, bytes, mime);
  return 'download';
}

/** 导出勾选印章为 ZIP（附一份 CSV 清单） */
export async function exportZip(seals, mode, render = {}, padRatio = 0.06) {
  const zip = new JSZip();
  const rows = [['文件名', '来源', '页码', 'X', 'Y', '宽', '高', '置信度']];
  for (const s of seals) {
    const png = await toPNGBytes(buildSealImage(s.page, s.box, mode, padRatio, render));
    zip.file(s.filename, png);
    rows.push([s.filename, s.page.name, String(s.page.pageNumber), String(s.box.x),
      String(s.box.y), String(s.box.w), String(s.box.h), String(s.box.score)]);
  }
  const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  zip.file('印章清单.csv', csv);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return saveBytes('合同印章.zip', bytes, 'zip');
}

/** 桌面端：选择文件夹，把每枚印章写成独立 PNG */
export async function exportToFolder(seals, mode, render = {}, padRatio = 0.06) {
  const t = await tauriModules();
  if (!t) return null;
  let folder;
  try {
    folder = await t.dialog.open({ directory: true, multiple: false, title: '选择导出文件夹' });
  } catch (e) {
    throw new Error(`无法打开文件夹选择：${e?.message ?? e}`);
  }
  if (!folder || typeof folder !== 'string') return 0;
  const sep = folder.includes('\\') ? '\\' : '/';
  const base = folder.replace(/[\\/]+$/, '');
  let written = 0;
  const failures = [];
  for (const s of seals) {
    try {
      const png = await toPNGBytes(buildSealImage(s.page, s.box, mode, padRatio, render));
      await writeFileViaRust(t, `${base}${sep}${s.filename}`, png);
      written++;
    } catch (e) {
      failures.push(`${s.filename}：${String(e?.message ?? e)}`);
    }
  }
  if (failures.length) {
    // 已写出的不回退，明确告知失败项，不静默吞掉
    throw new Error(`已写出 ${written} 个，${failures.length} 个失败。${failures.slice(0, 3).join('；')}${failures.length > 3 ? ' …' : ''}`);
  }
  return written;
}
