// SPDX-License-Identifier: Apache-2.0
//
// Pure per-isolate edge logic: snapshot handling, local lease, delta
// accumulation, and the admission decisions. No I/O and no crypto: the Worker
// (src/edge) parses cookies, calls the coordinator and builds responses; the
// simulations drive this class directly.

import { CidrSet } from "../shared/cidr.js";
import { MINUTE_MS } from "../shared/time.js";
import type { Batch, EdgeCounters, RoomConfig, Snapshot } from "../shared/types.js";
import { zeroEdgeCounters } from "../shared/counters.js";
import { pauseOffsetFor } from "./pause.js";

/** By default, a snapshot older than this many TTLs is not used at all (STALE_SNAPSHOT_TTLS). */
export const MAX_STALE_TTLS = 6;
const WL_SEEN_MAX = 10_000;
const CLAIMED_MAX = 50_000;
/** Counters sent with the batches but never a reason to flush: counting a request must not cost a Durable Object request. */
const PIGGYBACK = new Set<string>(["workerRequests", "earlyExits"]);

export type TicketState = "admit" | "wait" | "expired" | "duplicate";

export type NewVisitorDecision =
  /** Mode off: relay untouched. */
  | { kind: "relay" }
  /** Open mode, first request: relay and set the provisional cookie. No slot consumed. */
  | { kind: "relay-provisional" }
  /** Open mode, provisional cookie presented: a leased slot was consumed, issue a session. */
  | { kind: "admit-lease" }
  /** Open mode but the local lease is empty: refill it (urgent flush) and decide again. */
  | { kind: "need-lease" }
  /** Serve the waiting page. */
  | { kind: "wait" };

function addDelta(m: Map<number, number>, minute: number, d: number): void {
  const v = (m.get(minute) ?? 0) + d;
  if (v === 0) m.delete(minute);
  else m.set(minute, v);
}

export class EdgeCore {
  readonly isolateId: string;
  readonly tag: number;
  /** Cloudflare data center, set by the Worker from the first request that carries it. */
  colo: string | undefined;
  seq = 0;
  since: number;
  snapshot: Snapshot | null = null;
  config: RoomConfig | null = null;
  gen = -1;
  /** Local clock when the snapshot was received. */
  receivedAt = 0;
  /** ticketNo -> tag of the session allowed to keep it */
  revoked = new Map<number, number>();
  whitelist = new CidrSet([]);
  lease = { remaining: 0, exp: 0 };
  leaseUsed = 0;
  /** Lease usage per epoch second since the last flush. */
  private leaseUsage = new Map<number, number>();
  /** Claims since the last flush: demand estimate for the next lease. */
  claims = 0;
  redeemed: number[] = [];
  private redeemedLocal = new Map<number, number>();
  private active = new Map<number, number>();
  private wl = new Map<number, number>();
  private wlSeen = new Map<string, number>();
  counters: EdgeCounters = zeroEdgeCounters();
  lastFlushAt = 0;
  /**
   * Batch sent and not acknowledged yet. It is resent unchanged (same seq)
   * until the coordinator answers, and no newer batch leaves before that: the
   * coordinator then applies every batch exactly once, in order, even when an
   * answer is lost after the batch was applied.
   */
  unacked: Batch | null = null;
  /** Provisional nonces already exchanged for a leased slot here -> end of their window (epoch s). */
  private claimed = new Map<string, number>();

  constructor(isolateId: string, tag: number, now: number) {
    this.isolateId = isolateId;
    this.tag = tag >>> 0 || 1;
    this.since = now;
    this.lastFlushAt = now;
  }

  // -------------------------------------------------------------------------
  // Snapshot

  ttl(): number {
    return this.snapshot?.ttlMs ?? 10_000;
  }

  isFresh(now: number): boolean {
    return this.snapshot !== null && now - this.receivedAt < this.ttl();
  }

  /**
   * TTLs a snapshot stays usable while its refresh fails. Normal convergence
   * takes one TTL; beyond, the isolate runs on old state (pause, rate) during
   * an outage, until the fail mode takes over. 1 is the strict setting.
   */
  maxStaleTtls = MAX_STALE_TTLS;

