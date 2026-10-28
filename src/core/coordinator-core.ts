// SPDX-License-Identifier: Apache-2.0
//
// Pure coordinator algorithm: admission slots, leases, overbooking, safety
// brake, replay detection, pause. No I/O, the clock is always passed in.
// The Durable Object (src/coordinator) is a thin wrapper around this class,
// and the simulations (test/sim) drive it directly.

import { mergeConfig } from "../shared/config.js";
import { MINUTE_MS, minuteOf } from "../shared/time.js";
import { zeroEdgeCounters } from "../shared/counters.js";
import type { AdminOp, Batch, CoordinatorMetrics, DashboardData, EdgeCounters, Lease, Mode, ReserveRefusal, RoomConfig, Snapshot, WhitelistEntry } from "../shared/types.js";

export { zeroEdgeCounters };
import { AbsenceWindow } from "./absence.js";
import { MinuteHistory } from "./history.js";
import { MinuteCounter } from "./actives.js";
import { type LedgerData, TicketLedger, UNKNOWN_ADMIT } from "./ledger.js";
import { PauseState } from "./pause.js";

/** High-water marks persisted ahead of time so that a restart never re-issues a slot or a ticket number. */
export interface HighWater {
  cursorMs: number;
  ticketNo: number;
}

/** Margin of the high-water marks, in milliseconds of cursor. */
export const HWM_MARGIN_MS = 10_000;
const ABSENCE_MIN_SAMPLE = 20;
const ABSENCE_MAX = 0.9;
const ISOLATE_TTL_MS = 10 * MINUTE_MS;
/** Isolates whose last batch number is remembered (the oldest are forgotten first). */
const ISOLATES_MAX = 10_000;
/** Isolates listed on the dashboards (the largest leases first). */
const DASHBOARD_ISOLATES = 10;
/** Clock difference tolerated between the edge that signed a provisional cookie and the coordinator. */
const CLOCK_SKEW_SEC = 5;
/**
 * Nonces are kept for the longest provisional window the configuration
 * accepts: a later increase of provisionalWindowSec never lets an old cookie
 * reserve a second ticket.
 */
export const NONCE_RETENTION_SEC = 86_400 + CLOCK_SKEW_SEC;
const NONCE_PRUNE_EVERY_MS = 10_000;
/** Revocations kept at most (the ones expiring first are dropped); far above any real replay volume. */
const REVOKED_MAX = 20_000;
/** Key of the lease that stands for the slots granted after the last persisted state (see restore). */
export const RESTART_LEASE = "__restart__";
/** Lease usage older than this is forgotten (reports never lag that much). */
const USAGE_WINDOW_MS = 5 * MINUTE_MS;
/** Upper bounds (seconds) of the buckets of wr_reserve_wait_seconds. */
export const WAIT_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];

/** What a nonce obtained: the same nonce always gets the same ticket. */
export interface NonceRecord {
  ticketNo: number;
  admitAtMs: number;
  /** When the provisional cookie carrying the nonce was issued (epoch seconds). */
  issuedSec: number;
}

/**
 * Nonce -> ticket table. In memory for the simulations; the Durable Object
 * keeps it in SQLite, written before the reservation is answered, so that a
 * restart never hands a second ticket to the same nonce.
 */
export interface NonceStore {
  get(nonce: string): NonceRecord | undefined;
  set(nonce: string, r: NonceRecord): void;
  /** Drops the nonces issued before `beforeSec`. */
  prune(beforeSec: number): void;
  readonly size: number;
}

export class MemoryNonceStore implements NonceStore {
  private map = new Map<string, NonceRecord>();
  get(nonce: string): NonceRecord | undefined {
    return this.map.get(nonce);
  }
  set(nonce: string, r: NonceRecord): void {
    this.map.set(nonce, r);
  }
  prune(beforeSec: number): void {
    for (const [n, v] of this.map) if (v.issuedSec < beforeSec) this.map.delete(n);
  }
  get size(): number {
    return this.map.size;
  }
}

export type ReserveOutcome = { ticketNo: number; admitAtMs: number; refused?: undefined } | { refused: ReserveRefusal };

/** Last batch applied per isolate, and the lease granted in answer to it (answered again to a resent batch). */
interface IsolateState {
  seq: number;
  at: number;
  /** Cloudflare data center, unknown for isolates older than this field. */
  colo?: string;
  /** Configuration generation the isolate held when it sent its last batch. */
  gen?: number;
  lease?: Lease;
}

/** Billed Durable Object requests; `alarm` is the persistence alarm of the coordinator. */
export type RequestKind = "reserve" | "flush" | "snapshot" | "admin" | "alarm";
const KINDS: RequestKind[] = ["reserve", "flush", "snapshot", "admin", "alarm"];
const REQUEST_KEYS = KINDS.map((k) => `req_${k}`);
/** Per-minute series shown on the dashboards. */
export const HISTORY_KEYS = [...REQUEST_KEYS, "adm_lease", "adm_ticket", "reserved", "absent", "replays", "waiting", "bypass", "fail_open", "rows", "worker_req", "early_exit"] as const;

export interface CoreCounters {
  reserved: number;
  redeemed: number;
  absent: number;
  replays: number;
  redeemUnknown: number;
  leaseGranted: number;
  leaseUsed: number;
  leaseReturned: number;
  leaseExpired: number;
  rowsWritten: number;
  /** Batches received again (lost answer, retry): acknowledged without being applied. */
  batchDuplicates: number;
  /** Batch numbers skipped: batches applied after the last persisted state, lost by a restart. */
  batchGaps: number;
  /** Reservations refused because the queue reached maxWaitingTickets. */
  reserveFull: number;
  /** Wait handed out by the reservations, per bucket of WAIT_BUCKETS (the last one is +Inf). */
  waitCounts: number[];
  /** Sum of the waits handed out, in seconds. */
  waitSum: number;
  edge: EdgeCounters;
  /** requests[kind][mode] */
  requests: Record<string, Record<string, number>>;
}

