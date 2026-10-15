// SPDX-License-Identifier: Apache-2.0
//
// Proof of work of POST /__wr/reserve (public interface, docs/interfaces.md).
// The client finds a decimal counter such that
//   SHA-256("wr-pow1\0" + room + "\0" + nonce + "\0" + counter)
// starts with `bits` zero bits, where nonce is the one of its provisional
// cookie (given in the waiting page). One solution per provisional cookie,
// and a provisional cookie gets one ticket: the work is paid per ticket.
// Verification costs one hash.

const enc = new TextEncoder();
const COUNTER_RE = /^[0-9]{1,12}$/;

export function leadingZeroBits(b: Uint8Array): number {
  let n = 0;
  for (const x of b) {
    if (x === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(x) - 24;
  }
  return n;
}

export async function verifyPow(room: string, nonce: string, counter: unknown, bits: number): Promise<boolean> {
  if (bits <= 0) return true;
  if (typeof counter !== "string" || !COUNTER_RE.test(counter)) return false;
  const h = await crypto.subtle.digest("SHA-256", enc.encode(`wr-pow1\0${room}\0${nonce}\0${counter}`));
  return leadingZeroBits(new Uint8Array(h)) >= bits;
}
