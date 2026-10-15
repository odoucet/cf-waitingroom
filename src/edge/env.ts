// SPDX-License-Identifier: Apache-2.0

import type { Coordinator } from "../coordinator/index.js";
import { ROOM_ID_RE } from "../shared/config.js";
import type { FailMode } from "../shared/types.js";

/** Bindings, variables and secrets of the Worker (see wrangler/waitingroom.example.jsonc). */
export interface EdgeEnv {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  ROOM_ID: string;
  /** Read by the coordinator only (CoordinatorEnv). */
  WR_BOOTSTRAP_CONFIG?: string;
  FAIL_MODE?: string;
  STALE_SNAPSHOT_TTLS?: string;
  EARLY_EXIT_EXTENSIONS?: string;
  EARLY_EXIT_PREFIXES?: string;
  BOT_HEADER?: string;
  BYPASS_HEADER?: string;
  LOG_SAMPLE_RATE?: string;
  COORDINATOR_TIMEOUT_MS?: string;
  LOCATION_HINT?: string;
  ADMIN_HOSTS?: string;
  // Secrets
  WR_KEYS?: string;
  WR_KEY_CURRENT?: string;
  WR_ADMIN_TOKEN?: string;
  WR_METRICS_USER?: string;
  WR_METRICS_PASSWORD?: string;
  WR_DASHBOARD_USER?: string;
  WR_DASHBOARD_PASSWORD?: string;
  WR_BYPASS_SECRET?: string;
  WR_BOT_SECRET?: string;
  WR_TURNSTILE_SECRET?: string;
}

/**
 * Behaviour when the coordinator cannot be reached. A Worker variable, not part
 * of the room configuration: it must be known before the first snapshot. Null
 * when unset or invalid; the caller then fails closed.
 */
export function failModeOf(env: EdgeEnv): FailMode | null {
  return env.FAIL_MODE === "open" || env.FAIL_MODE === "closed" ? env.FAIL_MODE : null;
}

/**
 * Synchronous part of the base configuration (the keys are checked by
 * getKeyRing): the reason it is unusable, or null. Without it, protected paths
 * answer 503 instead of reaching the origin unprotected.
 */
export function baseConfigError(env: EdgeEnv): string | null {
  if (!ROOM_ID_RE.test(env.ROOM_ID ?? "")) return "invalid ROOM_ID";
  if (typeof env.COORDINATOR?.idFromName !== "function") return "COORDINATOR binding is missing";
  return null;
}

/** STALE_SNAPSHOT_TTLS: 1 (strict) to 6 (default) TTLs of use for a snapshot that cannot be refreshed. */
export function staleTtlsOf(env: EdgeEnv): number {
  const n = Number(env.STALE_SNAPSHOT_TTLS ?? "6");
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 6;
}
