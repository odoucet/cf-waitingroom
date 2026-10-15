// SPDX-License-Identifier: Apache-2.0
//
// Administration API v1 (public interface, see docs/interfaces.md).
// Bearer token (WR_ADMIN_TOKEN), compared in constant time.
//
//   GET    /__wr/admin/v1/preflight  checks before routes are switched (served even when misconfigured)
//   GET    /__wr/admin/v1/state
//   PATCH  /__wr/admin/v1/config     partial RoomConfig
//   PUT    /__wr/admin/v1/mode       { "mode": "off" | "on" | "queue_all" }
//   PUT    /__wr/admin/v1/pause      { "paused": true | false }
//   GET    /__wr/admin/v1/whitelist
//   POST   /__wr/admin/v1/whitelist  { "entries": [{ "cidr": "...", "label": "..." }] }
//   DELETE /__wr/admin/v1/whitelist  { "cidrs": ["..."] }
//   POST   /__wr/admin/v1/pass       { "label": "...", "ttlSeconds": 3600, "path": "/", "host": "shop.example.com" }
//          (host defaults to the request's host; required on an operator hostname)

import { tokens } from "../shared/cookies.js";
import { getKeyRing, secretEquals } from "../shared/crypto.js";
import type { AdminOp, AdminResult, Mode, RoomConfig, Snapshot } from "../shared/types.js";
import { baseConfigError, type EdgeEnv, failModeOf, staleTtlsOf } from "./env.js";
import { isAdminHost } from "./hosts.js";
import { json, readBodyLimited } from "./http.js";
import type { Isolate } from "./isolate.js";
import { logEvent } from "./log.js";

export const ADMIN_PREFIX = "/__wr/admin/v1/";
export const PREFLIGHT_PATH = `${ADMIN_PREFIX}preflight`;
const MAX_BODY = 64 * 1024;
const MAX_PASS_TTL = 30 * 86_400;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

async function authorized(request: Request, env: EdgeEnv): Promise<boolean> {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ") || !env.WR_ADMIN_TOKEN) return false;
  return secretEquals(h.slice(7).trim(), env.WR_ADMIN_TOKEN);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await readBodyLimited(request, MAX_BODY);
  if (raw === null) throw new Error(`body too large (at most ${MAX_BODY} bytes)`);
  const text = new TextDecoder().decode(raw);
  if (text.trim() === "") return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("body must be a JSON object");
  return v as Record<string, unknown>;
}

async function rpc(iso: Isolate, env: EdgeEnv, op: AdminOp): Promise<Response> {
  const r = (await iso.call(env, `admin:${op.op}`, (stub) => stub.admin(op) as unknown as Promise<AdminResult>, 5000)) as AdminResult | undefined;
  if (!r) return json({ error: "coordinator unavailable" }, 503);
  if (!r.ok) return json({ error: r.error }, 400);
  if (op.op !== "state" && op.op !== "metrics") await iso.invalidate(env);
  return json(r.data);
}

/**
 * Everything the Worker needs before it takes protected traffic: room id,
 * coordinator binding (and a call to it), keys, fail mode. 200 when ready,
 * 503 with the list of problems otherwise. Error messages never carry secrets.
 */
