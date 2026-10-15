// SPDX-License-Identifier: Apache-2.0
//
// Integration tests of the edge Worker in the Workers runtime (miniflare),
// with the coordinator Durable Object and a stand-in origin.

import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type EdgeEnv } from "../../../src/edge/index.js";
import { getIsolate, resetIsolate } from "../../../src/edge/isolate.js";
import { tokens } from "../../../src/shared/cookies.js";
import { zeroEdgeCounters } from "../../../src/shared/counters.js";
import { getKeyRing } from "../../../src/shared/crypto.js";
import { verifyPow } from "../../../src/shared/pow.js";

const baseEnv = env as unknown as EdgeEnv;
let roomSeq = 0;
let E: EdgeEnv;

beforeEach(() => {
  resetIsolate();
  // A fresh room (and thus a fresh coordinator) per test.
  E = { ...baseEnv, ROOM_ID: `t${Date.now() % 100000}-${roomSeq++}` };
});

class Browser {
  jar = new Map<string, string>();
  constructor(readonly headers: Record<string, string> = {}) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(path: string, init: RequestInit & { env?: EdgeEnv } = {}): Promise<Response> {
    const h = new Headers({ accept: "text/html", ...this.headers, ...(init.headers as Record<string, string>) });
    if (this.jar.size > 0) h.set("cookie", this.cookieHeader());
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`https://shop.example${path}`, { ...init, headers: h, redirect: "manual" }) as never, init.env ?? E, ctx);
    await waitOnExecutionContext(ctx);
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return r;
  }

  has(kind: "s" | "t" | "u" | "b"): boolean {
    return this.jar.has(`__Host-wr_${kind}_${E.ROOM_ID}`);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Counts the requests relayed to the origin. */
function originCalls() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => real(input, init));
}

async function admin(method: string, path: string, body?: unknown, env: EdgeEnv = E): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request(`https://shop.example/__wr/admin/v1/${path}`, {
      method,
      headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    }) as never,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return r;
}

describe("routing", () => {
  it("relays static extensions and prefixes untouched (early exit)", async () => {
    const b = new Browser();
    for (const p of ["/assets/app.css", "/img/logo.PNG", "/static/anything"]) {
      const r = await b.get(p);
      expect(await r.text()).toBe(`origin ${p}`);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    }
  });

  it("refuses the early exit for writes and for paths some origins resolve to a dynamic page", async () => {
    for (const p of ["/index.php/x.css", "/cart;.js", "/static/..;/cart", "/static/..%2Fcart", "/app.aspx/x.png"]) {
      const b = new Browser();
      await b.get(p);
      expect(b.has("u"), p).toBe(true); // went through the room
    }
    const b = new Browser();
    await b.get("/assets/app.css", { method: "POST" });
    expect(b.has("u")).toBe(true);
  });

  it("answers 404 on unknown reserved paths", async () => {
    const r = await new Browser().get("/__wr/nope");
    expect(r.status).toBe(404);
  });
});

describe("open mode", () => {
  it("relays the first visit with a provisional cookie, admits on the second, then adds no cookie", async () => {
    const b = new Browser();
    const r1 = await b.get("/product/1");
    expect(await r1.text()).toBe("origin /product/1");
    // A response that carries a cookie is never stored by a shared cache.
    expect(r1.headers.get("cache-control")).toBe("private, max-age=60");
    expect(b.has("u")).toBe(true);
    expect(b.has("s")).toBe(false);

    const r2 = await b.get("/product/2");
    expect(await r2.text()).toBe("origin /product/2");
    expect(b.has("s")).toBe(true);
    expect(b.has("u")).toBe(false);

    const r3 = await b.get("/product/3");
    expect(await r3.text()).toBe("origin /product/3");
    expect(r3.headers.getSetCookie()).toEqual([]);
    expect(r3.headers.get("x-origin")).toBe("1");
    expect(r3.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("cookies", () => {
  it("ignores a forged session cookie", async () => {
    const b = new Browser();
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, "AQEBAAAAAQAAAAEAAAABAA.AAAAAAAAAAAAAAAAAAAAAA");
    const r = await b.get("/");
    expect(await r.text()).toBe("origin /");
    expect(b.has("s")).toBe(false);
    expect(b.has("u")).toBe(true);
  });

  it("refuses an expired session cookie", async () => {
    const ring = await getKeyRing(E.WR_KEYS, E.WR_KEY_CURRENT);
    const old = Math.floor(Date.now() / 60000) - 60;
    const b = new Browser();
    await b.get("/"); // loads the configuration in the isolate
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, await tokens.sealSession(ring, E.ROOM_ID, { ticketNo: 0, tag: 1, issuedMinute: old, countedMinute: old, flags: 0 }));
    b.jar.delete(`__Host-wr_u_${E.ROOM_ID}`);
    await b.get("/");
    expect(b.has("s")).toBe(false);
  });

  it("bounds the total lifetime of an active session (sessionMaxMinutes)", async () => {
    await admin("PATCH", "config", { sessionMaxMinutes: 60 });
    const ring = await getKeyRing(E.WR_KEYS, E.WR_KEY_CURRENT);
    const now = Math.floor(Date.now() / 60000);
    const b = new Browser();
    await b.get("/"); // loads the configuration in the isolate
    b.jar.delete(`__Host-wr_u_${E.ROOM_ID}`);
    // Issued 58 minutes ago, active a minute ago: refreshed, but expires within 2 minutes.
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, await tokens.sealSession(ring, E.ROOM_ID, { ticketNo: 0, tag: 1, issuedMinute: now - 58, countedMinute: now - 1, flags: 0 }));
    const r = await b.get("/");
    expect(r.headers.getSetCookie().find((c) => c.startsWith("__Host-wr_s_"))).toMatch(/Max-Age=(60|120);/); // 2 minutes left (1 if the minute turns)
    // Issued 60 minutes ago: refused, however active.
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, await tokens.sealSession(ring, E.ROOM_ID, { ticketNo: 0, tag: 1, issuedMinute: now - 60, countedMinute: now, flags: 0 }));
    await b.get("/");
    expect(b.has("s")).toBe(false);
    expect(getIsolate().core.counters.sessionRefused).toBe(1);
  });

  it("refuses a session cookie signed for another room", async () => {
    const ring = await getKeyRing(E.WR_KEYS, E.WR_KEY_CURRENT);
    const b = new Browser();
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, await tokens.sealSession(ring, "other-room", { ticketNo: 0, tag: 1, issuedMinute: Math.floor(Date.now() / 60000), countedMinute: Math.floor(Date.now() / 60000), flags: 0 }));
    await b.get("/");
    expect(b.has("s")).toBe(false);
  });

  it("refuses a forged ticket", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const b = new Browser();
    b.jar.set(`__Host-wr_t_${E.ROOM_ID}`, "AQEBAAAAAQAAAAEAAAABAA.AAAAAAAAAAAAAAAAAAAAAA");
    const r = await b.get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("queue");
    expect(b.has("t")).toBe(false);
  });
});

