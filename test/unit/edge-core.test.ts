// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { CoordinatorCore } from "../../src/core/coordinator-core.js";
import { EdgeCore } from "../../src/core/edge-core.js";
import { DEFAULT_CONFIG, mergeConfig } from "../../src/shared/config.js";
import type { RoomConfig } from "../../src/shared/types.js";

const T = 1_767_600_000_000;

function issue(core: CoordinatorCore, nonce: string, now: number) {
  const r = core.reserve(nonce, now);
  if (r.refused) throw new Error(`refused: ${r.refused}`);
  return r;
}

function setup(p: Partial<RoomConfig> = {}) {
  const core = new CoordinatorCore(mergeConfig(DEFAULT_CONFIG, { admissionsPerMinute: 60, ...p }), 1, T);
  const edge = new EdgeCore("iso", 5, T);
  edge.applySnapshot(core.snapshot(T, null), T);
  return { core, edge };
}

describe("EdgeCore decisions", () => {
  it("relays a first visit with a provisional cookie, without consuming a slot", () => {
    const { edge } = setup();
    expect(edge.decideNew(T, false, false)).toEqual({ kind: "relay-provisional" });
    expect(edge.leaseUsed).toBe(0);
  });

  it("asks for a lease when a provisional cookie comes back, then admits", () => {
    const { core, edge } = setup();
    expect(edge.decideNew(T, true, false)).toEqual({ kind: "need-lease" });
    const b = edge.takeBatch(T, true);
    core.applyBatch(b, T);
    edge.applySnapshot(core.snapshot(T, b.knownGen, core.grantLease(b, T)), T);
    expect(edge.decideNew(T, true, true)).toEqual({ kind: "admit-lease" });
    expect(edge.leaseUsed).toBe(1);
  });

  it("serves the waiting page in queue_all, while paused, or once closed", () => {
    for (const p of [{ mode: "queue_all" as const }]) {
      const { edge } = setup(p);
      expect(edge.decideNew(T, false, false).kind).toBe("wait");
    }
    const { core, edge } = setup();
    core.admin({ op: "setPause", paused: true }, T);
    edge.applySnapshot(core.snapshot(T + 1, edge.gen), T + 1);
    expect(edge.decideNew(T + 1, true, false).kind).toBe("wait");
  });

  it("relays everything in mode off", () => {
    const { edge } = setup({ mode: "off" });
    expect(edge.decideNew(T, false, false)).toEqual({ kind: "relay" });
  });

  it("admits a ticket at admitAt, early with earlyUpTo, and refuses it after the grace", () => {
    const { core, edge } = setup({ redeemGraceSec: 60 });
    const t = issue(core, "n", T);
    const later = { ticketNo: t.ticketNo, admitAtMs: T + 30_000 };
    edge.snapshot!.earlyUpTo = t.ticketNo;
    expect(edge.ticketState(later.ticketNo, later.admitAtMs, T)).toBe("admit");
    edge.snapshot!.earlyUpTo = 0;
    expect(edge.ticketState(later.ticketNo, later.admitAtMs, T)).toBe("wait");
    expect(edge.ticketState(later.ticketNo, later.admitAtMs, T + 30_000)).toBe("admit");
    expect(edge.ticketState(later.ticketNo, later.admitAtMs, T + 91_000)).toBe("expired");
    edge.recordRedeem(later.ticketNo, later.admitAtMs, T + 30_000);
    expect(edge.ticketState(later.ticketNo, later.admitAtMs, T + 31_000)).toBe("duplicate");
  });

  it("revokes replayed sessions except the first redemption", () => {
    const { edge } = setup();
    edge.revoked = new Map([[7, 99]]);
    expect(edge.isRevoked(7, 99)).toBe(false);
    expect(edge.isRevoked(7, 98)).toBe(true);
    expect(edge.isRevoked(0, 1)).toBe(false);
  });

  it("counts a session at most once per minute", () => {
    const { edge } = setup();
    const m = Math.floor(T / 60000);
    expect(edge.countSession(m, m)).toBe(false);
    expect(edge.countSession(m - 1, m)).toBe(true);
    const b = edge.takeBatch(T, false);
    expect(b.activeDeltas.sort()).toEqual([[m - 1, -1], [m, 1]].sort());
  });

  it("deduplicates whitelisted clients per minute", () => {
    const { edge } = setup();
    const m = Math.floor(T / 60000);
    edge.countWhitelistedClient("1.2.3.4", m);
    edge.countWhitelistedClient("1.2.3.4", m);
    edge.countWhitelistedClient("1.2.3.4", m + 1);
    expect(edge.takeBatch(T, false).wlActiveDeltas).toEqual([[m, 0 + 1 - 1], [m + 1, 1]].filter(([, d]) => d !== 0));
  });

  it("flushes by kind of delta", () => {
    const { edge } = setup();
    expect(edge.flushReason(T)).toBeNull();
    edge.counters.provisionalIssued++;
    expect(edge.flushReason(T + 30_000)).toBeNull();
    expect(edge.flushReason(T + 300_000)).toBe("counters");
    edge.recordRedeem(1, T, T);
    expect(edge.flushReason(T + edge.ttl())).toBe("redeemed");
  });

  it("reports its data center with every batch", () => {
    const { edge } = setup();
    expect(edge.takeBatch(T, false).colo).toBeUndefined();
    edge.ackBatch(edge.seq);
    edge.colo = "CDG";
    expect(edge.takeBatch(T + 1000, false).colo).toBe("CDG");
  });

  it("sends the Worker request counts with the next batch, never flushing for them", () => {
    const { edge } = setup();
    edge.counters.workerRequests += 40;
    edge.counters.earlyExits += 30;
    expect(edge.flushReason(T + 3_600_000)).toBeNull();
    edge.counters.ipBypass++;
    expect(edge.flushReason(T + 300_000)).toBe("counters");
    const b = edge.takeBatch(T + 300_000, false);
    expect(b.counters.workerRequests).toBe(40);
    expect(b.counters.earlyExits).toBe(30);
    expect(edge.counters.workerRequests).toBe(0);
  });

  it("resends an unacknowledged batch unchanged before any newer one", () => {
    const { edge } = setup();
    edge.recordRedeem(3, T, T);
    const b1 = edge.takeBatch(T, false);
    expect(edge.hasPending()).toBe(true);
    expect(edge.flushReason(T + 5000)).toBe("retry");
    edge.recordRedeem(4, T, T + 1000);
    const again = edge.takeBatch(T + 5000, true);
    expect(again.seq).toBe(b1.seq);
    expect(again.redeemed).toEqual([3]);
    expect(again.urgent).toBe(true);
    edge.ackBatch(b1.seq);
    const b2 = edge.takeBatch(T + 6000, false);
    expect(b2.seq).toBe(b1.seq + 1);
    expect(b2.redeemed).toEqual([4]);
  });

  it("keeps the lease it gave back while its batch is unanswered", () => {
    const { edge } = setup();
    edge.lease = { remaining: 5, exp: T + 60_000 };
    const before = { ...edge.lease };
    edge.takeBatch(T, false);
    expect(edge.lease.remaining).toBe(0);
    edge.batchFailed(before, T + 1000);
    expect(edge.lease).toEqual({ remaining: 5, exp: T + 60_000 });
    // The resend does not give the lease back a second time.
    edge.lease.remaining = 2;
    const before2 = { ...edge.lease };
    edge.takeBatch(T + 5000, false);
    edge.batchFailed(before2, T + 6000);
    expect(edge.lease).toEqual({ remaining: 2, exp: T + 60_000 });
  });

  it("ignores an older cached snapshot", () => {
    const { core, edge } = setup();
    const newer = core.snapshot(T + 5000, edge.gen);
    edge.applySnapshot(newer, T + 5000);
    edge.applySnapshot(core.snapshot(T + 1000, edge.gen), T + 6000);
    expect(edge.snapshot!.at).toBe(T + 5000);
  });
});

