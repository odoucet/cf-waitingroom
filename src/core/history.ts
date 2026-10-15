// SPDX-License-Identifier: Apache-2.0
//
// Per-minute counters over the last hour, persisted with the coordinator state.
// They feed the cost projection and the dashboards.

import { minuteOf } from "../shared/time.js";

export const HISTORY_MINUTES = 60;

export class MinuteHistory {
  private minutes: Map<number, Record<string, number>>;

  constructor(entries: [number, Record<string, number>][] = []) {
    this.minutes = new Map(entries.map(([m, row]) => [m, { ...row }]));
  }

  /** [minute, counters] pairs, for persistence. */
  entries(): [number, Record<string, number>][] {
    return [...this.minutes];
  }

  add(now: number, key: string, n = 1): void {
    if (n === 0) return;
    const m = minuteOf(now);
    let row = this.minutes.get(m);
    if (!row) {
      row = {};
      this.minutes.set(m, row);
      if (this.minutes.size > HISTORY_MINUTES + 5) {
        for (const k of this.minutes.keys()) if (k <= m - HISTORY_MINUTES) this.minutes.delete(k);
      }
    }
    row[key] = (row[key] ?? 0) + n;
  }

  /** Sum of `keys` over the last hour, current minute included. */
  sum(now: number, keys: readonly string[]): number {
    const m = minuteOf(now);
    let total = 0;
    for (const [k, row] of this.minutes) {
      if (k <= m - HISTORY_MINUTES) continue;
      for (const key of keys) total += row[key] ?? 0;
    }
    return total;
  }

  /** One value per minute for each key, oldest first, the last one being the current (partial) minute. */
  series(now: number, keys: readonly string[]): Record<string, number[]> {
    const m = minuteOf(now);
    const out: Record<string, number[]> = {};
    for (const key of keys) {
      const values: number[] = [];
      for (let k = m - HISTORY_MINUTES + 1; k <= m; k++) values.push(this.minutes.get(k)?.[key] ?? 0);
      out[key] = values;
    }
    return out;
  }
}
