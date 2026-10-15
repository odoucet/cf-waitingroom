// SPDX-License-Identifier: Apache-2.0
//
// Sliding-window no-show ratio: share of tickets whose redemption deadline
// passed without being exchanged for a session. Aggregated per 10-second
// bucket, so that its size does not grow with the admission rate.

const BUCKET_MS = 10_000;

export class AbsenceWindow {
  /** [bucket start (ms), tickets, absent], ordered by bucket. */
  events: [number, number, number][] = [];
  private total = 0;
  private absent = 0;

  /** Also accepts the older layout: one [deadline, absent] entry per ticket. */
  constructor(events: ([number, number, number] | [number, number])[] = []) {
    for (const e of events) {
      if (e.length === 2) this.add(e[0], 1, e[1]);
      else this.add(e[0], e[1], e[2]);
    }
  }

  private add(t: number, n: number, absent: number): void {
    const b = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    const last = this.events[this.events.length - 1];
    if (last && last[0] === b) {
      last[1] += n;
      last[2] += absent;
    } else this.events.push([b, n, absent]);
    this.total += n;
    this.absent += absent;
  }

  record(t: number, absent: boolean): void {
    this.add(t, 1, absent ? 1 : 0);
  }

  /** Absence ratio over the window, or 0 when fewer than `minSample` tickets were evaluated. */
  ratio(now: number, windowMs: number, minSample: number): number {
    let drop = 0;
    while (drop < this.events.length && this.events[drop]![0] < now - windowMs) {
      this.total -= this.events[drop]![1];
      this.absent -= this.events[drop]![2];
      drop++;
    }
    if (drop > 0) this.events.splice(0, drop);
    if (this.total < minSample) return 0;
    return this.absent / this.total;
  }

  /** Tickets in the window. */
  get size(): number {
    return this.total;
  }
}
