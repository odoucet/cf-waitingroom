// SPDX-License-Identifier: Apache-2.0
//
// HTTP basic authentication, used by the metrics endpoint and the dashboards.

import { secretEquals } from "./crypto.js";

/** True when the request carries `user:password`. Both are compared in constant time. */
export async function basicAuthOk(request: Request, user: string | undefined, password: string | undefined): Promise<boolean> {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ") || !user || !password) return false;
  let decoded: string;
  try {
    decoded = atob(h.slice(6).trim());
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const [u, p] = await Promise.all([secretEquals(decoded.slice(0, i), user), secretEquals(decoded.slice(i + 1), password)]);
  return u && p;
}

export function unauthorized(realm: string): Response {
  return new Response("unauthorized\n", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`, "Cache-Control": "no-store" },
  });
}