describe("batch delivery", () => {
  it("resends the same batch after a timeout and sends no newer one before it is answered", async () => {
    const real = E.COORDINATOR.get(E.COORDINATOR.idFromName(E.ROOM_ID));
    const sent: { seq: number; redeemed: number[] }[] = [];
    const reserves: unknown[] = [];
    let hang = false;
    const stub = {
      flush: (b: { seq: number; redeemed: number[] }) => {
        sent.push({ seq: b.seq, redeemed: [...b.redeemed] });
        // First call: applied by the coordinator, but the answer never comes back.
        const p = real.flush(b as never);
        return hang ? ((hang = false), new Promise(() => void p)) : p;
      },
      getSnapshot: () => real.getSnapshot(),
      reserve: (...a: unknown[]) => (reserves.push(a[1]), (real.reserve as (...x: unknown[]) => unknown)(...a)),
      admin: (op: never) => real.admin(op),
    };
    const env = { ...E, COORDINATOR: { idFromName: () => ({}), get: () => stub } as unknown as EdgeEnv["COORDINATOR"] };
    const iso = getIsolate();
    const ctx = createExecutionContext();
    await iso.ensureSnapshot(env, ctx);
    iso.core.recordRedeem(1, Date.now(), Date.now());
    hang = true;
    expect(await iso.flush(env, ctx, false, 50)).toBe(false);
    iso.core.recordRedeem(2, Date.now(), Date.now());
    expect(await iso.flush(env, ctx, false, 2000)).toBe(true);
    expect(await iso.flush(env, ctx, false, 2000)).toBe(true);
    await waitOnExecutionContext(ctx);
    const first = sent[1]!.seq; // sent[0] is the cold isolate's first flush
    expect(sent.slice(1)).toEqual([{ seq: first, redeemed: [1] }, { seq: first, redeemed: [1] }, { seq: first + 1, redeemed: [2] }]);
    const m = (await real.admin({ op: "metrics" })) as unknown as { data: { counters: Record<string, number> } };
    expect(m.data.counters.wr_batch_duplicates_total).toBe(1);
    // Reservations never carry deltas.
    await new Browser().get("/");
    expect(reserves.every((b) => b === null)).toBe(true);
  });

  it("refuses a provisional cookie older than provisionalWindowSec", async () => {
    const ring = await getKeyRing(E.WR_KEYS, E.WR_KEY_CURRENT);
    const b = new Browser({ "sec-fetch-site": "same-origin" });
    b.jar.set(`__Host-wr_u_${E.ROOM_ID}`, await tokens.sealProvisional(ring, E.ROOM_ID, { nonce: "0123456789abcdef", issuedSec: Math.floor(Date.now() / 1000) - 601 }));
    const r = await b.get("/__wr/reserve", { method: "POST" });
    expect(r.status).toBe(403);
    expect(b.has("u")).toBe(false);
  });
});