export interface PersistedCore {
  v: 1 | 2;
  at: number;
  ticketCursor: number;
  usage: [number, number][];
  ledger: LedgerData;
  absence: ([number, number, number] | [number, number])[];
  credit: number;
  earlyUpTo: number;
  pause: { since: number | null; offsets: [number, number][] };
  actives: [number, number][];
  wl: [number, number][];
  /** Counted active users at `at`, without the restart floor (older states: with it). */
  activesEstimate: number;
  /** Restart floor running at `at` (absent from older states). */
  floor?: { value: number; until: number };
  rEff: number;
  brakeFactor: number;
  lastBrakeAt: number;
  absenceRatio: number;
  counters: CoreCounters;
  /** [isolateId, last batch number, last seen, data center]: persisted with the state it produced. */
  isolates?: [string, number, number, string?][];
  /** [isolateId, slots, expiry]: leases still outstanding. */
  leases?: [string, number, number][];
  /** [ticketNo, expiry, tag of the first redemption]: replay revocations published to the edge. */
  revoked?: [number, number, number][];
  /** [minute, counters]: per-minute history of the last hour (dashboards, cost projection). */
  history?: [number, Record<string, number>][];
}

function zeroCounters(): CoreCounters {
  return {
    reserved: 0,
    redeemed: 0,
    absent: 0,
    replays: 0,
    redeemUnknown: 0,
    leaseGranted: 0,
    leaseUsed: 0,
    leaseReturned: 0,
    leaseExpired: 0,
    rowsWritten: 0,
    batchDuplicates: 0,
    batchGaps: 0,
    reserveFull: 0,
    waitCounts: new Array<number>(WAIT_BUCKETS.length + 1).fill(0),
    waitSum: 0,
    edge: zeroEdgeCounters(),
    requests: {},
  };
}

export class AdminError extends Error {}

export class CoordinatorCore {
  config: RoomConfig;
  gen: number;
  /**
   * Admission cursor (epoch ms): the larger of the ticket cursor and of the
   * token bucket rebuilt from lease usage. Open mode while cursor <= now.
   */
  cursor: number;
  /** admitAt of the last ticket handed out. */
  ticketCursor: number;
  /** Lease usage per epoch second, as reported by the isolates (may arrive late, in any order). */
  usage = new Map<number, number>();
  private usageSorted: number[] | null = [];
  ledger = new TicketLedger();
  absence = new AbsenceWindow();
  /** Unexpected absences not yet compensated by early admissions. */
  credit = 0;
  earlyUpTo = 0;
  pause = new PauseState();
  actives = new MinuteCounter();
  wl = new MinuteCounter();
  /** After a restart, the estimate never drops below this value until `until`. */
  floor = { value: 0, until: 0 };
  activesEstimate = 0;
  rEff: number;
  brakeFactor = 1;
  lastBrakeAt = 0;
  absenceRatio = 0;
  leases = new Map<string, Lease>();
  outstanding = 0;
  /** Ordered from the least to the most recently seen. */
  isolates = new Map<string, IsolateState>();
  nonces: NonceStore;
  private lastNoncePrune = 0;
  /** Largest storage row written, in bytes (set by the Durable Object; alert well before 2 MB). */
  storageRowBytes = 0;
  /** Set when the state must be persisted before answering (a revocation was published). */
  persistNow = false;
  /** ticketNo -> { expiry, tag of the first redemption } */
  revoked = new Map<number, { exp: number; tag: number }>();
  hwm: HighWater;
  /** Set when `hwm` changed and must be persisted before answering. */
  hwmDirty = false;
  counters = zeroCounters();
  /** Per-minute counters over the last hour (requests, admissions, rows written...), for the cost projection and the dashboards. */
  history = new MinuteHistory();
  /** 10-second windows with at least one request over the last hour (object kept active). */
  private activeWindows = new Set<number>();
  /** Admissions (lease or ticket) per 10-second bucket, for the utilisation. */
  private admitBuckets = new Map<number, number>();

  constructor(config: RoomConfig, gen: number, now: number, nonces: NonceStore = new MemoryNonceStore()) {
    this.nonces = nonces;
    this.config = config;
    this.gen = gen;
    this.cursor = now - config.burstSec * 1000;
    this.ticketCursor = this.cursor;
    this.rEff = config.admissionsPerMinute;
    this.hwm = { cursorMs: 0, ticketNo: this.ledger.next };
  }

  // -------------------------------------------------------------------------
  // Derived values

  /** Clock used to place slots: frozen while paused. */
  private vnow(now: number): number {
    return this.pause.since ?? now;
  }

  private ttlBaseMs(): number {
    return this.config.snapshotTtlSec * 1000;
  }

  isOpen(now: number): boolean {
    return this.config.mode === "on" && !this.pause.paused && this.cursor <= now;
  }

  /**
   * Token bucket over the actual lease usage times, replayed in chronological
   * order. Reports may arrive late and out of order (lazy flushes): usage that
   * happened while capacity was idle is absorbed by the bucket floor instead of
   * being stacked on top of the cursor. While paused, time stands still at the
   * start of the pause: usage reported since (isolates that had not seen the
   * pause yet) is placed at that instant.
   */
  private leaseBucket(now: number): number {
    const B = this.burstMs();
    const slot = MINUTE_MS / this.leaseRate();
    const at = this.vnow(now);
    const from = at - USAGE_WINDOW_MS;
    if (this.usageSorted === null) this.usageSorted = [...this.usage.keys()].sort((a, b) => a - b);
    let c = from - B;
    for (const s of this.usageSorted) {
      const t = Math.min((s + 1) * 1000, this.pause.since ?? Infinity);
      if (t < from) continue;
      c = Math.max(c, t - B) + this.usage.get(s)! * slot;
    }
    return c;
  }

  private refreshCursor(now: number): void {
    this.cursor = Math.max(this.ticketCursor, this.leaseBucket(now));
  }

