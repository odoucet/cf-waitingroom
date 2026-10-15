// SPDX-License-Identifier: Apache-2.0
//
// Peak: demand climbs from ~1,800 to ~5,000 active users in 10 minutes
// (anonymised from an e-commerce site with ~2k active users). The admission
// rate must not exceed R_eff, so the active users stay at R x mean session.

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/shared/time.js";
import { maxInWindow, percentile, rateBetween, Simulation, T0 } from "./harness.js";

describe("peak: demand 1,800 -> 5,000 actives in 10 minutes", () => {
  const R = 220;
  const meanSessionMin = 10;
  const sim = new Simulation({
    seed: 42,
    durationMin: 40,
    isolates: 40,
    config: { admissionsPerMinute: R, sessionMinutes: 10 },
    // Arrivals x mean session = demand in active users: 180/min ~ 1,800, 500/min ~ 5,000.
    arrivalsPerMin: (m) => (m < 5 ? 180 : m < 15 ? 180 + (m - 5) * 32 : 500),
    meanSessionMin,
    thinkSec: 30,
  });
  const r = sim.run();
  const c = r.config;

  it("keeps the sustained admission rate at R_eff", () => {
    const sustained = rateBetween(r.admissions, 20, 40);
    expect(sustained).toBeLessThanOrEqual(R * 1.02);
    expect(sustained).toBeGreaterThan(R * 0.95);
  });

  it("bounds any 60-second window by R + burst + outstanding leases", () => {
    const bound = R + Math.ceil((R * (c.burstSec + c.calmLeaseMaxOutstandingSec)) / 60);
    const worst = maxInWindow(r.admissions, MINUTE_MS);
    expect(worst).toBeLessThanOrEqual(bound);
    // In practice the ramp is absorbed within a few percent.
    expect(worst).toBeLessThanOrEqual(R * 1.1);
  });

  it("keeps the real active users within a few percent of R x mean session", () => {
    const target = R * meanSessionMin;
    const peak = Math.max(...r.activeSamples.map((s) => s.actives));
    expect(peak).toBeLessThanOrEqual(target * 1.05);
  });

  it("only queues once demand exceeds R, and never hands out a slot twice", () => {
    const firstQueued = r.activeSamples.find((s) => !s.open);
    expect(firstQueued).toBeDefined();
    // Arrivals reach R (220/min) after ~6.3 minutes.
    expect(firstQueued!.t - T0).toBeGreaterThan(5 * MINUTE_MS);
    expect(r.reserves).toBe(r.queuedHumans);
    expect(r.core.counters.replays).toBe(0);
  });

  it("reports the outcome", () => {
    console.log(
      JSON.stringify({
        humans: r.humans,
        queued: r.queuedHumans,
        sustainedRate: rateBetween(r.admissions, 20, 40),
        worst60s: maxInWindow(r.admissions, MINUTE_MS),
        peakActives: Math.max(...r.activeSamples.map((s) => s.actives)),
        waitP50s: Math.round(percentile(r.waits, 0.5) / 1000),
        coordinatorRequests: r.coordinatorRequests,
      }),
    );
  });
});
