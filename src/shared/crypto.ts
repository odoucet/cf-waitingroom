// SPDX-License-Identifier: Apache-2.0
//
// HMAC-SHA256 key ring (Web Crypto). Keys are imported once per isolate.
// Two key ids may be active at the same time to allow rotation.

const enc = new TextEncoder();

export const TAG_BYTES = 16;

export class KeyRingError extends Error {}

export class KeyRing {
  private constructor(
    private readonly keys: Map<number, CryptoKey>,
    readonly currentKid: number,
  ) {}

  /**
   * @param keysJson JSON object `{ "<kid>": "<base64 secret>" }`, kid in 0..255, at most two entries.
   * @param current  kid used to sign new tokens.
   */
  static async create(keysJson: string | undefined, current: string | undefined): Promise<KeyRing> {
    if (!keysJson) throw new KeyRingError("WR_KEYS is not set");
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysJson);
    } catch {
      throw new KeyRingError("WR_KEYS is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) throw new KeyRingError("WR_KEYS must be an object");
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 2) throw new KeyRingError("WR_KEYS must hold one or two keys");
    const keys = new Map<number, CryptoKey>();
    for (const [kidStr, secret] of entries) {
      const kid = Number(kidStr);
      if (!Number.isInteger(kid) || kid < 0 || kid > 255) throw new KeyRingError(`invalid kid ${kidStr}`);
      if (typeof secret !== "string") throw new KeyRingError(`key ${kidStr} must be a base64 string`);
      const raw = base64ToBytes(secret);
      if (raw.length < 32) throw new KeyRingError(`key ${kidStr} must be at least 32 bytes`);
      keys.set(kid, await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    }
    const cur = current === undefined || current === "" ? Number(entries[0]![0]) : Number(current);
    if (!keys.has(cur)) throw new KeyRingError("WR_KEY_CURRENT does not match a key in WR_KEYS");
    return new KeyRing(keys, cur);
  }

  async mac(kid: number, data: Uint8Array): Promise<Uint8Array | null> {
    const key = this.keys.get(kid);
    if (!key) return null;
    const full = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    return full.subarray(0, TAG_BYTES);
  }
}

let cachedRing: { src: string; ring: Promise<KeyRing> } | null = null;

/** Returns the isolate-wide key ring, importing keys on first use only. */
export function getKeyRing(keysJson: string | undefined, current: string | undefined): Promise<KeyRing> {
  const src = `${current ?? ""}|${keysJson ?? ""}`;
  if (cachedRing && cachedRing.src === src) return cachedRing.ring;
  const ring = KeyRing.create(keysJson, current);
  cachedRing = { src, ring };
  // Do not cache a failure forever.
  ring.catch(() => {
    if (cachedRing?.ring === ring) cachedRing = null;
  });
  return ring;
}

/** Constant-time comparison of two byte arrays of equal length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Constant-time comparison of two secrets of arbitrary length: both sides are
 * hashed first so that the comparison does not leak the length.
 */
export async function secretEquals(provided: string, expected: string): Promise<boolean> {
  if (expected === "") return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return bytesEqual(new Uint8Array(a), new Uint8Array(b));
}

export function bytesToBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    return base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

export function base64ToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? s : s + "=".repeat(4 - (s.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