  /** Admissions over the last minute divided by the admission rate. */
  utilization(now: number): number {
    const b = Math.floor(now / 10_000);
    let n = 0;
    for (const [k, v] of this.admitBuckets) if (k > b - 6) n += v;
    return n / this.leaseRate();
  }

  private recordAdmissions(n: number, now: number): void {
    if (n <= 0) return;
    const b = Math.floor(now / 10_000);
    this.admitBuckets.set(b, (this.admitBuckets.get(b) ?? 0) + n);
    if (this.admitBuckets.size > 12) for (const k of this.admitBuckets.keys()) if (k <= b - 6) this.admitBuckets.delete(k);
  }

  /** Open with plenty of headroom: admissions over the last minute below calmUtilization * R. */
  isCalm(now: number): boolean {
    return this.isOpen(now) && this.utilization(now) < this.config.calmUtilization;
  }

  /** Snapshot TTL (and edge flush interval). */
  ttlMs(now: number): number {
    return this.isCalm(now) ? this.config.calmSnapshotTtlSec * 1000 : this.ttlBaseMs();
  }

  /** Rate used for slots consumed without a ticket: R * brake, no overbooking (no no-shows there). */
  private leaseRate(): number {
    return Math.max(0.01, this.config.admissionsPerMinute * this.brakeFactor);
  }

  private burstMs(): number {
    return this.config.burstSec * 1000;
  }

  /** Cap on outstanding leased slots (the larger of the calm and busy caps). */
  private leaseCapMax(): number {
    const c = this.config;
    return Math.ceil((this.leaseRate() * Math.max(c.leaseMaxOutstandingSec, c.calmLeaseMaxOutstandingSec)) / 60);
  }

  /** Longest lifetime of a lease granted with the current configuration. */
  private leaseLifeMaxMs(): number {
    return Math.max(this.config.calmLeaseSec, 2 * this.config.snapshotTtlSec) * 1000;
  }

  private sessionMs(): number {
    return this.config.sessionMinutes * MINUTE_MS;
  }

  /** Active users from the minute counters alone, without the restart floor. */
  private countedActives(nowMin: number): number {
    const c = this.config;
    return this.actives.estimate(nowMin, c.sessionMinutes) + (c.countWhitelisted ? this.wl.estimate(nowMin, c.sessionMinutes) : 0);
  }

  // -------------------------------------------------------------------------
  // Periodic recomputation (run on every RPC; there is no alarm)

  tick(now: number): void {
    const c = this.config;
    const oldest = Math.floor((this.vnow(now) - USAGE_WINDOW_MS) / 1000);
    for (const s of this.usage.keys()) {
      if (s < oldest) {
        this.usage.delete(s);
        this.usageSorted = null;
      }
    }
    for (const [id, l] of this.leases) {
      if (l.exp < now) {
        // Optimistic: an expired lease is assumed unused (its isolate went idle).
        this.outstanding -= l.n;
        this.leases.delete(id);
        if (id !== RESTART_LEASE) this.counters.leaseExpired += l.n;
      }
    }
    for (const [t, v] of this.revoked) if (v.exp < now) this.revoked.delete(t);
    if (this.revoked.size > REVOKED_MAX) {
      const byExp = [...this.revoked].sort((a, b) => a[1].exp - b[1].exp);
      for (const [t] of byExp.slice(0, this.revoked.size - REVOKED_MAX)) this.revoked.delete(t);
    }
    if (now - this.lastNoncePrune >= NONCE_PRUNE_EVERY_MS) {
      this.lastNoncePrune = now;
      this.nonces.prune(Math.floor(now / 1000) - NONCE_RETENTION_SEC);
    }
    for (const [id, v] of this.isolates) {
      if (v.at >= now - ISOLATE_TTL_MS && this.isolates.size <= ISOLATES_MAX) break;
      this.isolates.delete(id);
    }

    // Absence evaluation: a ticket is evaluated once its deadline (plus the
    // batch propagation lag) has passed. Not while paused: deadlines move.
    if (!this.pause.paused) {
      const grace = c.redeemGraceSec * 1000;
      const lag = 2 * this.ttlBaseMs();
      const L = this.ledger;
      while (L.evalNext < L.next) {
        const t = L.evalNext;
        const a = L.admitAtOf(t);
        if (a === UNKNOWN_ADMIT) {
          L.evalNext++;
          continue;
        }
        const deadline = a + this.pause.offsetFor(t) + grace;
        if (deadline + lag > now) break;
        const absent = !L.isRedeemed(t);
        this.absence.record(deadline, absent);
        if (absent) {
          this.counters.absent++;
          this.history.add(now, "absent");
        }
        this.credit += (absent ? 1 : 0) - L.aIssuedOf(t);
        L.evalNext++;
      }
    }
    this.absenceRatio = Math.min(ABSENCE_MAX, this.absence.ratio(now, c.absenceWindowSec * 1000, ABSENCE_MIN_SAMPLE));

    const nowMin = minuteOf(now);
    this.actives.prune(nowMin, c.sessionMinutes);
    this.wl.prune(nowMin, c.sessionMinutes);
    const est = this.countedActives(nowMin);
    this.activesEstimate = this.floor.until > now ? Math.max(est, this.floor.value) : est;
    if (this.lastBrakeAt === 0 || now - this.lastBrakeAt >= MINUTE_MS) this.updateBrake(now);

    const R = c.admissionsPerMinute;
    this.rEff = Math.max(0.01, Math.min(R / (1 - this.absenceRatio), c.overbookCap * R) * this.brakeFactor);
    this.credit = Math.max(0, Math.min(this.credit, this.rEff));

    if (!this.pause.paused) {
      const L = this.ledger;
      while (L.dueNext < L.next) {
        const a = L.admitAtOf(L.dueNext);
        if (a !== UNKNOWN_ADMIT && a + this.pause.offsetFor(L.dueNext) > now) break;
        L.dueNext++;
      }
      const due = L.dueNext - 1;
      if (this.earlyUpTo < due) this.earlyUpTo = due;
      while (this.credit >= 1 && this.earlyUpTo < L.next - 1) {
        this.earlyUpTo++;
        this.credit -= 1;
      }
      if (this.earlyUpTo >= L.next - 1) this.credit = 0;
    }

    this.ledger.prune(this.ledger.evalNext);
    this.pause.prune(this.ledger.base);
    this.refreshCursor(now);
  }

