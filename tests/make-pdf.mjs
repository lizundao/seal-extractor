import fs from 'node:fs';
import zlib from 'node:zlib';

// 从测试夹具 PNG 解码 RGB（我们生成的 PNG 每行 filter=0，无需反滤波）
const png = fs.readFileSync('tests/fixtures/contract.png');
let pos = 8, w = 0, h = 0; const idat = [];
while (pos < png.length) {
  const n = png.readUInt32BE(pos);
  const type = png.toString('ascii', pos + 4, pos + 8);
  const data = png.subarray(pos + 8, pos + 8 + n);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
  if (type === 'IDAT') idat.push(data);
  pos += 12 + n;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const rgb = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++) {
  const row = raw.subarray(y * (w * 4 + 1) + 1, y * (w * 4 + 1) + 1 + w * 4);
  for (let x = 0; x < w; x++) {
    rgb[(y * w + x) * 3] = row[x * 4];
    rgb[(y * w + x) * 3 + 1] = row[x * 4 + 1];
    rgb[(y * w + x) * 3 + 2] = row[x * 4 + 2];
  }
}
const imageStream = zlib.deflateSync(rgb, { level: 9 });
const page1 = Buffer.from('q 595 0 0 842 0 0 cm /Im0 Do Q\n', 'latin1');
const page2 = Buffer.from('q 535.5 0 0 757.8 29.75 42.1 cm /Im0 Do Q\n', 'latin1');

const parts = [], offsets = {}; let len = 0;
const push = (b) => { parts.push(b); len += b.length; };
const obj = (n, header, stream) => {
  offsets[n] = len;
  push(Buffer.from(`${n} 0 obj\n<< ${header} >>\n`, 'latin1'));
  if (stream) {
    push(Buffer.from('stream\n', 'latin1'));
    push(stream);
    push(Buffer.from('\nendstream\n', 'latin1'));
  }
  push(Buffer.from('endobj\n', 'latin1'));
};
push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
obj(1, '/Type /Catalog /Pages 2 0 R');
obj(2, '/Type /Pages /Kids [3 0 R 6 0 R] /Count 2');
obj(3, '/Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R');
obj(4, `/Length ${page1.length}`, page1);
obj(5, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageStream.length}`, imageStream);
obj(6, '/Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 7 0 R');
obj(7, `/Length ${page2.length}`, page2);
const xref = len;
let table = 'xref\n0 8\n0000000000 65535 f \n';
for (let i = 1; i <= 7; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
push(Buffer.from(table, 'latin1'));
push(Buffer.from(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
fs.writeFileSync('tests/fixtures/contract.pdf', Buffer.concat(parts));
console.log('PDF written:', w, 'x', h, 'source, 2 pages,', fs.statSync('tests/fixtures/contract.pdf').size, 'bytes');
