// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { bootstrapConfig, ConfigError, DEFAULT_CONFIG, mergeConfig } from "../../src/shared/config.js";

describe("config", () => {
  it("returns the defaults when the bootstrap is empty", () => {
    expect(bootstrapConfig("")).toEqual(DEFAULT_CONFIG);
    expect(bootstrapConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial patch, including nested brake settings", () => {
    const c = mergeConfig(DEFAULT_CONFIG, { admissionsPerMinute: 500, brake: { enabled: true } });
    expect(c.admissionsPerMinute).toBe(500);
    expect(c.brake.enabled).toBe(true);
    expect(c.brake.activesThreshold).toBe(DEFAULT_CONFIG.brake.activesThreshold);
    expect(DEFAULT_CONFIG.admissionsPerMinute).toBe(200);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { capacity: 1 })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { mode: "maybe" })).toThrow(/mode/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { admissionsPerMinute: 0 })).toThrow(/admissionsPerMinute/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { sessionMinutes: 1.5 })).toThrow(/integer/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { brake: { activesThreshold: 10, activesLimit: 5 } })).toThrow(/activesLimit/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { whitelist: [{ cidr: "x", label: "" }] })).toThrow(/whitelist/);
    expect(() => mergeConfig(DEFAULT_CONFIG, [])).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { sessionMaxMinutes: 0 })).toThrow(/sessionMaxMinutes/);
  });

  it("refuses whitelist blocks wider than /8 (IPv4) or /32 (IPv6), but keeps stored ones", () => {
    for (const cidr of ["0.0.0.0/0", "10.0.0.0/7", "::/0", "2001:db8::/31", "::ffff:0.0.0.0/0"]) {
      expect(() => mergeConfig(DEFAULT_CONFIG, { whitelist: [{ cidr, label: "" }] }), cidr).toThrow(/too wide/);
    }
    const ok = mergeConfig(DEFAULT_CONFIG, { whitelist: [{ cidr: "10.0.0.0/8", label: "" }, { cidr: "2001:db8::/32", label: "" }, { cidr: "192.0.2.1", label: "" }] });
    expect(ok.whitelist).toHaveLength(3);
    // An entry stored by an older version stays, and other entries can still be added or removed.
    const old = { ...DEFAULT_CONFIG, whitelist: [{ cidr: "0.0.0.0/0", label: "legacy" }] };
    const added = mergeConfig(old, { whitelist: [...old.whitelist, { cidr: "192.0.2.0/24", label: "" }] });
    expect(added.whitelist).toHaveLength(2);
  });
});