describe("sessions on a cold isolate", () => {
  const minute = () => Math.floor(Date.now() / 60000);
  const session = async (p: { ticketNo?: number; tag?: number; issuedMinute: number; countedMinute: number }) => {
    const ring = await getKeyRing(E.WR_KEYS, E.WR_KEY_CURRENT);
    return tokens.sealSession(ring, E.ROOM_ID, { ticketNo: 0, tag: 1, flags: 0, ...p });
  };
  const withSession = (value: string) => {
    const b = new Browser();
    b.jar.set(`__Host-wr_s_${E.ROOM_ID}`, value);
    return b;
  };
  const broken = (FAIL_MODE: string): EdgeEnv => {
    const fail = () => Promise.reject(new Error("simulated outage"));
    const stub = { flush: fail, getSnapshot: fail, reserve: fail, admin: fail };
    return { ...E, FAIL_MODE, COORDINATOR: { idFromName: () => ({}), get: () => stub } as unknown as EdgeEnv["COORDINATOR"] };
  };

  it("refuses an idle session", async () => {
    expect(getIsolate().core.config).toBeNull();
    const b = withSession(await session({ issuedMinute: minute() - 60, countedMinute: minute() - 60 }));
    await b.get("/");
    expect(b.has("s")).toBe(false);
    expect(getIsolate().core.counters.sessionRefused).toBe(1);
  });

  it("refuses a session beyond its total lifetime", async () => {
    await admin("PATCH", "config", { sessionMaxMinutes: 60 });
    resetIsolate();
    expect(getIsolate().core.config).toBeNull();
    const b = withSession(await session({ issuedMinute: minute() - 61, countedMinute: minute() }));
    await b.get("/");
    expect(b.has("s")).toBe(false);
    expect(getIsolate().core.counters.sessionRefused).toBe(1);
  });

  it("refuses a revoked session", async () => {
    // Two isolates redeem the same ticket: the coordinator keeps tag 7 and revokes the others.
    const stub = E.COORDINATOR.get(E.COORDINATOR.idFromName(E.ROOM_ID));
    const { ticketNo } = await stub.reserve("n", null);
    const batch = (isolateId: string, tag: number) => ({
      isolateId, tag, seq: 1, since: Date.now(), knownGen: -1, redeemed: [ticketNo], leaseUsed: 0, leaseUsage: [],
      leaseUnused: 0, leaseWanted: 0, urgent: false, activeDeltas: [], wlActiveDeltas: [], counters: zeroEdgeCounters(),
    });
    await stub.flush(batch("iso-1", 7));
    await stub.flush(batch("iso-2", 8));
    expect(getIsolate().core.config).toBeNull();
    const b = withSession(await session({ ticketNo, tag: 8, issuedMinute: minute(), countedMinute: minute() }));
    await b.get("/");
    expect(b.has("s")).toBe(false);
    expect(getIsolate().core.counters.sessionRefused).toBe(1);
  });

  it("neither honours nor renews a session it cannot check (fail open)", async () => {
    const value = await session({ issuedMinute: minute() - 600, countedMinute: minute() - 600 });
    const b = withSession(value);
    const r = await b.get("/", { env: broken("open") });
    expect(await r.text()).toBe("origin /");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(getIsolate().core.counters.failOpen).toBe(1);
    expect(getIsolate().core.counters.sessionRefused).toBe(0);
  });

  it("neither honours nor renews a session it cannot check (fail closed)", async () => {
    const origin = originCalls();
    const b = withSession(await session({ issuedMinute: minute(), countedMinute: minute() }));
    const r = await b.get("/", { env: broken("closed") });
    expect(r.status).toBe(503);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(origin).not.toHaveBeenCalled();
  });

  it("checks the session against the data-center copy when the coordinator is down", async () => {
    await new Browser().get("/"); // stores the snapshot in the data-center cache
    resetIsolate();
    const idle = withSession(await session({ issuedMinute: minute() - 60, countedMinute: minute() - 60 }));
    await idle.get("/", { env: broken("closed") });
    expect(idle.has("s")).toBe(false);
    resetIsolate();
    const ok = withSession(await session({ issuedMinute: minute(), countedMinute: minute() }));
    const r = await ok.get("/", { env: broken("closed") });
    expect(await r.text()).toBe("origin /");
    expect(ok.has("s")).toBe(true);
  });
});

