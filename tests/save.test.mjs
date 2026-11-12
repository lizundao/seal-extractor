/**
 * 桌面保存链路回归测试（纯 Node，不需要窗口）：
 * 验证 Tauri 2 的 camelCase 参数名、写入字节数校验、失败不再静默回退。
 * 运行：npm run test:save
 */
import { saveBytes, bytesToBase64 } from '../src/exporter.js';

const calls = [];
let behavior = 'ok';
let savePath = 'E:/tmp/seal-test/单张印章.png';

// 模拟 Tauri 运行时：@tauri-apps/api/core 与 plugin-dialog 最终都走这里
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args = {}) => {
      calls.push({ cmd, args });
      if (cmd === 'plugin:dialog|save') return savePath;
      if (cmd === 'plugin:dialog|open') return 'E:/tmp/seal-test';
      if (cmd === 'save_bytes') {
        if (behavior === 'reject') throw new Error('模拟写入被拒绝');
        return Buffer.from(args.dataB64 || '', 'base64').length;
      }
      return null;
    }
  }
};

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
let ok = true;
const check = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) ok = false; };

// 1. 正常保存：参数必须是 camelCase
calls.length = 0; behavior = 'ok';
const r1 = await saveBytes('单张印章.png', bytes, 'png');
const write = calls.find((c) => c.cmd === 'save_bytes');
check(r1 === 'saved', 'saveBytes 返回 saved');
check(!!write && 'dataB64' in write.args, '写入命令使用 camelCase 参数 dataB64');
check(!!write && !('data_b64' in write.args), '不再使用旧的 data_b64 参数');
check(write && write.args.dataB64 === bytesToBase64(bytes), 'base64 内容正确');
check(write && write.args.path === savePath, '写入路径来自保存对话框');

// 2. 扩展名自动补齐
calls.length = 0; savePath = 'E:/tmp/seal-test/noext';
await saveBytes('合同印章.zip', bytes, 'zip');
const write2 = calls.find((c) => c.cmd === 'save_bytes');
check(write2?.args.path.endsWith('.zip'), '对话框未带扩展名时自动补 .zip');
savePath = 'E:/tmp/seal-test/单张印章.png';

// 3. 写入失败必须抛错，不能静默回退到浏览器下载
calls.length = 0; behavior = 'reject';
let threw = false, msg = '';
try { await saveBytes('单张印章.png', bytes, 'png'); } catch (e) { threw = true; msg = e.message; }
check(threw && msg.includes('写入失败'), '写入失败明确抛错');
check(msg.includes('可写目录'), '错误提示给出可写目录建议');

// 4. 用户取消
calls.length = 0; behavior = 'ok'; savePath = null;
const r4 = await saveBytes('单张印章.png', bytes, 'png');
check(r4 === 'cancel', '取消保存返回 cancel');
check(!calls.some((c) => c.cmd === 'save_bytes'), '取消时不发起写入');

console.log(ok ? '\n全部通过' : '\n存在失败项');
process.exit(ok ? 0 : 1);
