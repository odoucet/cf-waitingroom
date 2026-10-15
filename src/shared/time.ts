// SPDX-License-Identifier: Apache-2.0

export const MINUTE_MS = 60_000;

/** Epoch minute of a timestamp in milliseconds. */
export function minuteOf(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}
