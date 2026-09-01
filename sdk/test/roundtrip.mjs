/**
 * Byte-compatibility round-trip: constructs blobs EXACTLY the way the web
 * app does (frontend/src/crypto/e2ee.ts — Argon2id+secretbox key wrap,
 * sealed-box DEK, AES-GCM/XChaCha field encryption), then verifies the SDK
 * opens all of them. Failures here mean the SDK would not decrypt real
 * account data.
 */
import { createRequire } from "node:module";
import {
  unwrapPrivateKey, openSealedDEK, decryptField, encryptField,
} from "../dist/index.js";

// CJS entry — the package's ESM entry is broken under plain Node (the SDK
// itself works around this the same way; see src/crypto.ts).
const sodium = createRequire(import.meta.url)("libsodium-wrappers-sumo");
await sodium.ready;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}
function eq(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// 1) Password-wrapped private key (app format: salt16 || nonce24 || secretbox)
const kp = sodium.crypto_box_keypair();
const password = "correct horse battery staple";
{
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kek = sodium.crypto_pwhash(
    32, password, salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(kp.privateKey, nonce, kek);
  const blob = new Uint8Array([...salt, ...nonce, ...ct]);

  const out = await unwrapPrivateKey(blob, password);
  check("password unwrap returns the private key", eq(out, kp.privateKey));

  let threw = false;
  try { await unwrapPrivateKey(blob, "wrong password"); } catch { threw = true; }
  check("wrong password throws", threw);
}

// 2) Sealed-box DEK
const dek = sodium.randombytes_buf(32);
{
  const sealed = sodium.crypto_box_seal(dek, kp.publicKey);
  const out = await openSealedDEK(sealed, kp.publicKey, kp.privateKey);
  check("sealed DEK opens", eq(out, dek));
}

// 3) AES-GCM field (12-byte IV — server & current client format)
{
  const env = await encryptField(dek, "日本語のメモ 🌸");
  check("AES-GCM IV is 12 bytes",
    sodium.from_base64(env.iv, sodium.base64_variants.ORIGINAL).length === 12);
  const out = await decryptField(dek, env);
  check("AES-GCM field round-trips", out === "日本語のメモ 🌸");
}

// 4) XChaCha20-Poly1305 field (24-byte IV — early-era projects)
{
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string("legacy xchacha memo"), null, null, nonce, dek);
  const env = {
    iv: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ct: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL),
  };
  const out = await decryptField(dek, env);
  check("XChaCha field decrypts", out === "legacy xchacha memo");
}

// 5) Python-style standard base64 (with padding) decodes identically
{
  const buf = sodium.randombytes_buf(88);
  const pyB64 = Buffer.from(buf).toString("base64");
  const decoded = sodium.from_base64(pyB64, sodium.base64_variants.ORIGINAL);
  check("python-format base64 interop", eq(decoded, buf));
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