describe("whitelist", () => {
  it("lets verified bots through without any cookie, and strips the secret", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const r = await new Browser({ "x-wr-bot": E.WR_BOT_SECRET! }).get("/");
    expect(await r.text()).toBe("origin /");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(r.headers.get("x-saw-bot")).toBe("no");
  });

  // What a client sends where the Transform Rules are missing or out of order.
  it("queues a forged bot header", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    for (const forged of ["true", "1", "test-bot-secret", `${E.WR_BOT_SECRET}x`]) {
      const r = await new Browser({ "x-wr-bot": forged }).get("/");
      expect(await r.text()).toContain("queue");
    }
  });

  it("disables the bot bypass without WR_BOT_SECRET", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const env = { ...E, WR_BOT_SECRET: undefined };
    for (const v of ["true", E.WR_BOT_SECRET!]) {
      const r = await new Browser({ "x-wr-bot": v }).get("/", { env });
      expect(await r.text()).toContain("queue");
    }
  });

  it("accepts the secret header and strips it before the origin", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const ok = await new Browser({ "x-wr-bypass": "test-bypass-secret" }).get("/api-like");
    expect(await ok.text()).toBe("origin /api-like");
    expect(ok.headers.get("x-saw-bypass")).toBe("no");
    const ko = await new Browser({ "x-wr-bypass": "wrong" }).get("/");
    expect(await ko.text()).not.toBe("origin /");
  });

  it("lets whitelisted IPs through", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    expect((await admin("POST", "whitelist", { entries: [{ cidr: "198.51.100.0/24", label: "office" }] })).status).toBe(200);
    const r = await new Browser({ "cf-connecting-ip": "198.51.100.9" }).get("/");
    expect(await r.text()).toBe("origin /");
    const other = await new Browser({ "cf-connecting-ip": "203.0.113.1" }).get("/");
    expect(await other.text()).not.toBe("origin /");
  });

  it("turns a signed link into a bypass cookie", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const res = await admin("POST", "pass", { label: "partner", ttlSeconds: 600, path: "/landing" });
    const { url } = (await res.json()) as { url: string };
    const link = new URL(url);
    const b = new Browser();
    const r = await b.get(link.pathname + link.search);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/landing");
    expect(b.has("b")).toBe(true);
    const r2 = await b.get("/landing");
    expect(await r2.text()).toBe("origin /landing");
  });

  it("never redirects a signed link to another host", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const { url } = (await (await admin("POST", "pass", { label: "partner", ttlSeconds: 600 })).json()) as { url: string };
    const token = new URL(url).searchParams.get("wr_pass")!;
    const r = await new Browser().get(`//evil.example/x?wr_pass=${token}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/evil.example/x");
    for (const path of ["//evil.example/", "/\\evil.example/", "https://evil.example/"]) {
      expect((await admin("POST", "pass", { label: "partner", path })).status).toBe(400);
    }
  });

  it("refuses a tampered signed link", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const r = await new Browser().get("/?wr_pass=AQFQAAAAAA.AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("queue");
  });
});

describe("queue", () => {
  it("fills every placeholder of the minified page, in both languages", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    for (const [lang, title, msg] of [["en", "You are in the queue", "Letting you in"], ["fr", "Vous êtes dans la file d’attente", "Entrée en cours"]] as const) {
      const r = await new Browser({ "accept-language": lang }).get("/");
      const nonce = /'nonce-([0-9a-f]+)'/.exec(r.headers.get("content-security-policy")!)![1]!;
      const html = await r.text();
      expect(html).not.toMatch(/\{\{\w+\}\}/);
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain(`<title>${title}</title>`);
      expect(html).toContain(`<style nonce="${nonce}">`);
      expect(html).toContain(`<script nonce="${nonce}">var MSG = {"wait":`);
      expect(html).toContain(msg);
      expect(html).toContain('"reserveUrl":"/__wr/reserve"');
    }
  });

  it("serves the waiting page, reserves a slot from JavaScript, admits at admitAt", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const b = new Browser({ "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" });
    const page = await b.get("/cart");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Merci de votre patience");
    expect(b.has("u")).toBe(true);

    const res = await b.get("/__wr/reserve", { method: "POST", headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { ticketNo: number; admitAtMs: number };
    expect(t.ticketNo).toBeGreaterThan(0);
    expect(b.has("t")).toBe(true);

    // Reloading the page does not take a second slot.
    const again = (await (await b.get("/__wr/reserve", { method: "POST" })).json()) as { ticketNo: number };
    expect(again.ticketNo).toBe(t.ticketNo);

    // The first ticket is due immediately (bucket): the reload is admitted.
    const r = await b.get("/cart");
    expect(await r.text()).toBe("origin /cart");
    expect(b.has("s")).toBe(true);
    expect(b.has("t")).toBe(false);
  });

  it("answers JSON to API clients and refuses reservations without a provisional cookie", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const r = await new Browser({ accept: "application/json" }).get("/");
    expect(r.status).toBe(503);
    expect(((await r.json()) as { status: string }).status).toBe("waiting");
    const noCookie = await new Browser().get("/__wr/reserve", { method: "POST" });
    expect(noCookie.status).toBe(403);
    const get = await new Browser().get("/__wr/reserve");
    expect(get.status).toBe(405);
  });

  it("keeps a visitor waiting until their slot, with a countdown", async () => {
    await admin("PATCH", "config", { mode: "queue_all", admissionsPerMinute: 1, burstSec: 0 });
    for (let i = 0; i < 2; i++) {
      const o = new Browser();
      await o.get("/");
      await o.get("/__wr/reserve", { method: "POST" });
    }
    const b = new Browser();
    await b.get("/");
    const t = (await (await b.get("/__wr/reserve", { method: "POST" })).json()) as { admitAtMs: number };
    expect(t.admitAtMs - Date.now()).toBeGreaterThan(60_000);
    const r = await b.get("/");
    const html = await r.text();
    expect(html).toContain("wr-data");
    expect(html).toContain(String(t.admitAtMs));
    expect(b.has("s")).toBe(false);
  });

  it("requires a minimum age of the provisional cookie", async () => {
    await admin("PATCH", "config", { mode: "queue_all", reserveMinAgeSec: 30 });
    const b = new Browser({ accept: "application/json" });
    const page = (await (await b.get("/")).json()) as { reserveAfterMs: number };
    expect(page.reserveAfterMs).toBeGreaterThan(Date.now() + 25_000);
    const r = await b.get("/__wr/reserve", { method: "POST" });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { status: string; error: string }).error).toBe("too_early");
    expect(getIsolate().core.counters.reserveTooEarly).toBe(1);
  });

  it("requires the proof of work", async () => {
    await admin("PATCH", "config", { mode: "queue_all", reservePowBits: 8 });
    const b = new Browser({ accept: "application/json" });
    const { pow } = (await (await b.get("/")).json()) as { pow: { room: string; nonce: string; bits: number } };
    expect(pow).toEqual({ room: E.ROOM_ID, nonce: expect.stringMatching(/^[0-9a-f]{16}$/), bits: 8 });
    const post = (body: unknown) => b.get("/__wr/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ pow: "0x1" })).status).toBe(403);
    let counter = 0;
    while (!(await verifyPow(pow.room, pow.nonce, String(counter), pow.bits))) counter++;
    if (counter > 0) expect((await post({ pow: String(counter - 1) })).status).toBe(403);
    // Oversized bodies are not parsed.
    expect((await post({ pow: String(counter), pad: "x".repeat(5000) })).status).toBe(403);
    const r = await post({ pow: String(counter) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ticketNo: number }).ticketNo).toBeGreaterThan(0);
  });

  it("refuses cross-site reservations", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const b = new Browser();
    await b.get("/");
    expect((await b.get("/__wr/reserve", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await b.get("/__wr/reserve", { method: "POST", headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it("caps the reservation calls in flight per isolate", async () => {
    await admin("PATCH", "config", { mode: "queue_all", reserveMaxInflight: 1 });
    const b = new Browser();
    await b.get("/");
    getIsolate().reserveInflight = 1;
    const r = await b.get("/__wr/reserve", { method: "POST" });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toMatch(/^[2-5]$/);
    expect(((await r.json()) as { status: string }).status).toBe("retry");
    getIsolate().reserveInflight = 0;
    expect((await b.get("/__wr/reserve", { method: "POST" })).status).toBe(200);
    expect(getIsolate().reserveInflight).toBe(0);
  });

  it("serves the status endpoint from the snapshot", async () => {
    const r = await new Browser().get("/__wr/status");
    const j = (await r.json()) as { mode: string; paused: boolean };
    expect(j.mode).toBe("on");
    expect(j.paused).toBe(false);
  });
});

describe("kill switch and fail modes", () => {
  it("relays everything in mode off, without redeploying", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    expect(await (await new Browser().get("/")).text()).not.toBe("origin /");
    await admin("PUT", "mode", { mode: "off" });
    const r = await new Browser().get("/");
    expect(await r.text()).toBe("origin /");
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  const broken = (): EdgeEnv => {
    const fail = () => Promise.reject(Object.assign(new Error("simulated outage"), { overloaded: true }));
    const stub = { flush: fail, getSnapshot: fail, reserve: fail, admin: fail };
    return { ...E, COORDINATOR: { idFromName: () => ({}), get: () => stub } as unknown as EdgeEnv["COORDINATOR"] };
  };

  it("fails open when FAIL_MODE is open and the coordinator is unavailable", async () => {
    const r = await new Browser().get("/", { env: broken() });
    expect(await r.text()).toBe("origin /");
    expect(getIsolate().core.counters.failOpen).toBe(1);
    expect(getIsolate().core.counters.errOverloaded).toBeGreaterThan(0);
  });

  it("fails closed on a cold isolate: no configuration needed, no origin call", async () => {
    const env = { ...broken(), FAIL_MODE: "closed" };
    expect(getIsolate().core.config).toBeNull();
    const origin = originCalls();
    const r = await new Browser().get("/x", { env });
    expect(r.status).toBe(503);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("http-equiv=\"refresh\"");
    const j = await new Browser({ accept: "application/json" }).get("/api", { env });
    expect(j.status).toBe(503);
    expect(((await j.json()) as { status: string }).status).toBe("unavailable");
    expect(origin).not.toHaveBeenCalled();
    expect(getIsolate().core.counters.failOpen).toBe(0);
  });

  it("fails closed when FAIL_MODE is unset or invalid", async () => {
    const origin = originCalls();
    for (const FAIL_MODE of [undefined, "close"]) {
      resetIsolate();
      const r = await new Browser().get("/x", { env: { ...broken(), FAIL_MODE } });
      expect(r.status).toBe(503);
    }
    expect(origin).not.toHaveBeenCalled();
  });

  it("never admits a reservation on a cold isolate in fail-closed mode", async () => {
    const b = new Browser();
    await b.get("/"); // provisional cookie
    resetIsolate();
    const r = await b.get("/__wr/reserve", { method: "POST", env: { ...broken(), FAIL_MODE: "closed" } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { status: string }).status).toBe("retry");
    expect(b.has("s")).toBe(false);
  });

  it("never turns a failed reservation into a session while visitors queue", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const b = new Browser();
    await b.get("/"); // provisional cookie, snapshot: queueing
    (getIsolate() as unknown as { stub: unknown }).stub = null; // drop the healthy stub
    const r = await b.get("/__wr/reserve", { method: "POST", env: broken() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { status: string }).status).toBe("retry");
    expect(b.has("s")).toBe(false);
    expect(getIsolate().core.counters.failOpen).toBe(0);
  });

  it("fails closed when the snapshot expires during an outage", async () => {
    const b = new Browser();
    await b.get("/"); // snapshot and configuration known
    getIsolate().core.receivedAt = -1e12; // snapshot unusable
    getIsolate().core.lease = { remaining: 0, exp: 0 };
    (getIsolate() as unknown as { stub: unknown }).stub = null; // drop the healthy stub
    await caches.default.delete(`https://wr-snapshot.internal/${E.ROOM_ID}/v1`);
    const origin = originCalls();
    const r = await b.get("/x", { env: { ...broken(), FAIL_MODE: "closed" } });
    expect(r.status).toBe(503);
    expect(origin).not.toHaveBeenCalled();
  });

  it("refuses failMode in the room configuration (now the FAIL_MODE variable)", async () => {
    expect((await admin("PATCH", "config", { failMode: "closed" })).status).toBe(400);
  });

  it("keeps serving valid sessions without the coordinator", async () => {
    const b = new Browser();
    await b.get("/");
    await b.get("/");
    expect(b.has("s")).toBe(true);
    const r = await b.get("/again", { env: broken() });
    expect(await r.text()).toBe("origin /again");
  });
});

