// SPDX-License-Identifier: Apache-2.0
//
// Abandons: 30 % of the queued visitors reserve a slot and never come back.
// Thanks to overbooking (R_eff = R / (1 - absence), capped), the observed
// admission rate stays within +/-10 % of R once the grace period has elapsed.

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/shared/time.js";
import { maxInWindow, rateBetween, Simulation, T0 } from "./harness.js";

describe("abandons: 30 % no-shows", () => {
  const R = 200;
  const r = new Simulation({
    seed: 11,
    durationMin: 50,
    isolates: 30,
    config: { admissionsPerMinute: R },
    arrivalsPerMin: () => R * 2,
    meanSessionMin: 10,
    thinkSec: 30,
    noShowRatio: 0.3,
  }).run();
  const grace = r.config.redeemGraceSec / 60;

  it("measures the absence ratio", () => {
    expect(r.core.absenceRatio).toBeGreaterThan(0.25);
    expect(r.core.absenceRatio).toBeLessThan(0.35);
  });

  it("overbooks within the cap", () => {
    expect(r.core.rEff).toBeGreaterThan(R * 1.3);
    expect(r.core.rEff).toBeLessThanOrEqual(R * r.config.overbookCap);
  });

  it("keeps the observed admission rate within 10 % of R after the grace period", () => {
    const from = Math.ceil(grace + r.config.absenceWindowSec / 60);
    for (let m = from; m + 5 <= 50; m += 5) {
      const rate = rateBetween(r.admissions, m, m + 5);
      expect(rate).toBeGreaterThanOrEqual(R * 0.9);
      expect(rate).toBeLessThanOrEqual(R * 1.1);
    }
    expect(maxInWindow(r.admissions, MINUTE_MS, T0 + from * MINUTE_MS)).toBeLessThanOrEqual(R * 1.15);
  });

  it("reports the outcome", () => {
    const rates = [];
    for (let m = 0; m < 50; m += 5) rates.push(Math.round(rateBetween(r.admissions, m, m + 5)));
    console.log(JSON.stringify({ absence: r.core.absenceRatio.toFixed(3), rEff: r.core.rEff.toFixed(1), ratesPer5min: rates }));
  });
});
