// SPDX-License-Identifier: Apache-2.0
//
// /__wr/dashboard/admin/* (the admin API routes, used by the page controls) behind the same
// credentials, which therefore grant administration.
// GET /__wr/dashboard on the operator hostname (ADMIN_HOSTS), else on the site: the coordinator's global view
// plus the local view of the isolate that answered (see shared/dashboard.ts). Basic auth
// (WR_DASHBOARD_USER / WR_DASHBOARD_PASSWORD); 404 when not configured.

import { basicAuthOk, unauthorized } from "../shared/basic-auth.js";
import { DASHBOARD_ADMIN_PREFIX, DASHBOARD_DATA_PATH, DASHBOARD_REALM, dashboardData, type EdgeView, renderDashboardPage } from "../shared/dashboard.js";
import { DASHBOARD_TEMPLATE } from "../shared/dashboard-template.js";
import type { AdminResult, DashboardData } from "../shared/types.js";
import { dispatchAdmin } from "./admin.js";
import type { EdgeEnv } from "./env.js";
import { json } from "./http.js";
import type { Isolate } from "./isolate.js";
import { logEvent } from "./log.js";

function edgeView(request: Request, iso: Isolate, now: number): EdgeView {
  const core = iso.core;
  const s = core.snapshot;
  const colo = (request.cf as { colo?: unknown } | undefined)?.colo;
  return {
    isolateId: core.isolateId,
    colo: typeof colo === "string" ? colo : null,
    uptimeSec: Math.round((now - iso.startedAt) / 1000),
    snapshot: s ? { ageMs: now - core.receivedAt, ttlMs: s.ttlMs, open: s.open, gen: core.gen } : null,
    lease: { remaining: core.lease.remaining, expiresInSec: Math.round((core.lease.exp - now) / 1000) },
    pending: core.pendingSummary(),
    calls: { ...iso.stats.calls },
    errors: { ...iso.stats.errors },
    cache: { hits: iso.stats.cacheHits, misses: iso.stats.cacheMisses },
    revoked: core.revoked.size,
    whitelist: core.config?.whitelist.length ?? 0,
  };
}

/** null when the request carries the dashboard credentials, else the answer to send. */
async function denied(request: Request, env: EdgeEnv): Promise<Response | null> {
  if (!env.WR_DASHBOARD_USER || !env.WR_DASHBOARD_PASSWORD) return json({ error: "not found" }, 404);
  if (await basicAuthOk(request, env.WR_DASHBOARD_USER, env.WR_DASHBOARD_PASSWORD)) return null;
  logEvent(env, "warn", "dashboard_denied", {}, true);
  return unauthorized(DASHBOARD_REALM);
}

/**
 * The browser resends basic auth credentials on any request to this origin,
 * including one forged by another site (CSRF). A change is accepted only from
 * the dashboard page itself: same Origin, JSON body (another site cannot send
 * one without a CORS preflight, which is never granted), and Sec-Fetch-Site
 * same-origin when the browser sends it.
 */
function sameOrigin(request: Request, url: URL): boolean {
  if (request.headers.get("origin") !== url.origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

export async function handleDashboardAdmin(request: Request, url: URL, env: EdgeEnv, iso: Isolate): Promise<Response> {
  const d = await denied(request, env);
  if (d) return d;
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request, url)) {
    logEvent(env, "warn", "dashboard_admin_refused", { reason: "cross-origin", method: request.method }, true);
    return json({ error: "refused: changes are accepted from the dashboard page only" }, 403);
  }
  return dispatchAdmin(request, url, `${request.method} ${url.pathname.slice(DASHBOARD_ADMIN_PREFIX.length)}`, env, iso, "dashboard");
}

export async function handleDashboard(request: Request, url: URL, env: EdgeEnv, iso: Isolate): Promise<Response> {
  const d = await denied(request, env);
  if (d) return d;
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
  if (url.pathname !== DASHBOARD_DATA_PATH) return renderDashboardPage(request, DASHBOARD_TEMPLATE);
  const r = (await iso.call(env, "admin:dashboard", (stub) => stub.admin({ op: "dashboard" }) as unknown as Promise<AdminResult>, 5000)) as AdminResult | undefined;
  const now = Date.now();
  return dashboardData({
    room: env.ROOM_ID,
    now,
    coordinator: r?.ok ? (r.data as DashboardData) : null,
    edge: edgeView(request, iso, now),
  });
}
