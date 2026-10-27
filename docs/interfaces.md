# Public interfaces (v1)

The cookie format, the admin API and the metric names are public interfaces. They follow semantic
versioning: a breaking change bumps the major version, gets a new version number in the format or the
path (`v2`), and is listed in [CHANGELOG.md](../CHANGELOG.md). During a migration, both versions are
accepted for at least one session duration.

## Signed tokens and cookies

```
token   = base64url(payload) "." base64url(tag)          (no padding)
payload = version:u8 (= 1) | type:u8 | kid:u8 | fields    (big-endian, fixed width)
tag     = first 16 bytes of HMAC-SHA256(key[kid], "wr1" 0x00 scope 0x00 payload)
scope   = ROOM_ID                    (session, ticket, provisional)
        | ROOM_ID "@" hostname       (bypass cookie, signed link; hostname in lower case)
```

- `kid` selects the key in `WR_KEYS`; two keys can be active (rotation).
- The room id is bound through the MAC input; a token of another room never verifies.
- A signed link and the bypass cookie it sets only verify on the hostname they were issued for, even
  when several hostnames share the room and the keys. They exempt the whole hostname: the `path` of
  `POST pass` is the landing page, not a limit. Use another room (or other keys) per trust boundary.
- Cookies: `__Host-` prefix, `Path=/; Secure; HttpOnly; SameSite=Lax`, no `Domain`.

| Type | Byte | Cookie / parameter | Fields | Lifetime |
|---|---|---|---|---|
| Session | `S` 0x53 | `__Host-wr_s_<room>` | `ticketNo:u32` (0 when admitted through a lease), `tag:u32` (issuing isolate), `issuedMinute:u32` (epoch minutes), `countedMinute:u32` (epoch minutes), `flags:u8` | `Max-Age = D × 60` (less near the end of its lifetime), refreshed at most once a minute; valid while `now_min − countedMinute < D` and `now_min − issuedMinute < max(sessionMaxMinutes, D)` |
| Ticket | `T` 0x54 | `__Host-wr_t_<room>` | `ticketNo:u32`, `admitAtMs:u48` (epoch ms), `issuedSec:u32` | until `admitAt + redeemGraceSec` |
| Provisional | `U` 0x55 | `__Host-wr_u_<room>` | `nonce:8 bytes`, `issuedSec:u32` | `provisionalWindowSec`; one leased slot per cookie in each isolate, one ticket per nonce |
| Bypass | `B` 0x42 | `__Host-wr_b_<room>` | `expirySec:u32`, `countedMinute:u32`, `label` (UTF-8, ≤ 32 bytes, rest of payload) (MAC bound to the hostname) | until `expirySec` |
| Signed link | `P` 0x50 | `?wr_pass=<token>` | `expirySec:u32`, `label` (MAC bound to the hostname) | until `expirySec` |

A session cookie value is 50 characters, a ticket 46.

## Visitor endpoints

| Endpoint | Description |
|---|---|
| `POST /__wr/reserve` | Requires a valid provisional cookie (403 `no_provisional_cookie`). Body (JSON, at most 4 KiB): `{"pow": "<counter>", "turnstileToken": "..."}`. The provisional cookie must be younger than `provisionalWindowSec`; otherwise 403 `no_provisional_cookie` and the cookie is cleared. Answers `{"status":"waiting","ticketNo":N,"admitAtMs":T,"serverTime":T}` and sets the ticket cookie; returns the existing ticket if one is still valid. Refusals: 403 `cross_site` (`Sec-Fetch-Site` present and not `same-origin`), 429 `{"status":"retry","error":"too_early","retryAfterSec":1}` (cookie younger than `reserveMinAgeSec`), 403 `pow_failed`, 403 `verification_failed` (Turnstile), 503 `{"status":"retry","error":"busy","retryAfterSec":2..5}` (`reserveMaxInflight` reached), 503 `{"status":"retry","error":"full","retryAfterSec":30..59}` (`maxWaitingTickets` reached). On coordinator failure: while the room queues, always 503 `{"status":"retry","retryAfterSec":5..14}`, so that an overloaded coordinator never opens the room; otherwise `{"status":"admitted"}` (`FAIL_MODE=open`, session cookie set once the configuration is known) or the same 503 (`FAIL_MODE=closed`). In mode `off`, no ticket is handed out: `{"status":"admitted"}` without cookie (the page reloads and is relayed). |
| `GET /__wr/status` | `{"mode","paused","open","earlyUpTo","pauseOffsets":[[ticketNoUpTo, offsetMs]],"serverTime"}`. Served from the snapshot. |

