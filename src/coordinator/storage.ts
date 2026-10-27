// SPDX-License-Identifier: Apache-2.0
//
// SQLite persistence of the coordinator. A row is limited to 2 MB, so nothing
// that grows with the queue lives in a single row:
//   kv      config   -> { gen, config }        written on every configuration change
//           hwm      -> high-water marks       written before answering when they move
//           state    -> persisted core         written at most every ~10 s (ledger meta only)
//           isolates -> last batch per isolate written with the state it belongs to
//   ledger  one row per chunk of LEDGER_CHUNK tickets, only the chunks that changed
//   nonces  one row per reservation, written before the reservation is answered
// Everything written by one request is committed atomically (single event, no await).

import type { HighWater, NonceRecord, NonceStore, PersistedCore } from "../core/coordinator-core.js";
import { LEDGER_CHUNK, type LedgerChunk, type LedgerData, type LedgerMeta, TicketLedger } from "../core/ledger.js";
import { writeLog } from "../shared/log.js";
import type { RoomConfig } from "../shared/types.js";

export interface StoredConfig {
  gen: number;
  config: RoomConfig;
}

/** Above this size, every write of the row is logged: the hard limit is 2 MB. */
const ROW_WARN_BYTES = 1_000_000;

type StoredState = Omit<PersistedCore, "ledger" | "isolates"> & { ledger: LedgerMeta | (LedgerData & { admitAtDelta?: number[] }) };

/** Nonce table: lookups by primary key, pruning by issue time. */
class SqlNonceStore implements NonceStore {
  size: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly written: (n: number) => void,
  ) {
    this.size = sql.exec<{ n: number }>("SELECT count(*) AS n FROM nonces").one().n;
  }

  get(nonce: string): NonceRecord | undefined {
    const rows = this.sql.exec<{ t: number; a: number; i: number }>("SELECT ticket_no AS t, admit_at AS a, issued_sec AS i FROM nonces WHERE nonce = ?", nonce).toArray();
    const r = rows[0];
    return r ? { ticketNo: r.t, admitAtMs: r.a, issuedSec: r.i } : undefined;
  }

  set(nonce: string, r: NonceRecord): void {
    const c = this.sql.exec("INSERT OR REPLACE INTO nonces (nonce, ticket_no, admit_at, issued_sec) VALUES (?, ?, ?, ?)", nonce, r.ticketNo, r.admitAtMs, r.issuedSec);
    this.written(c.rowsWritten);
    this.size++;
  }

  prune(beforeSec: number): void {
    const c = this.sql.exec("DELETE FROM nonces WHERE issued_sec < ?", beforeSec);
    this.written(c.rowsWritten);
    this.size = Math.max(0, this.size - c.rowsWritten);
  }
}

export class Storage {
  /** Rows written since the last call to takeRowsWritten(). */
  private rows = 0;
  /** Size of every row written or read, by key: the largest is exported as a metric. */
  private rowBytes = new Map<string, number>();
  readonly nonces: NonceStore;

  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS ledger (chunk INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, ticket_no INTEGER NOT NULL, admit_at INTEGER NOT NULL, issued_sec INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS nonces_issued ON nonces (issued_sec)");
    this.nonces = new SqlNonceStore(sql, (n) => (this.rows += n));
  }

  private get<T>(k: string): T | null {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray();
    if (rows.length === 0) return null;
    this.rowBytes.set(k, rows[0]!.v.length);
    return JSON.parse(rows[0]!.v) as T;
  }

  private size(key: string, json: string): void {
    this.rowBytes.set(key, json.length);
    if (json.length > ROW_WARN_BYTES) writeLog("warn", "storage_row_large", { key, bytes: json.length });
  }

  private put(k: string, v: unknown): void {
    const json = JSON.stringify(v);
    this.size(k, json);
    const c = this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, json);
    this.rows += c.rowsWritten;
  }

  takeRowsWritten(): number {
    const n = this.rows;
    this.rows = 0;
    return n;
  }

  /** Largest row written or read so far, in bytes. */
  maxRowBytes(): number {
    let m = 0;
    for (const v of this.rowBytes.values()) if (v > m) m = v;
    return m;
  }

  readConfig(): StoredConfig | null {
    return this.get<StoredConfig>("config");
  }

  writeConfig(c: StoredConfig): void {
    this.put("config", c);
  }

  readHwm(): HighWater | null {
    return this.get<HighWater>("hwm");
  }

  writeHwm(h: HighWater): void {
    this.put("hwm", h);
  }

  readState(): PersistedCore | null {
    const s = this.get<StoredState>("state");
    if (!s) return null;
    const isolates = this.get<PersistedCore["isolates"]>("isolates") ?? [];
    const l = s.ledger;
    let ledger: LedgerData;
    if ("next" in l) {
      const chunks = this.sql
        .exec<{ chunk: number; v: string }>("SELECT chunk, v FROM ledger WHERE chunk >= ? ORDER BY chunk", Math.floor(l.base / LEDGER_CHUNK))
        .toArray()
        .map((r) => {
          this.rowBytes.set(`ledger:${r.chunk}`, r.v.length);
          return JSON.parse(r.v) as LedgerChunk;
        });
      ledger = TicketLedger.fromChunks(l, chunks);
    } else {
      // Layout of older versions: the whole ledger inline, admitAt delta-encoded.
      ledger = l;
      const d = l.admitAtDelta;
      if (d) {
        const out: number[] = [];
        let prev = 0;
        for (const x of d) {
          if (x === -1) {
            out.push(-1);
            continue;
          }
          prev += x;
          out.push(prev);
        }
        ledger.admitAt = out;
        delete l.admitAtDelta;
      }
    }
    return { ...s, ledger, isolates };
  }

  /** Writes the state row, the batch numbers, and the ledger chunks that changed since the last call. */
  writeState(s: PersistedCore, ledger: TicketLedger): void {
    const { ledger: _full, isolates, ...rest } = s;
    this.put("state", { ...rest, ledger: ledger.meta() });
    this.put("isolates", isolates ?? []);
    for (const c of ledger.takeDirtyChunks()) {
      const json = JSON.stringify(ledger.chunk(c));
      this.size(`ledger:${c}`, json);
      const r = this.sql.exec("INSERT INTO ledger (chunk, v) VALUES (?, ?) ON CONFLICT(chunk) DO UPDATE SET v = excluded.v", c, json);
      this.rows += r.rowsWritten;
    }
    const first = ledger.firstChunk();
    const del = this.sql.exec("DELETE FROM ledger WHERE chunk < ?", first);
    this.rows += del.rowsWritten;
    for (const k of this.rowBytes.keys()) if (k.startsWith("ledger:") && Number(k.slice(7)) < first) this.rowBytes.delete(k);
  }
}
