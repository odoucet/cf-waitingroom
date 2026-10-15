// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { clearCookie, cookieName, readRoomCookies, setCookie, tokens } from "../../src/shared/cookies.js";
import { bytesToBase64Url, KeyRing, KeyRingError, secretEquals } from "../../src/shared/crypto.js";

const K1 = btoa("a".repeat(32));
const K2 = btoa("b".repeat(32));
let ring1: KeyRing;
let ring12: KeyRing;
let ring2: KeyRing;

beforeAll(async () => {
  ring1 = await KeyRing.create(JSON.stringify({ 1: K1 }), "1");
  ring12 = await KeyRing.create(JSON.stringify({ 1: K1, 2: K2 }), "2");
  ring2 = await KeyRing.create(JSON.stringify({ 2: K2 }), "2");
});

describe("signed tokens", () => {
  it("round-trips every token type", async () => {
    const s = await tokens.sealSession(ring1, "room", { ticketNo: 42, tag: 7, issuedMinute: 28_999_990, countedMinute: 29_000_000, flags: 0 });
    expect(await tokens.openSession(ring1, "room", s)).toEqual({ ticketNo: 42, tag: 7, issuedMinute: 28_999_990, countedMinute: 29_000_000, flags: 0 });
    const t = await tokens.sealTicket(ring1, "room", { ticketNo: 9, admitAtMs: 1_767_600_000_123, issuedSec: 1_767_600_000 });
    expect(await tokens.openTicket(ring1, "room", t)).toEqual({ ticketNo: 9, admitAtMs: 1_767_600_000_123, issuedSec: 1_767_600_000 });
    const u = await tokens.sealProvisional(ring1, "room", { nonce: "0123456789abcdef", issuedSec: 5 });
    expect(await tokens.openProvisional(ring1, "room", u)).toEqual({ nonce: "0123456789abcdef", issuedSec: 5 });
    const b = await tokens.sealBypass(ring1, "room", "a.example", { expirySec: 10, countedMinute: 3, label: "partner-é" });
    expect(await tokens.openBypass(ring1, "room", "A.example", b)).toEqual({ expirySec: 10, countedMinute: 3, label: "partner-é" });
    expect(await tokens.openBypass(ring1, "room", "b.example", b)).toBeNull();
    const p = await tokens.sealPass(ring1, "room", "a.example", { expirySec: 11, label: "x".repeat(50) });
    expect((await tokens.openPass(ring1, "room", "a.example", p))?.label).toBe("x".repeat(32));
    // A signed link only works on the hostname it was created for.
    expect(await tokens.openPass(ring1, "room", "b.example", p)).toBeNull();
  });

  it("keeps cookies compact", async () => {
    const s = await tokens.sealSession(ring1, "room", { ticketNo: 1, tag: 1, issuedMinute: 1, countedMinute: 1, flags: 0 });
    expect(s.length).toBe(50); // 20-byte payload + 16-byte tag, base64url
  });

  it("rejects tampered, foreign-room and wrong-type tokens", async () => {
    const s = await tokens.sealSession(ring1, "room", { ticketNo: 1, tag: 1, issuedMinute: 1, countedMinute: 1, flags: 0 });
    const [payload, tag] = s.split(".");
    const bytes = Uint8Array.from(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    bytes[4] = bytes[4]! ^ 1;
    expect(await tokens.openSession(ring1, "room", `${bytesToBase64Url(bytes)}.${tag}`)).toBeNull();
    expect(await tokens.openSession(ring1, "other", s)).toBeNull();
    expect(await tokens.openTicket(ring1, "room", s)).toBeNull();
    expect(await tokens.openSession(ring1, "room", "garbage")).toBeNull();
    expect(await tokens.openSession(ring1, "room", `${payload}.`)).toBeNull();
    expect(await tokens.openSession(ring1, "room", "x".repeat(300))).toBeNull();
  });

  it("supports key rotation with two kids", async () => {
    const old = await tokens.sealSession(ring1, "room", { ticketNo: 1, tag: 1, issuedMinute: 1, countedMinute: 1, flags: 0 });
    // New ring signs with kid 2 and still accepts kid 1.
    expect(await tokens.openSession(ring12, "room", old)).not.toBeNull();
    const fresh = await tokens.sealSession(ring12, "room", { ticketNo: 2, tag: 1, issuedMinute: 1, countedMinute: 1, flags: 0 });
    expect(await tokens.openSession(ring1, "room", fresh)).toBeNull();
    // Once kid 1 is removed, old cookies are refused.
    expect(await tokens.openSession(ring2, "room", old)).toBeNull();
  });

  it("validates key material", async () => {
    await expect(KeyRing.create(undefined, "1")).rejects.toThrow(KeyRingError);
    await expect(KeyRing.create(JSON.stringify({ 1: btoa("short") }), "1")).rejects.toThrow(/32 bytes/);
    await expect(KeyRing.create(JSON.stringify({ 1: K1 }), "3")).rejects.toThrow(/WR_KEY_CURRENT/);
    await expect(KeyRing.create(JSON.stringify({ 1: K1, 2: K1, 3: K1 }), "1")).rejects.toThrow(/one or two/);
  });

  it("compares secrets in constant time regardless of length", async () => {
    expect(await secretEquals("s3cret", "s3cret")).toBe(true);
    expect(await secretEquals("s3cret", "s3creT")).toBe(false);
    expect(await secretEquals("", "")).toBe(false);
    expect(await secretEquals("a", "a much longer value")).toBe(false);
  });
});

describe("cookie helpers", () => {
  it("names cookies with the __Host- prefix", () => {
    expect(cookieName("s", "main")).toBe("__Host-wr_s_main");
    expect(setCookie("n", "v", 60)).toBe("n=v; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(clearCookie("n")).toContain("Max-Age=0");
  });

  it("reads only the cookies of the room", () => {
    const h = "a=1; __Host-wr_s_main=SSS; __Host-wr_t_main=TTT; __Host-wr_s_other=OOO; __Host-wr_x_main=X";
    expect(readRoomCookies(h, "main")).toEqual({ s: "SSS", t: "TTT" });
    expect(readRoomCookies("a=1", "main")).toEqual({});
    expect(readRoomCookies(null, "main")).toEqual({});
  });
});
