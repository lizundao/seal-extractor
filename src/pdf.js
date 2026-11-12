import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 资源上限：防止恶意/超大文件把浏览器或 WebView 拖崩
export const MAX_PIXELS_PER_PAGE = 40_000_000;   // 单页解码后像素上限（约 160MB RGBA）
export const MAX_DIMENSION = 12_000;              // 单边像素上限
export const MAX_PDF_PAGES = 120;                 // 单个 PDF 最多渲染页数
export const MAX_PDF_BYTES = 150 * 1024 * 1024;   // 单个 PDF 文件体积上限 150MB

function assertPixels(width, height, label) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${label}：尺寸无效（${width}×${height}）`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`${label}：图片过大（${width}×${height}），单边不得超过 ${MAX_DIMENSION}px`);
  }
  if (width * height > MAX_PIXELS_PER_PAGE) {
    throw new Error(`${label}：图片像素过多（${width}×${height}），超过 ${(MAX_PIXELS_PER_PAGE / 1e6).toFixed(0)}MP 处理上限`);
  }
}

/** 单个位图文件 -> RGBA 像素 */
export async function readImageFile(file) {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，请先压缩`);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
      img.onerror = () => { reject(new Error(`无法读取图片：${file.name}`)); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
  try {
    const w = bitmap.width, h = bitmap.height;
    assertPixels(w, h, file.name);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    return [{
      name: file.name,
      image: { data: data.data, width: data.width, height: data.height },
      pageNumber: 1
    }];
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/** PDF -> 每页 RGBA 像素（全部在内存中完成，不写临时文件） */
export async function readPdfFile(file, scale = 2, onProgress = () => {}) {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(`PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，请先拆分`);
  }
  const bytes = await file.arrayBuffer();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: true }).promise;
  } catch {
    throw new Error(`无法解析 PDF：${file.name}（文件可能损坏或加密）`);
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF 共 ${doc.numPages} 页，超过 ${MAX_PDF_PAGES} 页处理上限，请先拆分`);
    }
    // 按页面物理尺寸反推安全 scale：大页面自动降清晰度，避免 canvas OOM
    const first = await doc.getPage(1);
    const baseViewport = first.getViewport({ scale: 1 });
    first.cleanup();
    const basePixels = Math.max(1, Math.floor(baseViewport.width) * Math.floor(baseViewport.height));
    const safeScale = Math.min(scale, Math.sqrt(MAX_PIXELS_PER_PAGE / basePixels));
    if (safeScale < scale) {
      onProgress(0, doc.numPages);
    }

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress(n, doc.numPages);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: safeScale });
      const w = Math.max(1, Math.floor(viewport.width));
      const h = Math.max(1, Math.floor(viewport.height));
      const canvas = document.createElement('canvas');
      try {
        assertPixels(w, h, `${file.name} 第 ${n} 页`);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        pages.push({
          name: `${file.name} · 第 ${n}/${doc.numPages} 页`,
          image: { data: data.data, width: data.width, height: data.height },
          pageNumber: n
        });
      } finally {
        page.cleanup();
        canvas.width = canvas.height = 0;
      }
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}
