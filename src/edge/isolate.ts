// SPDX-License-Identifier: Apache-2.0
//
// Per-isolate state: the pure EdgeCore plus the I/O around it: coordinator
// RPC with timeouts, Cache API snapshot sharing within the data center, and
// background flushes through ctx.waitUntil.

import { EdgeCore } from "../core/edge-core.js";
import { randomHex } from "../shared/crypto.js";
import type { Snapshot } from "../shared/types.js";
import type { EdgeEnv } from "./env.js";
import { logEvent } from "./log.js";

const BACKGROUND_TIMEOUT_MS = 5000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`coordinator call timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function cacheKey(room: string): string {
  return `https://wr-snapshot.internal/${room}/v1`;
}

export class Isolate {
  readonly core: EdgeCore;
  private coordinatorId: DurableObjectId | null = null;
  private inflight: Promise<boolean> | null = null;
  /** Reservation calls to the coordinator in progress (capped by reserveMaxInflight). */
  reserveInflight = 0;
  /** An invalid FAIL_MODE is logged once per isolate. */
  failModeChecked = false;
  /** Turnstile enabled without WR_TURNSTILE_SECRET is logged once per isolate. */
  turnstileWarned = false;
  readonly startedAt: number;
  /** Cumulative per-isolate statistics, shown on the edge dashboard (the core counters are deltas reset at each flush). */
  readonly stats = { calls: {} as Record<string, number>, errors: { timeout: 0, overloaded: 0, other: 0 }, cacheHits: 0, cacheMisses: 0 };

  constructor(now: number) {
    const tag = crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.core = new EdgeCore(randomHex(8), tag, now);
    this.startedAt = now;
  }

  /**
   * A new stub per call: a stub is bound to the request that created it, and
   * reusing it from another request fails ("Cannot perform I/O on behalf of a
   * different request"). Only the id, which holds no I/O, is kept.
   */
  private getStub(env: EdgeEnv) {
    this.coordinatorId ??= env.COORDINATOR.idFromName(env.ROOM_ID);
    const hint = env.LOCATION_HINT as DurableObjectLocationHint | undefined;
    return hint ? env.COORDINATOR.get(this.coordinatorId, { locationHint: hint }) : env.COORDINATOR.get(this.coordinatorId);
  }

  timeoutMs(env: EdgeEnv): number {
    const t = Number(env.COORDINATOR_TIMEOUT_MS ?? "1000");
    return Number.isFinite(t) && t > 0 ? t : 1000;
  }

  /**
   * Calls the coordinator. Errors and timeouts are counted, logged, and
   * resolve to undefined: callers apply the configured fail mode.
   */
  async call<T>(env: EdgeEnv, op: string, f: (stub: ReturnType<Isolate["getStub"]>) => Promise<T>, timeoutMs: number): Promise<T | undefined> {
    const c = this.core.counters;
    this.stats.calls[op] = (this.stats.calls[op] ?? 0) + 1;
    try {
      return await withTimeout(f(this.getStub(env)), timeoutMs);
    } catch (e) {
      const err = e as Error & { overloaded?: boolean; retryable?: boolean };
      let kind: keyof Isolate["stats"]["errors"];
      if (e instanceof TimeoutError) {
        c.errTimeout++;
        kind = "timeout";
      } else if (err.overloaded) {
        c.errOverloaded++;
        kind = "overloaded";
      } else {
        c.errOther++;
        kind = "other";
      }
      this.stats.errors[kind]++;
      logEvent(env, "error", "coordinator_error", { op, kind, error: String(err?.message ?? e) }, true);
      return undefined;
    }
  }

