// SPDX-License-Identifier: Apache-2.0
//
// Low traffic: between 30 % and 70 % of the admission rate, spread over many
// isolates (each holding a small lease). Nobody waits: no waiting page, no
// reservation. Leased slots that stay unused are given back without ever
// pushing the cursor ahead of the clock.

import { describe, expect, it } from "vitest";
import { Simulation } from "./harness.js";

const R = 200;

describe.each([0.3, 0.5, 0.7])("low traffic at %s of R", (load) => {
  const sim = new Simulation({
    seed: Math.round(load * 100),
    durationMin: 30,
    isolates: 50,
    config: { admissionsPerMinute: R },
    arrivalsPerMin: () => R * load,
    meanSessionMin: 10,
    thinkSec: 30,
    botsPerMin: 300,
  });
  const r = sim.run();

  it("never queues anyone", () => {
    expect(r.waitingPages).toBe(0);
    expect(r.reserves).toBe(0);
    expect(r.queuedHumans).toBe(0);
    expect(r.activeSamples.every((s) => s.open)).toBe(true);
    expect(r.maxCursorLagMs).toBeLessThanOrEqual(0);
  });

  it("reports the coordinator load", () => {
    const perMin = (r.coordinatorRequests.flush! + r.coordinatorRequests.snapshot! + r.coordinatorRequests.reserve!) / 30;
    console.log(JSON.stringify({ load, isolates: 50, doRequestsPerMinute: Math.round(perMin), projectedPerMonth: Math.round(perMin * 60 * 24 * 30) }));
  });
});
