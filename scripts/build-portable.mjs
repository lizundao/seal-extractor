/**
 * 生成绿色便携版：单目录（exe + 说明 + 示例合同）+ 同名 zip。
 * exe 已由 Tauri 把全部前端资源内嵌，无需 dist / node_modules / 安装。
 * 用法：npm run release:portable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeSrc = path.join(root, 'src-tauri', 'target', 'release', 'seal-extractor.exe');
const releaseDir = path.join(root, 'release');
const folderName = 'SealExtractor-1.1.0-portable-win-x64';
const outDir = path.join(releaseDir, folderName);
const zipPath = path.join(releaseDir, `${folderName}.zip`);

if (!fs.existsSync(exeSrc)) {
  console.error('未找到编译产物，请先运行：npx tauri build --no-bundle');
  process.exit(1);
}

const readme = `印章提取 · 绿色版 v1.1.0
========================================

【运行】
直接双击「印章提取.exe」，不用安装、不写注册表、不联网。
把合同图片（PNG / JPG / WEBP / BMP 等）或多页 PDF 拖进窗口，
也可以点右上角「打开合同」。PDF 会逐页渲染、逐页识别。

【导出】
· 右侧卡片勾选需要的印章，输出模式可选：
  透明底红章 / 白底红章 / 原图裁切 / 去黑字裁切
· 「保存这张 PNG」：单独另存一枚
· 「导出所选（ZIP）」：弹保存对话框，得到每枚印章的 PNG + 印章清单.csv
· 「导出到文件夹」：把每枚印章直接写成独立 PNG
· 保存时会弹出系统对话框，选好位置后文件直接写到磁盘；
  若目标目录不可写（如 C:\\ 根目录、受保护文件夹），窗口会明确提示原因，
  请改存到桌面 / 文档等可写目录。

【黑色压字 / 补色修复】
扫描件里黑签字常被扫成深褐红，连红色掩膜都会把它当成笔画收进来，
所以旧版导出后仍有黑色碎字。新版默认开启「补色修复黑色压字」：
先按印章自身红色算出参考红，把这类暗色杂墨识别出来，
再用周边可信红色把被盖住的笔画补回，其余暗色杂墨清掉；
透明底/白底输出会统一成参考红，章面不再有暗红褐色噪点；
边缘抗锯齿也改用邻近红色，透明底不再有黑毛边。
· 黑色笔画很粗、补不全 → 调大「补色半径」
· 相邻笔画被误连 → 调小「补色半径」
· 想看完全未处理的原始像素 → 关闭该开关并选「原图裁切」
· 想保留底纹但去掉黑字 → 选「去黑字裁切」

【识别不准时】
· 印章褪色、漏检 → 调低「红色饱和度下限」「最小印章边长」
· 章被拆成几块 → 调大「笔画连接强度」
· 红色横线 / 红字被当成章 → 调高「红色密度下限」、调小「形状比上限」
· 参数改完点「把参数应用到全部页面」

【运行环境】
Windows 10 / 11 64 位，需要系统已安装 WebView2 Runtime
（Win10 / Win11 一般自带；若提示缺少，安装微软 WebView2 Runtime 后重开即可）。
所有合同只在本机内存中处理，不上传、不产生网络请求、不写用户数据。

【附赠】
「示例合同.pdf」是两页测试件，共 8 枚红色印章，可直接拖进去试用。

源码与开发说明见项目目录 README.md。
`;

fs.mkdirSync(outDir, { recursive: true });
const exeDst = path.join(outDir, '印章提取.exe');
fs.copyFileSync(exeSrc, exeDst);
fs.writeFileSync(path.join(outDir, '使用说明.txt'), '\ufeff' + readme, 'utf8');
const licenseSrc = path.join(root, 'LICENSE');
if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(outDir, 'LICENSE'));

const sample = path.join(root, 'tests', 'fixtures', 'contract.pdf');
let hasSample = false;
if (fs.existsSync(sample)) {
  fs.copyFileSync(sample, path.join(outDir, '示例合同.pdf'));
  hasSample = true;
}

const zip = new JSZip();
const folder = zip.folder(folderName);
folder.file('印章提取.exe', fs.readFileSync(exeDst));
folder.file('使用说明.txt', '\ufeff' + readme);
if (fs.existsSync(licenseSrc)) folder.file('LICENSE', fs.readFileSync(licenseSrc));
if (hasSample) folder.file('示例合同.pdf', fs.readFileSync(sample));

const buf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 }
});
fs.writeFileSync(zipPath, buf);

console.log('绿色版目录：', outDir);
for (const f of fs.readdirSync(outDir)) {
  console.log('  ', f, (fs.statSync(path.join(outDir, f)).size / 1024 / 1024).toFixed(2), 'MB');
}
console.log('压缩包：', zipPath, (buf.length / 1024 / 1024).toFixed(2), 'MB');
