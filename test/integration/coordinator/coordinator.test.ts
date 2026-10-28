// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Coordinator } from "../../../src/coordinator/index.js";
import { zeroEdgeCounters } from "../../../src/shared/counters.js";
import type { AdminResult, Batch, Snapshot } from "../../../src/shared/types.js";

const ns = (env as unknown as { COORDINATOR: DurableObjectNamespace<Coordinator> }).COORDINATOR;
const stubFor = (name: string) => ns.get(ns.idFromName(name), { locationHint: "weur" });

function batch(seq: number, p: Partial<Batch> = {}): Batch {
  return {
    isolateId: "iso-1",
    tag: 7,
    seq,
    since: Date.now(),
    knownGen: -1,
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

describe("coordinator durable object", () => {
  it("bootstraps the configuration from WR_BOOTSTRAP_CONFIG", async () => {
    const s = (await stubFor("boot").getSnapshot()) as unknown as Snapshot;
    expect(s.config?.admissionsPerMinute).toBe(60);
    expect(s.mode).toBe("on");
    expect(s.open).toBe(true);
  });

  it("returns a snapshot and a lease on flush", async () => {
    const s = (await stubFor("flush").flush(batch(1, { leaseWanted: 3 }))) as unknown as Snapshot;
    expect(s.lease?.n).toBe(3);
    expect(s.config).toBeDefined();
  });

  it("hands out tickets and keeps them across a restart, with mode and pause", async () => {
    const stub = stubFor("restart");
    const a = await stub.reserve("nonce-a", null);
    await stub.reserve("nonce-b", null);
    await stub.admin({ op: "setMode", mode: "queue_all" });
    await stub.admin({ op: "setPause", paused: true });
    await evictDurableObject(stub);
    const stub2 = stubFor("restart");
    const c = await stub2.reserve("nonce-c", null);
    expect(c.ticketNo).toBeGreaterThan(a.ticketNo + 1);
    const state = (await stub2.admin({ op: "state" })) as unknown as AdminResult;
    expect(state.ok).toBe(true);
    const d = (state as { ok: true; data: Record<string, unknown> }).data;
    expect(d.mode).toBe("queue_all");
    expect(d.paused).toBe(true);
  });

  it("persists in SQLite", async () => {
    const stub = stubFor("sql");
    await stub.reserve("n", null);
    const keys = await runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ k: string }>("SELECT k FROM kv ORDER BY k").toArray().map((r) => r.k));
    expect(keys).toEqual(["config", "hwm", "isolates", "state"]);
  });

  it("applies a flush once when its answer is lost (same seq sent again)", async () => {
    const stub = stubFor("lost-answer");
    const sec = Math.floor(Date.now() / 1000);
    const b = batch(1, { leaseUsed: 3, leaseUsage: [[sec, 3]], leaseWanted: 2 });
    const first = (await stub.flush(b)) as unknown as Snapshot;
    const again = (await stub.flush(b)) as unknown as Snapshot;
    expect(again.lease).toEqual(first.lease);
    const m = (await stub.admin({ op: "metrics" })) as unknown as AdminResult & { data: { labelled: { name: string; labels: Record<string, string>; value: number }[]; counters: Record<string, number> } };
    const used = m.data.labelled.find((x) => x.name === "wr_lease_slots_total" && x.labels.state === "used")!.value;
    expect(used).toBe(3);
    expect(m.data.counters.wr_batch_duplicates_total).toBe(1);
  });

  it("keeps nonces and batch numbers across a restart", async () => {
    const stub = stubFor("durable");
    const t = await stub.reserve("same-nonce", null, { issuedSec: Math.floor(Date.now() / 1000) });
    await stub.flush(batch(1));
    // Batch numbers are persisted with the state, by the alarm that follows a change.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    const stub2 = stubFor("durable");
    for (let i = 0; i < 3; i++) await stub2.reserve(`other-${i}`, null);
    const again = await stub2.reserve("same-nonce", null, { issuedSec: Math.floor(Date.now() / 1000) });
    expect(again.ticketNo).toBe(t.ticketNo);
    expect(again.admitAtMs).toBe(t.admitAtMs);
    await stub2.flush(batch(1));
    const m = (await stub2.admin({ op: "metrics" })) as unknown as { data: { counters: Record<string, number> } };
    expect(m.data.counters.wr_batch_duplicates_total).toBe(1);
  });

  it("writes every change before it can hibernate: counters and history survive an eviction", async () => {
    const stub = stubFor("hibernation");
    await stub.reserve("h1", null, { issuedSec: Math.floor(Date.now() / 1000) });
    await stub.reserve("h2", null, { issuedSec: Math.floor(Date.now() / 1000) });
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(5_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    const d = (await stubFor("hibernation").admin({ op: "dashboard" })) as unknown as { data: { metrics: { counters: Record<string, number> }; history: Record<string, number[]> } };
    expect(d.data.metrics.counters.wr_tickets_reserved_total).toBe(2);
    const sum = (k: string) => d.data.history[k]!.reduce((a, b) => a + b, 0);
    expect(sum("reserved")).toBe(2);
    expect(sum("req_reserve")).toBe(2);
    expect(sum("req_alarm")).toBe(1);
  });

  it("refuses an expired provisional cookie and a full queue", async () => {
    const stub = stubFor("refusals");
    const old = await stub.reserve("old", null, { issuedSec: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.refused).toBe("expired");
    await stub.admin({ op: "patchConfig", patch: { mode: "queue_all", maxWaitingTickets: 100 } });
    // The first tickets fall due at once (burst): fill until refused.
    const results = [];
    for (let i = 0; i < 120; i++) results.push((await stub.reserve(`n${i}`, null, {})).refused);
    expect(results.slice(0, 100).every((r) => r === undefined)).toBe(true);
    expect(results.at(-1)).toBe("full");
    const s = (await stub.admin({ op: "state" })) as unknown as { data: { waitingTickets: number } };
    expect(s.data.waitingTickets).toBe(100);
  });

  it("refuses new reservations in mode off and accepts them again in mode on", async () => {
    const stub = stubFor("mode-off");
    await stub.reserve("before", null, {});
    const next = async () => ((await stub.admin({ op: "state" })) as unknown as { data: { nextTicketNo: number } }).data.nextTicketNo;
    const n0 = await next();
    await stub.admin({ op: "setMode", mode: "off" });
    expect((await stub.reserve("during", null, {})).refused).toBe("off");
    expect(await next()).toBe(n0);
    await stub.admin({ op: "setMode", mode: "on" });
    const r = await stub.reserve("after", null, {});
    expect(r.refused).toBeUndefined();
    expect(r.ticketNo).toBe(n0);
  });

  it("keeps revocations and leases across a restart", async () => {
    const stub = stubFor("restart-leases");
    const { ticketNo } = await stub.reserve("r", null, {});
    await stub.flush(batch(1, { redeemed: [ticketNo], leaseWanted: 5 })); // iso-1, tag 7
    await stub.flush(batch(1, { isolateId: "iso-2", tag: 8, redeemed: [ticketNo] })); // replay: revoked at once
    await evictDurableObject(stub);
    const s = (await stubFor("restart-leases").getSnapshot()) as unknown as Snapshot;
    expect(s.revoked).toEqual([[ticketNo, 7]]);
    const m = (await stubFor("restart-leases").admin({ op: "metrics" })) as unknown as { data: { gauges: Record<string, number> } };
    // The persisted lease plus the restart reserve: the cap is fully counted as outstanding.
    expect(m.data.gauges.wr_lease_outstanding_slots).toBeGreaterThanOrEqual(5);
  });

  it("stores a long queue in chunk rows far below the 2 MB row limit", async () => {
    const stub = stubFor("long-queue");
    await stub.admin({ op: "patchConfig", patch: { mode: "queue_all", maxWaitingTickets: 1_000_000, admissionsPerMinute: 1 } });
    // 20,000 tickets, written straight into the core (20,000 RPCs would be slow), then persisted.
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as { core: { reserve(n: string, t: number): unknown }; persist(now: number, force: boolean): void };
      const now = Date.now();
      for (let i = 0; i < 20_000; i++) o.core.reserve(`q${i}`, now);
      o.persist(now, true);
    });
    const rows = await runInDurableObject(stub, (_i, state) => ({
      kv: state.storage.sql.exec<{ k: string; n: number }>("SELECT k, length(v) AS n FROM kv").toArray(),
      ledger: state.storage.sql.exec<{ c: number; n: number }>("SELECT chunk AS c, length(v) AS n FROM ledger").toArray(),
    }));
    expect(rows.ledger.length).toBeGreaterThanOrEqual(5);
    for (const r of [...rows.kv, ...rows.ledger]) expect(r.n).toBeLessThan(200_000);
    const m = (await stub.admin({ op: "metrics" })) as unknown as { data: { gauges: Record<string, number> } };
    expect(m.data.gauges.wr_coordinator_storage_row_bytes).toBeGreaterThan(0);
    expect(m.data.gauges.wr_coordinator_storage_row_bytes).toBeLessThan(200_000);
    // The ledger comes back from its chunks after a restart.
    await evictDurableObject(stub);
    const s = (await stubFor("long-queue").admin({ op: "state" })) as unknown as { data: { waitingTickets: number } };
    expect(s.data.waitingTickets).toBeGreaterThanOrEqual(20_000);
  });

  it("drops failMode from a configuration stored by an older version", async () => {
    const stub = stubFor("legacy-fail-mode");
    await stub.getSnapshot();
    await runInDurableObject(stub, (_i, state) => {
      const row = state.storage.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = 'config'").one();
      const stored = JSON.parse(row.v) as { config: Record<string, unknown> };
      stored.config.failMode = "closed";
      state.storage.sql.exec("UPDATE kv SET v = ? WHERE k = 'config'", JSON.stringify(stored));
    });
    await evictDurableObject(stub);
    const s = (await stubFor("legacy-fail-mode").getSnapshot()) as unknown as Snapshot;
    expect(s.config?.admissionsPerMinute).toBe(60);
    expect(s.config).not.toHaveProperty("failMode");
  });

  it("validates admin input", async () => {
    const r = (await stubFor("admin").admin({ op: "patchConfig", patch: { admissionsPerMinute: -1 } })) as unknown as AdminResult;
    expect(r.ok).toBe(false);
  });

  it("deduplicates replayed tickets across isolates", async () => {
    const stub = stubFor("replay");
    const { ticketNo } = await stub.reserve("n", null);
    await stub.flush(batch(1, { redeemed: [ticketNo] }));
    const s = (await stub.flush(batch(1, { isolateId: "iso-2", tag: 8, redeemed: [ticketNo] }))) as unknown as Snapshot;
    expect(s.revoked).toEqual([[ticketNo, 7]]);
  });

  it("exposes metrics", async () => {
    const r = (await stubFor("metrics").admin({ op: "metrics" })) as unknown as AdminResult;
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; data: { gauges: Record<string, number> } }).data;
    expect(m.gauges.wr_admission_rate_target).toBe(60);
  });

  it("renders the Prometheus text for the edge", async () => {
    const text = await stubFor("metrics-text").prometheus("main");
    expect(text).toContain('wr_admission_rate_target{room="main"} 60');
    expect(text).toContain("# TYPE wr_tickets_reserved_total counter");
    expect(text).toContain("# TYPE wr_reserve_wait_seconds histogram");
    expect(text).toContain('wr_reserve_wait_seconds_bucket{room="main",le="+Inf"} 0');
    expect(text).toContain('wr_reserve_wait_seconds_count{room="main"} 0');
    // The room label is escaped: no injected sample line.
    expect(await stubFor("metrics-text").prometheus('x"} 1\nevil')).toContain('room="x\\"} 1\\nevil"');
  });
});