  private async cachePut(env: EdgeEnv, s: Snapshot): Promise<void> {
    try {
      const { lease: _l, ...shared } = s;
      const body = JSON.stringify({ ...shared, config: this.core.config ?? shared.config });
      const maxAge = Math.max(1, Math.floor(s.ttlMs / 1000));
      await caches.default.put(
        cacheKey(env.ROOM_ID),
        new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${maxAge}` } }),
      );
    } catch {
      // Cache API unavailable (e.g. workers.dev): the next isolate calls the coordinator.
    }
  }

  private async cacheGet(env: EdgeEnv): Promise<Snapshot | null> {
    try {
      const r = await caches.default.match(cacheKey(env.ROOM_ID));
      if (!r) {
        this.stats.cacheMisses++;
        return null;
      }
      this.stats.cacheHits++;
      return (await r.json()) as Snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Sends pending deltas; the answer carries a fresh snapshot and lease. The
   * only RPC that carries deltas, one at a time per isolate: a batch without
   * answer (even after a timeout, when the coordinator may have applied it) is
   * resent unchanged, and the coordinator recognises it by its seq.
   */
  async flush(env: EdgeEnv, ctx: ExecutionContext, urgent: boolean, timeoutMs = BACKGROUND_TIMEOUT_MS): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const p = (async () => {
      const now = Date.now();
      const leaseBefore = { ...this.core.lease };
      const b = this.core.takeBatch(now, urgent);
      const s = await this.call(env, "flush", (stub) => stub.flush(b) as unknown as Promise<Snapshot>, timeoutMs);
      if (!s) {
        this.core.batchFailed(leaseBefore, Date.now());
        return false;
      }
      this.core.ackBatch(b.seq);
      this.core.applySnapshot(s, Date.now());
      ctx.waitUntil(this.cachePut(env, s));
      return true;
    })();
    this.inflight = p;
    try {
      return await p;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Refreshes the snapshot: flush when due, otherwise the data-center cache, otherwise the coordinator.
   * A cold isolate whose first flush fails starts from the data-center copy, if any.
   */
  private async refresh(env: EdgeEnv, ctx: ExecutionContext, timeoutMs: number): Promise<boolean> {
    const now = Date.now();
    if (!this.core.snapshot) {
      if (await this.flush(env, ctx, false, timeoutMs)) return true;
      const cached = await this.cacheGet(env);
      if (cached) this.core.applySnapshot(cached, Date.now());
      return cached !== null;
    }
    if (this.core.shouldFlush(now)) return this.flush(env, ctx, false, timeoutMs);
    const cached = await this.cacheGet(env);
    if (cached) {
      this.core.applySnapshot(cached, Date.now());
      if (this.core.isFresh(Date.now())) return true;
    }
    const s = await this.call(env, "snapshot", (stub) => stub.getSnapshot() as unknown as Promise<Snapshot>, timeoutMs);
    if (!s) return false;
    this.core.applySnapshot(s, Date.now());
    ctx.waitUntil(this.cachePut(env, s));
    return true;
  }

  private refreshing: Promise<boolean> | null = null;

  private refreshOnce(env: EdgeEnv, ctx: ExecutionContext, timeoutMs: number): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (!this.refreshing) {
      this.refreshing = this.refresh(env, ctx, timeoutMs).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * Makes sure a usable snapshot is available. A stale but recent snapshot is
   * used immediately while a refresh runs in the background.
   */
  async ensureSnapshot(env: EdgeEnv, ctx: ExecutionContext): Promise<boolean> {
    const now = Date.now();
    if (this.core.isFresh(now)) return true;
    if (this.core.isUsable(now)) {
      ctx.waitUntil(this.refreshOnce(env, ctx, BACKGROUND_TIMEOUT_MS));
      return true;
    }
    await this.refreshOnce(env, ctx, this.timeoutMs(env));
    return this.core.isUsable(Date.now());
  }

  /** Schedules a background flush when the flush policy says so. */
  maybeFlush(env: EdgeEnv, ctx: ExecutionContext): void {
    if (!this.inflight && this.core.shouldFlush(Date.now())) ctx.waitUntil(this.flush(env, ctx, false));
  }

  /**
   * After an admin change: forces this isolate to refresh, and drops the
   * data-center cache entry. Other data centers converge within two TTLs.
   */
  async invalidate(env: EdgeEnv): Promise<void> {
    this.core.receivedAt = 0;
    try {
      await caches.default.delete(cacheKey(env.ROOM_ID));
    } catch {
      // no cache available
    }
  }
}

let isolate: Isolate | null = null;

export function getIsolate(): Isolate {
  isolate ??= new Isolate(Date.now());
  return isolate;
}

/** For tests only. */
export function resetIsolate(): void {
  isolate = null;
}
