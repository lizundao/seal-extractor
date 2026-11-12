import { loadOpenCV } from './cv.js';
import { detectSeals, DEFAULT_PARAMS, suggestMinSize } from './detector.js';
import { DEFAULT_RENDER } from './repair.js';
import { readImageFile, readPdfFile } from './pdf.js';
import {
  buildSealImage, toPNGBytes, saveBytes, exportZip, exportToFolder, isTauri
} from './exporter.js';

const $ = (id) => document.getElementById(id);
const state = {
  cv: null,
  pages: [],
  activeId: null,
  params: { ...DEFAULT_PARAMS },
  mode: 'transparent',
  render: { ...DEFAULT_RENDER },
  selected: new Set(),
  activeSeal: null,
  zoom: 'fit',
  pdfScale: 2,
  busy: false,
  lastMs: 0
};
let uid = 0;
let toastTimer = null;
let paramTimer = null;
let renderTimer = null;

const sealKey = (page, box) => `${page.id}#${box.id}`;
const activePage = () => state.pages.find((p) => p.id === state.activeId) || null;

function cleanName(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);
}

function allSeals() {
  const list = [];
  for (const page of state.pages) {
    for (const box of page.result?.boxes || []) {
      list.push({
        key: sealKey(page, box),
        page, box,
        filename: `${String(page.id).padStart(2, '0')}_${cleanName(page.baseName)}_P${page.pageNumber}_章${box.id}.png`
      });
    }
  }
  return list;
}

function selectedSeals() {
  return allSeals().filter((s) => state.selected.has(s.key));
}

/* ---------------- 基础 UI ---------------- */
function setStatus(text, stat) {
  $('statusText').textContent = text;
  if (stat !== undefined) $('statusStat').textContent = stat;
}

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function updateExportHint() {
  const base = ({
    transparent: '透明底：仅红色笔画，背景透明',
    white: '白底：保留红色笔画，其余置白',
    crop: '原图裁切：含合同底纹与文字（黑字保留）',
    clean: '去黑字裁切：保留底纹，清除黑色签字与印刷字'
  })[state.mode] || '原图裁切';
  $('exportHint').textContent = state.render.repair
    ? `${base} · 已开启补色与统一章色，黑字/暗红噪点会被清除`
    : `${base} · 未开启补色，原始像素保持原样`;
  $('valRadius').textContent = `${state.render.radius} px`;
  $('optRadius').disabled = !state.render.repair;
  $('radiusRow').classList.toggle('is-off', !state.render.repair);
}

function setBusy(busy) {
  state.busy = busy;
  ['btnOpen', 'btnPick', 'btnClear', 'btnRedetect', 'btnApplyAll', 'btnExportZip', 'btnExportFolder']
    .forEach((id) => { $(id).disabled = busy || !state.cv || (id === 'btnClear' && !state.pages.length); });
}

/* ---------------- 图像辅助 ---------------- */
function imageToCanvas(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0
  );
  return c;
}

function makeThumb(image) {
  const src = imageToCanvas(image);
  const t = document.createElement('canvas');
  t.width = 68; t.height = 88;
  const ctx = t.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, t.width, t.height);
  const scale = Math.min(t.width / image.width, t.height / image.height);
  const w = image.width * scale, h = image.height * scale;
  ctx.drawImage(src, (t.width - w) / 2, (t.height - h) / 2, w, h);
  src.width = src.height = 0;
  return t.toDataURL('image/png');
}

function sealThumb(page, box) {
  const img = buildSealImage(page, box, state.mode, 0.06, state.render);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const t = document.createElement('canvas');
  t.width = 120; t.height = 120;
  const ctx = t.getContext('2d');
  const scale = Math.min(t.width / img.width, t.height / img.height);
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(c, (t.width - w) / 2, (t.height - h) / 2, w, h);
  c.width = c.height = 0;
  return t.toDataURL('image/png');
}

