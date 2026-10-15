// SPDX-License-Identifier: Apache-2.0
//
// Structured decision logs, as JSON objects (indexed by Workers Logs).
// Nominal decisions are sampled (LOG_SAMPLE_RATE); refusals, errors and
// administrative actions are always logged.

import type { EdgeEnv } from "./env.js";

let rate: number | null = null;
let rateSrc: string | undefined;

function sampleRate(env: EdgeEnv): number {
  if (rate === null || rateSrc !== env.LOG_SAMPLE_RATE) {
    const r = Number(env.LOG_SAMPLE_RATE ?? "0.01");
    rate = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.01;
    rateSrc = env.LOG_SAMPLE_RATE;
  }
  return rate;
}

export type LogLevel = "info" | "warn" | "error";

/** Logs a decision. `always` bypasses sampling (refusals, errors, admin). */
export function logEvent(env: EdgeEnv, level: LogLevel, event: string, fields: Record<string, unknown>, always: boolean): void {
  if (!always && Math.random() >= sampleRate(env)) return;
  const line = { event, level, room: env.ROOM_ID, ...fields };
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
