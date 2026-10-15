// SPDX-License-Identifier: Apache-2.0
//
// Lease bound: a flash crowd hits while the room is calm (long leases spread
// over 40 isolates). Admissions beyond R are bounded by the outstanding leases
// and the bucket depth: at most (calmLeaseMaxOutstandingSec + burstSec) of R,
// once, and never more than leaseBlockMax x isolates.

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/shared/time.js";
import { maxInWindow, rateBetween, Simulation, T0 } from "./harness.js";

describe("lease bound: flash crowd from calm", () => {
  const R = 200;
  const isolates = 40;
  const r = new Simulation({
    seed: 5,
    durationMin: 30,
    isolates,
    config: { admissionsPerMinute: R },
    arrivalsPerMin: (m) => (m < 10 ? R * 0.3 : R * 4),
    meanSessionMin: 10,
    thinkSec: 15,
  }).run();
  const c = r.config;

  it("bounds the overshoot by the outstanding leases and the burst", () => {
    const bound = R + Math.ceil((R * (c.calmLeaseMaxOutstandingSec + c.burstSec)) / 60);
    const worst = maxInWindow(r.admissions, MINUTE_MS);
    expect(worst).toBeLessThanOrEqual(bound);
    expect(worst - R).toBeLessThanOrEqual(c.leaseBlockMax * isolates);
    console.log(JSON.stringify({ worst60s: worst, bound, R }));
  });

  it("returns to R within two minutes", () => {
    expect(rateBetween(r.admissions, 13, 30)).toBeLessThanOrEqual(R * 1.02);
    expect(maxInWindow(r.admissions, MINUTE_MS, T0 + 12 * MINUTE_MS)).toBeLessThanOrEqual(R * 1.05);
  });
});
