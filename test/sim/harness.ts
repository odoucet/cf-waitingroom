// SPDX-License-Identifier: Apache-2.0
//
// Discrete-event simulation of the waiting room: one coordinator, N edge
// isolates, human visitors, bots, no-shows and ticket replays. It drives the
// real algorithm (src/core) with a deterministic clock and PRNG. Cookies are
// modelled as plain objects (the signatures are covered by other tests).

import { CoordinatorCore, type HighWater, type PersistedCore } from "../../src/core/coordinator-core.js";
import { EdgeCore } from "../../src/core/edge-core.js";
import { DEFAULT_CONFIG, mergeConfig } from "../../src/shared/config.js";
import { MINUTE_MS, minuteOf } from "../../src/shared/time.js";
import type { RoomConfig, Snapshot } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG and event queue

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class EventQueue {
  private heap: { t: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  push(t: number, fn: () => void): void {
    const h = this.heap;
    h.push({ t, seq: this.seq++, fn });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p]!, h[i]!)) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  pop(): { t: number; fn: () => void } | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }

  private less(a: { t: number; seq: number }, b: { t: number; seq: number }): boolean {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq);
  }
}

// ---------------------------------------------------------------------------
// Scenario parameters

export interface SimParams {
  seed?: number;
  durationMin: number;
  isolates: number;
  config?: Partial<RoomConfig>;
  /** Human arrivals per minute, as a function of the simulated minute. */
  arrivalsPerMin: (tMin: number) => number;
  /** Mean session length after admission (exponential), minutes. */
  meanSessionMin: number;
  /** Mean time between two page views (exponential), seconds. */
  thinkSec: number;
  /** Share of queued humans who reserve a slot but never come back. */
  noShowRatio?: number;
  /** Requests per minute from bots that never keep cookies nor run JavaScript. */
  botsPerMin?: number;
  /** Interval of the optional status check of the waiting page, seconds (0 disables). */
  statusPollSec?: number;
  /** Simulated minute at which the coordinator restarts (memory lost, state reloaded). */
  restartAtMin?: number;
  /** Pause the room between these minutes. */
  pause?: { fromMin: number; toMin: number };
  /** Persistence interval of the coordinator snapshot, ms. */
  persistEveryMs?: number;
}

export interface Visitor {
  id: number;
  kind: "human" | "bot" | "replica";
  noShow: boolean;
  s?: { ticketNo: number; tag: number; countedMinute: number };
  u?: { issuedMs: number; nonce: string };
  t?: { ticketNo: number; admitAtMs: number };
  arrivedAt: number;
  queued: boolean;
  statusFor?: { ticketNo: number; admitAtMs: number };
  admittedAt?: number;
  leaveAt?: number;
  gone: boolean;
}

export interface SimResult {
  config: RoomConfig;
  /** Admission timestamps (session issued, lease or ticket). */
  admissions: number[];
  /** Active humans (ground truth) sampled every 10 s. */
  activeSamples: { t: number; actives: number; estimate: number; rEff: number; waiting: number; open: boolean }[];
  humans: number;
  queuedHumans: number;
  admittedHumans: number;
  /** Waiting time (ms) of admitted humans. */
  waits: number[];
  reserves: number;
  waitingPages: number;
  botWaitingPages: number;
  botSlots: number;
  coordinatorRequests: Record<string, number>;
  core: CoordinatorCore;
  isolates: EdgeCore[];
  maxCursorLagMs: number;
  /** Highest ticket number ever handed out before the restart, and the first one after. */
  restart?: { lastTicketBefore: number; firstTicketAfter: number; cursorBefore: number; cursorAfter: number; modeKept: boolean; pausedKept: boolean };
}

export const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

// ---------------------------------------------------------------------------
// Simulation

export class Simulation {
  readonly rnd: () => number;
  readonly q = new EventQueue();
  now = T0;
  core: CoordinatorCore;
  isolates: EdgeCore[] = [];
  config: RoomConfig;
  /** Shared Cache API entry (one data center). */
  private cached: { s: Snapshot; exp: number } | null = null;
  private persisted: PersistedCore | null = null;
  private hwm: HighWater | null = null;
  private nextId = 1;
  private visitors: Visitor[] = [];
  readonly res: Omit<SimResult, "core" | "isolates" | "config">;
  private readonly p: Required<Omit<SimParams, "restartAtMin" | "pause" | "config">> & SimParams;

