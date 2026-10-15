// SPDX-License-Identifier: Apache-2.0
//
// GET /__wr/metrics: Prometheus text exposition, protected by basic auth
// (WR_METRICS_USER / WR_METRICS_PASSWORD). The text is rendered by the
// coordinator (src/shared/prometheus.ts): one Durable Object request per scrape.

import { basicAuthOk, unauthorized } from "../shared/basic-auth.js";
import type { EdgeEnv } from "./env.js";
import type { Isolate } from "./isolate.js";
import { logEvent } from "./log.js";

export const METRICS_PATH = "/__wr/metrics";

export async function handleMetrics(request: Request, env: EdgeEnv, iso: Isolate): Promise<Response> {
  if (!env.WR_METRICS_USER || !env.WR_METRICS_PASSWORD) return new Response("metrics are disabled\n", { status: 404 });
  if (!(await basicAuthOk(request, env.WR_METRICS_USER, env.WR_METRICS_PASSWORD))) {
    logEvent(env, "warn", "metrics_denied", {}, true);
    return unauthorized("wr-metrics");
  }
  const text = (await iso.call(env, "admin:metrics", (stub) => stub.prometheus(env.ROOM_ID), 5000)) as string | undefined;
  if (typeof text !== "string") return new Response("coordinator unavailable\n", { status: 503 });
  return new Response(text, {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}
