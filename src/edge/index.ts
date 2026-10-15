// SPDX-License-Identifier: Apache-2.0
//
// Edge script: fetch handler of the waiting room.
//
// An operator hostname (ADMIN_HOSTS) only serves admin, metrics and dashboard.
// Decision order for a protected request:
//   1. early exit (GET/HEAD, static extensions/prefixes)  -> relay, no I/O
//      base configuration invalid (room id, binding, keys) -> 503, never the origin
//   2. /__wr/* (reserve, status; admin, metrics, dashboard unless ADMIN_HOSTS is set)
//   3. valid session cookie (not revoked)                 -> relay, zero coordinator call once the
//      isolate holds a snapshot (a cold isolate gets one first; unavailable -> fail mode)
//   4. whitelist: secret header, verified bot, bypass cookie, signed link
//   5. snapshot (memory, data-center cache, coordinator); mode off -> relay; IP whitelist
//   6. ticket due                                         -> session, relay
//   7. open mode: first visit -> relay + provisional cookie; second -> leased slot, session
//   8. otherwise                                          -> waiting page
// Coordinator errors go through the fail mode (FAIL_MODE variable, closed when unset or invalid).

import { clearCookie, cookieName, type ProvisionalToken, readRoomCookies, setCookie, tokens } from "../shared/cookies.js";
import { getKeyRing, type KeyRing, randomHex, secretEquals } from "../shared/crypto.js";
import { DASHBOARD_ADMIN_PREFIX, DASHBOARD_DATA_PATH, DASHBOARD_PATH } from "../shared/dashboard.js";
import { verifyPow } from "../shared/pow.js";
import { minuteOf } from "../shared/time.js";
import type { FailMode, ReserveResult, RoomConfig } from "../shared/types.js";
import { ADMIN_PREFIX, handleAdmin, PREFLIGHT_PATH } from "./admin.js";
import { handleDashboard, handleDashboardAdmin } from "./dashboard.js";
import { isEarlyExit } from "./early-exit.js";
import { baseConfigError, type EdgeEnv, failModeOf, staleTtlsOf } from "./env.js";
import { adminHostsSet, isAdminHost } from "./hosts.js";
import { clientIp, json, readBodyLimited, withCookies } from "./http.js";
import { getIsolate, type Isolate } from "./isolate.js";
import { logEvent } from "./log.js";
import { handleMetrics, METRICS_PATH } from "./metrics.js";
import { RESERVE_PATH, STATUS_PATH, unavailableResponse, waitingResponse, type WaitingTicket } from "./waiting.js";

export type { EdgeEnv } from "./env.js";

interface Ctx {
  request: Request;
  url: URL;
  env: EdgeEnv;
  ctx: ExecutionContext;
  iso: Isolate;
  ring: KeyRing;
  room: string;
  now: number;
  failMode: FailMode;
}

function names(room: string) {
  return { s: cookieName("s", room), t: cookieName("t", room), u: cookieName("u", room), b: cookieName("b", room) };
}

/** Relays to the origin (through the zone cache), untouched unless cookies must be set. */
async function relay(c: Ctx, cookies: string[] = [], request: Request = c.request): Promise<Response> {
  c.iso.maybeFlush(c.env, c.ctx);
  const resp = await fetch(request);
  return withCookies(resp, cookies);
}

/**
 * Coordinator unavailable: fail open (relay) or closed (static 503), always
 * logged. Never depends on the room configuration, which a cold isolate does
 * not have yet.
 */
async function failMode(c: Ctx, reason: string, cookies: string[]): Promise<Response> {
  logEvent(c.env, "error", "fail_mode", { reason, failMode: c.failMode, path: c.url.pathname }, true);
  if (c.failMode === "open") {
    c.iso.core.counters.failOpen++;
    return relay(c, cookies);
  }
  return unavailableResponse(c.request, cookies);
}

async function newProvisional(c: Ctx): Promise<{ cookie: string; nonce: string }> {
  const nonce = randomHex(8);
  const value = await tokens.sealProvisional(c.ring, c.room, { nonce, issuedSec: Math.floor(c.now / 1000) });
  const maxAge = c.iso.core.config?.provisionalWindowSec ?? 600;
  return { cookie: setCookie(names(c.room).u, value, maxAge), nonce };
}

