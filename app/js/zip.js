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
