// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AbsenceWindow } from "../../src/core/absence.js";
import { MinuteCounter } from "../../src/core/actives.js";
import { TicketLedger, UNKNOWN_ADMIT } from "../../src/core/ledger.js";
import { PauseState, pauseOffsetFor } from "../../src/core/pause.js";

describe("MinuteCounter", () => {
  it("counts each session once thanks to the decrement of the previous minute", () => {
    const c = new MinuteCounter();
    // Session A seen in minutes 100, 101, 102; session B in 101 only.
    c.apply([[100, 1]], 100, 10);
    c.apply([[101, 1], [100, -1]], 101, 10);
    c.apply([[101, 1]], 101, 10);
    c.apply([[102, 1], [101, -1]], 102, 10);
    expect(c.estimate(102, 10)).toBe(2);
    // Ten minutes later, B (last seen at 101) is out of the window, A (102) too at 112.
    expect(c.estimate(111, 10)).toBe(1);
    expect(c.estimate(112, 10)).toBe(0);
  });

  it("ignores deltas outside the window and never goes negative", () => {
    const c = new MinuteCounter();
    c.apply([[50, 5]], 100, 10);
    expect(c.estimate(100, 10)).toBe(0);
    c.apply([[99, -3]], 100, 10);
    expect(c.estimate(100, 10)).toBe(0);
  });
});

describe("AbsenceWindow", () => {
  it("computes the ratio over a sliding window with a minimum sample", () => {
    const w = new AbsenceWindow();
    for (let i = 0; i < 10; i++) w.record(i * 1000, i % 2 === 0);
    expect(w.ratio(10_000, 60_000, 20)).toBe(0);
    for (let i = 10; i < 30; i++) w.record(i * 1000, i % 4 === 0);
    expect(w.ratio(30_000, 60_000, 20)).toBeCloseTo((5 + 5) / 30, 5);
    // Old events leave the window.
    expect(w.ratio(80_000, 60_000, 1)).toBeCloseTo(3 / 10, 5);
  });
});

describe("TicketLedger", () => {
  it("issues sequential tickets and detects duplicates with the first tag", () => {
    const l = new TicketLedger();
    const a = l.issue(1000, 0);
    const b = l.issue(2000, 0.1);
    expect([a, b]).toEqual([1, 2]);
    expect(l.redeem(a, 77)).toEqual({ r: "ok" });
    expect(l.redeem(a, 88)).toEqual({ r: "duplicate", winnerTag: 77 });
    expect(l.redeem(99, 1)).toEqual({ r: "unknown" });
    expect(l.aIssuedOf(b)).toBe(0.1);
  });

  it("prunes in chunks and keeps numbering", () => {
    const l = new TicketLedger();
    for (let i = 0; i < 1000; i++) l.issue(i, 0);
    l.prune(600);
    expect(l.base).toBe(600);
    expect(l.next).toBe(1001);
    expect(l.admitAtOf(600)).toBe(599);
    expect(l.has(599)).toBe(false);
  });

  it("reserves unknown ticket numbers after a restart", () => {
    const l = new TicketLedger();
    l.issue(1, 0);
    l.skipTo(10);
    expect(l.next).toBe(10);
    expect(l.admitAtOf(5)).toBe(UNKNOWN_ADMIT);
  });
});

describe("PauseState", () => {
  it("shifts the tickets issued before the end of each pause", () => {
    const p = new PauseState();
    p.pause(1000);
    expect(p.resume(6000, 10)).toBe(5000);
    p.pause(10_000);
    p.resume(12_000, 20);
    expect(p.offsetFor(5)).toBe(7000);
    expect(p.offsetFor(15)).toBe(2000);
    expect(p.offsetFor(25)).toBe(0);
    expect(pauseOffsetFor(p.offsets, 10)).toBe(7000);
    p.prune(11);
    expect(p.offsets).toEqual([[20, 2000]]);
  });
});

describe("TicketLedger chunks", () => {
  it("rebuilds the ledger from its meta and its chunks", async () => {
    const { LEDGER_CHUNK } = await import("../../src/core/ledger.js");
    const l = new TicketLedger();
    for (let i = 0; i < 2 * LEDGER_CHUNK + 10; i++) l.issue(1_767_600_000_000 + i * 300, 0.25);
    l.skipTo(l.next + 3);
    l.redeem(5, 42);
    l.evalNext = 600;
    l.prune(600, true);
    const chunks = l.takeDirtyChunks().map((c) => l.chunk(c));
    expect(chunks.length).toBe(3);
    const back = TicketLedger.fromChunks(l.meta(), chunks);
    expect(back).toEqual(l.toData());
    // Only what changed is written next time.
    expect(l.takeDirtyChunks()).toEqual([]);
    l.redeem(700, 1);
    l.issue(1, 0);
    expect(l.takeDirtyChunks()).toEqual([0, 2]);
  });

  it("reads the per-ticket layout of the absence window of older versions", () => {
    const w = new AbsenceWindow([[1000, 1], [2000, 0], [15_000, 1]]);
    expect(w.size).toBe(3);
    expect(w.ratio(20_000, 60_000, 1)).toBeCloseTo(2 / 3, 5);
    expect(w.events.length).toBe(2);
  });
});
