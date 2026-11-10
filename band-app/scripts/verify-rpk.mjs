#!/usr/bin/env node
/**
 * WristKey - verify a signed Vela .rpk.
 *
 * Checks (all offline, no external deps):
 *   1. the RPK Sig Block inserted by aiot-toolkit is present and its RSA-SHA256
 *      signature over the signature data verifies with the embedded public key;
 *   2. the embedded X.509 certificate matches the expected SHA-256 fingerprint
 *      (default: the development certificate shared with the Android APK);
 *   3. the file digest list signed inside the block matches the actual ZIP
 *      entries (SHA-256), including the signed META-INF/CERT;
 *   4. the signed META-INF/CERT hash.json digests match the actual files;
 *   5. manifest.json package/name are the WristKey values.
 *
 * Usage: node scripts/verify-rpk.mjs [path/to/app.rpk]
 *        RPK_EXPECTED_SHA256="" node scripts/verify-rpk.mjs   (skip fingerprint check)
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"

const MAGIC = Buffer.from("RPK Sig Block 42")
const SIG_BLOCK_ID = 0x01000101
const FILES_BLOCK_ID = 0x01000201
const EXPECTED_PACKAGE = "com.flykhan.wristkey"
const DEV_CERT_SHA256 =
  "b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const rpkPath = process.argv[2] ? path.resolve(process.argv[2]) : findLatestRpk()
const expectedFingerprint =
  process.env.RPK_EXPECTED_SHA256 !== undefined
    ? process.env.RPK_EXPECTED_SHA256.replace(/:/g, "").toLowerCase()
    : DEV_CERT_SHA256

const failures = []
const passes = []

function main() {
  if (!rpkPath || !fs.existsSync(rpkPath)) {
    fail("找不到 .rpk 文件" + (rpkPath ? ": " + rpkPath : ""))
    finish()
    return
  }
  console.log("RPK:", rpkPath)
  console.log("size:", fs.statSync(rpkPath).size, "bytes")
  const rpk = fs.readFileSync(rpkPath)

  const entries = readZipEntries(rpk)
  const entryByName = {}
  for (const entry of entries) {
    entryByName[entry.name] = entry
  }
  if (!entryByName["manifest.json"]) {
    fail("rpk 中缺少 manifest.json")
    finish()
    return
  }

  const manifest = JSON.parse(entryByName["manifest.json"].data.toString("utf8"))
  if (manifest.package === EXPECTED_PACKAGE) {
    pass("manifest.package = " + manifest.package)
  } else {
    fail("manifest.package = " + manifest.package + " (期望 " + EXPECTED_PACKAGE + ")")
  }
  if (manifest.name) {
    pass("manifest.name = " + manifest.name)
  }

  const outer = findSignChunk(rpk)
  if (!outer) {
    fail("未找到 RPK Sig Block（rpk 可能未签名）")
    finish()
    return
  }
  const parsedOuter = parseSignChunk(rpk, outer.start, outer.end)
  if (!parsedOuter.signBlock) {
    fail("签名块结构不完整（缺少 sign block）")
    finish()
    return
  }

  const sigData = parsedOuter.signBlock.signData
  const publicKeyDer = parsedOuter.signBlock.pubKey
  const signature =
    parsedOuter.signBlock.signatures[0] && parsedOuter.signBlock.signatures[0].data
  if (!signature) {
    fail("签名块中缺少 RSA 签名")
    finish()
    return
  }
  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(sigData)
    .verify({ key: publicKeyDer, format: "der", type: "spki" }, signature)
  if (verified) {
    pass("RPK Sig Block RSA-SHA256 签名校验通过（内嵌公钥）")
  } else {
    fail("RPK Sig Block RSA-SHA256 签名校验失败")
  }

  const signData = parseSignData(sigData)
  const certDer = signData.certs[0]
  if (!certDer) {
    fail("签名数据中缺少证书")
    finish()
    return
  }
  const fingerprint = crypto.createHash("sha256").update(certDer).digest("hex")
  const certificate = new crypto.X509Certificate(certDer)
  console.log("certificate subject:", certificate.subject.replace(/\n/g, ", "))
  console.log("certificate SHA-256:", fingerprint)
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    fail("证书指纹不匹配: 期望 " + expectedFingerprint)
  } else if (expectedFingerprint) {
    pass("证书指纹与期望值一致")
  } else {
    pass("证书指纹已读取（未强制比对）")
  }

  const certPublicKey = certificate.publicKey.export({ format: "der", type: "spki" })
  if (Buffer.compare(certPublicKey, publicKeyDer) === 0) {
    pass("签名块内嵌公钥与证书公钥一致")
  } else {
    fail("签名块内嵌公钥与证书公钥不一致")
  }

  if (!parsedOuter.fileBlock) {
    fail("签名块中缺少文件摘要块（files block）")
  } else {
    verifyFileDigestBlock("RPK 文件摘要块", parsedOuter.fileBlock, entryByName, publicKeyDer)
  }

  const certEntry = entryByName["META-INF/CERT"]
  if (!certEntry) {
    fail("rpk 中缺少 META-INF/CERT")
    finish()
    return
  }
  const certBuffer = certEntry.data
  const inner = findSignChunk(certBuffer)
  if (!inner) {
    fail("META-INF/CERT 未签名")
  } else {
    const parsedInner = parseSignChunk(certBuffer, inner.start, inner.end)
    if (!parsedInner.fileBlock) {
      fail("META-INF/CERT 签名块缺少文件摘要块")
    } else {
      const certEntries = readZipEntries(certBuffer)
      const certEntryByName = {}
      for (const entry of certEntries) {
        certEntryByName[entry.name] = entry
      }
      // aiot-toolkit names this entry "hash.json" but hashes the *unsigned*
      // CERT zip buffer (the one before the signature block was inserted).
      // Reconstruct that buffer by removing the sign block and restoring the
      // EOCD central-directory offset, then compare that digest.
      const unsignedCert = reconstructUnsignedZip(certBuffer, inner)
      if (!unsignedCert) {
        fail("无法还原 META-INF/CERT 签名前的 buffer")
      } else {
        const customDigests = {}
        customDigests[crc32(Buffer.from("hash.json", "utf8"))] = crypto
          .createHash("sha256")
          .update(unsignedCert)
          .digest()
        verifyFileDigestBlock(
          "META-INF/CERT 文件摘要块",
          parsedInner.fileBlock,
          certEntryByName,
          publicKeyDer,
          customDigests
        )
      }
      const hashEntry = certEntryByName["hash.json"]
      if (!hashEntry) {
        fail("META-INF/CERT 中缺少 hash.json")
      } else {
        verifyHashJson(hashEntry.data, entryByName)
        pass("META-INF/CERT hash.json 读取成功")
      }
    }
  }

  finish()
}

/* ---------------------------------------------------------------- checks */

