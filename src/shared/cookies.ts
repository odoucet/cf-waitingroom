// SPDX-License-Identifier: Apache-2.0
//
// Signed token format, version 1 (public interface, see docs/interfaces.md).
//
//   token   = base64url(payload) "." base64url(tag)
//   payload = version:u8 (=1) | type:u8 | kid:u8 | fields (big-endian, fixed width)
//   tag     = first 16 bytes of HMAC-SHA256(key[kid], "wr1\0" + scope + "\0" + payload)
//   scope   = roomId, or roomId "@" hostname for the signed link and the bypass cookie: they
//             only work on the hostname they were issued for (a room id never contains "@").

import { base64UrlToBytes, bytesEqual, bytesToBase64Url, type KeyRing } from "./crypto.js";

export const TOKEN_VERSION = 1;

export const TokenType = {
  Session: 0x53, // 'S'
  Ticket: 0x54, // 'T'
  Provisional: 0x55, // 'U'
  Bypass: 0x42, // 'B'
  Pass: 0x50, // 'P'
} as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export interface SessionToken {
  /** Ticket the session was obtained with, 0 when admitted through a lease. */
  ticketNo: number;
  /** Tag of the isolate that issued the session (replay arbitration). */
  tag: number;
  /** Minute (epoch minutes) the session was issued: bounds its total lifetime. */
  issuedMinute: number;
  /** Last minute (epoch minutes) the session was counted in. */
  countedMinute: number;
  flags: number;
}

export interface TicketToken {
  ticketNo: number;
  admitAtMs: number;
  issuedSec: number;
}

export interface ProvisionalToken {
  /** 16 hex characters. */
  nonce: string;
  issuedSec: number;
}

export interface BypassToken {
  expirySec: number;
  countedMinute: number;
  label: string;
}

