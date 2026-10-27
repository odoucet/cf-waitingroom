// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { CoordinatorCore, MemoryNonceStore, NONCE_RETENTION_SEC, zeroEdgeCounters } from "../../src/core/coordinator-core.js";
import { DEFAULT_CONFIG, mergeConfig } from "../../src/shared/config.js";
import type { Batch, RoomConfig } from "../../src/shared/types.js";

const T = 1_767_600_000_000;

function cfg(p: Partial<RoomConfig> = {}): RoomConfig {
  return mergeConfig(DEFAULT_CONFIG, { admissionsPerMinute: 60, ...p });
}

/** A reservation that must succeed. */
function issue(c: CoordinatorCore, nonce: string, now: number, issuedSec?: number) {
  const r = c.reserve(nonce, now, issuedSec);
  if (r.refused) throw new Error(`refused: ${r.refused}`);
  return r;
}

function batch(p: Partial<Batch> & { isolateId?: string; seq: number }): Batch {
  return {
    isolateId: "a",
    tag: 1,
    since: T,
    knownGen: 1,
    redeemed: [],
    leaseUsed: 0,
    leaseUsage: [],
    leaseUnused: 0,
    leaseWanted: 0,
    urgent: false,
    activeDeltas: [],
    wlActiveDeltas: [],
    counters: zeroEdgeCounters(),
    ...p,
  };
}