describe("misconfiguration", () => {
  const cases: [string, Partial<EdgeEnv>][] = [
    ["invalid ROOM_ID", { ROOM_ID: "Bad Room!" }],
    ["missing WR_KEYS", { WR_KEYS: undefined }],
    ["malformed WR_KEYS", { WR_KEYS: "{not json" }],
    ["WR_KEY_CURRENT not in WR_KEYS", { WR_KEY_CURRENT: "9" }],
    ["missing COORDINATOR binding", { COORDINATOR: undefined as unknown as EdgeEnv["COORDINATOR"] }],
  ];

  for (const [name, patch] of cases) {
    it(`answers 503 without reaching the origin: ${name}`, async () => {
      const env = { ...E, ...patch };
      const origin = originCalls();
      const r = await new Browser().get("/product", { env });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).not.toBeNull();
      expect(r.headers.getSetCookie()).toEqual([]);
      const reserve = await new Browser().get("/__wr/reserve", { method: "POST", env });
      expect(reserve.status).toBe(500);
      expect(origin).not.toHaveBeenCalled();
    });
  }

  it("still relays the early-exit static paths", async () => {
    const r = await new Browser().get("/assets/app.css", { env: { ...E, WR_KEYS: undefined } });
    expect(await r.text()).toBe("origin /assets/app.css");
  });

  it("preflight reports a ready Worker", async () => {
    const r = await admin("GET", "preflight");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, room: E.ROOM_ID, failMode: "open", coordinator: "ok", botBypass: "enabled", errors: [] });
  });

  it("preflight lists every problem, even with an invalid room id", async () => {
    const env = { ...E, ROOM_ID: "Bad Room!", WR_KEY_CURRENT: "9", FAIL_MODE: "close" };
    const r = await admin("GET", "preflight", undefined, env);
    expect(r.status).toBe(503);
    const j = (await r.json()) as { ok: boolean; coordinator: string; errors: string[] };
    expect(j.ok).toBe(false);
    expect(j.coordinator).toBe("skipped");
    expect(j.errors).toEqual(["invalid ROOM_ID", "WR_KEY_CURRENT does not match a key in WR_KEYS", "FAIL_MODE must be open or closed"]);
  });

  it("preflight refuses a short bot secret", async () => {
    const r = await admin("GET", "preflight", undefined, { ...E, WR_BOT_SECRET: "short" });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { errors: string[] }).errors).toEqual(["WR_BOT_SECRET must be at least 32 characters"]);
  });

  it("preflight requires the admin token", async () => {
    const r = await new Browser().get("/__wr/admin/v1/preflight", { env: { ...E, ROOM_ID: "Bad Room!" } });
    expect(r.status).toBe(401);
  });
});

