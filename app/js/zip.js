// Store-only ZIP writer, dependency-free. Exports carry originals, so no
// recompression, and every timestamp field is fixed: the archive's own
// metadata must not leak when it was made beyond what the manifest says.

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function u16(n) {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// files: [{ name, bytes }] with forward-slash paths. Returns Uint8Array.
export function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;
    // Flag 0x0800: names are UTF-8. Date/time fixed at the DOS epoch.
    const local = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, file.bytes);
    central.push(
      Uint8Array.from([
        0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + size;
  }
  const centralStart = offset;
  let centralLen = 0;
  for (const c of central) centralLen += c.length;
  const eocd = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralLen), ...u32(centralStart), ...u16(0),
  ]);
  let total = centralStart + centralLen + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of [...parts, ...central, eocd]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Store-only ZIP reader, the exact mirror of buildZip above. It reads back
// nothing this file did not write itself: any compression method other than
// store, or a CRC that does not match, is treated as corruption, not
// tolerated. Used to self-verify a built export before it can leave the app.
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = dv.getUint16(eocd + 10, true);
  const centralStart = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = [];
  let p = centralStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error("not a zip: bad central directory entry");
    }
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen;
    if (method !== 0) throw new Error(`${name}: only the store method is supported`);
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLen;
    const data = bytes.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch, archive is corrupt`);
    files.push({ name, bytes: data });
  }
  return files;
}