/* ---------------- 检测 ---------------- */
function detectPage(page) {
  const t0 = performance.now();
  page.result = detectSeals(state.cv, page.image, state.params);
  state.lastMs = Math.round(performance.now() - t0);
}

function redetect(pages) {
  if (!state.cv || !pages.length) return;
  for (const page of pages) {
    for (const key of [...state.selected]) {
      if (key.startsWith(`${page.id}#`)) state.selected.delete(key);
    }
    detectPage(page);
    for (const box of page.result.boxes) state.selected.add(sealKey(page, box));
  }
  state.activeSeal = null;
}

/* ---------------- 渲染 ---------------- */
function renderPageList() {
  const el = $('pageList');
  el.innerHTML = '';
  $('pageCount').textContent = String(state.pages.length);
  if (!state.pages.length) {
    el.innerHTML = '<div class="hint">尚未添加文件</div>';
    return;
  }
  for (const page of state.pages) {
    const item = document.createElement('div');
    item.className = 'page-item' + (page.id === state.activeId ? ' active' : '');
    item.innerHTML = `
      <img src="${page.thumbUrl}" alt="" />
      <div class="meta"><strong title="${escapeHtml(page.name)}">${escapeHtml(page.name)}</strong>
      <span>${page.image.width} × ${page.image.height} px</span></div>
      <span class="n">${page.result?.boxes.length ?? 0} 枚</span>`;
    item.addEventListener('click', () => {
      state.activeId = page.id;
      state.activeSeal = null;
      renderAll();
    });
    el.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPreview() {
  const canvas = $('preview');
  const page = activePage();
  if (!page) {
    canvas.hidden = true;
    $('emptyState').hidden = false;
    $('currentName').textContent = '预览';
    return;
  }
  canvas.hidden = false;
  $('emptyState').hidden = true;
  $('currentName').textContent = page.name;
  canvas.width = page.image.width;
  canvas.height = page.image.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(page.image.data), page.image.width, page.image.height), 0, 0);

  const W = page.image.width, H = page.image.height;
  const lw = Math.max(3, Math.round(Math.min(W, H) / 190));
  const fs = Math.max(16, Math.round(Math.min(W, H) / 42));
  ctx.font = `bold ${fs}px "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';

  for (const box of page.result?.boxes || []) {
    const isActive = state.activeSeal === sealKey(page, box);
    const color = isActive ? '#f08c18' : '#12a05c';
    if (isActive) {
      ctx.fillStyle = 'rgba(240, 140, 24, .10)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isActive ? lw * 1.8 : lw;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    const label = String(box.id);
    const tw = ctx.measureText(label).width + fs * 0.9;
    const th = fs * 1.45;
    const ly = Math.max(0, box.y - th);
    ctx.fillStyle = color;
    ctx.fillRect(box.x, ly, tw, th);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, box.x + fs * 0.45, ly + th / 2);
  }
  applyZoom();
}

function applyZoom() {
  const canvas = $('preview');
  canvas.className = state.zoom === 'fit' ? '' : `zoom-${state.zoom === '1' ? '1' : '05'}`;
  document.querySelectorAll('.zoom-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.zoom === state.zoom);
  });
}

function renderSealList() {
  const el = $('sealList');
  const seals = allSeals();
  $('sealCount').textContent = `${seals.length} 枚`;
  $('btnExportZip').disabled = state.busy || !state.cv || !state.selected.size;
  $('btnExportFolder').disabled = state.busy || !state.cv || !state.selected.size;
  el.innerHTML = '';
  if (!seals.length) {
    el.innerHTML = '<div class="hint">没有识别到红色印章。可试着调低「红色饱和度下限」或「最小印章边长」。</div>';
    return;
  }
  for (const s of seals) {
    const card = document.createElement('div');
    card.className = 'seal-card' + (state.activeSeal === s.key ? ' active' : '');
    const cls = s.box.score >= 70 ? '' : (s.box.score >= 45 ? 'mid' : 'low');
    const label = s.box.score >= 70 ? '高' : (s.box.score >= 45 ? '中' : '低');
    card.innerHTML = `
      <div class="thumb-box"><img src="${sealThumb(s.page, s.box)}" alt="" /></div>
      <div class="info">
        <div class="row1">
          <input type="checkbox" ${state.selected.has(s.key) ? 'checked' : ''} title="勾选导出" />
          <span class="num">印章 ${s.box.id}</span>
          <span class="conf ${cls}">${label} ${s.box.score}</span>
        </div>
        <div class="src" title="${escapeHtml(s.page.name)}">${escapeHtml(s.page.name)}</div>
        <div class="dims">${s.box.w} × ${s.box.h} px · 红 ${(s.box.density * 100).toFixed(0)}%</div>
        <button class="save" type="button">保存这张 PNG</button>
      </div>`;
    const cb = card.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(s.key); else state.selected.delete(s.key);
      $('btnExportZip').disabled = state.busy || !state.selected.size;
      $('btnExportFolder').disabled = state.busy || !state.selected.size;
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.save').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const bytes = await toPNGBytes(buildSealImage(s.page, s.box, state.mode, 0.06, state.render));
        const r = await saveBytes(s.filename, bytes, 'png');
        if (r !== 'cancel') toast(r === 'saved' ? `已保存 ${s.filename}` : '已开始下载 PNG');
      } catch (err) { toast(err.message, true); }
    });
    card.addEventListener('click', () => {
      state.activeSeal = s.key;
      state.activeId = s.page.id;
      renderAll();
      const box = document.querySelector('.seal-card.active');
      box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    el.appendChild(card);
  }
}

function renderStats() {
  const pages = state.pages.length;
  const seals = allSeals().length;
  const picked = state.selected.size;
  $('statusStat').textContent = pages
    ? `${pages} 页 · ${seals} 枚印章 · 已勾选 ${picked} · 检测 ${state.lastMs}ms`
    : '';
}

function renderAll() {
  renderPageList();
  renderPreview();
  renderSealList();
  renderStats();
  setBusy(false);
}

/* ---------------- 文件导入 ---------------- */
const MAX_FILES = 60;          // 单次导入文件数上限，防止堆积把内存拖垮
const MAX_TOTAL_PAGES = 200;   // 累计页数上限

async function handleFiles(fileList) {
  if (!state.cv) { toast('图像引擎尚未就绪', true); return; }
  let files = [...fileList].filter((f) =>
    /\.pdf$/i.test(f.name) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name) || f.type.startsWith('image/')
  );
  if (!files.length) { toast('请选择图片或 PDF 文件', true); return; }
  if (files.length > MAX_FILES) {
    toast(`单次最多导入 ${MAX_FILES} 个文件，已取前 ${MAX_FILES} 个；其余请分批处理`, true);
    files = files.slice(0, MAX_FILES);
  }
  if (state.pages.length + files.length > MAX_TOTAL_PAGES) {
    toast(`累计最多 ${MAX_TOTAL_PAGES} 页，请先清空或分批导入`, true);
    return;
  }
  setBusy(true);
  let added = 0;
  for (const file of files) {
    try {
      setStatus(`正在读取 ${file.name} …`);
      await new Promise((r) => setTimeout(r, 0));
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const items = isPdf
        ? await readPdfFile(file, state.pdfScale, (n, total) => setStatus(`正在渲染 ${file.name} 第 ${n}/${total} 页…`))
        : await readImageFile(file);
      for (const it of items) {
        const page = {
          id: ++uid,
          name: it.name,
          baseName: file.name.replace(/\.[^.]+$/, ''),
          image: it.image,
          pageNumber: it.pageNumber
        };
        page.thumbUrl = makeThumb(page.image);
        setStatus(`正在识别 ${page.name} …`);
        await new Promise((r) => setTimeout(r, 0));
        detectPage(page);
        for (const box of page.result.boxes) state.selected.add(sealKey(page, box));
        state.pages.push(page);
        added++;
      }
    } catch (err) {
      console.error(err);
      toast(`${file.name}：${err.message}`, true);
    }
  }
  if (!state.activeId && state.pages.length) state.activeId = state.pages[0].id;
  syncParamLabels();
  renderAll();
  setStatus(added ? `完成：新增 ${added} 页，共识别 ${allSeals().length} 枚印章` : '未添加任何页面');
  if (added && !allSeals().length) toast('未发现红色印章，可尝试调低左侧参数后再识别');
}

/* ---------------- 参数 ---------------- */
function currentAutoSize() {
  const p = activePage();
  return p ? suggestMinSize(p.image.width, p.image.height) : 0;
}

function syncParamLabels() {
  const p = state.params;
  $('valSat').textContent = String(Math.round(p.satMin));
  $('valSize').textContent = p.minSize ? `${Math.round(p.minSize)}px` : `自动(${currentAutoSize()}px)`;
  $('valAspect').textContent = p.maxAspect.toFixed(1);
  $('valDensity').textContent = `${(p.minDensity * 100).toFixed(1)}%`;
  $('valClose').textContent = p.closeRatio.toFixed(2);
  $('valMerge').textContent = p.mergeIou.toFixed(2);
}

function paramsFromUI() {
  state.params = {
    ...state.params,
    satMin: Number($('pSat').value),
    minSize: Number($('pSize').value) || null,
    maxAspect: Number($('pAspect').value),
    minDensity: Number($('pDensity').value) / 100,
    closeRatio: Number($('pClose').value),
    mergeIou: Number($('pMerge').value),
    denoise: $('pDenoise').checked
  };
  syncParamLabels();
}

function onParamChange() {
  paramsFromUI();
  clearTimeout(paramTimer);
  paramTimer = setTimeout(() => {
    const page = activePage();
    if (!page) return;
    redetect([page]);
    renderAll();
    setStatus(`已按新参数重新识别当前页，找到 ${page.result.boxes.length} 枚`);
  }, 260);
}

/* ---------------- 导出 ---------------- */
async function doExportZip() {
  const seals = selectedSeals();
  if (!seals.length) { toast('请先勾选要导出的印章', true); return; }
  setBusy(true);
  setStatus(`正在生成 ${seals.length} 枚印章的 PNG…`);
  try {
    const r = await exportZip(seals, state.mode, state.render);
    if (r !== 'cancel') toast(r === 'saved' ? 'ZIP 已保存到指定位置' : 'ZIP 已开始下载');
    setStatus(`已导出 ${seals.length} 枚印章`);
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
    setStatus('导出失败');
  } finally { setBusy(false); }
}

async function doExportFolder() {
  const seals = selectedSeals();
  if (!seals.length) { toast('请先勾选要导出的印章', true); return; }
  setBusy(true);
  setStatus('正在写出 PNG 文件…');
  try {
    const n = await exportToFolder(seals, state.mode, state.render);
    if (n === null) { toast('此功能仅在桌面程序中使用', true); }
    else if (n === 0) { setStatus('已取消'); }
    else { toast(`已写出 ${n} 个 PNG 到所选文件夹`); setStatus(`已写出 ${n} 个 PNG`); }
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
  } finally { setBusy(false); }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('btnPick').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  $('btnClear').addEventListener('click', () => {
    state.pages = [];
    state.activeId = null;
    state.activeSeal = null;
    state.selected.clear();
    renderAll();
    setStatus('已清空，可重新拖入合同');
  });

  $('btnRedetect').addEventListener('click', () => {
    redetect(state.pages);
    renderAll();
    setStatus(`全部页面重新识别完成，共 ${allSeals().length} 枚`);
  });

  $('btnApplyAll').addEventListener('click', () => {
    redetect(state.pages);
    renderAll();
    setStatus(`参数已应用到 ${state.pages.length} 个页面`);
  });

  ['pSat', 'pSize', 'pAspect', 'pDensity', 'pClose', 'pMerge', 'pDenoise']
    .forEach((id) => $(id).addEventListener('input', onParamChange));

  $('btnResetParams').addEventListener('click', () => {
    state.params = { ...DEFAULT_PARAMS };
    $('pSat').value = DEFAULT_PARAMS.satMin;
    $('pSize').value = 0;
    $('pAspect').value = DEFAULT_PARAMS.maxAspect;
    $('pDensity').value = DEFAULT_PARAMS.minDensity * 100;
    $('pClose').value = DEFAULT_PARAMS.closeRatio;
    $('pMerge').value = DEFAULT_PARAMS.mergeIou;
    $('pDenoise').checked = DEFAULT_PARAMS.denoise;
    paramsFromUI();
    redetect(state.pages);
    renderAll();
    setStatus('参数已恢复默认并重新识别');
  });

  $('outputMode').addEventListener('change', (e) => {
    state.mode = e.target.value;
    updateExportHint();
    renderSealList();
  });

  $('optRepair').addEventListener('change', (e) => {
    state.render.repair = e.target.checked;
    updateExportHint();
    renderSealList();
  });

  $('optRadius').addEventListener('input', (e) => {
    state.render.radius = Number(e.target.value);
    updateExportHint();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderSealList(), 180);
  });

  $('pdfScale').addEventListener('change', (e) => {
    state.pdfScale = Number(e.target.value);
    toast('清晰度设置仅对新导入的 PDF 生效');
  });

  document.querySelectorAll('.zoom-btn').forEach((b) => {
    b.addEventListener('click', () => { state.zoom = b.dataset.zoom; applyZoom(); });
  });

  $('btnSelectAll').addEventListener('click', () => {
    allSeals().forEach((s) => state.selected.add(s.key));
    renderSealList();
    renderStats();
  });
  $('btnSelectNone').addEventListener('click', () => {
    state.selected.clear();
    renderSealList();
    renderStats();
  });

  $('btnExportZip').addEventListener('click', doExportZip);
  $('btnExportFolder').addEventListener('click', doExportFolder);

  $('preview').addEventListener('click', (e) => {
    const page = activePage();
    if (!page) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (page.image.width / rect.width);
    const y = (e.clientY - rect.top) * (page.image.height / rect.height);
    const hit = [...(page.result?.boxes || [])].reverse().find((b) =>
      x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    state.activeSeal = hit ? sealKey(page, hit) : null;
    renderPreview();
    renderSealList();
  });

  // 拖放（Tauri 中把原生 dragDropEnabled 关掉，交给页面处理）
  let depth = 0;
  const overlay = $('dropOverlay');
  window.addEventListener('dragenter', (e) => {
    e.preventDefault(); depth++; overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; overlay.hidden = true;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

/* ---------------- 启动 ---------------- */
function installGlobalGuards() {
  window.addEventListener('error', (e) => {
    console.error('未捕获错误：', e.error || e.message);
    toast(`界面遇到问题：${e.message || '未知错误'}`, true);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('未处理的异步错误：', e.reason);
    const msg = e.reason?.message || String(e.reason || '未知错误');
    toast(`操作失败：${msg}`, true);
  });
}

async function init() {
  installGlobalGuards();
  bindEvents();
  if (isTauri()) $('btnExportFolder').hidden = false;
  syncParamLabels();
  updateExportHint();
  renderAll();
  try {
    state.cv = await loadOpenCV((t) => setStatus(t));
    const badge = $('engineBadge');
    badge.className = 'badge';
    badge.innerHTML = '<i style="width:7px;height:7px;border-radius:50%;background:currentColor"></i>引擎就绪 · 离线';
    setStatus('就绪 · 拖入合同，或点击右上角「打开合同」');
    setBusy(false);
  } catch (err) {
    $('engineBadge').className = 'badge loading';
    $('engineBadge').textContent = '引擎加载失败';
    setStatus(err.message);
    toast(err.message, true);
  }
}

init();
