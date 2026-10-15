// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { leadingZeroBits, verifyPow } from "../../src/shared/pow.js";

describe("proof of work", () => {
  it("counts leading zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0, 0x10]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it("verifies against SHA-256 of the documented input", async () => {
    const hash = async (room: string, c: number) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wr-pow1\0${room}\0abcd\0${c}`)));
    let c = 0;
    while (leadingZeroBits(await hash("room", c)) < 10) c++;
    expect(await verifyPow("room", "abcd", String(c), 10)).toBe(true);
    // Bound to the room: the same counter is (almost surely) not a solution elsewhere.
    expect(await verifyPow("other", "abcd", String(c), 10)).toBe(leadingZeroBits(await hash("other", c)) >= 10);
  });

  it("rejects malformed counters and accepts anything when disabled", async () => {
    for (const bad of [undefined, 12, "", "-1", "1e3", "0x10", "1".repeat(13)]) expect(await verifyPow("r", "n", bad, 1)).toBe(false);
    expect(await verifyPow("r", "n", undefined, 0)).toBe(true);
  });
});