  private updateBrake(now: number): void {
    const b = this.config.brake;
    this.lastBrakeAt = now;
    if (!b.enabled) {
      this.brakeFactor = 1;
      return;
    }
    const est = this.activesEstimate;
    if (est <= b.activesThreshold) this.brakeFactor = 1;
    else if (est >= b.activesLimit) this.brakeFactor = b.minFactor;
    else this.brakeFactor = 1 - ((est - b.activesThreshold) / (b.activesLimit - b.activesThreshold)) * (1 - b.minFactor);
  }

  // -------------------------------------------------------------------------
  // Edge batches

  /**
   * Applies a batch. Returns false if it was already applied (same isolate,
   * same or older seq). An isolate sends its batches one at a time and resends
   * the same one until it gets an answer, so a seq at or below the last one is
   * always a duplicate, never a batch that would otherwise be lost.
   */
  applyBatch(b: Batch, now: number): boolean {
    const prev = this.isolates.get(b.isolateId);
    if (prev && b.seq <= prev.seq) {
      prev.at = now;
      this.counters.batchDuplicates++;
      return false;
    }
    if (prev && b.seq > prev.seq + 1) this.counters.batchGaps += b.seq - prev.seq - 1;
    this.isolates.delete(b.isolateId);
    this.isolates.set(b.isolateId, { seq: b.seq, at: now, gen: b.knownGen, colo: b.colo ?? prev?.colo });

    const l = this.leases.get(b.isolateId);
    if (l) {
      this.outstanding -= l.n;
      this.leases.delete(b.isolateId);
    }
    this.counters.leaseReturned += Math.max(0, b.leaseUnused);
    if (b.leaseUsed > 0) {
      this.counters.leaseUsed += b.leaseUsed;
      this.recordAdmissions(b.leaseUsed, now);
      const nowSec = Math.floor(now / 1000);
      const oldest = Math.floor((this.vnow(now) - USAGE_WINDOW_MS) / 1000);
      let placed = 0;
      for (const [sec, n] of b.leaseUsage) {
        if (n <= 0) continue;
        // Clamp to the window: very late or future-dated usage is counted now.
        const s = sec < oldest || sec > nowSec ? nowSec : sec;
        if (!this.usage.has(s)) this.usageSorted = null;
        this.usage.set(s, (this.usage.get(s) ?? 0) + n);
        this.history.add(s * 1000, "adm_lease", n);
        placed += n;
      }
      if (placed < b.leaseUsed) {
        if (!this.usage.has(nowSec)) this.usageSorted = null;
        this.usage.set(nowSec, (this.usage.get(nowSec) ?? 0) + (b.leaseUsed - placed));
        this.history.add(now, "adm_lease", b.leaseUsed - placed);
      }
      this.refreshCursor(now);
    }

    const D = this.sessionMs();
    for (const t of b.redeemed) {
      const res = this.ledger.redeem(t, b.tag);
      if (res.r === "ok") {
        this.counters.redeemed++;
        this.recordAdmissions(1, now);
        this.history.add(now, "adm_ticket");
      }
      else if (res.r === "duplicate") {
        this.counters.replays++;
        this.history.add(now, "replays");
        this.revoked.set(t, { exp: now + D, tag: res.winnerTag });
        this.persistNow = true;
      } else this.counters.redeemUnknown++;
    }

    const nowMin = minuteOf(now);
    this.actives.apply(b.activeDeltas, nowMin, this.config.sessionMinutes);
    this.wl.apply(b.wlActiveDeltas, nowMin, this.config.sessionMinutes);
    const e = this.counters.edge;
    for (const k of Object.keys(e) as (keyof EdgeCounters)[]) e[k] += Math.max(0, b.counters[k] ?? 0);
    const bc = b.counters;
    this.history.add(now, "waiting", Math.max(0, bc.waitingPages));
    this.history.add(now, "fail_open", Math.max(0, bc.failOpen));
    this.history.add(now, "bypass", Math.max(0, bc.botBypass + bc.ipBypass + bc.headerBypass + bc.passBypass));
    // Absent from the batches of isolates older than these counters.
    this.history.add(now, "worker_req", Math.max(0, bc.workerRequests ?? 0));
    this.history.add(now, "early_exit", Math.max(0, bc.earlyExits ?? 0));

    this.updateHwm();
    return true;
  }

  /** Grants a new lease to the isolate that sent `b`, in open mode only. */
  grantLease(b: Batch, now: number): Lease | undefined {
    if (!this.isOpen(now)) return undefined;
    const wanted = Math.max(b.leaseWanted, b.urgent ? 1 : 0);
    if (wanted <= 0) return undefined;
    const calm = this.isCalm(now);
    const capSec = calm ? this.config.calmLeaseMaxOutstandingSec : this.config.leaseMaxOutstandingSec;
    const cap = Math.ceil((this.leaseRate() * capSec) / 60);
    // Fair share: no isolate may hold more than twice its share of the cap.
    let active = 0;
    for (const v of this.isolates.values()) if (v.at > now - MINUTE_MS) active++;
    const share = Math.max(1, Math.ceil((2 * cap) / Math.max(1, active)));
    let n = Math.min(wanted, this.config.leaseBlockMax, share, cap - this.outstanding);
    if (n < 1 && b.urgent) n = 1;
    if (n < 1) return undefined;
    const lease = { n, exp: now + (calm ? this.config.calmLeaseSec * 1000 : 2 * this.ttlMs(now)) };
    this.leases.set(b.isolateId, lease);
    this.outstanding += n;
    this.counters.leaseGranted += n;
    const iso = this.isolates.get(b.isolateId);
    if (iso?.seq === b.seq) iso.lease = lease;
    return lease;
  }

