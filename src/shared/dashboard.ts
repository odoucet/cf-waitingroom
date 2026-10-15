// SPDX-License-Identifier: Apache-2.0
//
// Read-only dashboard served by the edge handler behind basic auth
// (WR_DASHBOARD_USER / WR_DASHBOARD_PASSWORD): a static page that renders the
// JSON of DASHBOARD_DATA_PATH and refreshes it every 10 s while visible. Each
// refresh costs one Durable Object request. The page template itself lives in
// dashboard-template.ts.

import { randomHex } from "./crypto.js";
import type { DashboardData } from "./types.js";
import { VERSION } from "./version.js";

export const DASHBOARD_PATH = "/__wr/dashboard";
export const DASHBOARD_DATA_PATH = "/__wr/dashboard/data";
/** Admin operations of the dashboard controls: the admin API routes, behind the dashboard credentials. */
export const DASHBOARD_ADMIN_PREFIX = "/__wr/dashboard/admin/";
export const DASHBOARD_REALM = "wr-dashboard";

/** Local view of the edge isolate that answered. */
export interface EdgeView {
  isolateId: string;
  colo: string | null;
  uptimeSec: number;
  snapshot: { ageMs: number; ttlMs: number; open: boolean; gen: number } | null;
  lease: { remaining: number; expiresInSec: number };
  pending: { redeemed: number; leaseUsed: number; claims: number; activeMinutes: number };
  calls: Record<string, number>;
  errors: { timeout: number; overloaded: number; other: number };
  cache: { hits: number; misses: number };
  revoked: number;
  whitelist: number;
}

export interface DashboardPayload {
  room: string;
  now: number;
  /** null when the coordinator did not answer. */
  coordinator: DashboardData | null;
  edge: EdgeView;
}

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };

export function renderDashboardPage(request: Request, template: string): Response {
  const nonce = randomHex(12);
  const html = template.replaceAll("{{NONCE}}", nonce);
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      ...HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

export function dashboardData(payload: DashboardPayload): Response {
  return new Response(JSON.stringify({ ...payload, version: VERSION }), {
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}