**JSON clients** (SPA, mobile apps): any request with `Accept: application/json` (before `text/html`),
or a method other than GET/HEAD, gets `503` with `Retry-After` and
`{"status":"waiting","reserveUrl":"/__wr/reserve","statusUrl":"/__wr/status","ticket":{...}|null,"paused":bool,"serverTime":T,"reserveAfterMs":T|null,"pow":{"room","nonce","bits"}|null}`
instead of the HTML page. The client solves the proof of work, waits until `reserveAfterMs` (server
clock), calls `reserveUrl` (keeping cookies), waits until `admitAtMs` (adding the offsets from
`statusUrl` if paused meanwhile) and retries the original request.

**Coordinator unavailable, `FAIL_MODE=closed`**: protected pages answer `503` with `Retry-After` and
`Cache-Control: no-store`: a static HTML page that reloads itself after `Retry-After`, or
`{"status":"unavailable","retryAfterSec":N}` for JSON clients.

**Proof of work.** Find a decimal counter (at most 12 digits) such that
`SHA-256("wr-pow1" NUL room NUL nonce NUL counter)` (UTF-8) starts with `bits` zero bits, and send it
as `pow`. `nonce` is the one of the visitor's provisional cookie, given in the waiting page: one
solution per provisional cookie, and a provisional cookie gets one ticket. The edge verifies it with
one hash.

## Admin API

Base path `/__wr/admin/v1/`, header `Authorization: Bearer <WR_ADMIN_TOKEN>`. JSON in, JSON out.
When `ADMIN_HOSTS` is set, the admin API, the metrics and the dashboard answer only on those hostnames,
and 404 on the others ([operator access](operator-access.md)).
Every call is logged. Errors: `400 {"error": "..."}` (validation), `401` (token), `503` (coordinator unavailable).

