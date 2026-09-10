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

// 8) Write endpoints return a readable memo on an E2EE project.
//    Regression: updateBlock/deleteBlock/restoreBlock echoed the server's
//    response verbatim, and for an E2EE project the server can only send
//    ciphertext — so `memo` came back "" after a successful edit, which
//    reads as "your memo was wiped". Reads take { decrypt: true }; a write
//    has no options object, so decryption has to be automatic there.
{
  const { PyuntoTM } = await import("../dist/index.js");
  const b64 = (b) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);

  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kek = sodium.crypto_pwhash(
    32, password, salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapped = new Uint8Array([
    ...salt, ...nonce, ...sodium.crypto_secretbox_easy(kp.privateKey, nonce, kek),
  ]);

  const MEMO = "設計レビュー 🌸";
  const memoEnc = await encryptField(dek, MEMO);
  const sealedDek = sodium.crypto_box_seal(dek, kp.publicKey);

  // A block exactly as the server sends it for an E2EE project: the
  // plaintext column is empty, the ciphertext carries the content.
  const serverBlock = {
    id: 596, project_id: 1, task_id: null, date: "2026-09-09",
    start_min: 540, end_min: 600, memo: "", memo_enc: memoEnc, created_by: 1,
  };

  const stub = async (url, init) => {
    const path = String(url).replace("http://stub/api/v1", "");
    const body =
      path === "/keys" ? {
        encryption_version: 1,
        public_key: b64(kp.publicKey),
        encrypted_private_key: b64(wrapped),
      }
      : path === "/projects" ? [{
        id: 1, name: "", name_enc: null, color: "#f00", role: "owner",
        is_shared: false, encryption_version: 1, dek_sealed: b64(sealedDek),
      }]
      : { ...serverBlock };   // PATCH / DELETE / POST-restore all echo the row
                              // (a fresh copy: withMemo fills memo in place)
    return { ok: true, status: 200, json: async () => body };
  };

  const tm = new PyuntoTM({ apiKey: "ptm_test", baseUrl: "http://stub", fetch: stub });
  await tm.unlock(password);

  const patched = await tm.updateBlock(596, { start_min: 600 });
  check("updateBlock returns the decrypted memo", patched.memo === MEMO);

  const removed = await tm.deleteBlock(596);
  check("deleteBlock returns the decrypted memo", removed.memo === MEMO);

  const back = await tm.restoreBlock(596);
  check("restoreBlock returns the decrypted memo", back.memo === MEMO);

  // A locked client must not invent a memo it cannot read.
  const locked = new PyuntoTM({ apiKey: "ptm_test", baseUrl: "http://stub", fetch: stub });
  const raw = await locked.deleteBlock(596);
  check("a locked client leaves the memo empty rather than guessing", raw.memo === "");
}

process.exit(failures === 0 ? 0 : 1);