async function sessionCookie(c: Ctx, ticketNo: number, config: RoomConfig): Promise<string> {
  const nowMin = minuteOf(c.now);
  const value = await tokens.sealSession(c.ring, c.room, { ticketNo, tag: c.iso.core.tag, issuedMinute: nowMin, countedMinute: nowMin, flags: 0 });
  return setCookie(names(c.room).s, value, config.sessionMinutes * 60);
}

async function handleProtected(c: Ctx): Promise<Response> {
  const { request, url, env, iso, ring, room, now } = c;
  const core = iso.core;
  const n = names(room);
  const nowMin = minuteOf(now);
  const nowSec = Math.floor(now / 1000);
  const ck = readRoomCookies(request.headers.get("cookie"), room);
  const out: string[] = [];
  /** Result of a snapshot load already attempted by this request. */
  let ready: boolean | undefined;

  // 3. Valid session: zero coordinator call, origin response streamed as is.
  // Sliding expiry after D idle minutes, within a total lifetime of sessionMaxMinutes.
  if (ck.s) {
    const s = await tokens.openSession(ring, room, ck.s);
    // Idle expiry, total lifetime and revocations come with the snapshot: a cold isolate loads it
    // before honouring a session (after the signature check: a forged cookie costs no call).
    // Without it, the session is neither honoured, renewed nor cleared: step 5 applies the fail mode.
    if (s && !core.config) ready = await iso.ensureSnapshot(env, c.ctx);
    const cfg = core.config;
    let refused: string | null = s ? null : "invalid";
    if (s && cfg) {
      const D = cfg.sessionMinutes;
      // A total lifetime shorter than D would make no sense: the larger of the two applies.
      const left = Math.max(cfg.sessionMaxMinutes, D) - (nowMin - s.issuedMinute);
      refused = core.isRevoked(s.ticketNo, s.tag) ? "revoked" : nowMin - s.countedMinute >= D ? "expired" : left <= 0 ? "max_age" : null;
      if (refused === null) {
        if (!core.countSession(s.countedMinute, nowMin)) return relay(c);
        const value = await tokens.sealSession(ring, room, { ...s, countedMinute: nowMin });
        return relay(c, [setCookie(n.s, value, Math.min(D, left) * 60)]);
      }
    }
    if (refused !== null) {
      core.counters.sessionRefused++;
      logEvent(env, "info", "session_refused", { reason: refused }, false);
      out.push(clearCookie(n.s));
    }
  }

  // 4. Whitelist that needs no snapshot.
  const ip = clientIp(request);
  if (env.BYPASS_HEADER && env.WR_BYPASS_SECRET) {
    const v = request.headers.get(env.BYPASS_HEADER);
    if (v !== null) {
      if (await secretEquals(v, env.WR_BYPASS_SECRET)) {
        core.counters.headerBypass++;
        core.countWhitelistedClient(`h:${ip}`, nowMin);
        const stripped = new Request(request);
        stripped.headers.delete(env.BYPASS_HEADER);
        logEvent(env, "info", "bypass", { kind: "header" }, false);
        return relay(c, out, stripped);
      }
      core.counters.bypassRefused++;
      logEvent(env, "warn", "bypass_refused", { kind: "header" }, false);
    }
  }
  // Verified bot: the Transform Rule sets the header to WR_BOT_SECRET, never a guessable value, so
  // that a client cannot forge it even where the rules are missing or out of order.
  if (env.BOT_HEADER && env.WR_BOT_SECRET) {
    const v = request.headers.get(env.BOT_HEADER);
    if (v !== null && v !== "") {
      if (await secretEquals(v, env.WR_BOT_SECRET)) {
        core.counters.botBypass++;
        core.countWhitelistedClient(`bot:${ip}`, nowMin);
        const stripped = new Request(request);
        stripped.headers.delete(env.BOT_HEADER);
        logEvent(env, "info", "bypass", { kind: "bot" }, false);
        return relay(c, out, stripped);
      }
      core.counters.bypassRefused++;
      logEvent(env, "warn", "bypass_refused", { kind: "bot" }, false);
    }
  }
  if (ck.b) {
    const b = await tokens.openBypass(ring, room, url.hostname, ck.b);
    if (b && b.expirySec > nowSec) {
      if (core.countBypassCookie(b.countedMinute, nowMin)) {
        const value = await tokens.sealBypass(ring, room, url.hostname, { ...b, countedMinute: nowMin });
        out.push(setCookie(n.b, value, b.expirySec - nowSec));
      }
      logEvent(env, "info", "bypass", { kind: "cookie", label: b.label }, false);
      return relay(c, out);
    }
    out.push(clearCookie(n.b));
  }
  if (url.search.includes("wr_pass=")) {
    const token = url.searchParams.get("wr_pass") ?? "";
    const p = await tokens.openPass(ring, room, url.hostname, token);
    if (p && p.expirySec > nowSec) {
      core.counters.passBypass++;
      const value = await tokens.sealBypass(ring, room, url.hostname, { expirySec: p.expirySec, countedMinute: 0, label: p.label });
      const target = new URL(url);
      target.searchParams.delete("wr_pass");
      logEvent(env, "info", "pass_used", { label: p.label, expirySec: p.expirySec }, true);
      // Collapse leading slashes: "//evil.example/x" would be a protocol-relative redirect to another host.
      const location = target.pathname.replace(/^\/+/, "/") + target.search;
      const h = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      for (const x of [...out, setCookie(n.b, value, p.expirySec - nowSec)]) h.append("Set-Cookie", x);
      return new Response(null, { status: 302, headers: h });
    }
    core.counters.passRefused++;
    logEvent(env, "warn", "pass_refused", { reason: p ? "expired" : "invalid" }, false);
  }

  // 5. Everything below needs the global state.
  if (!(ready ?? (await iso.ensureSnapshot(env, c.ctx))) || !core.snapshot || !core.config) return failMode(c, "no_snapshot", out);
  const snap = core.snapshot;
  const cfg = core.config;
  if (snap.mode === "off") return relay(c, out);
  const wl = core.whitelist.match(ip);
  if (wl !== null) {
    core.counters.ipBypass++;
    core.countWhitelistedClient(`ip:${ip}`, nowMin);
    logEvent(env, "info", "bypass", { kind: "ip", label: wl }, false);
    return relay(c, out);
  }

  // 6. Ticket.
  let ticket: WaitingTicket | null = null;
  if (ck.t) {
    const t = await tokens.openTicket(ring, room, ck.t);
    const state = t ? core.ticketState(t.ticketNo, t.admitAtMs, now) : "invalid";
    if (t && state === "admit") {
      core.recordRedeem(t.ticketNo, t.admitAtMs, now);
      out.push(await sessionCookie(c, t.ticketNo, cfg), clearCookie(n.t), clearCookie(n.u));
      logEvent(env, "info", "admit", { path: "ticket", ticketNo: t.ticketNo, waitedSec: Math.round(now / 1000 - t.issuedSec) }, false);
      return relay(c, out);
    }
    if (t && state === "wait") {
      ticket = { ticketNo: t.ticketNo, signedAdmitAtMs: t.admitAtMs, admitAtMs: core.effectiveAdmitAt(t.ticketNo, t.admitAtMs) };
    } else {
      if (t && state === "duplicate") core.recordDuplicate(t.ticketNo);
      core.counters.ticketRefused++;
      logEvent(env, "warn", "ticket_refused", { reason: state, ticketNo: t?.ticketNo }, false);
      out.push(clearCookie(n.t));
    }
  }

  // 7. Open mode, provisional cookie.
  let provisional: ProvisionalToken | null = null;
  if (!ticket) {
    const u = ck.u ? await tokens.openProvisional(ring, room, ck.u) : null;
    const age = u ? nowSec - u.issuedSec : 0;
    const provisionalOk = u !== null && age >= -5 && age < cfg.provisionalWindowSec && !core.isProvisionalClaimed(u.nonce, nowSec);
    let d = core.decideNew(now, provisionalOk, false);
    if (d.kind === "need-lease") {
      const ok = await iso.flush(env, c.ctx, true, iso.timeoutMs(env));
      if (!ok) return failMode(c, "lease_refill_failed", out);
      d = core.decideNew(Date.now(), provisionalOk, true);
    }
    switch (d.kind) {
      case "relay":
        return relay(c, out);
      case "relay-provisional":
        if (!provisionalOk) out.push((await newProvisional(c)).cookie);
        return relay(c, out);
      case "admit-lease":
        core.claimProvisional(u!.nonce, u!.issuedSec + cfg.provisionalWindowSec, nowSec);
        out.push(await sessionCookie(c, 0, cfg), clearCookie(n.u));
        logEvent(env, "info", "admit", { path: "lease" }, false);
        return relay(c, out);
      case "wait":
        if (provisionalOk) provisional = u;
        else {
          const p = await newProvisional(c);
          out.push(p.cookie);
          provisional = { nonce: p.nonce, issuedSec: nowSec };
        }
        break;
    }
  }

  // 8. Waiting page.
  core.counters.waitingPages++;
  iso.maybeFlush(env, c.ctx);
  logEvent(env, "info", "waiting", { method: request.method, ticketNo: ticket?.ticketNo, open: snap.open, paused: snap.paused }, false);
  return waitingResponse(request, cfg, { room, ticket, provisional, paused: snap.paused, cookies: out, now });
}