describe("CoordinatorCore", () => {
  it("starts open and spaces reservations by 1/R", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    expect(c.isOpen(T)).toBe(true);
    const a = issue(c, "n1", T);
    const b = issue(c, "n2", T);
    expect(b.admitAtMs - a.admitAtMs).toBe(1000);
    // The bucket (burstSec = 5 s) lets the first tickets in immediately.
    expect(a.admitAtMs).toBeLessThanOrEqual(T);
  });

  it("returns the same ticket for the same nonce", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    expect(issue(c, "n", T)).toEqual(issue(c, "n", T + 10));
    expect(c.counters.reserved).toBe(1);
  });

  it("closes when reported usage exceeds R plus the bucket, and reopens as time passes", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const sec = Math.floor(T / 1000);
    c.applyBatch(batch({ seq: 1, leaseUsed: 10, leaseUsage: [[sec, 10]] }), T);
    // 10 slots of 1 s on top of a 5 s bucket: cursor 5 s ahead.
    expect(c.isOpen(T + 999)).toBe(false);
    c.tick(T + 7000);
    expect(c.isOpen(T + 7000)).toBe(true);
  });

  it("absorbs late usage reports that happened while capacity was idle", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const now = T + 120_000;
    const old = Math.floor(T / 1000);
    // 60 slots spread over the last two minutes (one every two seconds), reported at once.
    const usage: [number, number][] = [];
    for (let i = 0; i < 60; i++) usage.push([old + i * 2, 1]);
    c.applyBatch(batch({ seq: 1, leaseUsed: 60, leaseUsage: usage }), now);
    expect(c.isOpen(now)).toBe(true);
  });

  it("deduplicates batches by isolate and sequence", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const b = batch({ seq: 1, activeDeltas: [[Math.floor(T / 60000), 1]] });
    expect(c.applyBatch(b, T)).toBe(true);
    expect(c.applyBatch(b, T)).toBe(false);
  });

  it("grants leases only when open, within the block, share and cap limits", () => {
    const c = new CoordinatorCore(cfg({ leaseBlockMax: 5 }), 1, T);
    const l = c.grantLease(batch({ seq: 1, leaseWanted: 50 }), T);
    expect(l?.n).toBe(5);
    expect(c.outstanding).toBe(5);
    // Returning the lease frees the outstanding slots.
    c.applyBatch(batch({ seq: 2, leaseUnused: 5 }), T + 1);
    expect(c.outstanding).toBe(0);
    c.admin({ op: "setMode", mode: "queue_all" }, T + 2);
    expect(c.grantLease(batch({ seq: 3, leaseWanted: 3 }), T + 2)).toBeUndefined();
  });

  it("always grants one slot to an urgent request when open, even at the cap", () => {
    const c = new CoordinatorCore(cfg({ calmLeaseMaxOutstandingSec: 0, leaseMaxOutstandingSec: 0 }), 1, T);
    expect(c.grantLease(batch({ seq: 1, leaseWanted: 3 }), T)).toBeUndefined();
    expect(c.grantLease(batch({ seq: 2, leaseWanted: 3, urgent: true }), T)?.n).toBe(1);
  });

  it("expires leases optimistically", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const l = c.grantLease(batch({ seq: 1, leaseWanted: 3 }), T)!;
    c.tick(l.exp + 1);
    expect(c.outstanding).toBe(0);
    expect(c.counters.leaseExpired).toBe(l.n);
  });

  it("schedules tickets after outstanding leases", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    c.grantLease(batch({ seq: 1, leaseWanted: 10 }), T);
    const out = c.outstanding;
    const r = issue(c, "n", T);
    expect(r.admitAtMs).toBeGreaterThanOrEqual(T - 5000 + out * 1000);
  });

  it("revokes replayed tickets but keeps the first redemption", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const { ticketNo } = issue(c, "n", T);
    c.applyBatch(batch({ isolateId: "a", tag: 11, seq: 1, redeemed: [ticketNo] }), T + 1);
    c.applyBatch(batch({ isolateId: "b", tag: 22, seq: 1, redeemed: [ticketNo] }), T + 2);
    expect(c.counters.redeemed).toBe(1);
    expect(c.counters.replays).toBe(1);
    expect(c.snapshot(T + 3, 1).revoked).toEqual([[ticketNo, 11]]);
  });

  it("measures absences and overbooks up to the cap", () => {
    const c = new CoordinatorCore(cfg({ admissionsPerMinute: 60, overbookCap: 1.5, redeemGraceSec: 10 }), 1, T);
    const tickets = [];
    for (let i = 0; i < 100; i++) tickets.push(issue(c, `n${i}`, T));
    // Half of them show up.
    c.applyBatch(batch({ seq: 1, redeemed: tickets.filter((_, i) => i % 2 === 0).map((t) => t.ticketNo) }), T + 1000);
    c.tick(T + 200_000);
    expect(c.absenceRatio).toBeCloseTo(0.5, 1);
    expect(c.rEff).toBe(90);
  });

  it("pulls tickets forward with earlyUpTo when absences were not anticipated", () => {
    const c = new CoordinatorCore(cfg({ redeemGraceSec: 10 }), 1, T);
    for (let i = 0; i < 300; i++) issue(c, `n${i}`, T);
    // Nobody shows up for the first 30 tickets; they expire.
    c.tick(T + 25_000 + 10_000 + 20_000);
    expect(c.earlyUpTo).toBeGreaterThan(c.ledger.dueNext - 1);
  });

  it("lowers the rate with the brake above the threshold", () => {
    const c = new CoordinatorCore(cfg({ brake: { enabled: true, activesThreshold: 100, activesLimit: 200, minFactor: 0.2 } }), 1, T);
    const m = Math.floor(T / 60000);
    c.applyBatch(batch({ seq: 1, activeDeltas: [[m, 150]] }), T);
    c.tick(T + 60_000);
    expect(c.brakeFactor).toBeCloseTo(0.6, 5);
    expect(c.rEff).toBeCloseTo(36, 5);
  });

  it("freezes admissions while paused and shifts tickets on resume", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const a = issue(c, "a", T);
    c.admin({ op: "setPause", paused: true }, T + 1000);
    expect(c.isOpen(T + 1000)).toBe(false);
    const b = issue(c, "b", T + 30_000);
    c.admin({ op: "setPause", paused: false }, T + 61_000);
    const s = c.snapshot(T + 61_000, 1);
    expect(s.paused).toBe(false);
    expect(s.pauseOffsets).toEqual([[b.ticketNo, 60_000]]);
    expect(b.admitAtMs - a.admitAtMs).toBe(1000);
    const after = issue(c, "c", T + 61_000);
    expect(after.admitAtMs).toBeGreaterThan(b.admitAtMs + 60_000);
  });

  it("keeps the queue in place during a long pause", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    for (let i = 0; i < 30; i++) issue(c, `q${i}`, T);
    expect(c.state(T).cursorLagSec).toBe(25);
    c.admin({ op: "setPause", paused: true }, T);
    const now = T + 20 * 60_000;
    c.tick(now);
    // The wait shown while paused is the wait left once admissions resume.
    expect(c.state(now).cursorLagSec).toBe(25);
    expect(c.metrics(now).gauges.wr_cursor_lag_seconds).toBe(25);
    // A visitor arriving late in the pause is queued right behind the others.
    const late = issue(c, "late", now);
    c.admin({ op: "setPause", paused: false }, now);
    const s = c.snapshot(now, 1);
    const offset = s.pauseOffsets.reduce((a, [upTo, d]) => (late.ticketNo <= upTo ? a + d : a), 0);
    expect(late.admitAtMs + offset - now).toBe(26_000);
  });

  it("shifts the lease backlog by the pause duration", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const sec = Math.floor(T / 1000);
    c.applyBatch(batch({ seq: 1, leaseUsed: 20, leaseUsage: [[sec, 20]] }), T);
    expect(c.isOpen(T)).toBe(false);
    c.admin({ op: "setPause", paused: true }, T);
    // Usage reported during the pause, by an isolate that had not seen it yet.
    c.applyBatch(batch({ isolateId: "b", seq: 1, leaseUsed: 5, leaseUsage: [[sec + 30, 5]] }), T + 31_000);
    c.tick(T + 10 * 60_000);
    // 25 slots of 1 s on top of a 5 s bucket, frozen at the start of the pause.
    expect(c.state(T + 10 * 60_000).cursorLagSec).toBe(20);
    c.admin({ op: "setPause", paused: false }, T + 10 * 60_000);
    // The backlog is still there after the pause: the room does not open at once.
    expect(c.isOpen(T + 10 * 60_000)).toBe(false);
    expect(c.state(T + 10 * 60_000).cursorLagSec).toBe(20);
    expect(c.isOpen(T + 10 * 60_000 + 20_000)).toBe(true);
  });

  it("moves high-water marks ahead of tickets", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    issue(c, "a", T);
    expect(c.hwmDirty).toBe(true);
    expect(c.hwm.ticketNo).toBeGreaterThan(c.ledger.next);
    expect(c.hwm.cursorMs).toBeGreaterThan(c.ticketCursor);
  });

  it("includes the configuration only when the edge has an older generation", () => {
    const c = new CoordinatorCore(cfg(), 3, T);
    expect(c.snapshot(T, 3).config).toBeUndefined();
    expect(c.snapshot(T, 2).config).toBeDefined();
    c.admin({ op: "patchConfig", patch: { admissionsPerMinute: 120 } }, T);
    expect(c.gen).toBe(4);
  });

  it("restores conservatively from persisted state and high-water marks", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    for (let i = 0; i < 5; i++) issue(c, `n${i}`, T);
    const p = structuredClone(c.toPersisted(T));
    const hwm = { ...c.hwm };
    for (let i = 5; i < 10; i++) issue(c, `n${i}`, T + 1000); // lost: not persisted
    const r = CoordinatorCore.restore(p, hwm, c.config, c.gen, T + 2000);
    expect(r.ledger.next).toBeGreaterThan(c.ledger.next - 1);
    expect(r.ticketCursor).toBeGreaterThanOrEqual(c.ticketCursor);
    expect(r.floor.until).toBe(T + 10 * 60_000);
  });

  it("projects the monthly cost from the last hour", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    for (let i = 0; i < 60; i++) c.recordRequest("flush", T + i * 1000);
    const p = c.costProjection(T + 60_000);
    expect(p.requests).toBe(60 * 24 * 30);
    expect(p.usd.do_requests).toBe(0);
  });

  it("projects the Worker requests the isolates report", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    // 40k requests an hour, as reported by two isolates: 28.8 M a month, 18.8 M beyond the 10 M included.
    c.applyBatch(batch({ seq: 1, counters: { ...zeroEdgeCounters(), workerRequests: 25_000, earlyExits: 5_000 } }), T);
    c.applyBatch(batch({ isolateId: "b", seq: 1, counters: { ...zeroEdgeCounters(), workerRequests: 15_000 } }), T + 1000);
    const p = c.costProjection(T + 60_000);
    expect(p.workerRequests).toBe(40_000 * 720);
    expect(p.usd.worker_requests).toBeCloseTo(18.8 * 0.3, 6);
    const m = c.metrics(T + 60_000);
    expect(m.counters.wr_worker_requests_total).toBe(40_000);
    expect(m.counters.wr_early_exits_total).toBe(5_000);
    expect(m.labelled).toContainEqual({ name: "wr_usage_projection", labels: { item: "worker_requests" }, value: 40_000 * 720, type: "gauge" });
    expect(c.dashboard(T + 60_000).history.early_exit!.at(-2)).toBe(5_000);
  });

  it("accepts batches from isolates older than the Worker request counters", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const { workerRequests: _w, earlyExits: _e, ...old } = zeroEdgeCounters();
    c.applyBatch(batch({ seq: 1, counters: { ...old, ipBypass: 1 } as never }), T);
    expect(c.costProjection(T).workerRequests).toBe(0);
    expect(c.metrics(T).counters.wr_worker_requests_total).toBe(0);
  });

  it("keeps per-minute history for the dashboards", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    c.recordRequest("reserve", T);
    issue(c, "n1", T);
    c.applyBatch(batch({ seq: 1, leaseUsed: 3, leaseUsage: [[Math.floor((T - 60_000) / 1000), 3]], counters: { ...zeroEdgeCounters(), waitingPages: 2, botBypass: 1, ipBypass: 1 } }), T);
    const d = c.dashboard(T);
    const last = (k: string) => d.history[k]!.at(-1);
    expect(d.history.req_reserve).toHaveLength(60);
    expect(last("req_reserve")).toBe(1);
    expect(last("reserved")).toBe(1);
    expect(last("waiting")).toBe(2);
    expect(last("bypass")).toBe(2);
    // Lease usage is placed at the minute it happened, not when it was reported.
    expect(d.history.adm_lease!.at(-2)).toBe(3);
    expect(d.isolates.top).toEqual([{ id: "a", seq: 1, lastSeenSec: 0, lease: 0 }]);
    expect(d.state.mode).toBe("on");
  });

  it("counts the isolates for the dashboards and lists the largest leases first", () => {
    const c = new CoordinatorCore(cfg({ leaseBlockMax: 3 }), 1, T);
    c.applyBatch(batch({ isolateId: "gone", seq: 1 }), T - 11 * 60_000);
    c.applyBatch(batch({ isolateId: "idle", seq: 1 }), T - 5 * 60_000);
    c.applyBatch(batch({ isolateId: "behind", seq: 3, knownGen: 0 }), T - 2000);
    for (let i = 0; i < 12; i++) c.applyBatch(batch({ isolateId: `e${i}`, seq: 1 }), T - 1000);
    c.receiveBatch(batch({ isolateId: "small", seq: 1, leaseWanted: 2 }), T - 3000);
    c.receiveBatch(batch({ isolateId: "big", seq: 1, leaseWanted: 50 }), T - 4000);
    const d = c.dashboard(T);
    expect(d.isolates).toMatchObject({ seen: 16, active: 15, leasing: 2, behind: 1 });
    expect(d.isolates.top).toHaveLength(10);
    expect(d.isolates.top.slice(0, 3)).toEqual([
      { id: "big", seq: 1, lastSeenSec: 4, lease: 3 },
      { id: "small", seq: 1, lastSeenSec: 3, lease: 2 },
      { id: "e0", seq: 1, lastSeenSec: 1, lease: 0 },
    ]);
    expect(d.isolates.top.map((i) => i.id)).not.toContain("idle");
  });
});

