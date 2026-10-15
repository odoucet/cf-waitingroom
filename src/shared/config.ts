// SPDX-License-Identifier: Apache-2.0

import { parseCidr } from "./cidr.js";
import type { RoomConfig, WhitelistEntry } from "./types.js";

/** Room identifier: Durable Object name, MAC input and cookie suffix. */
export const ROOM_ID_RE = /^[a-z0-9-]{1,32}$/;

/**
 * Defaults are deliberately generic. Real values belong to the private
 * deployment configuration (bootstrap variable or admin API).
 */
export const DEFAULT_CONFIG: RoomConfig = {
  mode: "on",
  admissionsPerMinute: 200,
  sessionMinutes: 10,
  sessionMaxMinutes: 240,
  leaseBlockMax: 20,
  leaseMaxOutstandingSec: 10,
  burstSec: 5,
  overbookCap: 1.5,
  redeemGraceSec: 180,
  provisionalWindowSec: 600,
  absenceWindowSec: 600,
  brake: { enabled: false, activesThreshold: 2000, activesLimit: 2400, minFactor: 0.25 },
  waitingStatus: 200,
  snapshotTtlSec: 10,
  calmSnapshotTtlSec: 30,
  calmUtilization: 0.5,
  calmLeaseSec: 120,
  calmLeaseMaxOutstandingSec: 30,
  countWhitelisted: true,
  reserveMinAgeSec: 2,
  reservePowBits: 14,
  reserveMaxInflight: 20,
  maxWaitingTickets: 100_000,
  reserveVerifier: "none",
  turnstileSiteKey: "",
  whitelist: [],
};

export class ConfigError extends Error {}

function num(v: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${name} must be a number`);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(v)) throw new ConfigError(`${name} must be an integer`);
  return v;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(`${name} must be a boolean`);
  return v;
}

/** Widest whitelist blocks accepted: a wider one, often a typo, would let most visitors skip the room. */
const MIN_PREFIX = { 4: 8, 6: 32 } as const;

/** @param known CIDRs already in the configuration: kept as they are, even if a later version is stricter. */
export function validateWhitelist(entries: unknown, known: ReadonlySet<string> = new Set()): WhitelistEntry[] {
  if (!Array.isArray(entries)) throw new ConfigError("whitelist must be an array");
  if (entries.length > 1000) throw new ConfigError("whitelist is limited to 1000 entries");
  return entries.map((e, i) => {
    if (typeof e !== "object" || e === null) throw new ConfigError(`whitelist[${i}] must be an object`);
    const { cidr, label } = e as Record<string, unknown>;
    const c = typeof cidr === "string" ? parseCidr(cidr) : null;
    if (typeof cidr !== "string" || c === null) throw new ConfigError(`whitelist[${i}].cidr is invalid`);
    const len = cidr.split("/")[1];
    if (!known.has(cidr) && len !== undefined && Number(len) < MIN_PREFIX[c.v]) {
      throw new ConfigError(`whitelist[${i}].cidr is too wide (at most /${MIN_PREFIX[4]} for IPv4, /${MIN_PREFIX[6]} for IPv6)`);
    }
    const l = typeof label === "string" ? label.slice(0, 64) : "";
    return { cidr, label: l };
  });
}

/** Numeric settings: [name, min, max, integer]. */
const NUMBERS: [keyof RoomConfig & string, number, number, boolean?][] = [
  ["admissionsPerMinute", 1, 1_000_000],
  ["sessionMinutes", 1, 1440, true],
  ["sessionMaxMinutes", 1, 10080, true],
  ["leaseBlockMax", 1, 1000, true],
  ["leaseMaxOutstandingSec", 0, 600],
  ["burstSec", 0, 600],
  ["overbookCap", 1, 5],
  ["redeemGraceSec", 10, 3600, true],
  ["provisionalWindowSec", 10, 86400, true],
  ["absenceWindowSec", 60, 7200, true],
  ["waitingStatus", 200, 599, true],
  ["snapshotTtlSec", 1, 60],
  ["calmSnapshotTtlSec", 1, 300],
  ["calmUtilization", 0, 1],
  ["calmLeaseSec", 1, 3600],
  ["calmLeaseMaxOutstandingSec", 0, 3600],
  ["reserveMinAgeSec", 0, 60, true],
  ["reservePowBits", 0, 24, true],
  ["reserveMaxInflight", 1, 1000, true],
  ["maxWaitingTickets", 100, 1_000_000, true],
];

/** Validates a full configuration. Throws ConfigError on the first problem. */
export function validateConfig(c: RoomConfig, knownCidrs?: ReadonlySet<string>): RoomConfig {
  if (c.mode !== "off" && c.mode !== "on" && c.mode !== "queue_all") throw new ConfigError("mode must be off, on or queue_all");
  for (const [k, min, max, integer] of NUMBERS) num(c[k], k, min, max, integer);
  if (typeof c.brake !== "object" || c.brake === null) throw new ConfigError("brake must be an object");
  bool(c.brake.enabled, "brake.enabled");
  num(c.brake.activesThreshold, "brake.activesThreshold", 1, 100_000_000);
  num(c.brake.activesLimit, "brake.activesLimit", 1, 100_000_000);
  if (c.brake.activesLimit <= c.brake.activesThreshold) throw new ConfigError("brake.activesLimit must exceed brake.activesThreshold");
  num(c.brake.minFactor, "brake.minFactor", 0, 1);
  bool(c.countWhitelisted, "countWhitelisted");
  if (c.reserveVerifier !== "none" && c.reserveVerifier !== "turnstile") throw new ConfigError("reserveVerifier must be none or turnstile");
  if (typeof c.turnstileSiteKey !== "string") throw new ConfigError("turnstileSiteKey must be a string");
  // Without a site key the page shows no widget and every reservation would fail verification.
  if (c.reserveVerifier === "turnstile" && !/^[0-9A-Za-z_-]{8,128}$/.test(c.turnstileSiteKey)) {
    throw new ConfigError("reserveVerifier turnstile requires a valid turnstileSiteKey");
  }
  c.whitelist = validateWhitelist(c.whitelist, knownCidrs);
  return c;
}

const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof RoomConfig)[];

/** Applies a partial patch on top of a configuration and validates the result. */
export function mergeConfig(base: RoomConfig, patch: unknown): RoomConfig {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ConfigError("config patch must be an object");
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!KEYS.includes(k as keyof RoomConfig)) throw new ConfigError(`unknown config key: ${k}`);
  }
  const merged = structuredClone(base) as RoomConfig & Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (k === "brake" && typeof v === "object" && v !== null) {
      merged.brake = { ...merged.brake, ...(v as Partial<RoomConfig["brake"]>) };
    } else {
      merged[k] = v;
    }
  }
  return validateConfig(merged, new Set(base.whitelist.map((e) => e.cidr)));
}

/** Parses the bootstrap JSON (may be empty) into a validated configuration. */
export function bootstrapConfig(json: string | undefined): RoomConfig {
  if (!json || json.trim() === "") return structuredClone(DEFAULT_CONFIG);
  return mergeConfig(DEFAULT_CONFIG, JSON.parse(json));
}
