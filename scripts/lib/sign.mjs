// ed25519 signing of the exact bytes of index.json.
//
// Key formats (kept as plain as possible so the app and the CI secret are easy):
//   private key  base64 of the 32-byte seed (the CI secret REGISTRY_SIGNING_KEY)
//   public key   base64 of the 32-byte raw key (what the app embeds)
//   signature    base64 of the 64-byte signature (the content of index.json.sig)

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

// DER prefixes for an ed25519 key: PKCS#8 (private) and SubjectPublicKeyInfo.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeB64(text, bytes, what) {
  const clean = String(text ?? "").trim();
  const buf = Buffer.from(clean, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || buf.length !== bytes) {
    throw new Error(`${what} must be base64 of ${bytes} bytes`);
  }
  return buf;
}

/** A fresh keypair: { privateKey: base64 seed, publicKey: base64 raw key }. */
export function generateKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: pkcs8.subarray(PKCS8_PREFIX.length).toString("base64"),
    publicKey: spki.subarray(SPKI_PREFIX.length).toString("base64"),
  };
}

/** The public key (base64 raw) belonging to a base64 seed. */
export function publicKeyOf(privateKeyB64) {
  const seed = decodeB64(privateKeyB64, 32, "the signing key");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_PREFIX.length).toString("base64");
}

/** Sign `bytes`; returns the base64 signature. */
export function signBytes(bytes, privateKeyB64) {
  const seed = decodeB64(privateKeyB64, 32, "the signing key");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, bytes, key).toString("base64");
}

/** Whether `signatureB64` is a valid signature of `bytes` under `publicKeyB64`. */
export function verifyBytes(bytes, signatureB64, publicKeyB64) {
  try {
    const raw = decodeB64(publicKeyB64, 32, "the public key");
    const sig = decodeB64(signatureB64, 64, "the signature");
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}