| Method and path | Body | Result |
|---|---|---|
| `GET preflight` | — | `{"ok", "room", "failMode", "coordinator": "ok" \| "unavailable" \| "skipped", "botBypass": "enabled" \| "disabled", "errors": [...]}`: 200 when the Worker is ready for protected traffic (valid `ROOM_ID`, `COORDINATOR` binding answering, valid `WR_KEYS`/`WR_KEY_CURRENT`, valid `FAIL_MODE`, `WR_BOT_SECRET` of at least 32 characters when the bot bypass is enabled), 503 otherwise. Served even when the base configuration is invalid. |
| `GET state` | — | mode, paused, open, cursor lag, `R`, `R_eff`, absence ratio, brake factor, active estimate, waiting tickets, next ticket number, outstanding leases, isolates, generation, configuration |
| `PATCH config` | partial configuration ([configuration.md](configuration.md)) | the new configuration |
| `PUT mode` | `{"mode": "off" \| "on" \| "queue_all"}` | `{"mode": ...}` |
| `PUT pause` | `{"paused": true \| false}` | `{"paused": ...}` |
| `GET whitelist` | — | `[{"cidr","label"}]` |
| `POST whitelist` | `{"entries": [{"cidr": "198.51.100.0/24", "label": "office"}]}` | the whitelist (entries with the same `cidr` are replaced) |
| `DELETE whitelist` | `{"cidrs": ["198.51.100.0/24"]}` | the whitelist |
| `POST pass` | `{"label": "partner", "ttlSeconds": 3600, "path": "/", "host": "shop.example.com"}` (60 s to 30 days; `host` defaults to the request's host and is required on an operator hostname) | `{"url", "label", "expiresAt"}`: a signed link to `https://<host><path>` that sets a bypass cookie |

Changes take effect immediately in the coordinator, and reach every data center within two snapshot
TTLs. Without `ADMIN_HOSTS`, the data center that served the call also applies them at once (the
Cache API is not available on `workers.dev`).

## Metrics

`GET /__wr/metrics`, basic auth (`WR_METRICS_USER` / `WR_METRICS_PASSWORD`), Prometheus text format
0.0.4. Every series has a `room` label. Counters are persisted by the coordinator and survive restarts;
edge-side counters arrive with the flushes (up to five minutes late).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `wr_build_info` | gauge | `version` | always 1 |
| `wr_admission_rate_target` | gauge | | `R` |
| `wr_admission_rate_effective` | gauge | | `R_eff` (overbooking and brake) |
| `wr_cursor_lag_seconds` | gauge | | cursor − now; positive while visitors wait. While paused, cursor − start of the pause: the wait once admissions resume |
| `wr_waiting_tickets` | gauge | | tickets reserved and not yet due (waiting visitors) |
| `wr_absence_ratio` | gauge | | no-show ratio over the sliding window |
| `wr_active_users_estimate` | gauge | | sessions seen within `D` (plus whitelisted if counted) |
| `wr_active_users_whitelisted` | gauge | | whitelisted users (separate counter) |
| `wr_brake_factor` | gauge | | brake multiplier |
| `wr_paused`, `wr_open`, `wr_calm` | gauge | | 0/1 |
| `wr_mode` | gauge | `mode` | 1 for the current mode |
| `wr_utilization` | gauge | | admissions over the last minute ÷ `R` |
| `wr_lease_outstanding_slots` | gauge | | leased slots not reported yet |
| `wr_coordinator_isolates` | gauge | | isolates that reported in the last minute |
| `wr_config_generation` | gauge | | configuration generation |
| `wr_edge_config_generation_min` | gauge | | oldest configuration generation held by an isolate that reported in the last minute: below `wr_config_generation` for more than two TTLs, a change did not reach every isolate |
| `wr_coordinator_storage_row_bytes` | gauge | | largest SQLite row of the coordinator, in bytes (limit 2 MB: alert above 1 MB) |
| `wr_ledger_tickets` | gauge | | tickets held by the ledger (waiting, plus due and not evaluated yet) |
| `wr_admissions_total` | counter | `path=lease\|ticket` | admissions |
| `wr_tickets_reserved_total` | counter | | tickets issued (slots reserved) |
| `wr_tickets_redeemed_total` | counter | | tickets exchanged for a session (issued vs confirmed) |
| `wr_tickets_absent_total` | counter | | no-shows |
| `wr_replays_rejected_total` | counter | | replayed ticket redemptions |
| `wr_lease_slots_total` | counter | `state=granted\|used\|returned\|expired` | lease accounting |
| `wr_provisional_total` | counter | `state=issued\|claimed` | provisional cookies |
| `wr_bypass_total` | counter | `kind=bot\|ip\|header\|pass` | whitelist hits |
| `wr_waiting_pages_total` | counter | | waiting pages served |
| `wr_fail_open_total` | counter | | requests let through because the coordinator was unavailable |
| `wr_worker_requests_total` | counter | | invocations of the edge Worker (billed Worker requests), early exits and operator endpoints included, as reported by the isolates with their batches: an isolate evicted before its next batch is not counted |
| `wr_early_exits_total` | counter | | requests relayed untouched by the early exit (subset of `wr_worker_requests_total`) |
| `wr_coordinator_errors_total` | counter | `kind=timeout\|overloaded\|other` | failed coordinator calls |
| `wr_reserve_refused_total` | counter | `reason=too_early\|pow\|busy\|cross_site\|no_provisional_cookie\|turnstile\|full` | reservations refused: by the edge before reaching the coordinator, or by the coordinator (`full`) |
| `wr_refused_total` | counter | `kind=session\|ticket\|pass\|bypass_header` | session, ticket, signed link or bypass header refused (invalid, expired, revoked) |
| `wr_coordinator_requests_total` | counter | `kind=reserve\|flush\|snapshot\|admin\|alarm`, `mode=open\|queue\|paused\|off` | billed Durable Object requests |
| `wr_coordinator_rows_written_total` | counter | | SQLite rows written |
| `wr_batch_duplicates_total` | counter | | edge batches received again after a lost answer, acknowledged without being applied |
| `wr_batch_gaps_total` | counter | | edge batches lost by a coordinator restart |
| `wr_usage_projection` | gauge | `item=do_requests\|do_gb_seconds\|do_rows_written\|worker_requests` | monthly projection from the last hour |
| `wr_cost_projection_usd` | gauge | `item=...` | projected monthly cost beyond the included usage |

## Dashboards

`GET /__wr/dashboard` (HTML) and `GET /__wr/dashboard/data` (JSON), basic auth (`WR_DASHBOARD_USER` /
`WR_DASHBOARD_PASSWORD`) ([configuration](configuration.md#dashboards)). The JSON is meant for the page only and is **not**
part of the versioned interface: use the metrics for monitoring.

`/__wr/dashboard/admin/<route>` serves the routes of the admin API above (same methods, bodies,
validation and answers) behind the dashboard credentials instead of the bearer token, for the page
controls. Changes (any method but `GET`/`HEAD`) also require `Origin` equal to the dashboard origin,
`Content-Type: application/json` and, when sent, `Sec-Fetch-Site: same-origin`; otherwise `403`.
This path is not a versioned interface: scripts use `/__wr/admin/v1/`.

## Logs

Decision logs are JSON objects (`event`, `level`, `room`, plus fields), indexed by Workers Logs.
`message` repeats the event and its scalar fields (`admit room=main path=lease`) for the Workers Logs
event list.
Sampled (`LOG_SAMPLE_RATE`): `admit`, `bypass`, `waiting`, `session_refused`, `ticket_refused`,
`bypass_refused`, `pass_refused`, `reserve_refused`. A flood produces them, so they are counted
exactly by `wr_waiting_pages_total`, `wr_refused_total` and `wr_reserve_refused_total` instead.
Always logged: `pass_used`, `reserve`, `fail_mode`, `coordinator_error`, `admin_request`,
`admin_denied`, `metrics_denied`, `dashboard_denied`, `dashboard_admin_refused`, `misconfigured`. The
coordinator logs `coordinator_start`, `admin_change`, `dashboard_denied` and `dashboard_error`. Field names are not part of the versioned interface.
