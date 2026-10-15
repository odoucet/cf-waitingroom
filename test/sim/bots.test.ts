// SPDX-License-Identifier: Apache-2.0
//
// Bots: 300 requests per minute without cookies (nor JavaScript), on top of
// normal human traffic. They must consume zero admission slots, both in open
// mode and while the queue is active, and must not inflate the queue.

import { describe, expect, it } from "vitest";
import { Simulation } from "./harness.js";

const R = 200;

describe("bots: 300 cookie-less requests per minute", () => {
  it("consume no slot in open mode", () => {
    const r = new Simulation({
      seed: 7,
      durationMin: 30,
      isolates: 30,
      config: { admissionsPerMinute: R },
      arrivalsPerMin: () => R * 0.4,
      meanSessionMin: 10,
      thinkSec: 30,
      botsPerMin: 300,
    }).run();
    expect(r.botSlots).toBe(0);
    expect(r.reserves).toBe(0);
    expect(r.queuedHumans).toBe(0);
    // Every slot used went to a human: lease usage (reported or still pending
    // in an isolate) equals human admissions.
    const pending = r.isolates.reduce((n, i) => n + i.leaseUsed, 0);
    expect(r.core.counters.leaseUsed + pending).toBe(r.admittedHumans);
  });

  it("consume no slot and do not inflate the queue while queueing", () => {
    const r = new Simulation({
      seed: 8,
      durationMin: 30,
      isolates: 30,
      config: { admissionsPerMinute: R },
      arrivalsPerMin: () => R * 1.5,
      meanSessionMin: 10,
      thinkSec: 30,
      botsPerMin: 300,
    }).run();
    expect(r.botSlots).toBe(0);
    // Bots got waiting pages but never reserved: one reservation per queued human.
    expect(r.botWaitingPages).toBeGreaterThan(1000);
    expect(r.reserves).toBe(r.queuedHumans);
    expect(r.core.counters.reserved).toBe(r.queuedHumans);
    // The displayed wait follows the human queue only: tickets x slot, no ghost entries.
    const waiting = r.core.ledger.waitingCount();
    const humansWaiting = r.queuedHumans - r.core.counters.redeemed;
    expect(waiting).toBeLessThanOrEqual(humansWaiting + 1);
    console.log(JSON.stringify({ botPages: r.botWaitingPages, reserves: r.reserves, queuedHumans: r.queuedHumans, waitingTickets: waiting }));
  });
});