describe("audit fixes CF-11 to CF-21", () => {
  it("refuses new reservations in mode off (CF-11)", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const b = new Browser({ "sec-fetch-site": "same-origin" });
    await b.get("/"); // waiting page and provisional cookie
    await admin("PUT", "mode", { mode: "off" });
    const r = await b.get("/__wr/reserve", { method: "POST" });
    expect(await r.json()).toEqual({ status: "admitted" });
    expect(b.has("t")).toBe(false);
    const s = (await (await admin("GET", "state")).json()) as { nextTicketNo: number };
    expect(s.nextTicketNo).toBe(1);
  });

  it("enables Turnstile only with a site key and the edge secret (CF-12)", async () => {
    expect((await admin("PATCH", "config", { reserveVerifier: "turnstile", turnstileSiteKey: "0x4AAAAAAAtestkey" })).status).toBe(400);
    const env = { ...E, WR_TURNSTILE_SECRET: "turnstile-secret" };
    expect((await admin("PATCH", "config", { reserveVerifier: "turnstile" }, env)).status).toBe(400); // no site key
    expect((await admin("PATCH", "config", { reserveVerifier: "turnstile", turnstileSiteKey: "0x4AAAAAAAtestkey" }, env)).status).toBe(200);
    const pre = (await (await admin("GET", "preflight")).json()) as { errors: string[] };
    expect(pre.errors).toContain("reserveVerifier is turnstile but WR_TURNSTILE_SECRET is not set");
  });

  it("accepts a Turnstile token only for the hostname of the request (CF-12)", async () => {
    const env = { ...E, WR_TURNSTILE_SECRET: "turnstile-secret" };
    await admin("PATCH", "config", { mode: "queue_all", reserveVerifier: "turnstile", turnstileSiteKey: "0x4AAAAAAAtestkey" }, env);
    const real = globalThis.fetch;
    let hostname = "other.example";
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("https://challenges.cloudflare.com/")
        ? Promise.resolve(Response.json({ success: true, hostname }))
        : real(input, init),
    );
    const reserve = async () => {
      const b = new Browser({ "sec-fetch-site": "same-origin" });
      await b.get("/", { env });
      return b.get("/__wr/reserve", { method: "POST", env, body: JSON.stringify({ turnstileToken: "tok" }) });
    };
    expect((await reserve()).status).toBe(403);
    hostname = "shop.example";
    expect((await reserve()).status).toBe(200);
  });

  it("accepts a signed link only on the hostname it was created for (CF-15)", async () => {
    await admin("PUT", "mode", { mode: "queue_all" });
    const j = (await (await admin("POST", "pass", { label: "partner", host: "other.example" })).json()) as { url: string };
    const token = new URL(j.url).searchParams.get("wr_pass")!;
    const b = new Browser();
    const r = await b.get(`/?wr_pass=${token}`);
    expect(r.status).not.toBe(302);
    expect(b.has("b")).toBe(false);
  });

  it("gives one leased slot per provisional cookie (CF-16)", async () => {
    const b = new Browser();
    await b.get("/");
    const u = b.jar.get(`__Host-wr_u_${E.ROOM_ID}`)!;
    await b.get("/");
    expect(b.has("s")).toBe(true);
    // A client that keeps the first cookie value and sends it again gets no second slot.
    const replay = new Browser();
    replay.jar.set(`__Host-wr_u_${E.ROOM_ID}`, u);
    await replay.get("/");
    expect(replay.has("s")).toBe(false);
    expect(replay.jar.get(`__Host-wr_u_${E.ROOM_ID}`)).not.toBe(u); // a fresh provisional cookie instead
  });

  it("never relays /__wr/ paths and matches prefixes on segments (CF-17)", async () => {
    const env = { ...E, EARLY_EXIT_PREFIXES: "/static" };
    const r = await new Browser().get("/__wr/nothing.js", { env });
    expect(r.status).toBe(404);
    expect((await new Browser().get("/static/app", { env })).headers.getSetCookie()).toEqual([]);
    const other = await new Browser().get("/static-checkout/pay", { env });
    expect(other.headers.getSetCookie().some((c) => c.startsWith("__Host-wr_u_"))).toBe(true);
  });

  it("bounds the admin body in bytes, before reading it (CF-21)", async () => {
    const big = JSON.stringify({ label: "x".repeat(70_000) });
    const r = await admin("PATCH", "config", JSON.parse(big));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/too large/);
  });
});