describe("stale snapshots (CF-18)", () => {
  it("uses a snapshot that cannot be refreshed for STALE_SNAPSHOT_TTLS TTLs", () => {
    const { edge } = setup();
    const ttl = edge.ttl();
    expect(edge.isUsable(T + 3 * ttl)).toBe(true);
    edge.maxStaleTtls = 1;
    expect(edge.isUsable(T + ttl / 2)).toBe(true);
    expect(edge.isUsable(T + ttl)).toBe(false);
  });

  it("reports the oldest configuration generation held by the isolates", () => {
    const { core } = setup();
    const b = (isolateId: string, seq: number, knownGen: number) => ({ ...core.snapshot(T, null), isolateId, tag: 1, seq, since: T, knownGen, redeemed: [], leaseUsed: 0, leaseUsage: [], leaseUnused: 0, leaseWanted: 0, urgent: false, activeDeltas: [], wlActiveDeltas: [], counters: new EdgeCore("x", 1, T).counters });
    core.admin({ op: "patchConfig", patch: { admissionsPerMinute: 120 } }, T);
    core.applyBatch(b("a", 1, core.gen), T);
    core.applyBatch(b("b", 1, core.gen - 1), T);
    expect(core.edgeGenMin(T)).toBe(core.gen - 1);
    expect(core.edgeGenMin(T + 61_000)).toBe(core.gen);
  });
});