  isUsable(now: number): boolean {
    return this.snapshot !== null && now - this.receivedAt < this.maxStaleTtls * this.ttl();
  }

  /**
   * Installs a snapshot. Snapshots from the shared cache never replace a newer
   * one, and never carry a lease.
   */
  applySnapshot(s: Snapshot, now: number): void {
    if (this.snapshot && s.at < this.snapshot.at && !s.lease) return;
    if (s.config && s.gen !== this.gen) {
      this.config = s.config;
      this.gen = s.gen;
      this.whitelist = new CidrSet(s.config.whitelist);
    }
    if (s.lease) this.lease = { remaining: s.lease.n, exp: s.lease.exp };
    const { lease: _l, config: _c, ...rest } = s;
    this.snapshot = rest;
    this.receivedAt = now;
    this.revoked = new Map(s.revoked);
  }

  // -------------------------------------------------------------------------
  // Batches

  /** Counters worth a flush; the Worker request counts only ride along with the others. */
  private hasCounters(): boolean {
    const c = this.counters;
    for (const k in c) if (!PIGGYBACK.has(k) && c[k as keyof EdgeCounters] !== 0) return true;
    return false;
  }

  /** Sizes of the deltas waiting for the next flush (dashboard). */
  pendingSummary(): { redeemed: number; leaseUsed: number; claims: number; activeMinutes: number } {
    return { redeemed: this.redeemed.length, leaseUsed: this.leaseUsed, claims: this.claims, activeMinutes: this.active.size + this.wl.size };
  }

  hasPending(): boolean {
    return this.unacked !== null || this.redeemed.length > 0 || this.leaseUsed > 0 || this.active.size > 0 || this.wl.size > 0 || this.hasCounters();
  }

  /**
   * Flush policy. Every flush is a billed Durable Object request, so each
   * kind of delta has its own cadence:
   * - redeemed tickets: once per TTL (replay detection, absence statistics);
   * - leased slots used: once per TTL near capacity; when calm, only when the
   *   lease is exhausted or about to expire (unreported usage is bounded by
   *   the outstanding leases anyway);
   * - active-user deltas: every minute when the brake is enabled, every five
   *   minutes otherwise (metric only);
   * - plain counters (bypasses, provisional cookies, errors): every five minutes;
   * - Worker request counts: never on their own, they leave with the next batch.
   */
  flushReason(now: number): string | null {
    const elapsed = now - this.lastFlushAt;
    const ttl = this.ttl();
    if (this.unacked && elapsed >= Math.min(ttl, 5000)) return "retry";
    if (this.redeemed.length > 0 && elapsed >= ttl) return "redeemed";
    if (this.leaseUsed > 0) {
      if (!this.snapshot?.calm && elapsed >= ttl) return "usage";
      if (this.lease.remaining === 0) return "lease-exhausted";
      if (this.lease.exp - now < ttl) return "lease-expiring";
    }
    if (this.active.size > 0 || this.wl.size > 0) {
      const every = this.config?.brake.enabled ? MINUTE_MS : 5 * MINUTE_MS;
      if (elapsed >= Math.max(ttl, every)) return "actives";
    }
    return this.hasCounters() && elapsed >= 5 * MINUTE_MS ? "counters" : null;
  }

  shouldFlush(now: number): boolean {
    return this.flushReason(now) !== null;
  }

  /**
   * Slots wanted for the next lease: the claim rate observed since the last
   * flush, projected over the lease lifetime, with 50 % headroom.
   */
  leaseWanted(now: number): number {
    const s = this.snapshot;
    const c = this.config;
    if (!s?.open || !c) return 0;
    const elapsed = Math.max(now - this.lastFlushAt, this.ttl(), 1000);
    const horizon = s.calm ? c.calmLeaseSec * 1000 : 2 * this.ttl();
    const pending = this.counters.provisionalIssued > 0 ? 1 : 0;
    return Math.min(c.leaseBlockMax, Math.ceil((this.claims / elapsed) * horizon * 1.5) + pending);
  }

