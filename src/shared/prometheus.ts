// SPDX-License-Identifier: Apache-2.0
//
// Prometheus text exposition of the coordinator metrics. Metric names are part
// of the public interface (docs/interfaces.md). Rendered by the coordinator
// next to its data: /__wr/metrics gets the text in one RPC.

import type { CoordinatorMetrics } from "./types.js";
import { VERSION } from "./version.js";

const HELP: Record<string, string> = {
  wr_admission_rate_target: "Configured admission rate R (users per minute).",
  wr_admission_rate_effective: "Effective admission rate for tickets, after overbooking and brake (users per minute).",
  wr_cursor_lag_seconds: "Admission cursor minus current time (the start of the pause while paused); positive while visitors wait.",
  wr_waiting_tickets: "Tickets handed out and not yet due (visitors waiting).",
  wr_absence_ratio: "Share of tickets never exchanged within the grace period (sliding window).",
  wr_active_users_estimate: "Estimated active users (sessions seen within the session duration).",
  wr_active_users_whitelisted: "Estimated whitelisted active users (separate counter).",
  wr_brake_factor: "Multiplier applied to the admission rate by the safety brake.",
  wr_paused: "1 while admissions are paused.",
  wr_open: "1 while visitors are admitted without a ticket.",
  wr_calm: "1 while open with plenty of headroom (longer TTL and leases).",
  wr_utilization: "Admissions over the last minute divided by the admission rate.",
  wr_lease_outstanding_slots: "Slots leased to isolates and not reported yet.",
  wr_coordinator_isolates: "Edge isolates that reported in the last minute.",
  wr_config_generation: "Configuration generation.",
  wr_tickets_reserved_total: "Tickets handed out (slots reserved from the waiting page).",
  wr_tickets_redeemed_total: "Tickets exchanged for a session.",
  wr_tickets_absent_total: "Tickets never exchanged within the grace period.",
  wr_replays_rejected_total: "Ticket redemptions detected as replays.",
  wr_waiting_pages_total: "Waiting pages served.",
  wr_fail_open_total: "Requests let through because the coordinator was unavailable.",
  wr_worker_requests_total: "Invocations of the edge Worker reported by the isolates (billed Worker requests), early exits included.",
  wr_early_exits_total: "Requests relayed untouched by the early exit (static extensions and prefixes).",
  wr_coordinator_rows_written_total: "SQLite rows written by the coordinator.",
  wr_coordinator_storage_row_bytes: "Largest SQLite row, bytes (limit 2 MB).",
  wr_edge_config_generation_min: "Oldest configuration generation held by an isolate (last minute).",
  wr_ledger_tickets: "Tickets held by the ledger.",
  wr_batch_duplicates_total: "Edge batches resent after a lost answer, not applied again.",
  wr_batch_gaps_total: "Edge batches lost by a coordinator restart.",
  wr_coordinator_requests_total: "Requests received by the coordinator (billed Durable Object requests).",
  wr_mode: "Current mode.",
  wr_admissions_total: "Admissions by path (lease: open mode, ticket: from the queue).",
  wr_lease_slots_total: "Leased slots by state.",
  wr_provisional_total: "Provisional cookies issued and claimed.",
  wr_bypass_total: "Requests let through by the whitelist.",
  wr_coordinator_errors_total: "Coordinator calls that failed, by kind.",
  wr_reserve_refused_total: "Reservations refused, by reason.",
  wr_refused_total: "Session, ticket, signed link or bypass header refused (invalid, expired, revoked), by kind.",
  wr_cost_projection_usd: "Projected monthly cost beyond the included usage (Durable Object, Worker requests), from the last hour.",
  wr_reserve_wait_seconds: "Wait handed out by each reservation (admitAt minus now; the pause excluded).",
  wr_usage_projection: "Projected monthly usage (Durable Object, Worker requests), from the last hour.",
};

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "NaN";
}

export function renderPrometheus(m: CoordinatorMetrics, room: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const head = (name: string, type: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} ${type}`);
  };
  const r = `room="${esc(room)}"`;
  head("wr_build_info", "gauge");
  out.push(`wr_build_info{${r},version="${VERSION}"} 1`);
  for (const [k, v] of Object.entries(m.gauges)) {
    head(k, "gauge");
    out.push(`${k}{${r}} ${fmt(v)}`);
  }
  for (const [k, v] of Object.entries(m.counters)) {
    head(k, "counter");
    out.push(`${k}{${r}} ${fmt(v)}`);
  }
  for (const l of m.labelled) {
    head(l.name, l.type);
    const labels = Object.entries(l.labels).map(([k, v]) => `${k}="${esc(v)}"`);
    out.push(`${l.name}{${[r, ...labels].join(",")}} ${fmt(l.value)}`);
  }
  for (const h of m.histograms) {
    head(h.name, "histogram");
    let n = 0;
    h.bounds.forEach((b, i) => {
      n += h.counts[i] ?? 0;
      out.push(`${h.name}_bucket{${r},le="${fmt(b)}"} ${n}`);
    });
    n += h.counts[h.bounds.length] ?? 0;
    out.push(`${h.name}_bucket{${r},le="+Inf"} ${n}`, `${h.name}_sum{${r}} ${fmt(h.sum)}`, `${h.name}_count{${r}} ${n}`);
  }
  return `${out.join("\n")}\n`;
}
