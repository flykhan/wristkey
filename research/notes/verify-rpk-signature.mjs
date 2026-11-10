#!/usr/bin/env node
// 校验 aiot-toolkit 2.0.5 产出的 .rpk 签名块并提取内嵌证书。
// 用法: node verify-rpk-signature.mjs <app.rpk> [certificate.pem]
// 依赖: 仅 node:crypto (Node >= 18)。这不是官方工具，仅用于验收"rpk 证书 == APK 证书"。
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , rpkPath, pemPath] = process.argv;
if (!rpkPath) { console.error('usage: node verify-rpk-signature.mjs <app.rpk> [certificate.pem]'); process.exit(2); }
const buf = fs.readFileSync(rpkPath);
const MAGIC = Buffer.from('RPK Sig Block 42');

// 1) EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('not a zip/rpk: EOCD not found'); process.exit(1); }
const cdOffset = buf.readUInt32LE(eocd + 16);

// 2) 签名块末尾魔法串，块起始处 size 字段 == 总长-8
const magicPos = buf.indexOf(MAGIC, Math.max(0, cdOffset - 262144));
if (magicPos < 0 || magicPos + MAGIC.length !== cdOffset) {
  console.error('signature block magic not found immediately before central directory'); process.exit(1);
}
let blockStart = -1;
for (let p = magicPos - 4; p > Math.max(0, cdOffset - 262144); p--) {
  if (buf.readInt32LE(p) === cdOffset - p - 8) { blockStart = p; break; }
}
if (blockStart < 0) { console.error('signature block start not found'); process.exit(1); }
console.log('EOCD:', eocd, 'centralDir:', cdOffset, 'signBlock:', blockStart, 'size:', cdOffset - blockStart);

// 3) 第一个 kv (id 0x01000101) 内是 sign block
let o = blockStart + 8;
const kvSize = buf.readInt32LE(o);
const kvId = buf.readUInt32LE(o + 8);
console.log('kv id:', '0x' + kvId.toString(16), 'kvSize:', kvSize);
if (kvId !== 0x01000101) { console.error('unexpected first kv block (expect sign block 0x01000101)'); process.exit(1); }

// 4) 解析 sign block：valueSize, blockSize, signdataSize, signdata, signatures, pubkey
let q = o + 12;
const valueSize = buf.readInt32LE(q); q += 4;
const blockSize = buf.readInt32LE(q); q += 4;
const signdataSize = buf.readInt32LE(q); q += 4;
const signdata = buf.subarray(q, q + signdataSize); q += signdataSize;
const signaturesSize = buf.readInt32LE(q); q += 4;
const sigs = [];
const sigEnd = q + signaturesSize - 4;
while (q < sigEnd) {
  const size = buf.readInt32LE(q); q += 4;
  const id = buf.readUInt32LE(q); q += 4;
  const len = buf.readInt32LE(q); q += 4;
  sigs.push({ id, sig: buf.subarray(q, q + len) }); q += len;
}
const pubkeySize = buf.readInt32LE(q); q += 4;
const pubkeyDer = buf.subarray(q, q + pubkeySize);
console.log('signdata:', signdataSize, 'signatures:', sigs.length, 'pubkey:', pubkeySize);

// 5) 从签名块中提取 X.509 证书（DER: 30 82 ...，前面 4 字节长度）
const certs = [];
const region = buf.subarray(blockStart, cdOffset);
for (let i = 0; i + 6 < region.length; i++) {
  const len = region.readInt32LE(i);
  if (len > 300 && len < 8192 && region[i + 4] === 0x30 && region[i + 5] === 0x82 && i + 4 + len <= region.length) {
    try {
      const der = region.subarray(i + 4, i + 4 + len);
      certs.push(new crypto.X509Certificate(der));
    } catch { /* not a cert */ }
  }
}
if (certs.length === 0) { console.error('no embedded certificate found'); process.exit(1); }
for (const c of certs) {
  console.log('cert subject:', c.subject.replace(/\n/g, ', '), '| SHA-256:', c.fingerprint256);
  console.log('cert valid:', c.validFrom, '->', c.validTo);
}

// 6) 用内嵌公钥验证 RSA-SHA256 签名（签名覆盖 signdata）
const pubKey = crypto.createPublicKey({ key: pubkeyDer, format: 'der', type: 'spki' });
for (const s of sigs) {
  const ok = s.id === 0x0103 ? crypto.verify('RSA-SHA256', signdata, pubKey, s.sig) : null;
  console.log('signature id 0x' + s.id.toString(16), 'len', s.sig.length, '=> RSA-SHA256 verify:', ok);
}
// 证书公钥必须与签名公钥一致
const certPub = certs[0].publicKey.export({ type: 'spki', format: 'der' });
console.log('pubkey == cert[0].pubkey:', Buffer.compare(certPub, pubkeyDer) === 0);

// 7) 与给定 PEM 对比指纹
if (pemPath) {
  const pemCert = new crypto.X509Certificate(fs.readFileSync(pemPath));
  const same = pemCert.fingerprint256.replace(/:/g, '').toLowerCase() === certs[0].fingerprint256.replace(/:/g, '').toLowerCase();
  console.log('PEM fingerprint:', pemCert.fingerprint256);
  console.log('MATCH rpk cert == PEM cert:', same);
  process.exit(same ? 0 : 1);
}
