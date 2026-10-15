// SPDX-License-Identifier: Apache-2.0
//
// Active-user estimate without double counting. A session is counted at most
// once per minute: the edge adds +1 to the current minute and -1 to the minute
// it was previously counted in (known from its cookie). Each live session thus
// appears in exactly one minute, and the active users are the sum of the
// minutes inside the session window.

export class MinuteCounter {
  readonly counts = new Map<number, number>();

  constructor(entries: [number, number][] = []) {
    for (const [m, c] of entries) this.counts.set(m, c);
  }

  apply(deltas: readonly (readonly [number, number])[], nowMin: number, windowMin: number): void {
    for (const [m, d] of deltas) {
      // Ignore minutes that are already outside the window, or in the future.
      if (m <= nowMin - windowMin || m > nowMin + 1) continue;
      this.counts.set(m, (this.counts.get(m) ?? 0) + d);
    }
  }

  estimate(nowMin: number, windowMin: number): number {
    let sum = 0;
    for (const [m, c] of this.counts) if (m > nowMin - windowMin && m <= nowMin + 1) sum += c;
    return Math.max(0, sum);
  }

  prune(nowMin: number, windowMin: number): void {
    for (const m of this.counts.keys()) if (m <= nowMin - windowMin) this.counts.delete(m);
  }

  entries(): [number, number][] {
    return [...this.counts.entries()];
  }
}
