/**
 * E2EE primitives for the Pyunto TM SDK — byte-compatible with the web
 * app's crypto (frontend/src/crypto/e2ee.ts). Formats are stable:
 *
 *   Password-wrapped private key blob:
 *     salt(16) || nonce(24) || secretbox(privateKey)      (KEK = Argon2id)
 *   Project DEK addressed to a user:
 *     crypto_box_seal(dek, userPublicKey)                  (sealed box)
 *   Content fields ({iv, ct} base64 envelopes):
 *     iv 12 bytes → AES-256-GCM (WebCrypto)
 *     iv 24 bytes → XChaCha20-Poly1305 (early-era projects)
 */
export interface CipherEnvelope {
  iv: string; // base64
  ct: string; // base64 (ciphertext + auth tag)
}

// libsodium-wrappers-sumo ships a broken ESM entry (its .mjs references a
// sibling libsodium-sumo.mjs that isn't in the published package), which
// breaks plain-Node ESM imports. Bundlers (vite/webpack) resolve it fine.
// Load lazily: try the ESM specifier first (bundler / fixed versions),
// fall back to the CJS build via createRequire for Node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sodium: any = null;

async function loadSodium(): Promise<any> {
  try {
    const m: any = await import("libsodium-wrappers-sumo");
    const s = m.default ?? m;
    await s.ready;
    return s;
  } catch {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const s = req("libsodium-wrappers-sumo");
    await s.ready;
    return s;
  }
}

export async function ready(): Promise<void> {
  if (!sodium) sodium = await loadSodium();
}

function s(): any {
  if (!sodium) throw new Error("sodium not initialised — await ready() first");
  return sodium;
}

export function b64encode(b: Uint8Array): string {
  return s().to_base64(b, s().base64_variants.ORIGINAL);
}

export function b64decode(str: string): Uint8Array {
  return s().from_base64(str, s().base64_variants.ORIGINAL);
}

const KEK_LEN = 32;

/** Unwrap the password-wrapped private key blob served by GET /v1/keys. */
export async function unwrapPrivateKey(blob: Uint8Array, password: string): Promise<Uint8Array> {
  await ready();
  const SALT = sodium.crypto_pwhash_SALTBYTES;      // 16
  const NONCE = sodium.crypto_secretbox_NONCEBYTES; // 24
  if (blob.length < SALT + NONCE + 17) throw new Error("wrapped private key blob too short");
  const salt = blob.subarray(0, SALT);
  const nonce = blob.subarray(SALT, SALT + NONCE);
  const ct = blob.subarray(SALT + NONCE);
  const kek = sodium.crypto_pwhash(
    KEK_LEN, password, salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return sodium.crypto_secretbox_open_easy(ct, nonce, kek);
  } catch {
    throw new Error("wrong password (could not unwrap private key)");
  }
}

/** Open a project's sealed DEK (from /v1/projects dek_sealed). */
export async function openSealedDEK(
  sealed: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  return sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
}

// WebCrypto BufferSource wants a plain ArrayBuffer-backed view.
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** Decrypt a {iv, ct} content envelope with a project DEK. */
export async function decryptField(dek: Uint8Array, env: CipherEnvelope): Promise<string> {
  await ready();
  const iv = b64decode(env.iv);
  const ct = b64decode(env.ct);
  if (iv.length === 24) {
    // XChaCha20-Poly1305 (early-era E2EE projects)
    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, iv, dek);
    return sodium.to_string(pt);
  }
  if (iv.length === 12) {
    const key = await crypto.subtle.importKey("raw", ab(dek), { name: "AES-GCM" }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(ct));
    return new TextDecoder().decode(pt);
  }
  throw new Error(`unsupported field IV length ${iv.length} (expected 12 or 24)`);
}

/** Encrypt a content field with a project DEK (server-compatible AES-GCM). */
export async function encryptField(dek: Uint8Array, plaintext: string): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", ab(dek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ab(iv) }, key, ab(new TextEncoder().encode(plaintext)));
  await ready();
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

/** Best-effort zeroization of key material. */
export function wipe(b: Uint8Array): void {
  try { sodium.memzero(b); } catch { /* not ready — noop */ }
}
