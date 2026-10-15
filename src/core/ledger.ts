// SPDX-License-Identifier: Apache-2.0
//
// Ledger of recent tickets: signed admitAt, redemption flag, and the absence
// ratio that was applied when the ticket was issued. Entries are kept until
// their redemption deadline has passed and they have been evaluated.
// Persisted in chunks of LEDGER_CHUNK tickets: only the chunks that changed
// are written, and no single storage row grows with the queue.

/** Tickets per persisted chunk (≈ 30 bytes per ticket: a chunk row stays far below the 2 MB row limit). */
export const LEDGER_CHUNK = 4096;

export type RedeemResult = { r: "ok" } | { r: "duplicate"; winnerTag: number } | { r: "unknown" };

export interface LedgerData {
  base: number;
  admitAt: number[];
  redeemed: number[];
  aIssued: number[];
  evalNext: number;
  dueNext: number;
}

/** Ledger without its entries: what the state row holds. */
export type LedgerMeta = Omit<LedgerData, "admitAt" | "redeemed" | "aIssued"> & { next: number };

/** Entries of one chunk, from ticket `from` (admitAt delta-encoded, -1 = unknown). */
export interface LedgerChunk {
  from: number;
  a: number[];
  r: number[];
  i: number[];
}

/** Marker for tickets whose admitAt is unknown (issued just before a restart). */
export const UNKNOWN_ADMIT = -1;

export class TicketLedger {
  base: number;
  admitAt: number[];
  /** 0 when not redeemed, otherwise the tag of the isolate that redeemed it first. */
  redeemed: number[];
  aIssued: number[];
  /** Next ticket to evaluate for absence. */
  evalNext: number;
  /** Next ticket whose effective admitAt is still in the future. */
  dueNext: number;
  /** Chunks changed since the last takeDirtyChunks(). */
  private dirty = new Set<number>();

  constructor(data?: LedgerData) {
    this.base = data?.base ?? 1;
    this.admitAt = data?.admitAt.slice() ?? [];
    this.redeemed = data?.redeemed.slice() ?? [];
    this.aIssued = data?.aIssued.slice() ?? [];
    this.evalNext = data?.evalNext ?? this.base;
    this.dueNext = data?.dueNext ?? this.base;
    // A restored ledger is written again in full once (self-healing, and migrates older layouts).
    for (let c = Math.floor(this.base / LEDGER_CHUNK); c <= Math.floor((this.next - 1) / LEDGER_CHUNK); c++) this.dirty.add(c);
  }

  private touch(t: number): void {
    this.dirty.add(Math.floor(t / LEDGER_CHUNK));
  }

  /** Ticket number the next issued ticket will get. */
  get next(): number {
    return this.base + this.admitAt.length;
  }

  issue(admitAt: number, aIssued: number): number {
    const t = this.next;
    this.admitAt.push(admitAt);
    this.redeemed.push(0);
    this.aIssued.push(aIssued);
    this.touch(t);
    return t;
  }

  /** Reserves ticket numbers up to `upTo` (excluded) with unknown admitAt. */
  skipTo(upTo: number): void {
    while (this.next < upTo) {
      this.touch(this.next);
      this.admitAt.push(UNKNOWN_ADMIT);
      this.redeemed.push(0);
      this.aIssued.push(0);
    }
  }

  has(t: number): boolean {
    return t >= this.base && t < this.next;
  }

  admitAtOf(t: number): number {
    return this.has(t) ? this.admitAt[t - this.base]! : UNKNOWN_ADMIT;
  }

  isRedeemed(t: number): boolean {
    return this.has(t) && this.redeemed[t - this.base] !== 0;
  }

  aIssuedOf(t: number): number {
    return this.has(t) ? this.aIssued[t - this.base]! : 0;
  }

  /** Marks a ticket as redeemed by the isolate `tag` (non-zero). */
  redeem(t: number, tag: number): RedeemResult {
    if (!this.has(t)) return { r: "unknown" };
    const i = t - this.base;
    const prev = this.redeemed[i]!;
    if (prev !== 0) return { r: "duplicate", winnerTag: prev };
    this.redeemed[i] = tag || 1;
    this.touch(t);
    return { r: "ok" };
  }

  /** Drops entries below `keepFrom`. Amortised: only splices in large chunks. */
  prune(keepFrom: number, force = false): void {
    const n = Math.min(keepFrom, this.next) - this.base;
    if (n <= 0 || (!force && n < 512)) return;
    this.admitAt.splice(0, n);
    this.redeemed.splice(0, n);
    this.aIssued.splice(0, n);
    this.base += n;
    if (this.evalNext < this.base) this.evalNext = this.base;
    if (this.dueNext < this.base) this.dueNext = this.base;
  }

  /** Tickets issued and not yet due (an estimate of the waiting visitors). */
  waitingCount(): number {
    return this.next - this.dueNext;
  }

  /** Chunks changed since the previous call, still holding live tickets. */
  takeDirtyChunks(): number[] {
    const first = Math.floor(this.base / LEDGER_CHUNK);
    const out = [...this.dirty].filter((c) => c >= first).sort((a, b) => a - b);
    this.dirty.clear();
    return out;
  }

  /** First chunk that still holds live tickets: older ones can be deleted. */
  firstChunk(): number {
    return Math.floor(this.base / LEDGER_CHUNK);
  }

  meta(): LedgerMeta {
    return { base: this.base, next: this.next, evalNext: this.evalNext, dueNext: this.dueNext };
  }

  /** Live entries of chunk `c`. */
  chunk(c: number): LedgerChunk {
    const from = Math.max(this.base, c * LEDGER_CHUNK);
    const to = Math.min(this.next, (c + 1) * LEDGER_CHUNK);
    const a: number[] = [];
    let prev = 0;
    for (let t = from; t < to; t++) {
      const x = this.admitAt[t - this.base]!;
      if (x < 0) a.push(-1);
      else {
        a.push(x - prev);
        prev = x;
      }
    }
    const i = this.aIssued.slice(from - this.base, to - this.base).map((v) => Math.round(v * 1000) / 1000);
    return { from, a, r: this.redeemed.slice(from - this.base, to - this.base), i };
  }

  /** Rebuilds the ledger data from its meta and chunks; missing entries become unknown tickets. */
  static fromChunks(meta: LedgerMeta, chunks: LedgerChunk[]): LedgerData {
    const n = Math.max(0, meta.next - meta.base);
    const admitAt = new Array<number>(n).fill(UNKNOWN_ADMIT);
    const redeemed = new Array<number>(n).fill(0);
    const aIssued = new Array<number>(n).fill(0);
    for (const ch of chunks) {
      let prev = 0;
      for (let k = 0; k < ch.a.length; k++) {
        const d = ch.a[k]!;
        let x = UNKNOWN_ADMIT;
        if (d !== -1) {
          prev += d;
          x = prev;
        }
        const j = ch.from + k - meta.base;
        if (j < 0 || j >= n) continue;
        admitAt[j] = x;
        redeemed[j] = ch.r[k] ?? 0;
        aIssued[j] = ch.i[k] ?? 0;
      }
    }
    return { base: meta.base, admitAt, redeemed, aIssued, evalNext: meta.evalNext, dueNext: meta.dueNext };
  }

  toData(): LedgerData {
    return {
      base: this.base,
      admitAt: this.admitAt,
      redeemed: this.redeemed,
      aIssued: this.aIssued.map((a) => Math.round(a * 1000) / 1000),
      evalNext: this.evalNext,
      dueNext: this.dueNext,
    };
  }
}
