// SPDX-License-Identifier: Apache-2.0
//
// Replay: one ticket is copied and presented 100 times across 20 isolates at
// the same instant. The coordinator counts a single admission; the copies are
// revoked, and after one TTL only the first session is still accepted.

import { describe, expect, it } from "vitest";
import { Simulation, type Visitor } from "./harness.js";

describe("replay: one ticket presented 100 times on 20 isolates", () => {
  const sim = new Simulation({
    seed: 3,
    durationMin: 3,
    isolates: 20,
    config: { mode: "queue_all", admissionsPerMinute: 60 },
    arrivalsPerMin: () => 0,
    meanSessionMin: 10,
    thinkSec: 30,
  });
  const copies: Visitor[] = [];
  let admittedFirstRound = 0;
  const ttl = sim.config.snapshotTtlSec * 1000;

  sim.at(0.2, () => {
    const original = sim.newVisitor("replica");
    const ticket = sim.reserveFor(original);
    copies.push(original);
    for (let i = 1; i < 100; i++) {
      const c = sim.newVisitor("replica");
      c.t = { ...ticket };
      copies.push(c);
    }
    sim.q.push(ticket.admitAtMs + 500, () => {
      for (const c of copies) sim.send(c);
      admittedFirstRound = copies.filter((c) => c.s).length;
    });
    // Second round after one TTL: isolates flush the redemptions; third round
    // after the snapshots carrying the revocations have propagated.
    sim.q.push(ticket.admitAtMs + 500 + ttl + 100, () => copies.filter((c) => c.s).forEach((c) => sim.send(c)));
    sim.q.push(ticket.admitAtMs + 500 + 3 * ttl, () => copies.filter((c) => c.s).forEach((c) => sim.send(c)));
  });
  const r = sim.run();

  it("admits at most one copy per isolate in the first instant", () => {
    expect(admittedFirstRound).toBeGreaterThan(1);
    expect(admittedFirstRound).toBeLessThanOrEqual(20);
  });

  it("counts a single admission and flags the replays", () => {
    expect(r.core.counters.redeemed).toBe(1);
    expect(r.core.counters.replays).toBeGreaterThan(0);
  });

  it("keeps exactly one session alive after one TTL", () => {
    const alive = copies.filter((c) => c.s && !c.gone);
    expect(alive.length).toBe(1);
  });
});