describe("CoordinatorCore delivery and durability", () => {
  it("applies a batch once when its answer is lost, and answers the resend with the same lease", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const sec = Math.floor(T / 1000);
    const b = batch({ seq: 1, leaseUsed: 3, leaseUsage: [[sec, 3]], leaseWanted: 2 });
    const lease = c.receiveBatch(b, T);
    expect(lease?.n).toBe(2);
    // The answer is lost: the isolate sends the very same batch again.
    expect(c.receiveBatch(structuredClone(b), T + 1000)).toBe(lease);
    expect(c.counters.leaseUsed).toBe(3);
    expect(c.counters.leaseGranted).toBe(2);
    expect(c.counters.batchDuplicates).toBe(1);
    // A resend that arrives after the next batch changes nothing and gets no lease.
    c.receiveBatch(batch({ seq: 2, leaseUnused: 2 }), T + 2000);
    expect(c.receiveBatch(structuredClone(b), T + 3000)).toBeUndefined();
    expect(c.counters.leaseUsed).toBe(3);
  });

  it("counts batch numbers skipped by a restart", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    c.applyBatch(batch({ seq: 1 }), T);
    const p = structuredClone(c.toPersisted(T));
    c.applyBatch(batch({ seq: 2 }), T + 1000); // applied after the persisted state: lost
    const r = CoordinatorCore.restore(p, null, c.config, c.gen, T + 2000);
    expect(r.applyBatch(batch({ seq: 1 }), T + 2000)).toBe(false);
    expect(r.applyBatch(batch({ seq: 3 }), T + 2000)).toBe(true);
    expect(r.counters.batchGaps).toBe(1);
  });

  it("gives a nonce the same ticket across a restart", () => {
    const nonces = new MemoryNonceStore();
    const c = new CoordinatorCore(cfg(), 1, T, nonces);
    const first = issue(c, "n", T);
    for (let i = 0; i < 5; i++) issue(c, `x${i}`, T);
    const r = CoordinatorCore.restore(null, { ...c.hwm }, c.config, c.gen, T + 1000, nonces);
    expect(issue(r, "n", T + 1000)).toEqual(first);
  });

  it("accepts a nonce only within provisionalWindowSec of its cookie", () => {
    const c = new CoordinatorCore(cfg({ provisionalWindowSec: 600 }), 1, T);
    const sec = Math.floor(T / 1000);
    expect(c.reserve("old", T, sec - 606).refused).toBe("expired");
    expect(c.reserve("future", T, sec + 60).refused).toBe("expired");
    const ok = issue(c, "n", T, sec - 590);
    // The same cookie, replayed once outside the window, never gets a ticket again.
    expect(c.reserve("n", T + 20_000, sec - 590).refused).toBe("expired");
    expect(issue(c, "n", T + 5000, sec - 590)).toEqual(ok);
  });

  it("keeps nonces for the longest provisional window, then forgets them", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    issue(c, "n", T);
    c.tick(T + 3_600_000);
    expect(c.nonces.size).toBe(1);
    c.tick(T + (NONCE_RETENTION_SEC + 60) * 1000);
    expect(c.nonces.size).toBe(0);
  });

  it("refuses new reservations when the queue is full, never a known nonce", () => {
    const c = new CoordinatorCore(cfg({ mode: "queue_all", maxWaitingTickets: 100 }), 1, T);
    for (let i = 0; i < 100; i++) issue(c, `n${i}`, T);
    expect(c.reserve("one-more", T).refused).toBe("full");
    expect(c.counters.reserveFull).toBe(1);
    expect(c.reserve("n7", T).refused).toBeUndefined();
  });
});

