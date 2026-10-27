# Cost model

Prices from the Cloudflare documentation as of October 2026
([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)). Check them
again before relying on the figures.

| Item | Included (Workers Paid, $5/month) | Beyond |
|---|---|---|
| Worker requests | 10 M / month | $0.30 / million |
| Worker CPU time | 30 M ms / month | $0.02 / million ms |
| Durable Object requests (HTTP, RPC sessions, **alarm invocations**) | 1 M / month | $0.15 / million |
| Durable Object duration (128 MB while active and not hibernatable) | 400,000 GB-s / month | $12.50 / million GB-s |
| SQLite rows written | 50 M / month | $1.00 / million |
| SQLite storage | 5 GB-month | $0.20 / GB-month |
| Workers Logs (until 1 Dec 2026) | 20 M events / month | $0.60 / million |
| Workers Logs (from 1 Dec 2026, Observability pricing) | 50 GB ingested / month | $0.25 / GB |

## Worker requests

Every request on a protected route is one Worker request, whatever the decision. Routes without a
Worker (static, API, webhooks) cost nothing. Count your HTML page views on protected paths: that is the
Worker bill. CPU stays around 0.1–0.3 ms per request (one HMAC verification, plus one signature when a
cookie is written).

## Durable Object requests

They are driven by the number of **active isolates** and the number of **queued humans**, not by
raw traffic:

- each isolate flushes its deltas in one RPC (which also returns the snapshot and a lease); cadence in
  [algorithm.md](algorithm.md#flushes): roughly once per lease lifetime when calm (2 minutes), once
  per TTL (10 s) to once per lease exhaustion near capacity;
- isolates with nothing to send read the snapshot from the Cache API (free), at most one RPC per data
  center and TTL when the cache is empty;
- each queued human costs one reservation;
- admin calls and metrics scrapes cost one request each (a 30 s scrape interval is ≈ 86k per month);
- an open dashboard costs one request per refresh (every 10 s while visible, ≈ 360 per hour);
- the persistence alarm: at most one every 5 s, and only after a change (≈ 520k per month if the room
  never stays quiet for 5 s, a few thousand when it idles); without it, the object would lose its
  memory when it hibernates after 10 s without a request.

Simulated monthly requests (R = 200/min, 30-minute runs extrapolated to 30 days, 100 bot requests/min):

| Active isolates | 10 % of R | 25 % of R | 50 % of R | 80 % of R |
|---|---|---|---|---|
| 5 | 0.2 M | 0.2 M | 1.2 M | 1.8 M |
| 10 | 0.3 M | 0.4 M | 2.1 M | 3.4 M |
| 20 | 0.6 M | 0.8 M | 3.4 M | 8.1 M |
| 50 | 1.4 M | 2.5 M | 6.3 M | 11 M |

While queueing (demand at 1.5 R, 20 isolates): ≈ 324 requests per minute, 92 % of them
reservations. A site that spends most of the day below 25 % of `R` and a few hours near or above it stays
within 1–3 M requests per month. In dollars, even 11 M requests per month is about $1.50 beyond
the included million.

The knobs, in order of effect: `calmLeaseSec` and `calmSnapshotTtlSec` (longer = fewer flushes when
calm), `calmLeaseMaxOutstandingSec` and `leaseMaxOutstandingSec` (larger = fewer refills, larger
overshoot bound), and the brake (on = session counts flushed every minute instead of every five).

## Durable Object duration

The single coordinator receives a request at least every few seconds, so it is practically always
active: 0.125 GB × 2,592,000 s ≈ 324,000 GB-s per month, inside the 400,000 included. A staging room
doubles it (≈ 648,000 GB-s, about $3 beyond the allowance). One object per room, no shards.

## SQLite

State written by the persistence alarm at most every 5 s while the room changes (state, batch numbers
and the ledger chunks that changed: a few rows, ≈ 2 M rows per month at most), high-water marks every 10 s of reserved slots, configuration on changes.
Each reservation also writes its nonce (one row plus its index entry) and deletes it 24 h later: about
3 rows per ticket, 3 M rows for a million tickets. Far below the 50 M rows included.

## Logs

Invocation logs are disabled on the Worker (`observability.logs.invocation_logs: false`): each
invocation would otherwise emit one billed log line. Nominal decisions are sampled (`LOG_SAMPLE_RATE`,
1 %), and so are waiting pages and refusals, which visitors and floods can multiply: they are
counted exactly in the metrics instead. Errors, admin actions, signed-link uses and reservations are
always logged. During a coordinator outage, `fail_mode` is logged for every request it lets through.

## Live projection

The coordinator exports, from its last hour of activity:

- `wr_usage_projection{item="do_requests"|"do_gb_seconds"|"do_rows_written"|"worker_requests"}`: monthly usage;
- `wr_cost_projection_usd{item=...}`: monthly cost beyond the included usage (it ignores other
  Workers of the account sharing the allowance);
- `wr_coordinator_requests_total{kind,mode}`: requests by kind (reserve, flush, snapshot, admin) and
  mode (open, queue, paused, off);
- `wr_coordinator_isolates`: active isolates, the main driver;
- `wr_worker_requests_total` and `wr_early_exits_total`: Worker requests, and those relayed by the
  early exit.

Each isolate counts its Worker requests in memory and sends the count with its next batch; the count
alone never triggers a flush, so measuring the Worker requests costs no Durable Object request. The
figure is a slight undercount: an isolate evicted before its next batch takes its count with it, which
mostly concerns isolates serving only early exits or bots. Early exits are billed like any other
request: `wr_early_exits_total` is what excluding those paths from the routes would save. The Worker
CPU time cannot be measured from inside the Worker (the clock does not advance during execution); read
it from the Cloudflare analytics.