export interface PassToken {
  expirySec: number;
  label: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_LABEL = 32;

class Writer {
  private buf: number[] = [];
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u32(v: number): this {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u48(v: number): this {
    const hi = Math.floor(v / 2 ** 32);
    return this.u8(hi >>> 8).u8(hi).u32(v >>> 0);
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.buf.push(x);
    return this;
  }
  out(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  get remaining(): number {
    return this.b.length - this.o;
  }
  u8(): number {
    if (this.o + 1 > this.b.length) throw new RangeError();
    return this.b[this.o++]!;
  }
  u32(): number {
    if (this.o + 4 > this.b.length) throw new RangeError();
    const v = ((this.b[this.o]! << 24) | (this.b[this.o + 1]! << 16) | (this.b[this.o + 2]! << 8) | this.b[this.o + 3]!) >>> 0;
    this.o += 4;
    return v;
  }
  u48(): number {
    const hi = (this.u8() << 8) | this.u8();
    return hi * 2 ** 32 + this.u32();
  }
  rest(): Uint8Array {
    const r = this.b.subarray(this.o);
    this.o = this.b.length;
    return r;
  }
}

function macInput(room: string, payload: Uint8Array): Uint8Array {
  const prefix = enc.encode(`wr1\0${room}\0`);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

async function seal(ring: KeyRing, room: string, type: TokenType, fields: Uint8Array): Promise<string> {
  const payload = new Writer().u8(TOKEN_VERSION).u8(type).u8(ring.currentKid).bytes(fields).out();
  const tag = await ring.mac(ring.currentKid, macInput(room, payload));
  if (!tag) throw new Error("current key missing");
  return `${bytesToBase64Url(payload)}.${bytesToBase64Url(tag)}`;
}

async function open(ring: KeyRing, room: string, type: TokenType, token: string): Promise<Reader | null> {
  if (token.length > 256) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = base64UrlToBytes(token.slice(0, dot));
  const tag = base64UrlToBytes(token.slice(dot + 1));
  if (!payload || !tag || payload.length < 3 || tag.length !== 16) return null;
  if (payload[0] !== TOKEN_VERSION || payload[1] !== type) return null;
  const expected = await ring.mac(payload[2]!, macInput(room, payload));
  if (!expected || !bytesEqual(expected, tag)) return null;
  const r = new Reader(payload);
  r.u8();
  r.u8();
  r.u8();
  return r;
}

function labelBytes(label: string): Uint8Array {
  let b = enc.encode(label);
  if (b.length > MAX_LABEL) b = b.subarray(0, MAX_LABEL);
  return b;
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** MAC scope of the tokens bound to a hostname. */
function hostScope(room: string, host: string): string {
  return `${room}@${host.toLowerCase()}`;
}

export const tokens = {
  sealSession(ring: KeyRing, room: string, t: SessionToken): Promise<string> {
    return seal(ring, room, TokenType.Session, new Writer().u32(t.ticketNo).u32(t.tag).u32(t.issuedMinute).u32(t.countedMinute).u8(t.flags).out());
  },
  async openSession(ring: KeyRing, room: string, s: string): Promise<SessionToken | null> {
    const r = await open(ring, room, TokenType.Session, s);
    return r && safe(() => ({ ticketNo: r.u32(), tag: r.u32(), issuedMinute: r.u32(), countedMinute: r.u32(), flags: r.u8() }));
  },
  sealTicket(ring: KeyRing, room: string, t: TicketToken): Promise<string> {
    return seal(ring, room, TokenType.Ticket, new Writer().u32(t.ticketNo).u48(t.admitAtMs).u32(t.issuedSec).out());
  },
  async openTicket(ring: KeyRing, room: string, s: string): Promise<TicketToken | null> {
    const r = await open(ring, room, TokenType.Ticket, s);
    return r && safe(() => ({ ticketNo: r.u32(), admitAtMs: r.u48(), issuedSec: r.u32() }));
  },
  sealProvisional(ring: KeyRing, room: string, t: ProvisionalToken): Promise<string> {
    const nonce = new Uint8Array(8);
    for (let i = 0; i < 8; i++) nonce[i] = parseInt(t.nonce.slice(i * 2, i * 2 + 2), 16) || 0;
    return seal(ring, room, TokenType.Provisional, new Writer().bytes(nonce).u32(t.issuedSec).out());
  },
  async openProvisional(ring: KeyRing, room: string, s: string): Promise<ProvisionalToken | null> {
    const r = await open(ring, room, TokenType.Provisional, s);
    return (
      r &&
      safe(() => {
        let nonce = "";
        for (let i = 0; i < 8; i++) nonce += r.u8().toString(16).padStart(2, "0");
        return { nonce, issuedSec: r.u32() };
      })
    );
  },
  sealBypass(ring: KeyRing, room: string, host: string, t: BypassToken): Promise<string> {
    return seal(ring, hostScope(room, host), TokenType.Bypass, new Writer().u32(t.expirySec).u32(t.countedMinute).bytes(labelBytes(t.label)).out());
  },
  async openBypass(ring: KeyRing, room: string, host: string, s: string): Promise<BypassToken | null> {
    const r = await open(ring, hostScope(room, host), TokenType.Bypass, s);
    return r && safe(() => ({ expirySec: r.u32(), countedMinute: r.u32(), label: dec.decode(r.rest()) }));
  },
  sealPass(ring: KeyRing, room: string, host: string, t: PassToken): Promise<string> {
    return seal(ring, hostScope(room, host), TokenType.Pass, new Writer().u32(t.expirySec).bytes(labelBytes(t.label)).out());
  },
  async openPass(ring: KeyRing, room: string, host: string, s: string): Promise<PassToken | null> {
    const r = await open(ring, hostScope(room, host), TokenType.Pass, s);
    return r && safe(() => ({ expirySec: r.u32(), label: dec.decode(r.rest()) }));
  },
};

// ---------------------------------------------------------------------------
// Cookie names and header helpers

export type CookieKind = "s" | "t" | "u" | "b";

/** `__Host-` prefix: Secure, Path=/, no Domain; cannot be set by a subdomain. */
export function cookieName(kind: CookieKind, room: string): string {
  return `__Host-wr_${kind}_${room}`;
}

export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Extracts the waiting-room cookies of one room from a Cookie header.
 * Other cookies are skipped without allocation-heavy parsing.
 */
export function readRoomCookies(header: string | null, room: string): Partial<Record<CookieKind, string>> {
  const out: Partial<Record<CookieKind, string>> = {};
  if (!header || header.indexOf("__Host-wr_") === -1) return out;
  const suffix = `_${room}=`;
  for (const part of header.split(";")) {
    const p = part.trim();
    if (!p.startsWith("__Host-wr_")) continue;
    const kind = p.charAt(10) as CookieKind;
    if (p.slice(11, 11 + suffix.length) !== suffix) continue;
    if (kind === "s" || kind === "t" || kind === "u" || kind === "b") out[kind] = p.slice(11 + suffix.length);
  }
  return out;
}