describe("CoordinatorCore restart (CF-13, CF-14)", () => {
  it("keeps the lease cap across a restart: persisted leases plus a reserve for the unknown ones", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const granted = c.receiveBatch(batch({ seq: 1, leaseWanted: 5 }), T);
    expect(granted?.n).toBe(5);
    const p = structuredClone(c.toPersisted(T));
    const r = CoordinatorCore.restore(p, { ...c.hwm }, c.config, c.gen, T + 1000);
    // R = 60/min, calm cap 30 s of R: 30 slots, all counted as outstanding.
    expect(r.outstanding).toBe(30);
    expect(r.leases.get("a")?.n).toBe(5);
    // Only urgent single slots until the longest possible lease has expired.
    expect(r.receiveBatch(batch({ isolateId: "b", seq: 1, leaseWanted: 10 }), T + 1000)).toBeUndefined();
    expect(r.receiveBatch(batch({ isolateId: "c", seq: 1, leaseWanted: 10, urgent: true }), T + 1000)?.n).toBe(1);
    r.tick(T + 1000 + 121_000);
    expect(r.receiveBatch(batch({ isolateId: "d", seq: 1, leaseWanted: 10 }), T + 122_000)?.n).toBeGreaterThan(1);
  });

  it("keeps published revocations across a restart", () => {
    const c = new CoordinatorCore(cfg(), 1, T);
    const { ticketNo } = issue(c, "n", T);
    c.applyBatch(batch({ isolateId: "a", tag: 11, seq: 1, redeemed: [ticketNo] }), T + 1);
    c.applyBatch(batch({ isolateId: "b", tag: 22, seq: 1, redeemed: [ticketNo] }), T + 2);
    expect(c.persistNow).toBe(true);
    const r = CoordinatorCore.restore(structuredClone(c.toPersisted(T + 3)), { ...c.hwm }, c.config, c.gen, T + 4);
    expect(r.snapshot(T + 4, null).revoked).toEqual([[ticketNo, 11]]);
  });
});
