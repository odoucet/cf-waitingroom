// SPDX-License-Identifier: Apache-2.0
//
// Coordinator Durable Object (one per room, SQLite storage), exported by the
// same Worker as the edge handler (src/index.ts). It is a thin wrapper around the pure algorithm in
// src/core/coordinator-core.ts. The state is recomputed on every RPC. It is
// persisted by an alarm set FLUSH_DELAY_MS after the first change (high-water
// marks immediately): the object hibernates after 10 s without a request or an
// event and loses its memory, so every change must be written before that.

import { DurableObject } from "cloudflare:workers";
import { AdminError, CoordinatorCore, type RequestKind } from "../core/coordinator-core.js";
import { bootstrapConfig, ConfigError, mergeConfig, DEFAULT_CONFIG } from "../shared/config.js";
import { renderPrometheus } from "../shared/prometheus.js";
import type { AdminOp, AdminResult, Batch, CoordinatorRpc, ReserveOptions, ReserveResult, Snapshot } from "../shared/types.js";
import { Storage } from "./storage.js";

export interface CoordinatorEnv {
  /** JSON patch applied on top of the defaults when the room has no stored configuration. */
  WR_BOOTSTRAP_CONFIG?: string;
}


/** Delay of the persistence alarm: well under the 10 s of inactivity after which the object hibernates. */
export const FLUSH_DELAY_MS = 5_000;
/** Backstop when the alarm is late: a request persists if the last write is older than this. */
const PERSIST_EVERY_MS = 10_000;
const MAX_BATCH_ITEMS = 50_000;

function sanitizeBatch(b: Batch): Batch {
  if (typeof b !== "object" || b === null || typeof b.isolateId !== "string" || !Number.isFinite(b.seq)) {
    throw new TypeError("invalid batch");
  }
  if (b.redeemed.length > MAX_BATCH_ITEMS || b.leaseUsage.length > MAX_BATCH_ITEMS || b.activeDeltas.length > MAX_BATCH_ITEMS) {
    throw new TypeError("batch too large");
  }
  return b;
}