  constructor(params: SimParams) {
    this.p = { seed: 1, noShowRatio: 0, botsPerMin: 0, statusPollSec: 60, persistEveryMs: 10_000, ...params };
    this.rnd = mulberry32(this.p.seed);
    this.config = mergeConfig(DEFAULT_CONFIG, this.p.config ?? {});
    this.core = new CoordinatorCore(this.config, 1, this.now);
    for (let i = 0; i < this.p.isolates; i++) {
      this.isolates.push(new EdgeCore(`iso-${i}`, Math.floor(this.rnd() * 2 ** 32), this.now));
    }
    this.res = {
      admissions: [],
      activeSamples: [],
      humans: 0,
      queuedHumans: 0,
      admittedHumans: 0,
      waits: [],
      reserves: 0,
      waitingPages: 0,
      botWaitingPages: 0,
      botSlots: 0,
      coordinatorRequests: { reserve: 0, flush: 0, snapshot: 0 },
      maxCursorLagMs: 0,
    };
  }

  exp(mean: number): number {
    return -Math.log(1 - this.rnd()) * mean;
  }

  private pickIsolate(): EdgeCore {
    return this.isolates[Math.floor(this.rnd() * this.isolates.length)]!;
  }

  // -------------------------------------------------------------------------
  // Coordinator RPC (instantaneous)

  flushReasons: Record<string, number> = {};
  private rpcFlush(iso: EdgeCore, urgent: boolean, reason = urgent ? "urgent" : "periodic"): void {
    this.flushReasons[reason] = (this.flushReasons[reason] ?? 0) + 1;
    const b = iso.takeBatch(this.now, urgent);
    this.core.tick(this.now);
    const lease = this.core.receiveBatch(b, this.now);
    iso.ackBatch(b.seq);
    this.core.recordRequest("flush", this.now);
    this.res.coordinatorRequests.flush!++;
    this.afterRpc();
    const s = this.core.snapshot(this.now, b.knownGen, lease);
    iso.applySnapshot(s, this.now);
    this.cachePut(s);
  }

  private rpcSnapshot(iso: EdgeCore): void {
    this.core.tick(this.now);
    this.core.recordRequest("snapshot", this.now);
    this.res.coordinatorRequests.snapshot!++;
    const s = this.core.snapshot(this.now, null);
    iso.applySnapshot(s, this.now);
    this.cachePut(s);
  }

  private rpcReserve(iso: EdgeCore, nonce: string): { ticketNo: number; admitAtMs: number } {
    // As on the edge: a reservation carries no batch (deltas only travel with flushes).
    this.core.tick(this.now);
    const r = this.core.reserve(nonce, this.now);
    if (r.refused) throw new Error(`reservation refused: ${r.refused}`);
    this.core.recordRequest("reserve", this.now);
    this.res.coordinatorRequests.reserve!++;
    this.res.reserves++;
    this.afterRpc();
    const s = this.core.snapshot(this.now, iso.gen);
    iso.applySnapshot(s, this.now);
    return r;
  }

  private afterRpc(): void {
    if (this.core.hwmDirty) {
      this.hwm = { ...this.core.hwm };
      this.core.hwmDirty = false;
    }
    this.res.maxCursorLagMs = Math.max(this.res.maxCursorLagMs, this.core.cursor - this.now);
  }

  private cachePut(s: Snapshot): void {
    const { lease: _l, ...shared } = s;
    this.cached = { s: { ...shared, config: this.core.config }, exp: this.now + s.ttlMs };
  }

  /** Same refresh policy as the Worker: memory, then flush if pending, then cache, then RPC. */
  private ensureSnapshot(iso: EdgeCore): void {
    if (iso.isFresh(this.now)) return;
    if (iso.shouldFlush(this.now) || !iso.snapshot) {
      this.rpcFlush(iso, false, "stale");
      return;
    }
    if (this.cached && this.cached.exp > this.now) {
      iso.applySnapshot(this.cached.s, this.now);
      if (iso.isFresh(this.now)) return;
    }
    this.rpcSnapshot(iso);
  }

