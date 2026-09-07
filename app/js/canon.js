// Canonical serialization for chain hashing. The byte layout is the
// contract: two devices given the same entry must produce identical bytes
// forever, so keys are written in one fixed order and the version is baked
// in. Never reorder or extend this list for v1 entries.

const KEYS = ["v", "seq", "ts", "type", "title", "note", "file"];
const FILE_KEYS = ["name", "mime", "size", "sha256"];

export function canonical(entry) {
  const parts = [];
  for (const k of KEYS) {
    let v = entry[k];
    if (k === "file") {
      if (!v) {
        v = null;
      } else {
        const f = {};
        for (const fk of FILE_KEYS) f[fk] = v[fk];
        v = f;
      }
    }
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v ?? null)}`);
  }
  return `{${parts.join(",")}}`;
}

export function makeEntry({ seq, ts, type, title, note, file }) {
  return {
    v: 1,
    seq,
    ts,
    type,
    title: String(title || "").slice(0, 200),
    note: String(note || ""),
    file: file
      ? { name: String(file.name).slice(0, 120), mime: String(file.mime || ""), size: file.size, sha256: file.sha256 }
      : null,
  };
}