  /**
   * Answer to a batch that applyBatch() found already applied: the lease
   * granted to that very batch, if it is still outstanding. A resent batch
   * means its first answer was lost, so the isolate never received that lease.
   */
  leaseFor(b: Batch, now: number): Lease | undefined {
    const iso = this.isolates.get(b.isolateId);
    const lease = iso?.seq === b.seq ? iso.lease : undefined;
    return lease && this.leases.get(b.isolateId) === lease && lease.exp > now ? lease : undefined;
  }

  /** applyBatch + grantLease, or the earlier answer for a resent batch. */
  receiveBatch(b: Batch, now: number): Lease | undefined {
    return this.applyBatch(b, now) ? this.grantLease(b, now) : this.leaseFor(b, now);
  }

  // -------------------------------------------------------------------------
  // Reservations

  /**
   * Hands out the next admission slot. The same nonce always gets the same
   * ticket, so a page reload does not consume a second slot. `issuedSec` is
   * the issue time of the provisional cookie that carries the nonce (signed by
   * the edge): the cookie must still be within provisionalWindowSec. Unknown
   * (older edge): the reservation time is used.
   */
  reserve(nonce: string, now: number, issuedSec?: number): ReserveOutcome {
    // Room disabled: existing tickets stay valid for when it comes back, no new ones.
    if (this.config.mode === "off") return { refused: "off" };
    const nowSec = Math.floor(now / 1000);
    const issued = issuedSec ?? nowSec;
    const age = nowSec - issued;
    if (age < -CLOCK_SKEW_SEC || age > this.config.provisionalWindowSec + CLOCK_SKEW_SEC) return { refused: "expired" };
    const known = this.nonces.get(nonce);
    if (known) return { ticketNo: known.ticketNo, admitAtMs: known.admitAtMs };
    if (this.ledger.waitingCount() >= this.config.maxWaitingTickets) {
      this.counters.reserveFull++;
      return { refused: "full" };
    }
    const slot = MINUTE_MS / this.rEff;
    // Queueing: leased slots not reported yet may still be consumed, schedule after them.
    // Open (a waiting page served while the room was open, e.g. an urgent refill that came
    // back empty): the slots really consumed are enough. Counting the whole lease cap there
    // would put the ticket up to calmLeaseMaxOutstandingSec ahead, close the room, and every
    // later reservation would keep it closed.
    const leased = this.isOpen(now) ? 0 : this.outstanding * (MINUTE_MS / this.leaseRate());
    const floor = this.vnow(now) - this.burstMs();
    const start = Math.max(this.ticketCursor, Math.max(this.leaseBucket(now), floor) + leased, floor);
    const admitAtMs = Math.round(start + slot);
    this.ticketCursor = admitAtMs;
    this.cursor = Math.max(this.cursor, admitAtMs);
    const ticketNo = this.ledger.issue(admitAtMs, this.absenceRatio);
    this.nonces.set(nonce, { ticketNo, admitAtMs, issuedSec: issued });
    this.counters.reserved++;
    this.recordWait(Math.max(0, admitAtMs - this.vnow(now)) / 1000);
    this.history.add(now, "reserved");
    this.updateHwm();
    return { ticketNo, admitAtMs };
  }

  /** Wait handed out by a reservation (the pause excluded, like the cursor lag). */
  private recordWait(sec: number): void {
    const c = this.counters;
    const i = WAIT_BUCKETS.findIndex((b) => sec <= b);
    const k = i < 0 ? WAIT_BUCKETS.length : i;
    c.waitCounts[k] = (c.waitCounts[k] ?? 0) + 1;
    c.waitSum += sec;
  }

