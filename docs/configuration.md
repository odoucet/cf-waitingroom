# Configuration

Nothing deployment-specific lives in this repository. The configuration is split in three layers,
by how often it changes and by who needs it first.

| Layer | What | Where | How to change |
|---|---|---|---|
| Routing | hostnames, protected paths, excluded paths (static, API, webhooks), bot Transform Rules and their categories | `deploy/*.env` for routes (copies of `deploy/routes.env.example`), Transform Rules in the dashboard; in your private repository | `deploy/scripts/routes.sh apply` |
| Worker static | room id, fail mode, Durable Object binding, early-exit lists, header names, timeouts | `wrangler/waitingroom.jsonc` (git-ignored copy of `waitingroom.example.jsonc`) | `wrangler deploy` |
| Secrets | HMAC keys, admin token, metrics and dashboard credentials, bypass secret, Turnstile secret | `wrangler secret put` | no code change, but a new version: restarts the coordinator like a deployment |
| Operational | mode, rate, session duration, leases, overbooking, brake, whitelist… | coordinator storage (SQLite), distributed with the snapshot | admin API, live |

Anything the Worker needs before its first I/O (early exit) or without the coordinator (fail mode) is a variable. Anything an operator may
change during an event is operational and needs no deployment.

## Worker variables

| Variable | Default | Meaning |
|---|---|---|
| `ROOM_ID` | — | Room identifier, `[a-z0-9-]{1,32}`. Name of the Durable Object, part of the cookie names and of the cookie MAC input. Changing it starts a new, empty room. |
| `FAIL_MODE` | — (required) | Behaviour when the coordinator cannot be reached, including on an isolate that has not received its first snapshot yet: `open` relays to the origin (`wr_fail_open_total`), `closed` answers a static `503` with `Retry-After` (HTML page that reloads itself, or `{"status":"unavailable","retryAfterSec":N}` for JSON clients), without calling the origin. Unset or invalid: `closed`, and each isolate logs `misconfigured` once. A variable rather than a room setting so that it never depends on the coordinator. |
| `EARLY_EXIT_EXTENSIONS` | see example | Comma-separated extensions relayed untouched before any I/O (`GET`/`HEAD`, path forms such as `;` or `/index.php/x.css` excluded). List only extensions the origin serves from static files ([routing](routing.md#inside-the-worker)). |
| `EARLY_EXIT_PREFIXES` | empty | Comma-separated path prefixes relayed untouched, matched on whole segments: `/static` covers `/static` and `/static/…`, not `/static-checkout`. Never applied under `/__wr/`. Prefer routes without a Worker (the Worker does not even run). |
| `STALE_SNAPSHOT_TTLS` | `6` | How many snapshot TTLs an isolate keeps using its last snapshot while it cannot refresh it (coordinator unreachable), before the fail mode applies. Normal propagation takes at most two TTLs whatever the value; this only bounds how long an isolate keeps admitting on old state (pause, rate) during an outage. `1` is the strict setting: about 10 s near capacity, 30 s when calm. 1–6. |
| `BOT_HEADER` | `x-wr-bot` | Header that the Transform Rules set to `WR_BOT_SECRET` for verified bots of the allowed categories ([routing](routing.md#verified-bots)). The bypass needs both this variable and `WR_BOT_SECRET`; any other value is refused, so a client cannot forge it even without the rules. Removed before the request reaches the origin. Empty disables the bot bypass. |
| `BYPASS_HEADER` | `x-wr-bypass` | Header carrying `WR_BYPASS_SECRET` (server-to-server). Removed before the request reaches the origin. |
| `LOG_SAMPLE_RATE` | `0.01` | Share of nominal decisions, waiting pages and refusals logged (refusals are counted exactly in the metrics). Errors, admin actions and signed-link uses are always logged. |
| `COORDINATOR_TIMEOUT_MS` | `1000` | Timeout of coordinator calls on the request path (background calls use 5 s). |
| `LOCATION_HINT` | `weur` | Durable Object placement hint. Only honoured when the object is created; objects never move afterwards. |
| `ADMIN_HOSTS` | empty | Comma-separated operator hostnames, typically `waitingroom.<account-subdomain>.workers.dev` (with `workers_dev: true`). When set, the admin API, the metrics and the dashboard answer only there (404 on the site), and those hostnames serve nothing else. Recommended in production: see [operator access](operator-access.md). |

One variable is read by the coordinator Durable Object only:

| Variable | Meaning |
|---|---|
| `WR_BOOTSTRAP_CONFIG` | JSON patch applied on top of the defaults when the room has no stored configuration yet. Ignored afterwards. |

## Secrets

| Secret | Required | Meaning |
|---|---|---|
| `WR_KEYS` | yes | JSON object `{"<kid>": "<base64 secret>"}`, kid 0–255, one or two entries, secrets ≥ 32 bytes. |
| `WR_KEY_CURRENT` | yes | kid used to sign new cookies. Both kids are accepted for verification (rotation, see the runbook). |
| `WR_ADMIN_TOKEN` | for the admin API | Bearer token of `/__wr/admin/v1/*`. The API answers 404 when unset. |
| `WR_METRICS_USER`, `WR_METRICS_PASSWORD` | for metrics | Basic auth of `/__wr/metrics`. The endpoint answers 404 when unset. |
| `WR_DASHBOARD_USER`, `WR_DASHBOARD_PASSWORD` | for the dashboard | Basic auth of `/__wr/dashboard`, whose controls can change the room: an administration credential. The endpoint answers 404 when unset. Use credentials different from the metrics ones. |
| `WR_BYPASS_SECRET` | no | Value of the bypass header. |
| `WR_BOT_SECRET` | for the bot bypass | Value the Transform Rule gives `BOT_HEADER` for allowed verified bots (same value as the Transform Rule), at least 32 random characters. Unset: the bot bypass is disabled. |
| `WR_TURNSTILE_SECRET` | with Turnstile | Turnstile secret key. Set it **before** `reserveVerifier: turnstile`: the admin API refuses to enable Turnstile without it, and the preflight reports it missing. If it disappears later, reservations skip Turnstile (the proof of work still applies) and `misconfigured` is logged, rather than refusing every visitor. |

An invalid `ROOM_ID`, a missing `COORDINATOR` binding, or missing or invalid keys make the Worker
answer `503` with `Retry-After` on every protected path (the waiting-room paths answer `500
{"error":"misconfigured"}`) and log `misconfigured` on every request: a deployment mistake never
sends unprotected traffic to the origin. Early-exit paths are still relayed. Check the configuration
with `GET /__wr/admin/v1/preflight` before creating the routes ([runbook](runbook.md#cut-over-from-the-managed-waiting-room)).

## Dashboards

One page, `https://<host>/__wr/dashboard`, on the operator hostname (`ADMIN_HOSTS`), else on the
protected hostname. Basic auth, no external resources (strict CSP). It shows:

- the room, from the coordinator: mode, rate, wait, waiting tickets, utilisation, active users;
  per-minute charts of the last hour (admissions, tickets, waiting pages, no-shows, Durable Object
  requests by kind, bypasses, fail-open, rows written); totals; monthly cost projection; isolates;
  configuration;
- the isolate that answered: data center, snapshot age, local lease, pending deltas, coordinator calls
  and errors, Cache API hits.

Every figure has a help tooltip. The **Controls** section changes the room live, like the admin API:
mode (on, queue all, off), pause and resume, admission rate and session duration, whitelist, signed
links, and any other setting as a JSON patch. Each change asks for confirmation, is validated by the
coordinator and logged. **The dashboard credentials therefore grant administration**: keep them as
secret as `WR_ADMIN_TOKEN`. For a read-only view (a customer, an on-call screen), use the Grafana
dashboard of [monitoring](monitoring.md) instead.

The page refreshes every 10 s while visible. Each refresh is one Durable Object request (≈ 360 per
hour with the page open). The per-minute history is kept in memory: it restarts empty after a coordinator restart,
while the totals are persisted.

With the `version_metadata` binding (`CF_VERSION_METADATA`, in `waitingroom.example.jsonc`), the page,
its data and the coordinator carry the id of the deployment that produced them. While a deployment
propagates, data from another version is not shown: a `coordinator on another version` badge (or
`this page and the server run different versions`) replaces it, usually for less than a minute. A
badge that lasts means the coordinator or part of the edge still runs another version: check
`wrangler deployments list`. Without the binding, no check is made.

## Operational configuration

Read with `GET /__wr/admin/v1/state`, change with `PATCH /__wr/admin/v1/config` (partial JSON,
validated; unknown keys are rejected). Each change increments a generation number; edges pick the new
configuration up with the next snapshot.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `on` | `off`: relay everything (kill switch). `on`: normal operation. `queue_all`: every new visitor goes through a reservation, admitted at the rate `R`. |
| `admissionsPerMinute` | 200 | Target admission rate `R`. Steady-state active users ≈ `R × mean session length`. |
| `sessionMinutes` | 10 | Session duration `D`: a session expires after `D` minutes without a request (sliding). |
| `sessionMaxMinutes` | 240 | Total lifetime of a session, however active (at least `D` applies). Bounds a shared or stolen session cookie; the visitor then goes through the room again. |
| `leaseBlockMax` | 20 | Largest block of slots one isolate may lease in open mode. |
| `leaseMaxOutstandingSec` | 10 | Cap on all outstanding leased slots near capacity, in seconds of `R`. |
| `calmLeaseMaxOutstandingSec` | 30 | Same cap when calm (utilisation below `calmUtilization`). |
| `calmLeaseSec` | 120 | Lease lifetime when calm (otherwise two snapshot TTLs). |
| `calmUtilization` | 0.5 | Calm when open and admissions over the last minute are below this share of `R`. |
| `burstSec` | 5 | Depth of the open-mode token bucket, in seconds of `R`. |
| `overbookCap` | 1.5 | Upper bound of the overbooking multiplier: `R_eff ≤ overbookCap × R`. |
| `redeemGraceSec` | 180 | A ticket can be exchanged from `admitAt` until `admitAt + redeemGraceSec`. Also the delay before an unused ticket counts as a no-show. |
| `absenceWindowSec` | 600 | Sliding window of the no-show ratio. |
| `provisionalWindowSec` | 600 | Maximum age of the provisional cookie (also its `Max-Age`), for an open-mode admission and for a reservation. |
| `brake.enabled` | false | Slow safety loop on the estimated active users. |
| `brake.activesThreshold` / `brake.activesLimit` / `brake.minFactor` | 2000 / 2400 / 0.25 | Above the threshold, `R_eff` is multiplied by a factor decreasing linearly to `minFactor` at the limit. Recomputed once a minute. |
| `waitingStatus` | 200 | HTTP status of the HTML waiting page (JSON answers use 503 with `Retry-After`). |
| `snapshotTtlSec` | 10 | Snapshot TTL and flush interval near capacity or while queueing. |
| `calmSnapshotTtlSec` | 30 | Snapshot TTL when calm. |
| `countWhitelisted` | true | Whether whitelisted users count in the active-user estimate (brake). |
| `reserveMinAgeSec` | 2 | Minimum age of the provisional cookie before `POST /__wr/reserve` (whole seconds). The page waits for it. |
| `reservePowBits` | 14 | Proof of work on `POST /__wr/reserve`, in leading zero bits of SHA-256; 0 disables. Each extra bit doubles the client work: 14 bits ≈ 16k hashes on average, about 0.1 s median and 0.6 s at p90 with WebCrypto on a desktop, several times more on low-end phones. Computed while the page waits for `reserveMinAgeSec`. |
| `maxWaitingTickets` | 100000 | Reservations are refused while this many tickets are waiting (503 `{"status":"retry","error":"full"}`, retried by the page after 30–60 s; `wr_reserve_refused_total{reason="full"}`). Bounds the coordinator memory and storage. 100–1,000,000. |
| `reserveMaxInflight` | 20 | Concurrent reservation calls to the coordinator per edge isolate. Beyond, the edge answers 503 `retry` (2–5 s) without calling the coordinator. |
| `reserveVerifier` | `none` | `turnstile` requires a Turnstile token on `POST /__wr/reserve`, obtained on the hostname of the request (Siteverify `hostname`). Needs `turnstileSiteKey` and the `WR_TURNSTILE_SECRET` edge secret. |
| `turnstileSiteKey` | empty | Public site key rendered in the waiting page. Required with `reserveVerifier: turnstile`. |
| `whitelist` | `[]` | `[{ "cidr": "198.51.100.0/24", "label": "office" }]`, IPv4/IPv6, at most 1,000 entries, no block wider than `/8` (IPv4) or `/32` (IPv6). Prefer the dedicated endpoints. |

### Choosing `R` and `D`

- `R` is the knob. If the origin is comfortable with `N` active users and the observed mean session
  length is `L` minutes, start with `R = N / L`. The active-user estimate exported by the coordinator counts
  sessions seen within `D`, so it reads higher than the real concurrency (about `R × (L + D)`).
- `D` is the inactivity timeout of a session. Keep it long enough for a checkout (10–30 minutes).

## Example

```sh
curl -X PATCH https://waitingroom.<account-subdomain>.workers.dev/__wr/admin/v1/config \
  -H "Authorization: Bearer $WR_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"admissionsPerMinute": 220, "sessionMinutes": 15, "brake": {"enabled": true, "activesThreshold": 4000, "activesLimit": 5000}}'
```