function verifyFileDigestBlock(label, fileBlock, entryByName, publicKeyDer, customDigests) {
  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(fileBlock.signedData)
    .verify({ key: publicKeyDer, format: "der", type: "spki" }, fileBlock.signature)
  if (verified) {
    pass(label + " RSA-SHA256 签名校验通过")
  } else {
    fail(label + " RSA-SHA256 签名校验失败")
  }

  const namesByCrc = {}
  for (const name of Object.keys(entryByName)) {
    namesByCrc[crc32(Buffer.from(name, "utf8"))] = name
  }

  let matched = 0
  for (const entry of fileBlock.entries) {
    const custom = customDigests ? customDigests[entry.nameHash] : null
    if (custom) {
      if (Buffer.compare(custom, entry.hash) === 0) {
        matched += 1
      } else {
        fail(label + ": 摘要不匹配 (签名前 buffer)")
      }
      continue
    }
    const name = namesByCrc[entry.nameHash]
    if (!name) {
      fail(label + ": 无法通过名字哈希匹配 ZIP 条目 (0x" + entry.nameHash.toString(16) + ")")
      continue
    }
    const actual = crypto.createHash("sha256").update(entryByName[name].data).digest()
    if (Buffer.compare(actual, entry.hash) === 0) {
      matched += 1
    } else {
      fail(label + ": 摘要不匹配 " + name)
    }
  }
  if (matched === fileBlock.entries.length && matched > 0) {
    pass(label + ": " + matched + " 个文件摘要全部匹配")
  }
}

