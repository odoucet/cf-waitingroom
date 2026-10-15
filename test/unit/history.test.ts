// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HISTORY_MINUTES, MinuteHistory } from "../../src/core/history.js";

const T = 1_767_600_000_000; // a minute boundary

describe("MinuteHistory", () => {
  it("sums and lists the last hour per minute", () => {
    const h = new MinuteHistory();
    h.add(T, "a");
    h.add(T + 30_000, "a", 2);
    h.add(T + 60_000, "a", 4);
    h.add(T + 60_000, "b", 0);
    expect(h.sum(T + 60_000, ["a"])).toBe(7);
    const s = h.series(T + 60_000, ["a", "b"]);
    expect(s.a).toHaveLength(HISTORY_MINUTES);
    expect(s.a!.slice(-2)).toEqual([3, 4]);
    expect(s.b!.every((v) => v === 0)).toBe(true);
  });

  it("forgets minutes older than an hour", () => {
    const h = new MinuteHistory();
    h.add(T, "a", 5);
    for (let i = 1; i <= HISTORY_MINUTES + 10; i++) h.add(T + i * 60_000, "a");
    const now = T + (HISTORY_MINUTES + 10) * 60_000;
    expect(h.sum(now, ["a"])).toBe(HISTORY_MINUTES);
    expect(h.series(now, ["a"]).a!.every((v) => v === 1)).toBe(true);
  });
});
