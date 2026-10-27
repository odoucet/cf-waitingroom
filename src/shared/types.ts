// SPDX-License-Identifier: Apache-2.0
//
// Types shared by the edge handler, the coordinator Durable Object and the
// pure algorithm. Everything that crosses the RPC boundary is declared here.

export type Mode = "off" | "on" | "queue_all";
export type FailMode = "open" | "closed";

export interface WhitelistEntry {
  /** IPv4 or IPv6 address or CIDR block. */
  cidr: string;
  /** Free-form label, logged when the entry matches. */
  label: string;
}

export interface BrakeConfig {
  /** Enables the slow safety loop that lowers the admission rate. */
  enabled: boolean;
  /** Estimated active users above which the rate starts being lowered. */
  activesThreshold: number;
  /** Estimated active users at which the rate reaches `minFactor`. */
  activesLimit: number;
  /** Lowest multiplier applied to the admission rate (0..1). */
  minFactor: number;
}

/**
 * Operational configuration. Stored in the coordinator, changed through the
 * admin API, distributed to the edge with the state snapshot.
 */
export interface RoomConfig {
  mode: Mode;
  /** Target admission rate R (new users per minute). */
  admissionsPerMinute: number;
  /** Session duration D: a session expires after D minutes without a request. */
  sessionMinutes: number;
  /** Total lifetime of a session in minutes, however active (bounds a shared or stolen cookie). */
  sessionMaxMinutes: number;
  /** Largest block of slots one isolate may lease in open mode. */
  leaseBlockMax: number;
  /** Cap on all outstanding leased slots, expressed in seconds of R. */
  leaseMaxOutstandingSec: number;
  /** Token bucket depth of the open mode, in seconds of R. */
  burstSec: number;
  /** Upper bound of the overbooking multiplier (R_eff <= R * overbookCap). */
  overbookCap: number;
  /** A ticket can be exchanged from admitAt until admitAt + redeemGraceSec. */
  redeemGraceSec: number;
  /** Maximum age of the provisional cookie for an open-mode claim. */
  provisionalWindowSec: number;
  /** Sliding window used to measure the no-show ratio. */
  absenceWindowSec: number;
  brake: BrakeConfig;
  /** HTTP status of the waiting page. */
  waitingStatus: number;
  /** Snapshot TTL and flush interval near or above the admission rate. */
  snapshotTtlSec: number;
  /** Snapshot TTL and flush interval when there is plenty of headroom ("calm"). */
  calmSnapshotTtlSec: number;
  /** Calm when open and admissions over the last minute are below this share of R. */
  calmUtilization: number;
  /** Lease lifetime when calm, seconds (leases live 2 TTL otherwise). */
  calmLeaseSec: number;
  /** Cap on outstanding leased slots when calm, in seconds of R. */
  calmLeaseMaxOutstandingSec: number;
  /** Whether whitelisted traffic counts in the active-user estimate. */
  countWhitelisted: boolean;
  /** Minimum age of the provisional cookie before POST /__wr/reserve, seconds. */
  reserveMinAgeSec: number;
  /** Proof of work required by POST /__wr/reserve, in leading zero bits of SHA-256 (0 disables). */
  reservePowBits: number;
  /** Maximum concurrent reservation calls to the coordinator per edge isolate. */
  reserveMaxInflight: number;
  /** Reservations are refused ("full") while this many tickets are waiting: bounds memory and storage. */
  maxWaitingTickets: number;
  /** Optional verification hook on POST /__wr/reserve. */
  reserveVerifier: "none" | "turnstile";
  /** Public Turnstile site key rendered in the waiting page. */
  turnstileSiteKey: string;
  whitelist: WhitelistEntry[];
}

export interface Lease {
  /** Number of slots granted to the isolate. */
  n: number;
  /** Expiry (epoch ms). Unused slots are reclaimed after this time. */
  exp: number;
}

/**
 * Global state distributed to every isolate. Cached per data center by the
 * Cache API (without `lease`).
 */
export interface Snapshot {
  v: 1;
  /** Configuration generation. */
  gen: number;
  /** Coordinator clock when the snapshot was built (epoch ms). */
  at: number;
  mode: Mode;
  paused: boolean;
  /** True when visitors can be admitted without a ticket. */
  open: boolean;
  /** Open with plenty of headroom: longer TTL and leases, lazy usage reports. */
  calm: boolean;
  cursorMs: number;
  /** Effective admission rate for tickets (per minute). */
  rEff: number;
  /** Tickets with ticketNo <= earlyUpTo may be admitted now. */
  earlyUpTo: number;
  /** [ticketNoUpTo, offsetMs]: offsets added to tickets issued before a pause ended. */
  pauseOffsets: [number, number][];
  /**
   * [ticketNo, winnerTag]: tickets redeemed more than once. Sessions carrying
   * such a ticket are refused unless their tag matches the first redemption.
   */
  revoked: [number, number][];
  activesEstimate: number;
  brakeFactor: number;
  /** How long this snapshot may be used, and the flush interval. */
  ttlMs: number;
  lease?: Lease;
  config?: RoomConfig;
}