  private maybeFlush(iso: EdgeCore): void {
    const r = iso.flushReason(this.now);
    if (r) this.rpcFlush(iso, false, r);
  }

  // -------------------------------------------------------------------------
  // Edge request handling (mirror of src/edge/index.ts)

  private request(v: Visitor): void {
    if (v.gone) return;
    const iso = this.pickIsolate();
    this.ensureSnapshot(iso);
    const now = this.now;
    const nowMin = minuteOf(now);
    const cfg = iso.config!;

    if (v.s) {
      const valid = nowMin - v.s.countedMinute < cfg.sessionMinutes && !iso.isRevoked(v.s.ticketNo, v.s.tag);
      if (valid) {
        if (iso.countSession(v.s.countedMinute, nowMin)) v.s.countedMinute = nowMin;
        this.maybeFlush(iso);
        this.onRelay(v);
        return;
      }
      v.s = undefined;
      if (v.kind === "replica") {
        v.gone = true;
        return;
      }
    }

    if (v.t) {
      const st = iso.ticketState(v.t.ticketNo, v.t.admitAtMs, now);
      if (st === "admit") {
        iso.recordRedeem(v.t.ticketNo, v.t.admitAtMs, now);
        this.admit(v, iso.tag, v.t.ticketNo);
        v.t = undefined;
        this.maybeFlush(iso);
        this.onRelay(v);
        return;
      }
      if (st === "wait") {
        this.maybeFlush(iso);
        this.onWaitingWithTicket(v, iso);
        return;
      }
      if (st === "duplicate") {
        // Already redeemed in this isolate: the ticket is dropped and reported.
        iso.recordDuplicate(v.t.ticketNo);
        if (v.kind === "replica") {
          v.t = undefined;
          v.gone = true;
          return;
        }
      }
      v.t = undefined; // expired or duplicate: back to the normal flow
    }

    const provisionalOk = v.u !== undefined && now - v.u.issuedMs < cfg.provisionalWindowSec * 1000;
    let d = iso.decideNew(now, provisionalOk, false);
    if (d.kind === "need-lease") {
      this.rpcFlush(iso, true);
      d = iso.decideNew(now, provisionalOk, true);
    }
    switch (d.kind) {
      case "relay":
        this.onRelay(v);
        break;
      case "relay-provisional":
        if (!v.u && v.kind !== "bot") v.u = { issuedMs: now, nonce: `n${v.id}` };
        this.onRelay(v);
        break;
      case "admit-lease":
        this.admit(v, iso.tag, 0);
        v.u = undefined;
        if (v.kind === "bot") this.res.botSlots++;
        this.onRelay(v);
        break;
      case "wait":
        iso.counters.waitingPages++;
        if (!v.u && v.kind !== "bot") v.u = { issuedMs: now, nonce: `n${v.id}` };
        this.onWaitingPage(v, iso);
        break;
      default:
        throw new Error("unreachable");
    }
    this.maybeFlush(iso);
  }

  private admit(v: Visitor, tag: number, ticketNo: number): void {
    v.s = { ticketNo, tag, countedMinute: minuteOf(this.now) };
    this.res.admissions.push(this.now);
    if (v.kind === "human") {
      this.res.admittedHumans++;
      this.res.waits.push(this.now - v.arrivedAt);
      v.admittedAt = this.now;
      v.leaveAt = this.now + this.exp(this.p.meanSessionMin * MINUTE_MS);
    }
  }

  /** The visitor got a page: schedule the next one, or leave. */
  private onRelay(v: Visitor): void {
    if (v.kind !== "human") return;
    const next = this.now + this.exp(this.p.thinkSec * 1000);
    if (v.leaveAt !== undefined && next > v.leaveAt) {
      v.gone = true;
      return;
    }
    // A visitor on the provisional cookie who never gets a second page view
    // within the session would just leave; model the same think time.
    this.q.push(next, () => this.request(v));
  }