  /**
   * The batch to send: the unacknowledged one if any (same seq and deltas,
   * only the lease request is refreshed), otherwise all pending deltas moved
   * into a new batch, with the remainder of the current lease given back (the
   * coordinator answers with a fresh lease).
   */
  takeBatch(now: number, urgent: boolean): Batch {
    if (this.unacked) {
      this.lastFlushAt = now;
      this.unacked = { ...this.unacked, knownGen: this.gen, urgent, leaseWanted: Math.max(this.leaseWanted(now), urgent ? 1 : 0) };
      return this.unacked;
    }
    const b: Batch = {
      isolateId: this.isolateId,
      colo: this.colo,
      tag: this.tag,
      seq: ++this.seq,
      since: this.since,
      knownGen: this.gen,
      redeemed: this.redeemed,
      leaseUsed: this.leaseUsed,
      leaseUsage: [...this.leaseUsage.entries()],
      leaseUnused: this.lease.exp > now ? this.lease.remaining : 0,
      leaseWanted: Math.max(this.leaseWanted(now), urgent ? 1 : 0),
      urgent,
      activeDeltas: [...this.active.entries()],
      wlActiveDeltas: [...this.wl.entries()],
      counters: this.counters,
    };
    this.redeemed = [];
    this.leaseUsed = 0;
    this.leaseUsage = new Map();
    this.claims = 0;
    this.lease = { remaining: 0, exp: 0 };
    this.active = new Map();
    this.wl = new Map();
    this.counters = zeroEdgeCounters();
    this.since = now;
    this.lastFlushAt = now;
    this.unacked = b;
    return b;
  }

  /** The coordinator answered batch `seq`: the next batch may leave. */
  ackBatch(seq: number): void {
    if (this.unacked?.seq === seq) this.unacked = null;
  }

  /**
   * No answer for the batch: it stays unacknowledged and is resent as is. The
   * lease given back with it (`before`, the lease held before takeBatch) is
   * kept meanwhile, unless something replaced it.
   */
  batchFailed(before: { remaining: number; exp: number }, now: number): void {
    if (this.lease.exp === 0 && before.exp > now) this.lease = { ...before };
  }

  // -------------------------------------------------------------------------
  // Active-user counting (once per minute per session)

  /** Counts a session cookie. Returns true when the cookie must be rewritten. */
  countSession(countedMinute: number, nowMin: number): boolean {
    if (countedMinute === nowMin) return false;
    addDelta(this.active, nowMin, 1);
    const D = this.config?.sessionMinutes ?? 0;
    if (nowMin - countedMinute < D) addDelta(this.active, countedMinute, -1);
    return true;
  }

  countNewSession(nowMin: number): void {
    addDelta(this.active, nowMin, 1);
  }

  /** Same as countSession, for bypass cookies (whitelist counter). */
  countBypassCookie(countedMinute: number, nowMin: number): boolean {
    if (countedMinute === nowMin) return false;
    addDelta(this.wl, nowMin, 1);
    const D = this.config?.sessionMinutes ?? 0;
    if (nowMin - countedMinute < D && countedMinute > 0) addDelta(this.wl, countedMinute, -1);
    return true;
  }