/** Siteverify; the token must have been obtained on this very hostname (a site key may serve several). */
async function verifyTurnstile(c: Ctx, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token === "" || !c.env.WR_TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.append("secret", c.env.WR_TURNSTILE_SECRET);
  form.append("response", token);
  const ip = clientIp(c.request);
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = (await r.json()) as { success?: boolean; hostname?: string };
    return j.success === true && j.hostname === c.url.hostname;
  } catch {
    return false;
  }
}

const RESERVE_MAX_BODY = 4096;

/** Reads at most RESERVE_MAX_BODY bytes of the body; larger bodies are not parsed. */
async function reserveBody(request: Request): Promise<{ pow?: unknown; turnstileToken?: unknown }> {
  try {
    const raw = await readBodyLimited(request, RESERVE_MAX_BODY);
    if (!raw || raw.length === 0) return {};
    const v: unknown = JSON.parse(new TextDecoder().decode(raw));
    return typeof v === "object" && v !== null ? (v as { pow?: unknown; turnstileToken?: unknown }) : {};
  } catch {
    return {};
  }
}

/** POST /__wr/reserve: hands out an admission slot to a visitor holding a provisional cookie. */
async function handleReserve(c: Ctx): Promise<Response> {
  const { request, env, iso, ring, room, now } = c;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
  // Browsers say where the call comes from; the waiting page calls from the same origin.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    iso.core.counters.reserveCrossSite++;
    logEvent(env, "warn", "reserve_refused", { reason: "cross_site", site: site.slice(0, 32) }, false);
    return json({ error: "cross_site" }, 403);
  }
  const core = iso.core;
  const n = names(room);
  const ck = readRoomCookies(request.headers.get("cookie"), room);
  const nowSec = Math.floor(now / 1000);
  const u = ck.u ? await tokens.openProvisional(ring, room, ck.u) : null;
  if (!u) return noProvisional(c);
  if (!(await iso.ensureSnapshot(env, c.ctx)) || !core.config) return reserveFailure(c, null, "no_snapshot");
  const cfg = core.config;
  // Mode off: no new ticket; the page reloads and is relayed.
  if (core.snapshot?.mode === "off") return json({ status: "admitted" });
  // A valid ticket is returned as is: reloading the page never takes a second slot.
  if (ck.t) {
    const t = await tokens.openTicket(ring, room, ck.t);
    if (t && core.ticketState(t.ticketNo, t.admitAtMs, now) !== "expired") {
      return json({ status: "waiting", ticketNo: t.ticketNo, admitAtMs: core.effectiveAdmitAt(t.ticketNo, t.admitAtMs), serverTime: now });
    }
  }
  // Same window as the browser cookie (Max-Age) and the coordinator nonce table.
  const age = nowSec - u.issuedSec;
  if (age < -5 || age > cfg.provisionalWindowSec) return noProvisional(c);
  // Counted exactly, logged with sampling: these refusals are the ones a flood produces.
  if (nowSec - u.issuedSec < cfg.reserveMinAgeSec) {
    core.counters.reserveTooEarly++;
    logEvent(env, "warn", "reserve_refused", { reason: "too_early" }, false);
    return json({ status: "retry", error: "too_early", retryAfterSec: 1 }, 429, { "Retry-After": "1" });
  }
  const body = await reserveBody(request);
  if (!(await verifyPow(room, u.nonce, body.pow, cfg.reservePowBits))) {
    core.counters.reservePowFailed++;
    logEvent(env, "warn", "reserve_refused", { reason: "pow" }, false);
    return json({ error: "pow_failed" }, 403);
  }
  // Without its secret, Turnstile cannot be checked: rather than refusing every visitor forever, the
  // reservation relies on the other checks (proof of work) and the misconfiguration is logged.
  const turnstile = cfg.reserveVerifier === "turnstile" && !!env.WR_TURNSTILE_SECRET;
  if (cfg.reserveVerifier === "turnstile" && !turnstile && !iso.turnstileWarned) {
    iso.turnstileWarned = true;
    logEvent(env, "error", "misconfigured", { reason: "reserveVerifier is turnstile but WR_TURNSTILE_SECRET is not set: Turnstile skipped" }, true);
  }
  if (turnstile) {
    if (!(await verifyTurnstile(c, body.turnstileToken))) {
      core.counters.reserveTurnstileFailed++;
      logEvent(env, "warn", "reserve_refused", { reason: "turnstile" }, false);
      return json({ error: "verification_failed" }, 403);
    }
  }

  // Bounds the load one isolate can put on the coordinator during a flood.
  if (iso.reserveInflight >= cfg.reserveMaxInflight) {
    core.counters.reserveBusy++;
    logEvent(env, "warn", "reserve_refused", { reason: "busy" }, false);
    const retry = String(2 + Math.floor(Math.random() * 4));
    return json({ status: "retry", error: "busy", retryAfterSec: Number(retry) }, 503, { "Retry-After": retry });
  }
  // No batch here: deltas only travel through Isolate.flush(), one batch at a time.
  iso.reserveInflight++;
  let r: ReserveResult | undefined;
  try {
    const opts = { issuedSec: u.issuedSec, knownGen: core.gen };
    r = (await iso.call(env, "reserve", (stub) => stub.reserve(u.nonce, null, opts) as unknown as Promise<ReserveResult>, iso.timeoutMs(env))) as ReserveResult | undefined;
  } finally {
    iso.reserveInflight--;
  }
  if (!r) return reserveFailure(c, cfg, "reserve_failed");
  core.applySnapshot(r.snapshot, Date.now());
  iso.maybeFlush(env, c.ctx);
  if (r.refused === "expired") return noProvisional(c);
  if (r.refused === "off") return json({ status: "admitted" });
  if (r.refused === "full") {
    logEvent(env, "warn", "reserve_refused", { reason: "full" }, true);
    const retry = String(30 + Math.floor(Math.random() * 30));
    return json({ status: "retry", error: "full", retryAfterSec: Number(retry) }, 503, { "Retry-After": retry });
  }
  const value = await tokens.sealTicket(ring, room, { ticketNo: r.ticketNo, admitAtMs: r.admitAtMs, issuedSec: nowSec });
  const maxAge = Math.max(60, Math.ceil((r.admitAtMs - now) / 1000) + cfg.redeemGraceSec);
  logEvent(env, "info", "reserve", { ticketNo: r.ticketNo, waitSec: Math.round((r.admitAtMs - now) / 1000) }, true);
  return json(
    { status: "waiting", ticketNo: r.ticketNo, admitAtMs: core.effectiveAdmitAt(r.ticketNo, r.admitAtMs), serverTime: now },
    200,
    {},
    [setCookie(n.t, value, maxAge)],
  );
}