describe("administration and metrics", () => {
  it("rejects missing or wrong tokens", async () => {
    const r = await new Browser({ authorization: "Bearer nope" }).get("/__wr/admin/v1/state");
    expect(r.status).toBe(401);
    const m = await new Browser().get("/__wr/metrics");
    expect(m.status).toBe(401);
  });

  it("validates configuration patches", async () => {
    const r = await admin("PATCH", "config", { admissionsPerMinute: "fast" });
    expect(r.status).toBe(400);
    const ok = await admin("PATCH", "config", { admissionsPerMinute: 300 });
    expect(((await ok.json()) as { admissionsPerMinute: number }).admissionsPerMinute).toBe(300);
  });

  it("exposes Prometheus metrics behind basic auth", async () => {
    const b = new Browser({ authorization: `Basic ${btoa("prometheus:test-metrics-password")}` });
    const r = await b.get("/__wr/metrics");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain(`wr_admission_rate_target{room="${E.ROOM_ID}"} 60`);
    expect(text).toContain("# TYPE wr_coordinator_requests_total counter");
    expect(text).toContain('wr_cost_projection_usd{room="');
  });

  it("pauses admissions", async () => {
    expect((await admin("PUT", "pause", { paused: true })).status).toBe(200);
    const b = new Browser();
    await b.get("/");
    const r = await b.get("/");
    expect(await r.text()).not.toBe("origin /");
    expect(b.has("s")).toBe(false);
  });
});

describe("operator hostnames", () => {
  const OPS = "waitingroom.acct.workers.dev";
  const call = async (url: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(url, { ...init, headers, redirect: "manual" }) as never, { ...E, ADMIN_HOSTS: ` ${OPS.toUpperCase()} ,other.example` }, ctx);
    await waitOnExecutionContext(ctx);
    return r;
  };
  const bearer = { authorization: "Bearer test-admin-token", "content-type": "application/json" };
  const metrics = { authorization: `Basic ${btoa("prometheus:test-metrics-password")}` };
  const dash = { authorization: `Basic ${btoa("ops:test-dashboard-password")}` };

  it("serves admin, metrics and dashboard on the operator hostname only", async () => {
    expect((await call(`https://${OPS}/__wr/admin/v1/state`, bearer)).status).toBe(200);
    expect((await call(`https://${OPS}/__wr/metrics`, metrics)).status).toBe(200);
    expect((await call(`https://${OPS}/__wr/dashboard`, dash)).status).toBe(200);
    expect((await call(`https://${OPS}/__wr/admin/v1/state`)).status).toBe(401);
    expect((await call(`https://${OPS}/__wr/dashboard/admin/state`, dash)).status).toBe(200);
    for (const [path, h] of [["/__wr/admin/v1/state", bearer], ["/__wr/metrics", metrics], ["/__wr/dashboard", dash], ["/__wr/dashboard/data", dash], ["/__wr/dashboard/admin/state", dash]] as const) {
      expect((await call(`https://shop.example${path}`, h)).status).toBe(404);
    }
  });

  it("serves nothing else on the operator hostname", async () => {
    for (const path of ["/", "/landing", "/assets/app.css", "/__wr/status"]) {
      const r = await call(`https://${OPS}${path}`);
      expect(r.status).toBe(404);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    expect((await call(`https://${OPS}/__wr/reserve`, {}, { method: "POST" })).status).toBe(404);
  });

  it("keeps the site's hostnames working", async () => {
    expect(await (await call("https://shop.example/assets/app.css")).text()).toBe("origin /assets/app.css");
    expect((await call("https://shop.example/")).status).toBe(200);
    expect((await call("https://shop.example/__wr/status")).status).toBe(200);
  });

  it("creates signed links for a site hostname", async () => {
    const pass = (body: unknown) => call(`https://${OPS}/__wr/admin/v1/pass`, bearer, { method: "POST", body: JSON.stringify(body) });
    expect((await pass({ label: "partner" })).status).toBe(400);
    expect((await pass({ label: "partner", host: OPS })).status).toBe(400);
    expect((await pass({ label: "partner", host: "evil.example/x" })).status).toBe(400);
    expect((await pass({ label: "partner", host: "shop.example", path: "//evil.example/" })).status).toBe(400);
    const r = await pass({ label: "partner", host: "Shop.Example", path: "/landing" });
    expect(r.status).toBe(200);
    const link = new URL(((await r.json()) as { url: string }).url);
    expect(link.origin).toBe("https://shop.example");
    expect(link.pathname).toBe("/landing");
    expect(link.searchParams.get("wr_pass")).toBeTruthy();
  });
});