async function preflight(env: EdgeEnv, iso: Isolate): Promise<Response> {
  const errors: string[] = [];
  const base = baseConfigError(env);
  if (base) errors.push(base);
  try {
    await getKeyRing(env.WR_KEYS, env.WR_KEY_CURRENT);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (failModeOf(env) === null) errors.push("FAIL_MODE must be open or closed");
  if (env.STALE_SNAPSHOT_TTLS !== undefined && String(staleTtlsOf(env)) !== env.STALE_SNAPSHOT_TTLS.trim()) errors.push("STALE_SNAPSHOT_TTLS must be an integer from 1 to 6");
  const botBypass = env.BOT_HEADER && env.WR_BOT_SECRET ? "enabled" : "disabled";
  if (botBypass === "enabled" && env.WR_BOT_SECRET!.length < 32) errors.push("WR_BOT_SECRET must be at least 32 characters");
  let coordinator = "skipped";
  if (!base) {
    const s = await iso.call(env, "preflight", (stub) => stub.getSnapshot() as unknown as Promise<Snapshot>, 5000);
    coordinator = s ? "ok" : "unavailable";
    if (!s) errors.push("coordinator unavailable");
    if (s?.config?.reserveVerifier === "turnstile" && !env.WR_TURNSTILE_SECRET) errors.push("reserveVerifier is turnstile but WR_TURNSTILE_SECRET is not set");
  }
  const ok = errors.length === 0;
  logEvent(env, ok ? "info" : "error", "preflight", { ok, errors }, true);
  return json({ ok, room: env.ROOM_ID ?? null, failMode: env.FAIL_MODE ?? null, coordinator, botBypass, errors }, ok ? 200 : 503);
}

export async function handleAdmin(request: Request, url: URL, env: EdgeEnv, iso: Isolate): Promise<Response> {
  if (!env.WR_ADMIN_TOKEN) return json({ error: "administration is disabled (WR_ADMIN_TOKEN is not set)" }, 404);
  if (!(await authorized(request, env))) {
    logEvent(env, "warn", "admin_denied", { path: url.pathname }, true);
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="wr-admin"' });
  }
  return dispatchAdmin(request, url, `${request.method} ${url.pathname.slice(ADMIN_PREFIX.length)}`, env, iso, "api");
}

/**
 * Admin operations, once the caller is authenticated: by the admin token (API)
 * or by the dashboard credentials (dashboard controls). `route` is
 * "<METHOD> <path after the prefix>".
 */
export async function dispatchAdmin(request: Request, url: URL, route: string, env: EdgeEnv, iso: Isolate, via: "api" | "dashboard"): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = request.method === "GET" || request.method === "HEAD" ? {} : await body(request);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  logEvent(env, "info", "admin_request", { route, via, keys: Object.keys(b) }, true);

  switch (route) {
    case "GET preflight":
      return preflight(env, iso);
    case "GET state":
      return rpc(iso, env, { op: "state" });
    case "PATCH config":
      // The coordinator cannot see the edge secrets: check the one Turnstile needs here.
      if (b.reserveVerifier === "turnstile" && !env.WR_TURNSTILE_SECRET) return json({ error: "set the WR_TURNSTILE_SECRET secret before enabling Turnstile" }, 400);
      return rpc(iso, env, { op: "patchConfig", patch: b as Partial<RoomConfig> });
    case "PUT mode":
      return rpc(iso, env, { op: "setMode", mode: b.mode as Mode });
    case "PUT pause":
      if (typeof b.paused !== "boolean") return json({ error: "paused must be a boolean" }, 400);
      return rpc(iso, env, { op: "setPause", paused: b.paused });
    case "GET whitelist": {
      const r = (await iso.call(env, "admin:state", (stub) => stub.admin({ op: "state" }) as unknown as Promise<AdminResult>, 5000)) as AdminResult | undefined;
      if (!r?.ok) return json({ error: "coordinator unavailable" }, 503);
      return json((r.data as { config: RoomConfig }).config.whitelist);
    }
    case "POST whitelist":
      if (!Array.isArray(b.entries)) return json({ error: "entries must be an array" }, 400);
      return rpc(iso, env, { op: "whitelistAdd", entries: b.entries as { cidr: string; label: string }[] });
    case "DELETE whitelist":
      if (!Array.isArray(b.cidrs)) return json({ error: "cidrs must be an array" }, 400);
      return rpc(iso, env, { op: "whitelistRemove", cidrs: b.cidrs.map(String) });
    case "POST pass": {
      const label = typeof b.label === "string" ? b.label.slice(0, 32) : "";
      const ttl = typeof b.ttlSeconds === "number" ? Math.floor(b.ttlSeconds) : 3600;
      const path = typeof b.path === "string" ? b.path : "/";
      if (label === "") return json({ error: "label is required" }, 400);
      if (ttl < 60 || ttl > MAX_PASS_TTL) return json({ error: `ttlSeconds must be between 60 and ${MAX_PASS_TTL}` }, 400);
      // The link must point to a site hostname, never to an operator hostname (which serves nothing else).
      let origin = url.origin;
      if (typeof b.host === "string") {
        const host = b.host.toLowerCase();
        if (!HOSTNAME_RE.test(host) || isAdminHost(host, env)) return json({ error: "host must be a site hostname" }, 400);
        origin = `https://${host}`;
      } else if (isAdminHost(url.hostname, env)) {
        return json({ error: "host is required on an operator hostname" }, 400);
      }
      const ring = await getKeyRing(env.WR_KEYS, env.WR_KEY_CURRENT);
      const expirySec = Math.floor(Date.now() / 1000) + ttl;
      // Bound to the link's hostname: the same keys and room on another hostname do not accept it.
      const token = await tokens.sealPass(ring, env.ROOM_ID, new URL(origin).hostname, { expirySec, label });
      let link: URL;
      try {
        link = new URL(path, origin);
      } catch {
        return json({ error: "path is invalid" }, 400);
      }
      // A backslash or a double slash ("/\evil.example", "//evil.example") resolves to another host.
      if (!path.startsWith("/") || link.origin !== origin) return json({ error: "path must be a path on this host" }, 400);
      link.searchParams.set("wr_pass", token);
      logEvent(env, "info", "pass_created", { label, expirySec, host: link.host }, true);
      return json({ url: link.toString(), label, expiresAt: new Date(expirySec * 1000).toISOString() });
    }
    default:
      return json({ error: "not found" }, 404);
  }
}