/** No usable provisional cookie: the waiting page reloads and gets a fresh one. */
function noProvisional(c: Ctx): Response {
  c.iso.core.counters.reserveNoProvisional++;
  logEvent(c.env, "warn", "reserve_refused", { reason: "no_provisional_cookie" }, false);
  return json({ error: "no_provisional_cookie" }, 403, {}, [clearCookie(names(c.room).u)]);
}

async function reserveFailure(c: Ctx, cfg: RoomConfig | null, reason: string): Promise<Response> {
  // While visitors queue, a failed reservation never turns into a session: a
  // coordinator overloaded by a flood of reservations must not open the room.
  const queueing = c.iso.core.snapshot?.open === false;
  const mode = queueing ? "retry" : c.failMode;
  logEvent(c.env, "error", "fail_mode", { reason, failMode: mode, path: RESERVE_PATH }, true);
  if (mode === "open" && cfg) {
    c.iso.core.counters.failOpen++;
    return json({ status: "admitted" }, 200, {}, [await sessionCookie(c, 0, cfg), clearCookie(names(c.room).u)]);
  }
  if (mode === "open") {
    c.iso.core.counters.failOpen++;
    return json({ status: "admitted" });
  }
  const retry = String(5 + Math.floor(Math.random() * 10));
  return json({ status: "retry", retryAfterSec: Number(retry) }, 503, { "Retry-After": retry });
}