  private onWaitingPage(v: Visitor, iso: EdgeCore): void {
    this.res.waitingPages++;
    if (v.kind === "bot") {
      this.res.botWaitingPages++;
      return; // no JavaScript: never reserves
    }
    if (v.kind !== "human") return;
    if (!v.queued) {
      v.queued = true;
      this.res.queuedHumans++;
    }
    if (v.t) {
      this.onWaitingWithTicket(v, iso);
      return;
    }
    // The page's JavaScript calls POST /__wr/reserve (with the provisional cookie).
    const r = this.rpcReserve(iso, v.u!.nonce);
    v.t = r;
    if (v.noShow) {
      v.gone = true;
      return;
    }
    this.onWaitingWithTicket(v, iso);
  }

  /** Countdown to admitAt, with jitter, plus the optional status check. */
  private onWaitingWithTicket(v: Visitor, iso: EdgeCore): void {
    if (!v.t || v.gone) return;
    const eff = iso.effectiveAdmitAt(v.t.ticketNo, v.t.admitAtMs);
    const paused = iso.snapshot?.paused ?? false;
    const reloadAt = paused ? this.now + this.p.statusPollSec * 1000 : Math.max(this.now + 250, eff + this.rnd() * 2000);
    const ticket = v.t;
    this.q.push(reloadAt, () => {
      if (v.t === ticket) this.request(v);
    });
    if (this.p.statusPollSec > 0) this.scheduleStatus(v, ticket);
  }

  private scheduleStatus(v: Visitor, ticket: { ticketNo: number; admitAtMs: number }): void {
    if (v.statusFor === ticket) return;
    v.statusFor = ticket;
    this.continueStatus(v, ticket);
  }

  private continueStatus(v: Visitor, ticket: { ticketNo: number; admitAtMs: number }): void {
    const at = this.now + this.p.statusPollSec * 1000 * (0.8 + 0.4 * this.rnd());
    this.q.push(at, () => {
      if (v.gone || v.t !== ticket) return;
      // GET /__wr/status: served from the cached snapshot, no coordinator call.
      const iso = this.pickIsolate();
      if (!iso.isFresh(this.now) && this.cached && this.cached.exp > this.now) iso.applySnapshot(this.cached.s, this.now);
      const s = iso.snapshot;
      if (s && !s.paused && ticket.ticketNo <= s.earlyUpTo) {
        this.request(v);
        return;
      }
      this.continueStatus(v, ticket);
    });
  }

  // -------------------------------------------------------------------------
  // Traffic generators

  private scheduleArrivals(): void {
    const end = T0 + this.p.durationMin * MINUTE_MS;
    const step = (t: number) => {
      const rate = this.p.arrivalsPerMin((t - T0) / MINUTE_MS);
      const dt = rate > 0 ? this.exp(MINUTE_MS / rate) : 1000;
      const nt = t + dt;
      if (nt >= end) return;
      this.q.push(nt, () => {
        if (rate > 0) {
          const v = this.newVisitor("human");
          v.noShow = this.rnd() < this.p.noShowRatio;
          this.res.humans++;
          this.request(v);
        }
        step(nt);
      });
    };
    step(T0);
    if (this.p.botsPerMin > 0) {
      const bstep = (t: number) => {
        const nt = t + this.exp(MINUTE_MS / this.p.botsPerMin);
        if (nt >= end) return;
        this.q.push(nt, () => {
          this.request(this.newVisitor("bot"));
          bstep(nt);
        });
      };
      bstep(T0);
    }
  }

  newVisitor(kind: Visitor["kind"]): Visitor {
    const v: Visitor = { id: this.nextId++, kind, noShow: false, arrivedAt: this.now, queued: false, gone: false };
    if (kind === "human") this.visitors.push(v);
    return v;
  }