function verifyHashJson(hashJsonBuffer, entryByName) {
  let hashJson
  try {
    hashJson = JSON.parse(hashJsonBuffer.toString("utf8"))
  } catch (error) {
    fail("hash.json 不是合法 JSON")
    return
  }
  const digests = hashJson.digests || {}
  let checked = 0
  let mismatched = 0
  for (const name of Object.keys(digests)) {
    const entry = entryByName[name]
    if (!entry) {
      fail("hash.json 引用了 rpk 中不存在的文件: " + name)
      mismatched += 1
      continue
    }
    const actual = crypto.createHash("sha256").update(entry.data).digest("hex")
    if (actual === String(digests[name]).toLowerCase()) {
      checked += 1
    } else {
      fail("hash.json 摘要不匹配: " + name)
      mismatched += 1
    }
  }
  if (mismatched === 0) {
    pass("hash.json: " + checked + " 个文件 SHA-256 摘要全部匹配")
  }
}

/* ---------------------------------------------------------------- ZIP */

function findLatestRpk() {
  const dist = path.join(root, "dist")
  if (!fs.existsSync(dist)) {
    return null
  }
  const files = fs
    .readdirSync(dist)
    .filter(name => name.endsWith(".rpk"))
    .map(name => path.join(dist, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  return files[0] || null
}

function readZipEntries(buffer) {
  const eocdOffset = findEocd(buffer)
  if (eocdOffset < 0) {
    throw new Error("not a zip file (EOCD not found)")
  }
  const count = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)
  const entries = []
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("bad central directory at " + offset)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8")
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith("/")) {
      continue
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.slice(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) {
      data = compressed
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed)
    } else {
      throw new Error("unsupported zip compression method " + method + " for " + name)
    }
    entries.push({ name, data })
  }
  return entries
}

/**
 * Reverse aiot-toolkit's saveChunk(): drop the inserted signature block and
 * restore the EOCD central-directory offset to reconstruct the unsigned zip.
 */
function reconstructUnsignedZip(buffer, signChunk) {
  const eocd = findEocd(buffer)
  if (eocd < 0) {
    return null
  }
  const commentLength = buffer.readUInt16LE(eocd + 20)
  const tailStart = eocd + 22 + commentLength
  const prefix = buffer.slice(0, signChunk.start)
  const suffix = buffer.slice(signChunk.end, tailStart)
  const rebuilt = Buffer.concat([prefix, suffix])
  const newEocd = prefix.length + (eocd - signChunk.end)
  if (newEocd + 22 > rebuilt.length) {
    return null
  }
  const signChunkLength = signChunk.end - signChunk.start
  const patchedOffset = buffer.readUInt32LE(eocd + 16)
  if (patchedOffset < signChunkLength) {
    return null
  }
  rebuilt.writeUInt32LE(patchedOffset - signChunkLength, newEocd + 16)
  return rebuilt
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset
    }
  }
  return -1
}

/* ---------------------------------------------------------------- signing */

function findSignChunk(buffer) {
  const magicIndex = buffer.lastIndexOf(MAGIC)
  if (magicIndex < 0) {
    return null
  }
  const end = magicIndex + MAGIC.length
  if (end - 24 < 0) {
    return null
  }
  const size = buffer.readUInt32LE(end - 24)
  const start = end - (size + 8)
  if (start < 0 || start >= end) {
    return null
  }
  return { start, end, size }
}