  /**
   * Keeps the high-water marks ahead of the last ticket handed out. Only
   * tickets need this protection: slots consumed through leases carry no
   * identity, so losing a few seconds of them on restart is harmless.
   */
  private updateHwm(): void {
    const lastAdmit = this.ledger.next > this.ledger.base ? this.ledger.admitAtOf(this.ledger.next - 1) : UNKNOWN_ADMIT;
    if (lastAdmit > this.hwm.cursorMs) {
      this.hwm = { ...this.hwm, cursorMs: lastAdmit + HWM_MARGIN_MS };
      this.hwmDirty = true;
    }
    if (this.ledger.next > this.hwm.ticketNo) {
      const maxTicketsInMargin = Math.ceil((this.config.admissionsPerMinute * this.config.overbookCap * HWM_MARGIN_MS) / MINUTE_MS);
      this.hwm = { ...this.hwm, ticketNo: this.ledger.next + maxTicketsInMargin + 16 };
      this.hwmDirty = true;
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot

  snapshot(now: number, knownGen: number | null, lease?: Lease): Snapshot {
    const s: Snapshot = {
      v: 1,
      gen: this.gen,
      at: now,
      mode: this.config.mode,
      paused: this.pause.paused,
      open: this.isOpen(now),
      calm: this.isCalm(now),
      cursorMs: Math.round(this.cursor),
      rEff: Math.round(this.rEff * 100) / 100,
      earlyUpTo: this.earlyUpTo,
      pauseOffsets: this.pause.offsets.map(([a, b]) => [a, b] as [number, number]),
      revoked: [...this.revoked].map(([t, v]) => [t, v.tag] as [number, number]),
      activesEstimate: this.activesEstimate,
      brakeFactor: Math.round(this.brakeFactor * 1000) / 1000,
      ttlMs: this.ttlMs(now),
    };
    if (lease) s.lease = lease;
    if (knownGen !== this.gen) s.config = this.config;
    return s;
  }

  // -------------------------------------------------------------------------
  // Administration

  admin(op: AdminOp, now: number): unknown {
    switch (op.op) {
      case "state":
        return this.state(now);
      case "metrics":
        return this.metrics(now);
      case "dashboard":
        return this.dashboard(now);
      case "patchConfig":
        this.setConfig(mergeConfig(this.config, op.patch), now);
        return this.config;
      case "setMode":
        this.setConfig(mergeConfig(this.config, { mode: op.mode satisfies Mode }), now);
        return { mode: this.config.mode };
      case "setPause":
        if (op.paused) this.pause.pause(now);
        else {
          // The lease backlog at the start of the pause is shifted like the tickets.
          if (this.pause.paused) this.ticketCursor = Math.max(this.ticketCursor, this.leaseBucket(now));
          const d = this.pause.resume(now, this.ledger.next - 1);
          this.ticketCursor += d;
          this.refreshCursor(now);
          this.updateHwm();
        }
        return { paused: this.pause.paused };
      case "whitelistAdd": {
        const byCidr = new Map<string, WhitelistEntry>(this.config.whitelist.map((e) => [e.cidr, e]));
        for (const e of op.entries) byCidr.set(e.cidr, e);
        this.setConfig(mergeConfig(this.config, { whitelist: [...byCidr.values()] }), now);
        return this.config.whitelist;
      }
      case "whitelistRemove": {
        const drop = new Set(op.cidrs);
        this.setConfig(mergeConfig(this.config, { whitelist: this.config.whitelist.filter((e) => !drop.has(e.cidr)) }), now);
        return this.config.whitelist;
      }
      default:
        throw new AdminError("unknown admin operation");
    }
  }

  setConfig(config: RoomConfig, now: number): void {
    this.config = config;
    this.gen++;
    this.tick(now);
  }

  state(now: number): Record<string, unknown> {
    return {
      mode: this.config.mode,
      paused: this.pause.paused,
      open: this.isOpen(now),
      cursorLagSec: Math.round((this.cursor - this.vnow(now)) / 100) / 10,
      admissionsPerMinute: this.config.admissionsPerMinute,
      rEff: this.rEff,
      absenceRatio: this.absenceRatio,
      brakeFactor: this.brakeFactor,
      activesEstimate: this.activesEstimate,
      waitingTickets: Math.max(0, this.ledger.waitingCount()),
      nextTicketNo: this.ledger.next,
      earlyUpTo: this.earlyUpTo,
      outstandingLeases: this.outstanding,
      isolates: this.isolates.size,
      gen: this.gen,
      config: this.config,
    };
  }

  /**
   * Oldest configuration generation held by an isolate that reported within
   * the last minute (the current one when none did). Below wr_config_generation
   * for more than two TTLs: a change did not reach every isolate.
   */
  edgeGenMin(now: number): number {
    let min = this.gen;
    for (const v of this.isolates.values()) if (v.at > now - MINUTE_MS && v.gen !== undefined && v.gen >= 0 && v.gen < min) min = v.gen;
    return min;
  }

  /** Everything the dashboards show, in one request. */
  dashboard(now: number): DashboardData {
    const isolates: DashboardData["isolates"] = { seen: 0, active: 0, leasing: 0, behind: 0, top: [], colos: [] };
    const rows: DashboardData["isolates"]["top"] = [];
    const colos = new Map<string, [number, number]>();
    for (const [id, v] of this.isolates) {
      if (v.at < now - ISOLATE_TTL_MS) continue;
      isolates.seen++;
      const active = v.at > now - MINUTE_MS;
      if (active) {
        isolates.active++;
        if (v.gen !== undefined && v.gen >= 0 && v.gen < this.gen) isolates.behind++;
      }
      const dc = colos.get(v.colo ?? "?") ?? [0, 0];
      colos.set(v.colo ?? "?", [dc[0] + 1, dc[1] + (active ? 1 : 0)]);
      const l = this.leases.get(id);
      const lease = l && l.exp >= now ? l.n : 0;
      if (lease > 0) isolates.leasing++;
      rows.push({ id, colo: v.colo, seq: v.seq, lastSeenSec: Math.round((now - v.at) / 1000), lease });
    }
    isolates.top = rows.sort((a, b) => b.lease - a.lease || a.lastSeenSec - b.lastSeenSec).slice(0, DASHBOARD_ISOLATES);
    isolates.colos = [...colos].map(([c, [seen, active]]) => [c, seen, active] as [string, number, number]).sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
    return {
      at: now,
      state: this.state(now),
      metrics: this.metrics(now),
      history: this.history.series(now, HISTORY_KEYS),
      isolates,
      revoked: this.revoked.size,
      pendingNonces: this.nonces.size,
      ledgerTickets: this.ledger.next - this.ledger.base,
    };
  }

  // -------------------------------------------------------------------------
  // Request accounting and metrics

  recordRequest(kind: RequestKind, now: number): void {
    const mode = this.pause.paused ? "paused" : this.isOpen(now) ? "open" : this.config.mode === "off" ? "off" : "queue";
    const byMode = (this.counters.requests[kind] ??= {});
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    this.history.add(now, `req_${kind}`);
    const w = Math.floor(now / 10_000);
    this.activeWindows.add(w);
    if (this.activeWindows.size > 400) for (const k of this.activeWindows) if (k < w - 360) this.activeWindows.delete(k);
  }

  recordRowsWritten(n: number, now: number): void {
    this.counters.rowsWritten += n;
    this.history.add(now, "rows", n);
  }

  /**
   * Monthly projection from the last hour of activity (30-day month). Worker
   * requests are those the isolates reported: a slight undercount, an isolate
   * evicted before its next batch takes its count with it.
   */
  costProjection(now: number): { requests: number; gbSeconds: number; rowsWritten: number; workerRequests: number; usd: Record<string, number> } {
    const req = this.history.sum(now, REQUEST_KEYS);
    const rows = this.history.sum(now, ["rows"]);
    const w = Math.floor(now / 10_000);
    let win = 0;
    for (const k of this.activeWindows) if (k > w - 360) win++;
    const month = 30 * 24;
    const requests = req * month;
    const rowsWritten = rows * month;
    const workerRequests = this.history.sum(now, ["worker_req"]) * month;
    // 128 MB billed while the object is active (not hibernatable).
    const gbSeconds = 0.125 * 30 * 86_400 * Math.min(1, win / 360);
    return {
      requests,
      gbSeconds,
      rowsWritten,
      workerRequests,
      usd: {
        do_requests: (Math.max(0, requests - 1_000_000) * 0.15) / 1e6,
        do_duration: (Math.max(0, gbSeconds - 400_000) * 12.5) / 1e6,
        do_rows_written: (Math.max(0, rowsWritten - 50_000_000) * 1.0) / 1e6,
        worker_requests: (Math.max(0, workerRequests - 10_000_000) * 0.3) / 1e6,
      },
    };
  }

  metrics(now: number): CoordinatorMetrics {
    const c = this.counters;
    const cost = this.costProjection(now);
    const labelled: CoordinatorMetrics["labelled"] = [];
    for (const kind of KINDS) {
      for (const [mode, v] of Object.entries(c.requests[kind] ?? {})) {
        labelled.push({ name: "wr_coordinator_requests_total", labels: { kind, mode }, value: v, type: "counter" });
      }
    }
    for (const mode of ["off", "on", "queue_all"] as Mode[]) {
      labelled.push({ name: "wr_mode", labels: { mode }, value: this.config.mode === mode ? 1 : 0, type: "gauge" });
    }
    // [name, label, label value, value, type (counter by default)]
    const rows: [string, string, string, number, ("gauge" | "counter")?][] = [
      ["wr_admissions_total", "path", "lease", c.leaseUsed],
      ["wr_admissions_total", "path", "ticket", c.redeemed],
      ["wr_lease_slots_total", "state", "granted", c.leaseGranted],
      ["wr_lease_slots_total", "state", "used", c.leaseUsed],
      ["wr_lease_slots_total", "state", "returned", c.leaseReturned],
      ["wr_lease_slots_total", "state", "expired", c.leaseExpired],
      ["wr_provisional_total", "state", "issued", c.edge.provisionalIssued],
      ["wr_provisional_total", "state", "claimed", c.edge.provisionalClaimed],
      ["wr_bypass_total", "kind", "bot", c.edge.botBypass],
      ["wr_bypass_total", "kind", "ip", c.edge.ipBypass],
      ["wr_bypass_total", "kind", "header", c.edge.headerBypass],
      ["wr_bypass_total", "kind", "pass", c.edge.passBypass],
      ["wr_coordinator_errors_total", "kind", "timeout", c.edge.errTimeout],
      ["wr_coordinator_errors_total", "kind", "overloaded", c.edge.errOverloaded],
      ["wr_coordinator_errors_total", "kind", "other", c.edge.errOther],
      ["wr_reserve_refused_total", "reason", "too_early", c.edge.reserveTooEarly],
      ["wr_reserve_refused_total", "reason", "pow", c.edge.reservePowFailed],
      ["wr_reserve_refused_total", "reason", "busy", c.edge.reserveBusy],
      ["wr_reserve_refused_total", "reason", "cross_site", c.edge.reserveCrossSite],
      ["wr_reserve_refused_total", "reason", "no_provisional_cookie", c.edge.reserveNoProvisional],
      ["wr_reserve_refused_total", "reason", "turnstile", c.edge.reserveTurnstileFailed],
      ["wr_reserve_refused_total", "reason", "full", c.reserveFull],
      ["wr_refused_total", "kind", "session", c.edge.sessionRefused],
      ["wr_refused_total", "kind", "ticket", c.edge.ticketRefused],
      ["wr_refused_total", "kind", "pass", c.edge.passRefused],
      ["wr_refused_total", "kind", "bypass_header", c.edge.bypassRefused],
      ["wr_cost_projection_usd", "item", "do_requests", cost.usd.do_requests!, "gauge"],
      ["wr_cost_projection_usd", "item", "do_duration", cost.usd.do_duration!, "gauge"],
      ["wr_cost_projection_usd", "item", "do_rows_written", cost.usd.do_rows_written!, "gauge"],
      ["wr_cost_projection_usd", "item", "worker_requests", cost.usd.worker_requests!, "gauge"],
      ["wr_usage_projection", "item", "do_requests", cost.requests, "gauge"],
      ["wr_usage_projection", "item", "do_gb_seconds", cost.gbSeconds, "gauge"],
      ["wr_usage_projection", "item", "do_rows_written", cost.rowsWritten, "gauge"],
      ["wr_usage_projection", "item", "worker_requests", cost.workerRequests, "gauge"],
    ];
    for (const [name, k, v, value, type] of rows) labelled.push({ name, labels: { [k]: v }, value, type: type ?? "counter" });
    const nowMin = minuteOf(now);
    return {
      gauges: {
        wr_admission_rate_target: this.config.admissionsPerMinute,
        wr_admission_rate_effective: this.rEff,
        wr_cursor_lag_seconds: (this.cursor - this.vnow(now)) / 1000,
        wr_waiting_tickets: Math.max(0, this.ledger.waitingCount()),
        wr_absence_ratio: this.absenceRatio,
        wr_active_users_estimate: this.activesEstimate,
        wr_active_users_whitelisted: this.wl.estimate(nowMin, this.config.sessionMinutes),
        wr_brake_factor: this.brakeFactor,
        wr_paused: this.pause.paused ? 1 : 0,
        wr_open: this.isOpen(now) ? 1 : 0,
        wr_calm: this.isCalm(now) ? 1 : 0,
        wr_utilization: this.utilization(now),
        wr_lease_outstanding_slots: this.outstanding,
        wr_coordinator_isolates: [...this.isolates.values()].filter((v) => v.at > now - MINUTE_MS).length,
        wr_config_generation: this.gen,
        wr_coordinator_storage_row_bytes: this.storageRowBytes,
        wr_edge_config_generation_min: this.edgeGenMin(now),
        wr_ledger_tickets: this.ledger.next - this.ledger.base,
      },
      counters: {
        wr_tickets_reserved_total: c.reserved,
        wr_tickets_redeemed_total: c.redeemed,
        wr_tickets_absent_total: c.absent,
        wr_replays_rejected_total: c.replays,
        wr_waiting_pages_total: c.edge.waitingPages,
        wr_fail_open_total: c.edge.failOpen,
        wr_worker_requests_total: c.edge.workerRequests,
        wr_early_exits_total: c.edge.earlyExits,
        wr_coordinator_rows_written_total: c.rowsWritten,
        wr_batch_duplicates_total: c.batchDuplicates,
        wr_batch_gaps_total: c.batchGaps,
      },
      labelled,
      histograms: [{ name: "wr_reserve_wait_seconds", bounds: WAIT_BUCKETS, counts: c.waitCounts, sum: c.waitSum }],
    };
  }

  // -------------------------------------------------------------------------
  // Persistence

  toPersisted(now: number): PersistedCore {
    return {
      v: 2,
      at: now,
      ticketCursor: Math.round(this.ticketCursor),
      usage: [...this.usage.entries()],
      ledger: this.ledger.toData(),
      absence: this.absence.events,
      credit: this.credit,
      earlyUpTo: this.earlyUpTo,
      pause: { since: this.pause.since, offsets: this.pause.offsets },
      actives: this.actives.entries(),
      wl: this.wl.entries(),
      activesEstimate: this.countedActives(minuteOf(now)),
      floor: { ...this.floor },
      rEff: this.rEff,
      brakeFactor: this.brakeFactor,
      lastBrakeAt: this.lastBrakeAt,
      absenceRatio: this.absenceRatio,
      counters: this.counters,
      isolates: [...this.isolates].map(([id, v]) => (v.colo ? [id, v.seq, v.at, v.colo] : [id, v.seq, v.at]) as [string, number, number, string?]),
      leases: [...this.leases].map(([id, l]) => [id, l.n, l.exp] as [string, number, number]),
      revoked: [...this.revoked].map(([t, v]) => [t, v.exp, v.tag] as [number, number, number]),
      history: this.history.entries(),
    };
  }

  /**
   * Rebuilds the coordinator after a restart. Conservative: the cursor and the
   * ticket numbers resume from the high-water marks (never re-issued), mode and
   * pause are kept, and the active-user estimate cannot drop below the last
   * persisted value until a full session window has elapsed. That floor is
   * carried, never extended, by later restarts.
   */
  static restore(p: PersistedCore | null, hwm: HighWater | null, config: RoomConfig, gen: number, now: number, nonces?: NonceStore): CoordinatorCore {
    const core = new CoordinatorCore(config, gen, now, nonces);
    if (p) {
      core.ticketCursor = p.ticketCursor;
      core.usage = new Map(p.usage);
      core.usageSorted = null;
      core.ledger = new TicketLedger(p.ledger);
      core.absence = new AbsenceWindow(p.absence);
      core.credit = p.credit;
      core.earlyUpTo = p.earlyUpTo;
      core.pause.since = p.pause.since;
      core.pause.offsets = p.pause.offsets;
      core.actives = new MinuteCounter(p.actives);
      core.wl = new MinuteCounter(p.wl);
      core.rEff = p.rEff;
      core.brakeFactor = p.brakeFactor;
      core.lastBrakeAt = p.lastBrakeAt;
      core.absenceRatio = p.absenceRatio;
      core.counters = { ...zeroCounters(), ...p.counters, edge: { ...zeroEdgeCounters(), ...p.counters.edge } };
      // Older states, or other buckets: the histogram starts again (a counter reset for Prometheus).
      if (core.counters.waitCounts.length !== WAIT_BUCKETS.length + 1) {
        core.counters.waitCounts = zeroCounters().waitCounts;
        core.counters.waitSum = 0;
      }
      // The object restarts after every quiet period (between two scrapes, say): a floor re-armed
      // by each restart would freeze the estimate, so a higher floor still running is kept as is.
      const fresh = { value: p.activesEstimate, until: p.at + config.sessionMinutes * MINUTE_MS };
      core.floor = p.floor && p.floor.until > now && p.floor.value > fresh.value ? { ...p.floor } : fresh;
      core.activesEstimate = p.activesEstimate;
      core.history = new MinuteHistory(p.history ?? []);
      // Batch numbers come back with the state they produced: a batch applied after this state
      // was persisted is lost with its effects, and its resend is applied again.
      for (const [id, seq, at, colo] of p.isolates ?? []) core.isolates.set(id, colo ? { seq, at, colo } : { seq, at });
      // Revocations already published stay in force: a losing session never becomes valid again.
      for (const [t, exp, tag] of p.revoked ?? []) if (exp > now) core.revoked.set(t, { exp, tag });
      for (const [id, n, exp] of p.leases ?? []) {
        if (exp <= now || n <= 0) continue;
        core.leases.set(id, { n, exp });
        core.outstanding += n;
      }
      // Leases granted after the persisted state are unknown but may still be in use: until the
      // longest of them has expired, the rest of the cap counts as outstanding (only urgent single
      // slots are granted meanwhile), so the global cap holds across the restart.
      const unknown = core.leaseCapMax() - core.outstanding;
      if (unknown > 0) {
        core.leases.set(RESTART_LEASE, { n: unknown, exp: now + core.leaseLifeMaxMs() });
        core.outstanding += unknown;
      }
    }
    if (hwm) {
      core.ticketCursor = Math.max(core.ticketCursor, hwm.cursorMs);
      core.ledger.skipTo(Math.max(core.ledger.next, hwm.ticketNo));
      core.hwm = { ...hwm };
    } else {
      core.hwm = { cursorMs: 0, ticketNo: core.ledger.next };
    }
    core.updateHwm();
    core.tick(now);
    return core;
  }
}
