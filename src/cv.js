/** 按需加载 public/opencv.js（单文件，wasm 已内嵌，完全离线） */
let promise = null;

export function loadOpenCV(onStatus = () => {}) {
  if (promise) return promise;
  promise = (async () => {
    onStatus('正在加载 OpenCV.js 引擎…');
    if (!window.cv) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${import.meta.env.BASE_URL}opencv.js`;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('引擎文件 opencv.js 未能加载'));
        document.head.appendChild(s);
      });
    }
    onStatus('正在初始化图像引擎…');
    const raw = window.cv;
    const cv = raw && typeof raw.then === 'function' ? await raw : raw;
    if (!cv || typeof cv.Mat !== 'function') {
      throw new Error('OpenCV.js 初始化失败（未取得 Mat）');
    }
    return cv;
  })().catch((e) => {
    promise = null;
    throw e;
  });
  return promise;
}