export interface EdgeCounters {
  provisionalIssued: number;
  provisionalClaimed: number;
  waitingPages: number;
  botBypass: number;
  ipBypass: number;
  headerBypass: number;
  passBypass: number;
  failOpen: number;
  errTimeout: number;
  errOverloaded: number;
  errOther: number;
  reserveTooEarly: number;
  reservePowFailed: number;
  reserveBusy: number;
  reserveCrossSite: number;
  reserveNoProvisional: number;
  reserveTurnstileFailed: number;
  sessionRefused: number;
  ticketRefused: number;
  passRefused: number;
  bypassRefused: number;
}

/** Deltas accumulated by one isolate and sent with every RPC. */
export interface Batch {
  isolateId: string;
  /** Random non-zero 32-bit tag of the isolate, stored in the session cookies it issues. */
  tag: number;
  seq: number;
  /** Start of the period covered by this batch (epoch ms). */
  since: number;
  knownGen: number;
  /** Ticket numbers exchanged for a session since the previous batch. */
  redeemed: number[];
  /** Leased slots consumed since the previous batch. */
  leaseUsed: number;
  /** [epochSecond, count]: when those slots were consumed. */
  leaseUsage: [number, number][];
  /** Leased slots given back (the remainder of the current lease). */
  leaseUnused: number;
  /** Slots requested for the next lease. */
  leaseWanted: number;
  /** A visitor is waiting for a slot right now. */
  urgent: boolean;
  /** [minute, delta]: +1 on the current minute, -1 on the previously counted one. */
  activeDeltas: [number, number][];
  wlActiveDeltas: [number, number][];
  counters: EdgeCounters;
}

/** Why the coordinator refused a reservation: cookie outside provisionalWindowSec, queue at maxWaitingTickets, or mode off. */
export type ReserveRefusal = "expired" | "full" | "off";

export interface ReserveResult {
  /** 0 when refused. */
  ticketNo: number;
  admitAtMs: number;
  /** Set when no ticket was handed out (absent from older coordinators). */
  refused?: ReserveRefusal;
  snapshot: Snapshot;
}

/** Third argument of reserve(); ignored by older coordinators. */
export interface ReserveOptions {
  /** Issue time of the provisional cookie carrying the nonce (epoch seconds). */
  issuedSec?: number;
  /** Configuration generation the isolate holds (the snapshot omits the configuration when unchanged). */
  knownGen?: number;
}

export type AdminOp =
  | { op: "state" }
  | { op: "metrics" }
  | { op: "dashboard" }
  | { op: "patchConfig"; patch: Partial<RoomConfig> }
  | { op: "setMode"; mode: Mode }
  | { op: "setPause"; paused: boolean }
  | { op: "whitelistAdd"; entries: WhitelistEntry[] }
  | { op: "whitelistRemove"; cidrs: string[] };

export type AdminResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** RPC surface of the coordinator Durable Object. */
export interface CoordinatorRpc {
  /** `batch` is only sent by older edges: batches now always go through flush(). */
  reserve(nonce: string, batch: Batch | null, opts?: ReserveOptions): Promise<ReserveResult>;
  flush(batch: Batch): Promise<Snapshot>;
  getSnapshot(): Promise<Snapshot>;
  admin(op: AdminOp): Promise<AdminResult>;
  prometheus(room: string): Promise<string>;
}

/** Metrics exported by the coordinator, rendered as Prometheus text (src/shared/prometheus.ts). */
export interface CoordinatorMetrics {
  gauges: Record<string, number>;
  counters: Record<string, number>;
  labelled: { name: string; labels: Record<string, string>; value: number; type: "gauge" | "counter" }[];
}

/** Data behind the dashboards (admin op "dashboard"). Not a stable interface. */
export interface DashboardData {
  at: number;
  state: Record<string, unknown>;
  metrics: CoordinatorMetrics;
  /** Per-minute series over the last hour, oldest first; the last value is the current minute. */
  history: Record<string, number[]>;
  /** Isolates seen within the last 10 minutes. */
  isolates: {
    seen: number;
    /** Reported within the last minute (wr_coordinator_isolates). */
    active: number;
    /** Holding a lease that has not expired. */
    leasing: number;
    /** Reported within the last minute with an older configuration generation. */
    behind: number;
    /** The 10 largest leases, then the most recent reports. */
    top: { id: string; seq: number; lastSeenSec: number; lease: number }[];
  };
  revoked: number;
  pendingNonces: number;
  /** Tickets held by the ledger (waiting, plus due but not evaluated yet). */
  ledgerTickets: number;
}