export class Coordinator extends DurableObject<CoordinatorEnv> implements CoordinatorRpc {
  private core!: CoordinatorCore;
  private storage!: Storage;
  private lastPersist = 0;
  /** Changes not written yet. */
  private dirty = false;
  /** A persistence alarm is set (it is cleared when it runs). */
  private alarmSet = false;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.load());
  }

  private load(): void {
    const now = Date.now();
    this.storage = new Storage(this.ctx.storage.sql);
    let stored = this.storage.readConfig();
    if (!stored) {
      stored = { gen: 1, config: bootstrapConfig(this.env.WR_BOOTSTRAP_CONFIG) };
      this.storage.writeConfig(stored);
    } else {
      // Accept configurations stored by an older version: new keys get their defaults, removed
      // keys are dropped (failMode is now the edge FAIL_MODE variable), and whitelist entries
      // stored before a stricter check are kept (base whitelist = stored one).
      const { failMode: _removed, ...config } = stored.config as typeof stored.config & { failMode?: unknown };
      // Turnstile without a site key, accepted by older versions, would refuse every reservation.
      if (config.reserveVerifier === "turnstile" && !config.turnstileSiteKey) {
        config.reserveVerifier = "none";
        console.error({ event: "config_repaired", reason: "reserveVerifier turnstile without turnstileSiteKey: set to none" });
      }
      const whitelist = Array.isArray(config.whitelist) ? config.whitelist : [];
      stored = { gen: stored.gen, config: mergeConfig({ ...DEFAULT_CONFIG, whitelist }, config) };
    }
    this.core = CoordinatorCore.restore(this.storage.readState(), this.storage.readHwm(), stored.config, stored.gen, now, this.storage.nonces);
    this.lastPersist = now;
    this.persist(now, true);
    console.log({ event: "coordinator_start", mode: this.core.config.mode, paused: this.core.pause.paused, gen: this.core.gen, nextTicketNo: this.core.ledger.next });
  }

  /**
   * Writes the high-water marks when they moved, and the state when forced (revocation,
   * configuration, pause) or when the last write is older than PERSIST_EVERY_MS. Otherwise the
   * persistence alarm writes it within FLUSH_DELAY_MS.
   */
  private persist(now: number, force = false): void {
    if (this.core.hwmDirty) {
      this.storage.writeHwm(this.core.hwm);
      this.core.hwmDirty = false;
    }
    if (force || this.core.persistNow || now - this.lastPersist >= PERSIST_EVERY_MS) {
      this.core.persistNow = false;
      this.storage.writeState(this.core.toPersisted(now), this.core.ledger);
      this.lastPersist = now;
      this.dirty = false;
      this.core.storageRowBytes = this.storage.maxRowBytes();
    }
    // Rows of this write are counted in memory only: they would otherwise call for another write.
    this.core.recordRowsWritten(this.storage.takeRowsWritten(), now);
    if (this.dirty && !this.alarmSet) {
      this.alarmSet = true;
      void this.ctx.storage.setAlarm(now + FLUSH_DELAY_MS);
    }
  }

  private begin(kind: RequestKind): number {
    const now = Date.now();
    this.core.tick(now);
    this.core.recordRequest(kind, now);
    this.dirty = true;
    return now;
  }

  /** Persistence alarm: writes what changed since the last write, before the object can hibernate. */
  override async alarm(): Promise<void> {
    this.alarmSet = false;
    const now = Date.now();
    this.core.tick(now);
    // Counted (it is billed) without calling for a write of its own: it is written with the next change.
    this.core.recordRequest("alarm", now);
    if (this.dirty) this.persist(now, true);
  }

  /**
   * Reservation. The nonce row is written in this same request: the answer
   * leaves only once it is durable. `batch` comes from older edges only.
   */
  async reserve(nonce: string, batch: Batch | null, opts?: ReserveOptions): Promise<ReserveResult> {
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) throw new TypeError("invalid nonce");
    const issuedSec = opts?.issuedSec;
    if (issuedSec !== undefined && !Number.isSafeInteger(issuedSec)) throw new TypeError("invalid issuedSec");
    const now = this.begin("reserve");
    if (batch) this.core.applyBatch(sanitizeBatch(batch), now);
    const r = this.core.reserve(nonce, now, issuedSec);
    this.persist(now);
    const snapshot = this.core.snapshot(now, batch ? batch.knownGen : (opts?.knownGen ?? null));
    if (!r.refused) return { ...r, snapshot };
    // Older edges (no `opts`) do not read `refused` and would sign ticket 0: make them retry instead.
    if (!opts) throw new Error(`reservation refused: ${r.refused}`);
    return { ticketNo: 0, admitAtMs: 0, refused: r.refused, snapshot };
  }

  /** Applies a batch once: a resent batch (same seq) gets the same lease back and changes nothing. */
  async flush(batch: Batch): Promise<Snapshot> {
    const now = this.begin("flush");
    const b = sanitizeBatch(batch);
    const lease = this.core.receiveBatch(b, now);
    this.persist(now);
    return this.core.snapshot(now, b.knownGen, lease);
  }

  async getSnapshot(): Promise<Snapshot> {
    const now = this.begin("snapshot");
    this.persist(now);
    return this.core.snapshot(now, null);
  }

  /** Prometheus text of the coordinator metrics, for /__wr/metrics. */
  async prometheus(room: string): Promise<string> {
    const now = this.begin("admin");
    this.persist(now);
    return renderPrometheus(this.core.metrics(now), room);
  }

  async admin(op: AdminOp): Promise<AdminResult> {
    const now = this.begin("admin");
    try {
      const genBefore = this.core.gen;
      const pausedBefore = this.core.pause.paused;
      const data = this.core.admin(op, now);
      if (this.core.gen !== genBefore) this.storage.writeConfig({ gen: this.core.gen, config: this.core.config });
      this.persist(now, this.core.gen !== genBefore || this.core.pause.paused !== pausedBefore);
      if (op.op !== "state" && op.op !== "metrics" && op.op !== "dashboard") {
        console.log({ event: "admin_change", op: op.op, gen: this.core.gen, mode: this.core.config.mode, paused: this.core.pause.paused });
      }
      return { ok: true, data };
    } catch (e) {
      if (e instanceof ConfigError || e instanceof AdminError) return { ok: false, error: e.message };
      throw e;
    }
  }
}
