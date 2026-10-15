// SPDX-License-Identifier: Apache-2.0
//
// Waiting page (HTML in English or French, chosen from Accept-Language) and
// its JSON variant for SPAs and mobile apps. Always `Cache-Control: no-store`.
// The page is templates/waiting.html, minified at build time into
// templates/generated/waiting.html (scripts/build-templates.mjs).

import type { ProvisionalToken } from "../shared/cookies.js";
import { randomHex } from "../shared/crypto.js";
import type { RoomConfig } from "../shared/types.js";
import { json, wantsJson } from "./http.js";
import page from "./templates/generated/waiting.html";

export const RESERVE_PATH = "/__wr/reserve";
export const STATUS_PATH = "/__wr/status";

export interface WaitingTicket {
  ticketNo: number;
  signedAdmitAtMs: number;
  admitAtMs: number;
}

interface Texts {
  lang: string;
  title: string;
  heading: string;
  intro: string;
  wait: string;
  note: string;
  noscript: string;
  /** Static page served when the coordinator is unavailable in fail-closed mode. */
  unavailable: string;
  /** Texts used by the page script. */
  msg: { wait: string; now: string; paused: string; error: string; min: string; sec: string };
}

const TEXTS: Record<string, Texts> = {
  en: {
    lang: "en",
    title: "You are in the queue",
    heading: "Thanks for your patience",
    intro: "We are receiving a lot of visitors. Your place is reserved and you will be let in automatically.",
    wait: "Estimated wait",
    note: "Keep this page open: it reloads by itself. Reloading it manually does not move you back in line.",
    noscript: "JavaScript is required to hold your place in the queue.",
    unavailable: "We are receiving a lot of visitors. This page will retry by itself in a few seconds.",
    msg: {
      wait: "Estimated wait",
      now: "Letting you in…",
      paused: "Admissions are paused for a moment. Your place is kept.",
      error: "Connection problem, retrying…",
      min: "min",
      sec: "s",
    },
  },
  fr: {
    lang: "fr",
    title: "Vous êtes dans la file d’attente",
    heading: "Merci de votre patience",
    intro: "Nous accueillons beaucoup de visiteurs. Votre place est réservée et vous entrerez automatiquement.",
    wait: "Attente estimée",
    note: "Gardez cette page ouverte : elle se recharge toute seule. La recharger vous-même ne vous fait pas perdre votre place.",
    noscript: "JavaScript est nécessaire pour réserver votre place dans la file.",
    unavailable: "Nous accueillons beaucoup de visiteurs. Cette page se rechargera toute seule dans quelques secondes.",
    msg: {
      wait: "Attente estimée",
      now: "Entrée en cours…",
      paused: "Les entrées sont suspendues un instant. Votre place est conservée.",
      error: "Problème de connexion, nouvel essai…",
      min: "min",
      sec: "s",
    },
  },
};

/** First supported language in Accept-Language (q-values honoured), English by default. */
export function pickLanguage(header: string | null): string {
  if (!header) return "en";
  let best = "en";
  let bestQ = -1;
  for (const part of header.split(",")) {
    const [tag, ...params] = part.trim().split(";");
    const lang = (tag ?? "").toLowerCase().split("-")[0]!;
    if (!(lang in TEXTS)) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q > bestQ) {
      best = lang;
      bestQ = q;
    }
  }
  return best;
}

function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function waitingResponse(
  request: Request,
  config: RoomConfig,
  opts: { room: string; ticket: WaitingTicket | null; provisional: ProvisionalToken | null; paused: boolean; cookies: string[]; now: number },
): Response {
  // What the client needs before POST /__wr/reserve: when it may call (reserveMinAgeSec) and the proof of work.
  const p = opts.provisional;
  const reserveAfterMs = p ? (p.issuedSec + config.reserveMinAgeSec) * 1000 + 100 : null;
  const pow = p && config.reservePowBits > 0 ? { room: opts.room, nonce: p.nonce, bits: config.reservePowBits } : null;
  const headers = new Headers({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  for (const c of opts.cookies) headers.append("Set-Cookie", c);

  if ((request.method !== "GET" && request.method !== "HEAD") || wantsJson(request)) {
    const retry = opts.ticket ? Math.max(1, Math.ceil((opts.ticket.admitAtMs - opts.now) / 1000)) : 5;
    return json(
      {
        status: "waiting",
        reserveUrl: RESERVE_PATH,
        statusUrl: STATUS_PATH,
        ticket: opts.ticket,
        paused: opts.paused,
        serverTime: opts.now,
        reserveAfterMs,
        pow,
      },
      503,
      { "Retry-After": String(retry), "X-Robots-Tag": "noindex" },
      opts.cookies,
    );
  }

  const nonce = randomHex(12);
  const turnstile = config.reserveVerifier === "turnstile" && config.turnstileSiteKey !== "";
  const data = {
    reserveUrl: RESERVE_PATH,
    statusUrl: STATUS_PATH,
    serverTime: opts.now,
    paused: opts.paused,
    ticket: opts.ticket,
    turnstile,
    reserveAfterMs,
    pow,
  };
  const widget = turnstile
    ? `<div class="cf-turnstile" data-sitekey="${config.turnstileSiteKey.replace(/[^A-Za-z0-9_-]/g, "")}" data-callback="wrTurnstile"></div>` +
      `<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";
  const { msg, ...texts } = TEXTS[pickLanguage(request.headers.get("accept-language"))]!;
  const values: Record<string, string> = { ...texts, NONCE: nonce, DATA: scriptJson(data), TURNSTILE: widget, MSG: scriptJson(msg) };
  // One pass over the template: inserted values are never scanned for placeholders.
  const html = page.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
  const extra = turnstile ? " https://challenges.cloudflare.com" : "";
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'${extra}; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src${extra || " 'none'"}; base-uri 'none'; form-action 'none'`,
  );
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(request.method === "HEAD" ? null : html, { status: config.waitingStatus, headers });
}

/**
 * Coordinator unavailable, fail-closed: a static 503 that needs neither the
 * room configuration nor a snapshot (a cold isolate has neither). The HTML
 * variant reloads itself after Retry-After.
 */
export function unavailableResponse(request: Request, cookies: string[]): Response {
  const retry = 5 + Math.floor(Math.random() * 10);
  if ((request.method !== "GET" && request.method !== "HEAD") || wantsJson(request)) {
    return json({ status: "unavailable", retryAfterSec: retry }, 503, { "Retry-After": String(retry), "X-Robots-Tag": "noindex" }, cookies);
  }
  const t = TEXTS[pickLanguage(request.headers.get("accept-language"))]!;
  const html =
    `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="${retry}"><title>${t.title}</title></head><body><h1>${t.heading}</h1><p>${t.unavailable}</p></body></html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(retry),
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(request.method === "HEAD" ? null : html, { status: 503, headers });
}
