#!/usr/bin/env python3
"""Check that a signed Magpie release APK holds exactly what an unsigned
build of the same commit holds.

    python3 tools/compare-apk.py BUILT.apk RELEASE.apk

BUILT.apk is android/app/build/outputs/apk/release/app-release-unsigned.apk
from `cd android && ./gradlew assembleRelease`. Signing leaves every entry
alone and only adds a signing block outside them, plus META-INF/MANIFEST.MF,
*.SF and *.RSA for a v1 signature, so those are skipped. Every other entry
must match by name, order, compression method, CRC-32 and the compressed
bytes. Exit 0 when they all do, 1 when anything differs, 2 when a file
can't be read as a zip. Needs only the Python standard library.
"""
import hashlib, struct, sys, zipfile

SIGNATURE_SUFFIXES = (".SF", ".RSA", ".DSA", ".EC")

def is_signature(name):
    if not name.startswith("META-INF/") or "/" in name[len("META-INF/"):]:
        return False
    return name == "META-INF/MANIFEST.MF" or name.upper().endswith(SIGNATURE_SUFFIXES)

def raw_digest(f, info):
    # The local header's name and extra lengths can differ from the central directory's; read them here.
    f.seek(info.header_offset)
    head = f.read(30)
    if len(head) != 30 or head[:4] != b"PK\x03\x04":
        raise zipfile.BadZipFile(f"no local header for {info.filename}")
    name_len, extra_len = struct.unpack("<HH", head[26:30])
    f.seek(info.header_offset + 30 + name_len + extra_len)
    h = hashlib.sha256()
    left = info.compress_size
    while left:
        block = f.read(min(left, 1 << 20))
        if not block:
            raise zipfile.BadZipFile(f"{info.filename} is cut short")
        h.update(block)
        left -= len(block)
    return h.hexdigest()

def entries(path):
    with zipfile.ZipFile(path) as z, open(path, "rb") as f:
        kept, skipped = [], 0
        for info in z.infolist():
            if is_signature(info.filename):
                skipped += 1
                continue
            kept.append((info.filename, info.compress_type, info.CRC, info.compress_size, raw_digest(f, info)))
        return kept, skipped

def load(path):
    try:
        return entries(path)
    except (OSError, zipfile.BadZipFile) as err:
        print(f"ERROR: {path} could not be read as an APK ({err})")
        sys.exit(2)

def main():
    if len(sys.argv) != 3:
        print(__doc__.strip())
        sys.exit(2)
    built_path, release_path = sys.argv[1:]
    built, built_sigs = load(built_path)
    release, release_sigs = load(release_path)

    diffs = []
    built_names = [e[0] for e in built]
    release_names = [e[0] for e in release]
    for name in sorted(set(built_names) - set(release_names)):
        diffs.append(f"only in the build: {name}")
    for name in sorted(set(release_names) - set(built_names)):
        diffs.append(f"only in the release: {name}")
    if not diffs and built_names != release_names:
        first = next(i for i, (a, b) in enumerate(zip(built_names, release_names)) if a != b)
        diffs.append(f"entry order differs from entry {first + 1} ({built_names[first]} vs {release_names[first]})")
    release_by_name = {e[0]: e for e in release}
    for name, method, crc, size, digest in built:
        other = release_by_name.get(name)
        if other is None:
            continue
        if other[1] != method:
            diffs.append(f"{name}: compression method {method} vs {other[1]}")
        elif other[2] != crc:
            diffs.append(f"{name}: CRC-32 {crc:08x} vs {other[2]:08x}")
        elif other[3] != size or other[4] != digest:
            diffs.append(f"{name}: compressed bytes differ")

    if diffs:
        print(f"DIFFERENT: {len(diffs)} difference(s) between {built_path} and {release_path}")
        for d in diffs[:50]:
            print("  " + d)
        if len(diffs) > 50:
            print(f"  ... and {len(diffs) - 50} more")
        sys.exit(1)
    print(f"SAME: all {len(built)} entries match; signature files skipped: {built_sigs} in the build, {release_sigs} in the release")

if __name__ == "__main__":
    main()