describe("dashboard", () => {
  const auth = { authorization: `Basic ${btoa("ops:test-dashboard-password")}` };

  it("requires the dashboard credentials", async () => {
    expect((await new Browser().get("/__wr/dashboard")).status).toBe(401);
    expect((await new Browser({ authorization: `Basic ${btoa("ops:wrong")}` }).get("/__wr/dashboard/data")).status).toBe(401);
    expect((await new Browser({ authorization: `Basic ${btoa("prometheus:test-metrics-password")}` }).get("/__wr/dashboard")).status).toBe(401);
    const off = { ...E, WR_DASHBOARD_PASSWORD: undefined };
    expect((await new Browser(auth).get("/__wr/dashboard", { env: off })).status).toBe(404);
    expect((await new Browser(auth).get("/__wr/dashboard", { method: "POST" })).status).toBe(405);
  });

  it("serves the page with a strict CSP", async () => {
    const r = await new Browser(auth).get("/__wr/dashboard");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /'nonce-([0-9a-f]+)'/.exec(csp)![1]!;
    const html = await r.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("{{");
    expect(html).not.toContain("<!--"); // minified by scripts/build-templates.mjs
    expect(html).toContain("Share of queue places"); // help texts of the tooltips
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("applies admin changes from the dashboard page only", async () => {
    const json = { "content-type": "application/json" };
    const put = (headers: Record<string, string>, auth2: Record<string, string> = auth) =>
      new Browser(auth2).get("/__wr/dashboard/admin/mode", { method: "PUT", headers, body: JSON.stringify({ mode: "queue_all" }) });
    const mode = async () => ((await (await new Browser(auth).get("/__wr/dashboard/admin/state")).json()) as { mode: string }).mode;
    expect((await new Browser().get("/__wr/dashboard/admin/state")).status).toBe(401);
    expect((await put({ ...json, origin: "https://shop.example" }, {})).status).toBe(401);
    // Cross-site forgeries: no Origin, another Origin, a form content type, Sec-Fetch-Site cross-site.
    expect((await put(json)).status).toBe(403);
    expect((await put({ ...json, origin: "https://evil.example" })).status).toBe(403);
    expect((await put({ "content-type": "text/plain", origin: "https://shop.example" })).status).toBe(403);
    expect((await put({ ...json, origin: "https://shop.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await mode()).toBe("on");
    const ok = await put({ ...json, origin: "https://shop.example", "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(await mode()).toBe("queue_all");
    const back = await new Browser(auth).get("/__wr/dashboard/admin/mode", { method: "PUT", headers: { ...json, origin: "https://shop.example" }, body: JSON.stringify({ mode: "on" }) });
    expect(back.status).toBe(200);
    expect(await mode()).toBe("on");
    // Validation is the admin API's.
    const bad = await new Browser(auth).get("/__wr/dashboard/admin/config", { method: "PATCH", headers: { ...json, origin: "https://shop.example" }, body: JSON.stringify({ admissionsPerMinute: -1 }) });
    expect(bad.status).toBe(400);
  });

  it("serves the controls of the page", async () => {
    const html = await (await new Browser(auth).get("/__wr/dashboard")).text();
    for (const id of ['id="controls"', 'data-mode="off"', 'id="f-rate"', 'id="f-wl"', 'id="f-pass"', 'id="f-cfg"']) expect(html).toContain(id);
  });

  it("returns the global and the isolate views", async () => {
    const b = new Browser();
    await b.get("/");
    await b.get("/");
    const r = await new Browser(auth).get("/__wr/dashboard/data");
    expect(r.status).toBe(200);
    const d = (await r.json()) as {
      room: string;
      coordinator: { state: { mode: string }; history: Record<string, number[]> };
      edge: { isolateId: string; calls: Record<string, number> };
    };
    expect(d.room).toBe(E.ROOM_ID);
    expect(d.coordinator.state.mode).toBe("on");
    expect(d.coordinator.history.req_flush).toHaveLength(60);
    expect(d.edge.isolateId).toBe(getIsolate().core.isolateId);
    expect(d.edge.calls["admin:dashboard"]).toBe(1);
  });
});