  /**
   * Whitelisted traffic without cookie (IP, header, verified bot): deduplicated
   * per client IP within this isolate only. Cross-isolate duplicates are
   * possible; the whitelist counter is an estimate.
   */
  countWhitelistedClient(key: string, nowMin: number): void {
    const last = this.wlSeen.get(key);
    if (last === nowMin) return;
    addDelta(this.wl, nowMin, 1);
    const D = this.config?.sessionMinutes ?? 0;
    if (last !== undefined && nowMin - last < D) addDelta(this.wl, last, -1);
    this.wlSeen.set(key, nowMin);
    if (this.wlSeen.size > WL_SEEN_MAX) {
      for (const [k, m] of this.wlSeen) if (nowMin - m >= D) this.wlSeen.delete(k);
      if (this.wlSeen.size > WL_SEEN_MAX) this.wlSeen.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Provisional cookies: one leased slot each

  /**
   * A provisional cookie is exchanged for one leased slot only: a client that
   * sends the same value again gets no second slot from this isolate. Other
   * isolates do not know it (the coordinator only sees counts): replaying one
   * cookie across isolates still costs the replayer as much as a fresh
   * cookie, one relayed page view per slot.
   */
  isProvisionalClaimed(nonce: string, nowSec: number): boolean {
    const exp = this.claimed.get(nonce);
    return exp !== undefined && exp > nowSec;
  }

  claimProvisional(nonce: string, expSec: number, nowSec: number): void {
    this.claimed.set(nonce, expSec);
    if (this.claimed.size <= CLAIMED_MAX) return;
    for (const [n, e] of this.claimed) if (e <= nowSec) this.claimed.delete(n);
    // Still full: forget the oldest claims first (insertion order).
    for (const n of this.claimed.keys()) {
      if (this.claimed.size <= CLAIMED_MAX * 0.9) break;
      this.claimed.delete(n);
    }
  }

  // -------------------------------------------------------------------------
  // Decisions

  /** A session is revoked when its ticket was replayed and it is not the first redemption. */
  isRevoked(ticketNo: number, tag: number): boolean {
    if (ticketNo === 0) return false;
    const winner = this.revoked.get(ticketNo);
    return winner !== undefined && winner !== tag;
  }

  /** Effective admitAt of a ticket, including pause offsets. */
  effectiveAdmitAt(ticketNo: number, admitAtMs: number): number {
    return admitAtMs + pauseOffsetFor(this.snapshot?.pauseOffsets ?? [], ticketNo);
  }

  ticketState(ticketNo: number, admitAtMs: number, now: number): TicketState {
    const s = this.snapshot;
    const c = this.config;
    if (!s || !c) return "wait";
    const eff = this.effectiveAdmitAt(ticketNo, admitAtMs);
    if (now > eff + c.redeemGraceSec * 1000) return "expired";
    if (s.paused || s.mode === "off") return "wait";
    if (this.redeemedLocal.has(ticketNo)) return "duplicate";
    if (now >= eff || ticketNo <= s.earlyUpTo) return "admit";
    return "wait";
  }

  /** Records a ticket exchanged for a session (sent to the coordinator in the next batch). */
  recordRedeem(ticketNo: number, admitAtMs: number, now: number): void {
    this.redeemed.push(ticketNo);
    const exp = this.effectiveAdmitAt(ticketNo, admitAtMs) + (this.config?.redeemGraceSec ?? 0) * 1000;
    this.redeemedLocal.set(ticketNo, exp);
    if (this.redeemedLocal.size > 5000) for (const [t, e] of this.redeemedLocal) if (e < now) this.redeemedLocal.delete(t);
    this.countNewSession(Math.floor(now / MINUTE_MS));
  }

  /** A ticket presented twice in this isolate: report it so that the coordinator revokes it. */
  recordDuplicate(ticketNo: number): void {
    this.redeemed.push(ticketNo);
  }

  private tryClaim(now: number): boolean {
    if (this.lease.remaining > 0 && now < this.lease.exp) {
      this.lease.remaining--;
      this.leaseUsed++;
      addDelta(this.leaseUsage, Math.floor(now / 1000), 1);
      this.claims++;
      this.counters.provisionalClaimed++;
      this.countNewSession(Math.floor(now / MINUTE_MS));
      return true;
    }
    return false;
  }

  hasLease(now: number): boolean {
    return this.lease.remaining > 0 && now < this.lease.exp;
  }

  /**
   * Decision for a visitor without a valid session or ticket.
   * @param provisionalOk the request carries a valid, recent provisional cookie
   * @param afterUrgent   an urgent lease refill was already attempted
   */
  decideNew(now: number, provisionalOk: boolean, afterUrgent: boolean): NewVisitorDecision {
    const s = this.snapshot;
    if (!s) return { kind: "wait" };
    if (s.mode === "off") return { kind: "relay" };
    if (s.paused || s.mode === "queue_all") return { kind: "wait" };
    if (provisionalOk) {
      if (this.tryClaim(now)) return { kind: "admit-lease" };
      if (!afterUrgent && s.open) return { kind: "need-lease" };
      return { kind: "wait" };
    }
    if (s.open || this.hasLease(now)) {
      this.counters.provisionalIssued++;
      return { kind: "relay-provisional" };
    }
    return { kind: "wait" };
  }
}
