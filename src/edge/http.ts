// SPDX-License-Identifier: Apache-2.0

const SHARED_ONLY = /^(?:public|s-maxage=.*|proxy-revalidate)$/i;
const NOT_SHARED = /^(?:private|no-store)$/i;

/**
 * Cache-Control of a response that carries a waiting-room cookie: browsers may
 * still cache it, shared caches (corporate proxies, another CDN) must not, or
 * they would hand the cookie to other visitors. The zone cache is not affected:
 * it is looked up before the cookie is added.
 */
export function privateCacheControl(cc: string | null): string {
  const kept = (cc ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !SHARED_ONLY.test(d));
  return (kept.some((d) => NOT_SHARED.test(d)) ? kept : ["private", ...kept]).join(", ");
}

/** Cloudflare data center (IATA code) that received the request, if known. */
export function coloOf(request: Request): string | undefined {
  const colo = (request.cf as { colo?: unknown } | undefined)?.colo;
  return typeof colo === "string" ? colo : undefined;
}

/**
 * Adds Set-Cookie headers to an origin response without reading its body
 * (streamed), and makes it private to the browser. WebSocket upgrades are
 * returned untouched.
 */
export function withCookies(resp: Response, cookies: string[]): Response {
  if (cookies.length === 0 || resp.status === 101 || resp.webSocket) return resp;
  const r = new Response(resp.body, resp);
  for (const c of cookies) r.headers.append("Set-Cookie", c);
  r.headers.set("Cache-Control", privateCacheControl(r.headers.get("Cache-Control")));
  r.headers.delete("CDN-Cache-Control");
  r.headers.delete("Surrogate-Control");
  return r;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}, cookies: string[] = []): Response {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** Prefers JSON when the client asks for it and does not ask for HTML first. */
export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const j = accept.indexOf("application/json");
  if (j === -1) return false;
  const h = accept.indexOf("text/html");
  return h === -1 || j < h;
}

export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

/**
 * Reads at most `maxBytes` of the body, refusing a larger Content-Length up
 * front and stopping as soon as the stream goes beyond it: null when too large.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  const reader = request.body.getReader();
  const buf = new Uint8Array(maxBytes);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return buf.subarray(0, size);
    if (size + value.byteLength > maxBytes) {
      await reader.cancel();
      return null;
    }
    buf.set(value, size);
    size += value.byteLength;
  }
}