function parseSignChunk(buffer, start, end) {
  let offset = start
  const chunkSize = buffer.readUInt32LE(offset)
  offset += 4
  offset += 4 // reserved
  const result = { chunkSize, signBlock: null, fileBlock: null }
  const dataEnd = end - 24

  while (offset < dataEnd) {
    const kvSize = buffer.readUInt32LE(offset)
    offset += 4
    offset += 4 // reserved
    const kvId = buffer.readUInt32LE(offset)
    offset += 4
    const valueSize = buffer.readUInt32LE(offset)
    offset += 4
    const valueStart = offset
    const valueEnd = valueStart + valueSize

    if (kvId === SIG_BLOCK_ID) {
      offset += 4 // block size
      const signDataSize = buffer.readUInt32LE(offset)
      offset += 4
      const signData = buffer.slice(offset, offset + signDataSize)
      offset += signDataSize
      const signaturesSize = buffer.readUInt32LE(offset)
      offset += 4
      const signatureEnd = offset + signaturesSize
      const signatures = []
      while (offset < signatureEnd) {
        offset += 4 // size
        const sigId = buffer.readUInt32LE(offset)
        offset += 4
        const dataLength = buffer.readUInt32LE(offset)
        offset += 4
        signatures.push({ id: sigId, data: buffer.slice(offset, offset + dataLength) })
        offset += dataLength
      }
      const pubKeySize = buffer.readUInt32LE(offset)
      offset += 4
      const pubKey = buffer.slice(offset, offset + pubKeySize)
      offset += pubKeySize
      result.signBlock = { signData, signatures, pubKey }
    } else if (kvId === FILES_BLOCK_ID) {
      const block = buffer.slice(valueStart, valueEnd)
      result.fileBlock = parseDigestBlock(block)
      offset = valueEnd
    } else {
      offset = valueEnd
    }
    if (offset !== valueEnd) {
      throw new Error(
        "signature block parse error (kv " + kvId + "): " + offset + " != " + valueEnd
      )
    }
  }
  return result
}

function parseDigestBlock(buffer) {
  let offset = 0
  const size = buffer.readUInt32LE(offset)
  offset += 4
  const signedData = buffer.slice(offset, offset + size)
  offset += size
  const digestId = signedData.readUInt32LE(0)
  const entries = []
  let cursor = 4
  while (cursor < signedData.length) {
    const nameHash = signedData.readUInt32LE(cursor)
    cursor += 4
    const hashLength = signedData.readUInt16LE(cursor)
    cursor += 2
    entries.push({ nameHash, hash: signedData.slice(cursor, cursor + hashLength) })
    cursor += hashLength
  }
  const signSize = buffer.readUInt32LE(offset)
  offset += 4
  const signId = buffer.readUInt32LE(offset)
  offset += 4
  const dataLength = buffer.readUInt32LE(offset)
  offset += 4
  const signature = buffer.slice(offset, offset + dataLength)
  return { size, digestId, entries, signature, signedData, signSize, signId }
}

function parseSignData(buffer) {
  let offset = 0
  const digestsSize = buffer.readUInt32LE(offset)
  offset += 4
  const digestItems = []
  const digestEnd = offset + digestsSize
  while (offset < digestEnd) {
    const itemSize = buffer.readUInt32LE(offset)
    offset += 4
    const id = buffer.readUInt32LE(offset)
    offset += 4
    const dataLength = buffer.readUInt32LE(offset)
    offset += 4
    digestItems.push({ id, data: buffer.slice(offset, offset + dataLength) })
    offset += dataLength
    if (itemSize !== dataLength + 8) {
      throw new Error("bad digest item size")
    }
  }
  const certsSize = buffer.readUInt32LE(offset)
  offset += 4
  const certs = []
  const certsEnd = offset + certsSize
  while (offset < certsEnd) {
    const certSize = buffer.readUInt32LE(offset)
    offset += 4
    certs.push(buffer.slice(offset, offset + certSize))
    offset += certSize
  }
  return { digestItems, certs }
}

/* ---------------------------------------------------------------- misc */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pass(message) {
  passes.push(message)
  console.log("  PASS  " + message)
}

function fail(message) {
  failures.push(message)
  console.log("  FAIL  " + message)
}

function finish() {
  console.log("")
  if (failures.length > 0) {
    console.log("结果: FAIL (" + failures.length + " 项失败, " + passes.length + " 项通过)")
    process.exitCode = 1
    return
  }
  console.log("结果: PASS (" + passes.length + " 项检查通过)")
}

main()
