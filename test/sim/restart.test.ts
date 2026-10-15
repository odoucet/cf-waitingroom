// SPDX-License-Identifier: Apache-2.0
//
// Coordinator restart in the middle of a queue: memory is lost, the state is
// reloaded from the last persisted snapshot (<= 10 s old) and from the
// high-water marks. The cursor never moves back, no ticket number is handed
// out twice, mode and pause are kept, and the admission rate stays at R.

import { describe, expect, it } from "vitest";
import { HWM_MARGIN_MS } from "../../src/core/coordinator-core.js";
import { MINUTE_MS } from "../../src/shared/time.js";
import { maxInWindow, rateBetween, Simulation, T0 } from "./harness.js";

describe("restart while queueing", () => {
  const R = 200;
  const r = new Simulation({
    seed: 9,
    durationMin: 30,
    isolates: 30,
    config: { admissionsPerMinute: R, brake: { enabled: true, activesThreshold: 1e6, activesLimit: 2e6, minFactor: 0.5 } },
    arrivalsPerMin: () => R * 1.5,
    meanSessionMin: 10,
    thinkSec: 30,
    restartAtMin: 15,
  }).run();

  it("never re-issues a ticket number nor a slot", () => {
    const x = r.restart!;
    expect(x.firstTicketAfter).toBeGreaterThan(x.lastTicketBefore);
    expect(x.cursorAfter).toBeGreaterThanOrEqual(x.cursorBefore);
    // At most the high-water margin of slots is skipped.
    expect(x.cursorAfter - x.cursorBefore).toBeLessThanOrEqual(HWM_MARGIN_MS);
    expect(r.core.counters.replays).toBe(0);
  });

  it("keeps the mode", () => {
    expect(r.restart!.modeKept).toBe(true);
    expect(r.restart!.pausedKept).toBe(true);
  });

  it("keeps the admission rate at R across the restart", () => {
    expect(maxInWindow(r.admissions, MINUTE_MS, T0 + 13 * MINUTE_MS, T0 + 18 * MINUTE_MS)).toBeLessThanOrEqual(R * 1.05);
    expect(rateBetween(r.admissions, 14, 17)).toBeGreaterThan(R * 0.9);
  });

  it("does not let the active-user estimate drop below the persisted value for a session window", () => {
    expect(r.core.floor.value).toBeGreaterThan(0);
    const after = r.activeSamples.filter((s) => s.t > T0 + 15 * MINUTE_MS && s.t < r.core.floor.until);
    expect(after.every((s) => s.estimate >= r.core.floor.value)).toBe(true);
  });
});

describe("restart while paused", () => {
  const r = new Simulation({
    seed: 10,
    durationMin: 20,
    isolates: 10,
    config: { admissionsPerMinute: 100 },
    arrivalsPerMin: () => 150,
    meanSessionMin: 10,
    thinkSec: 30,
    pause: { fromMin: 8, toMin: 14 },
    restartAtMin: 10,
  }).run();

  it("keeps the pause and admits nobody while paused", () => {
    expect(r.restart!.pausedKept).toBe(true);
    // An isolate learns of the pause with its next snapshot: within two TTLs (10 s each here).
    const during = r.admissions.filter((t) => t > T0 + 8 * MINUTE_MS + 20_000 && t < T0 + 14 * MINUTE_MS);
    expect(during.length).toBe(0);
  });

  it("does not release a burst when the pause ends", () => {
    expect(maxInWindow(r.admissions, MINUTE_MS, T0 + 14 * MINUTE_MS)).toBeLessThanOrEqual(100 * 1.15);
  });
});
