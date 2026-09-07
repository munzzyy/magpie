// The encryption layer: passphrase to key, key to sealed records. Pure
// WebCrypto, no state. The vault module owns WHEN a key exists; this module
// only knows HOW to use one.
//
// PBKDF2-SHA256 at 600k iterations into AES-256-GCM. Argon2 would be
// stronger against GPUs but needs WASM we refuse to vendor; the honest
// mitigation is the passphrase advice in the UI, and the iteration count
// is stored so it can rise in later versions without stranding old vaults.

export const KDF_ITERS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(passphrase, salt, iters = KDF_ITERS) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad ? enc.encode(aad) : undefined },
    key,
    bytes,
  );
  return { iv, ct: new Uint8Array(ct) };
}

export async function open(key, box, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: box.iv, additionalData: aad ? enc.encode(aad) : undefined },
    key,
    box.ct,
  );
  return new Uint8Array(pt);
}

export const sealText = async (key, text, aad) => seal(key, enc.encode(text), aad);
export const openText = async (key, box, aad) => dec.decode(await open(key, box, aad));
