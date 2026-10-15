// SPDX-License-Identifier: Apache-2.0
//
// k6 load test of a test hostname routed through the waiting room.
//   k6 run -e BASE_URL=https://wr-test.example.com deploy/k6/load.js
// Each virtual user behaves like a browser: first visit, second page view
// (open mode admission), or waiting page -> proof of work -> reservation ->
// countdown -> reload. Never run it against production without the site
// owner's agreement.
//
// The reservation path is the real one: the proof of work of the waiting page
// is solved (reservePowBits, 14 by default: ~16,000 SHA-256 per ticket, a few
// tens of ms of CPU per virtual user) and the minimum cookie age is honoured.
// Turnstile cannot be solved by a script: for a load test, use a test room with
// reserveVerifier "none" (the proof of work stays on); users that meet a
// Turnstile widget are counted in wr_turnstile_blocked and stop there.
//
// Thresholds: checks, successful reservations, retries (coordinator busy, queue
// full), origin latency, and optionally the admission rate the origin sees
// (MAX_ADMISSIONS_PER_SEC, e.g. R / 60 * 1.2): the room must hold it.

import http from "k6/http";
import crypto from "k6/crypto";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL;
const admitted = new Counter("wr_admitted");
const queued = new Counter("wr_queued");
const turnstileBlocked = new Counter("wr_turnstile_blocked");
const reserveOk = new Rate("wr_reserve_ok");
const reserveRetry = new Rate("wr_reserve_retry");
const waitTime = new Trend("wr_wait_seconds");
const powTime = new Trend("wr_pow_ms");

const thresholds = {
  checks: ["rate>0.99"],
  http_req_failed: ["rate<0.01"],
  wr_reserve_ok: ["rate>0.95"],
  // Busy (reserveMaxInflight), full (maxWaitingTickets), too early: the coordinator or the queue saturates.
  wr_reserve_retry: ["rate<0.05"],
  "http_req_duration{page:origin}": ["p(95)<" + (__ENV.ORIGIN_P95_MS || "2000")],
};
if (__ENV.MAX_ADMISSIONS_PER_SEC) thresholds.wr_admitted = ["rate<=" + __ENV.MAX_ADMISSIONS_PER_SEC];

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: Number(__ENV.START_RATE || 2),
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages: [
        { target: Number(__ENV.PEAK_RATE || 10), duration: __ENV.RAMP || "5m" },
        { target: Number(__ENV.PEAK_RATE || 10), duration: __ENV.HOLD || "10m" },
      ],
    },
  },
  thresholds,
};

const HTML = { headers: { accept: "text/html" } };

/** Data of the waiting page (<script id="wr-data">), null for an origin page. */
function waitingData(r) {
  const m = /<script id="wr-data" type="application\/json">([^<]*)<\/script>/.exec(String(r.body || ""));
  return m ? JSON.parse(m[1]) : null;
}

/** Same proof of work as the waiting page: SHA-256("wr-pow1\0" room "\0" nonce "\0" counter), `bits` leading zero bits. */
function solve(p) {
  if (!p) return null;
  const prefix = "wr-pow1\u0000" + p.room + "\u0000" + p.nonce + "\u0000";
  const fullNibbles = Math.floor(p.bits / 4);
  const zeros = "0".repeat(fullNibbles);
  const rest = p.bits % 4;
  for (let i = 0; ; i++) {
    const h = crypto.sha256(prefix + i, "hex");
    if (h.startsWith(zeros) && (rest === 0 || parseInt(h[fullNibbles], 16) >> (4 - rest) === 0)) return String(i);
  }
}

function page(name) {
  return { headers: HTML.headers, tags: { page: name } };
}

export default function () {
  const start = Date.now();
  let r = http.get(`${BASE}/`, page("first"));
  check(r, { "first visit ok": (x) => x.status === 200 });
  sleep(1 + Math.random() * 3);
  r = http.get(`${BASE}/`, page("second"));
  const d = waitingData(r);
  if (!d) {
    admitted.add(1);
    return;
  }
  queued.add(1);
  if (d.turnstile) {
    turnstileBlocked.add(1);
    return;
  }
  const t0 = Date.now();
  const pow = solve(d.pow);
  powTime.add(Date.now() - t0);
  // Honour reserveMinAgeSec, on the server clock.
  if (d.reserveAfterMs) sleep(Math.max(0, d.reserveAfterMs - d.serverTime - (Date.now() - t0)) / 1000);

  let t = null;
  for (let attempt = 0; attempt < 5 && !t; attempt++) {
    const res = http.post(`${BASE}/__wr/reserve`, JSON.stringify({ pow }), {
      headers: { "content-type": "application/json", accept: "application/json", "sec-fetch-site": "same-origin" },
      tags: { page: "reserve" },
    });
    const j = res.status === 200 || res.status === 503 || res.status === 429 ? res.json() : null;
    const retry = j !== null && j.status === "retry";
    reserveRetry.add(retry);
    if (retry) {
      sleep(Number(j.retryAfterSec || 5));
      continue;
    }
    reserveOk.add(res.status === 200);
    if (!check(res, { "reserve ok": (x) => x.status === 200 })) return;
    t = j;
  }
  if (!t) return;
  if (t.status === "admitted") {
    admitted.add(1);
    return;
  }
  const waitMs = Math.max(0, t.admitAtMs - t.serverTime) + Math.random() * 2000;
  sleep(waitMs / 1000);
  r = http.get(`${BASE}/`, page("origin"));
  if (check(r, { "admitted after wait": (x) => x.status === 200 && waitingData(x) === null })) {
    admitted.add(1);
    waitTime.add((Date.now() - start) / 1000);
  }
}
