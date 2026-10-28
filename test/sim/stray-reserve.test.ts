// SPDX-License-Identifier: Apache-2.0
//
// Calm room, one stray reservation: a visitor who got the waiting page while
// the room was open (an urgent lease refill that came back empty) reserves a
// ticket. Seen in production at ~25 % of R, right after a coordinator restart
// that counted the whole lease cap as outstanding: the ticket was placed
// behind 100 leased slots (25 s ahead), which closed the room, and every
// reservation that followed kept it closed for 40 minutes. The room must
// stay open: the stray ticket is placed after the slots really consumed.

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/shared/time.js";
import { Simulation, T0 } from "./harness.js";

const R = 200;

describe.each([false, true])("stray reservation in a calm room (restart before: %s)", (restart) => {
  const sim = new Simulation({
    seed: 28,
    durationMin: 20,
    isolates: 20,
    config: { admissionsPerMinute: R },
    arrivalsPerMin: () => R * 0.25,
    meanSessionMin: 10,
    thinkSec: 30,
    restartAtMin: restart ? 9 : undefined,
  });
  let stray: { ticketNo: number; admitAtMs: number } | undefined;
  let strayAt = 0;
  sim.at(10, () => {
    strayAt = sim.now;
    stray = sim.reserveFor(sim.newVisitor("human"));
  });
  const r = sim.run();
  const after = r.activeSamples.filter((s) => s.t > T0 + 10 * MINUTE_MS);

  it("gives the stray visitor a ticket due at once", () => {
    expect(stray!.admitAtMs - strayAt).toBeLessThanOrEqual(1000);
  });

  it("does not turn the stray ticket into a queue", () => {
    // Only the stray reservation itself.
    expect(r.reserves).toBe(1);
    expect(r.waitingPages).toBe(0);
    expect(after.every((s) => s.open)).toBe(true);
  });
});