/** GET /__wr/status: served from the snapshot (memory or data-center cache), no coordinator call in steady state. */
async function handleStatus(c: Ctx): Promise<Response> {
  const core = c.iso.core;
  if (!(await c.iso.ensureSnapshot(c.env, c.ctx)) || !core.snapshot) return json({ error: "unavailable" }, 503);
  const s = core.snapshot;
  return json({ mode: s.mode, paused: s.paused, open: s.open, earlyUpTo: s.earlyUpTo, pauseOffsets: s.pauseOffsets, serverTime: c.now });
}

/** Administration API, metrics and dashboard; null for any other path. */
function handleOperator(request: Request, url: URL, env: EdgeEnv, iso: Isolate): Promise<Response> | null {
  const p = url.pathname;
  if (p === METRICS_PATH) return handleMetrics(request, env, iso);
  if (p === DASHBOARD_PATH || p === DASHBOARD_DATA_PATH) return handleDashboard(request, url, env, iso);
  if (p.startsWith(DASHBOARD_ADMIN_PREFIX)) return handleDashboardAdmin(request, url, env, iso);
  if (p.startsWith(ADMIN_PREFIX)) return handleAdmin(request, url, env, iso);
  return null;
}

async function handleReserved(c: Ctx): Promise<Response> {
  const p = c.url.pathname;
  if (p === RESERVE_PATH) return handleReserve(c);
  if (p === STATUS_PATH) return handleStatus(c);
  // With ADMIN_HOSTS set, operator endpoints do not exist on the site's hostnames.
  const op = adminHostsSet(c.env) ? null : handleOperator(c.request, c.url, c.env, c.iso);
  return op ?? json({ error: "not found" }, 404);
}

