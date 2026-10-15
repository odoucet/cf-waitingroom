// SPDX-License-Identifier: Apache-2.0
//
// Global pause. While paused nothing is admitted; when the pause ends every
// ticket issued so far is shifted by the pause duration, so that resuming
// does not release a burst of tickets whose admitAt passed during the pause.

/** Offset (ms) to add to the signed admitAt of ticket `t`. */
export function pauseOffsetFor(offsets: readonly (readonly [number, number])[], t: number): number {
  let off = 0;
  for (const [upTo, d] of offsets) if (t <= upTo) off += d;
  return off;
}

export class PauseState {
  since: number | null = null;
  /** [ticketNoUpTo, offsetMs] */
  offsets: [number, number][] = [];

  get paused(): boolean {
    return this.since !== null;
  }

  pause(now: number): void {
    if (this.since === null) this.since = now;
  }

  /** Ends the pause. Returns its duration (ms), 0 if not paused. */
  resume(now: number, lastTicketNo: number): number {
    if (this.since === null) return 0;
    const d = Math.max(0, now - this.since);
    this.since = null;
    if (d > 0 && lastTicketNo > 0) this.offsets.push([lastTicketNo, d]);
    return d;
  }

  offsetFor(t: number): number {
    return pauseOffsetFor(this.offsets, t);
  }

  /** Drops offsets that only apply to tickets older than `oldestLive`. */
  prune(oldestLive: number): void {
    if (this.offsets.length > 0) this.offsets = this.offsets.filter(([upTo]) => upTo >= oldestLive);
  }
}
