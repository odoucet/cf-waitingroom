// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { CidrSet, parseCidr, parseIp } from "../../src/shared/cidr.js";

describe("cidr", () => {
  it("parses IPv4 and IPv6 addresses", () => {
    expect(parseIp("192.0.2.1")).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp("2001:db8::1")?.v).toBe(6);
    expect(parseIp("::ffff:192.0.2.1")).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp("256.0.0.1")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
  });

  it("rejects invalid blocks", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("10.0.0.0/8/1")).toBeNull();
    expect(parseCidr("nope")).toBeNull();
  });

  it("matches v4 and v6 blocks", () => {
    const set = new CidrSet([
      { cidr: "198.51.100.0/24", label: "office" },
      { cidr: "2001:db8:1::/48", label: "monitoring" },
      { cidr: "203.0.113.7", label: "single" },
    ]);
    expect(set.match("198.51.100.42")).toBe("office");
    expect(set.match("198.51.101.1")).toBeNull();
    expect(set.match("2001:db8:1:ffff::1")).toBe("monitoring");
    expect(set.match("2001:db8:2::1")).toBeNull();
    expect(set.match("203.0.113.7")).toBe("single");
    expect(set.match("203.0.113.8")).toBeNull();
    expect(set.match(null)).toBeNull();
  });

  it("supports /0", () => {
    expect(new CidrSet([{ cidr: "0.0.0.0/0", label: "all" }]).match("8.8.8.8")).toBe("all");
  });
});