/**
 * Base configuration unusable (room id, coordinator binding, keys): protected
 * paths answer 503, never the origin. A deployment mistake must not open the room.
 */
function misconfigured(request: Request, env: EdgeEnv, reason: string, reserved: boolean): Response {
  logEvent(env, "error", "misconfigured", { reason }, true);
  return reserved ? json({ error: "misconfigured" }, 500) : unavailableResponse(request, []);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // An operator hostname serves the operator endpoints and nothing else: no
    // queue, no relay to the origin.
    const operatorHost = isAdminHost(url.hostname, env);
    if (!operatorHost && isEarlyExit(request.method, url.pathname, env)) return fetch(request);
    const reserved = operatorHost || url.pathname.startsWith("/__wr/");
    const iso = getIsolate();
    // The preflight check reports configuration errors: it must answer before they are refused.
    if (url.pathname === PREFLIGHT_PATH && (operatorHost || !adminHostsSet(env))) return handleAdmin(request, url, env, iso);
    const invalid = baseConfigError(env);
    if (invalid) return misconfigured(request, env, invalid, reserved);
    const failMode = failModeOf(env);
    if (failMode === null && !iso.failModeChecked) {
      logEvent(env, "error", "misconfigured", { reason: "FAIL_MODE must be open or closed, failing closed" }, true);
    }
    iso.failModeChecked = true;
    iso.core.maxStaleTtls = staleTtlsOf(env);
    if (operatorHost) return handleOperator(request, url, env, iso) ?? json({ error: "not found" }, 404);
    let ring: KeyRing;
    try {
      ring = await getKeyRing(env.WR_KEYS, env.WR_KEY_CURRENT);
    } catch (e) {
      return misconfigured(request, env, (e as Error).message, reserved);
    }
    const c: Ctx = { request, url, env, ctx, iso, ring, room: env.ROOM_ID, now: Date.now(), failMode: failMode ?? "closed" };
    return reserved ? handleReserved(c) : handleProtected(c);
  },
} satisfies ExportedHandler<EdgeEnv>;