  private scheduleSampling(): void {
    const end = T0 + this.p.durationMin * MINUTE_MS;
    for (let t = T0; t <= end; t += 10_000) {
      this.q.push(t, () => {
        let actives = 0;
        for (const v of this.visitors) if (!v.gone && v.admittedAt !== undefined && v.leaveAt! > this.now) actives++;
        // Drop visitors that left, to keep sampling cheap.
        if (this.visitors.length > 20_000) this.visitors = this.visitors.filter((v) => !v.gone);
        this.core.tick(this.now);
        this.res.activeSamples.push({
          t: this.now,
          actives,
          estimate: this.core.activesEstimate,
          rEff: this.core.rEff,
          waiting: Math.max(0, this.core.ledger.waitingCount()),
          open: this.core.isOpen(this.now),
        });
      });
    }
  }

  private schedulePersistence(): void {
    const end = T0 + this.p.durationMin * MINUTE_MS;
    for (let t = T0 + this.p.persistEveryMs; t <= end; t += this.p.persistEveryMs) {
      this.q.push(t, () => {
        this.core.tick(this.now);
        this.persisted = structuredClone(this.core.toPersisted(this.now));
      });
    }
  }

  // -------------------------------------------------------------------------

  /** Schedules a callback at a simulated minute (for custom scenarios). */
  at(min: number, fn: () => void): void {
    this.q.push(T0 + min * MINUTE_MS, fn);
  }

  /** Coordinator restart: memory lost, state reloaded from the last persisted snapshot and high-water marks. */
  restart(): NonNullable<SimResult["restart"]> {
    const before = this.core;
    const lastTicketBefore = before.ledger.next - 1;
    const cursorBefore = before.cursor;
    const persistedConfig = before.config;
    // The nonce table is durable (SQLite in the Durable Object): it survives the restart.
    this.core = CoordinatorCore.restore(this.persisted, this.hwm, persistedConfig, before.gen, this.now, before.nonces);
    return {
      lastTicketBefore,
      firstTicketAfter: this.core.ledger.next,
      cursorBefore,
      cursorAfter: this.core.cursor,
      modeKept: this.core.config.mode === before.config.mode,
      pausedKept: this.core.pause.paused === before.pause.paused,
    };
  }

  /** Lets a scenario hand a ticket to arbitrary visitors (replay test). */
  reserveFor(v: Visitor): { ticketNo: number; admitAtMs: number } {
    const iso = this.pickIsolate();
    this.ensureSnapshot(iso);
    v.u ??= { issuedMs: this.now, nonce: `n${v.id}` };
    const r = this.rpcReserve(iso, v.u.nonce);
    v.t = r;
    return r;
  }

  /** Sends one request on behalf of a visitor (replay test). */
  send(v: Visitor): void {
    this.request(v);
  }

  run(): SimResult {
    this.scheduleArrivals();
    this.scheduleSampling();
    this.schedulePersistence();
    let restartInfo: SimResult["restart"];
    if (this.p.restartAtMin !== undefined) this.at(this.p.restartAtMin, () => (restartInfo = this.restart()));
    if (this.p.pause) {
      const { fromMin, toMin } = this.p.pause;
      this.at(fromMin, () => this.core.admin({ op: "setPause", paused: true }, this.now));
      this.at(toMin, () => this.core.admin({ op: "setPause", paused: false }, this.now));
    }
    const end = T0 + this.p.durationMin * MINUTE_MS;
    for (;;) {
      const e = this.q.pop();
      if (!e || e.t > end) break;
      this.now = Math.max(this.now, e.t);
      e.fn();
    }
    this.core.tick(this.now);
    return { ...this.res, core: this.core, isolates: this.isolates, config: this.config, restart: restartInfo };
  }
}

// ---------------------------------------------------------------------------
// Result helpers

/** Largest number of admissions within any sliding window of `windowMs` starting after `fromMs`. */
export function maxInWindow(times: number[], windowMs: number, fromMs = T0, toMs = Infinity): number {
  const ts = times.filter((t) => t >= fromMs && t <= toMs).sort((a, b) => a - b);
  let best = 0;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i]! - ts[j]! >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** Admissions per minute averaged between two simulated minutes. */
export function rateBetween(times: number[], fromMin: number, toMin: number): number {
  const a = T0 + fromMin * MINUTE_MS;
  const b = T0 + toMin * MINUTE_MS;
  return times.filter((t) => t >= a && t < b).length / (toMin - fromMin);
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
