// SPDX-License-Identifier: Apache-2.0
//
// Minimal IPv4/IPv6 CIDR parsing and matching, without dependencies.

export interface Cidr {
  v: 4 | 6;
  net: bigint;
  mask: bigint;
  label: string;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = (n << 8n) | BigInt(b);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (s.includes("%")) return null;
  let head: string[];
  let tail: string[] = [];
  const dbl = s.indexOf("::");
  if (dbl !== -1) {
    if (s.indexOf("::", dbl + 1) !== -1) return null;
    head = s.slice(0, dbl) === "" ? [] : s.slice(0, dbl).split(":");
    tail = s.slice(dbl + 2) === "" ? [] : s.slice(dbl + 2).split(":");
  } else {
    head = s.split(":");
  }
  const groups: bigint[] = [];
  const pushGroups = (arr: string[], out: bigint[]): boolean => {
    for (let i = 0; i < arr.length; i++) {
      const g = arr[i]!;
      if (i === arr.length - 1 && g.includes(".")) {
        const v4 = parseV4(g);
        if (v4 === null) return false;
        out.push(v4 >> 16n, v4 & 0xffffn);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
      out.push(BigInt(parseInt(g, 16)));
    }
    return true;
  };
  const h: bigint[] = [];
  const t: bigint[] = [];
  if (!pushGroups(head, h) || !pushGroups(tail, t)) return null;
  if (dbl === -1) {
    if (h.length !== 8) return null;
    groups.push(...h);
  } else {
    const fill = 8 - h.length - t.length;
    if (fill < 1) return null;
    groups.push(...h, ...new Array<bigint>(fill).fill(0n), ...t);
  }
  let n = 0n;
  for (const g of groups) n = (n << 16n) | g;
  return n;
}

/** Parses an address into its family and integer value. */
export function parseIp(s: string): { v: 4 | 6; n: bigint } | null {
  if (s.includes(":")) {
    const n = parseV6(s);
    if (n === null) return null;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched as IPv4.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

/** Parses "a.b.c.d", "a.b.c.d/nn", "x::y" or "x::y/nnn". Returns null if invalid. */
export function parseCidr(s: string, label = ""): Cidr | null {
  const [addr, len, extra] = s.trim().split("/");
  if (addr === undefined || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const bits = ip.v === 4 ? 32 : 128;
  let prefix = bits;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    prefix = Number(len);
    if (prefix > bits) return null;
  }
  const all = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (all << BigInt(bits - prefix)) & all;
  return { v: ip.v, net: ip.n & mask, mask, label };
}

/** A compiled list of CIDR blocks. */
export class CidrSet {
  private readonly blocks: Cidr[];

  constructor(entries: { cidr: string; label: string }[]) {
    this.blocks = [];
    for (const e of entries) {
      const c = parseCidr(e.cidr, e.label);
      if (c) this.blocks.push(c);
    }
  }

  get size(): number {
    return this.blocks.length;
  }

  /** Returns the matching entry label, or null. */
  match(ip: string | null | undefined): string | null {
    if (!ip || this.blocks.length === 0) return null;
    const a = parseIp(ip);
    if (!a) return null;
    for (const b of this.blocks) {
      if (b.v === a.v && (a.n & b.mask) === b.net) return b.label;
    }
    return null;
  }
}
