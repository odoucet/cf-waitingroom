# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/); the public interfaces are the cookie format, the admin
API and the metric names ([docs/interfaces.md](docs/interfaces.md)).

## [0.1.0] - unreleased

### Added

- Rate-based admission with an admission cursor: open mode with leased slots, queue with signed
  tickets (`admitAt`), exact countdown on the waiting page.
- Provisional cookie: no slot for clients that keep no cookie or run no JavaScript.
- Overbooking from the measured no-show ratio, early admission credit.
- Optional safety brake on the estimated active users.
- Replay detection with revocation of copied tickets.
- Pause, kill switch (`mode: off`), `queue_all`. The queue keeps its place during a pause of any
  length, and the lease backlog is shifted like the tickets.
- Whitelist: IP/CIDR, verified bots (Transform Rules), secret header, signed links.
- `routes.sh` manages the IP whitelist from the config file (`WHITELIST`, `WHITELIST_PRUNE`).
- Admin API v1, Prometheus metrics, cost projection.
- Worker requests counted by the isolates and sent with their batches, without any extra Durable
  Object request: `wr_worker_requests_total`, `wr_early_exits_total`,
  `wr_usage_projection{item="worker_requests"}` and its cost, a chart and a projection row on the
  dashboard.
- Coordinator state, per-minute history included, written by an alarm 5 s after a change: the object
  hibernates after 10 s without traffic and loses its memory, and a quiet period loses nothing.
- Reservation checks: minimum provisional cookie age, proof of work, `Sec-Fetch-Site`, and a cap on
  concurrent reservation calls per isolate (`wr_reserve_refused_total`).
- Dashboard behind basic auth: current state, per-minute usage over the last hour (hover or tap a
  chart for the values of a minute), totals, cost projection, isolate counts (last 10 minutes, last
  minute, holding a lease, on an older configuration) with the ten largest leases, a help tooltip on
  every figure (hover, keyboard focus or tap), the current wait in the tab title, a warning when the
  page, the edge and the coordinator run different deployments (`version_metadata` binding
  `CF_VERSION_METADATA`), and live controls served by
  `/__wr/dashboard/admin/*` with the admin API validation and a same-origin check against CSRF: mode,
  pause, rate and session duration in the top bar; whitelist, settings (JSON patch and current
  configuration) and signed links in overlays. The dashboard credentials grant administration;
  read-only views go through the metrics.
- Grafana dashboard (`deploy/grafana/waitingroom.json`) for the `/__wr/metrics` series: state,
  admissions and queue, bots and refusals, health, Cloudflare usage and cost, with annotations
  for configuration changes and coordinator restarts; scrape, import and suggested alerts in
  `docs/monitoring.md`.
- `ADMIN_HOSTS`: admin API, metrics and dashboard served only on operator hostnames (typically
  `workers.dev`), 404 on the site; `host` field on `POST pass`.
- Verified bot bypass limited to a list of categories (search engines, link previews, ad checks
  by default).
- Cookie format v1 (HMAC-SHA256, key rotation).
- Coordinator Durable Object with SQLite persistence and high-water marks.
- Simulations: peak, bots, abandons, low traffic, lease bound, replay, restart.
- Route script (`deploy/scripts/routes.sh`, config in `deploy/*.env`); k6 load test.
- Waiting page and dashboard page minified at build time (one waiting template, texts per language in the code); Prometheus
  text rendered by the coordinator; `keep_names` disabled.
- One Worker (`wrangler/waitingroom.jsonc`, script `waitingroom`) exports both the edge handler and
  the `Coordinator` Durable Object, instead of two scripts bound across. The coordinator's own
  dashboard and `ROOM_IDS` are gone; the dashboard template is bundled with the edge (no RPC per page
  load). Bundle size check at 250 KiB. The edge creates a Durable Object stub per call: a stub of a
  class in the same script is bound to the request that created it, and reusing it from the next
  request failed every other call ("Cannot perform I/O on behalf of a different request"). The
  dashboard keeps the last coordinator data, marked stale, when a refresh fails.
- Terraform module removed: routes are managed by `routes.sh` from an env-style config file
  (`deploy/routes.env.example`, file path as second argument); the two bot Transform Rules are
  created by hand, with complementary expressions so that their order does not matter.
- Early exit restricted to `GET`/`HEAD` and refused for `;`, encoded slashes and PATH_INFO paths;
  `json`, `xml`, `txt`, `pdf` removed from the example extensions.
- A failed reservation never opens the room while visitors queue (`retry` instead of fail-open).
- Fail mode moved from the room configuration (`failMode`) to the required edge variable
  `FAIL_MODE` (closed when unset or invalid): an isolate that cannot get its first snapshot no longer
  fails open regardless of the operator's choice. Fail-closed now answers a static `503` with
  `Retry-After` that needs no configuration. A stored `failMode` is dropped on load; the admin API
  refuses it.
- An invalid base configuration (`ROOM_ID`, `COORDINATOR` binding, `WR_KEYS`, `WR_KEY_CURRENT`) answers
  `503` on protected paths instead of relaying them to the origin unprotected. New
  `GET /__wr/admin/v1/preflight`, served even when misconfigured; `routes.sh apply` refuses to create
  the routes unless it answers `ok`.
- A cold isolate loads the snapshot before honouring a session cookie: idle expiry, total lifetime
  and revocations were not checked before the first snapshot, so an old signed cookie could be
  accepted and renewed. If no snapshot can be obtained, the request goes through the fail mode and
  the cookie is neither renewed nor cleared. A cold isolate whose first coordinator call fails now
  falls back to the data-center copy of the snapshot.
- Verified-bot bypass: the Transform Rule sets `BOT_HEADER` to a shared secret (`WR_BOT_SECRET`)
  instead of `true`, and the Worker strips it before the origin. A
  forged header is refused even when the rules are missing (deployments with `routes.sh`) or out of
  order; the reset rule now removes the header. The bypass is disabled until `WR_BOT_SECRET` is set.
- Edge batches are applied exactly once and in order: one batch without answer per isolate, resent
  unchanged (same `seq`) until acknowledged; reservations no longer carry deltas; the coordinator
  answers a resent batch with the lease granted to it and persists the last `seq` of each isolate with
  the state (`wr_batch_duplicates_total`, `wr_batch_gaps_total`).
- Nonces are stored in SQLite before the reservation is answered and kept 24 h: a restart no longer
  hands a second ticket to the same provisional cookie. Edge and coordinator both refuse a cookie
  older than `provisionalWindowSec` (the 1-hour edge limit is gone).
- Storage: the ledger is written in chunks of 4,096 tickets (only the changed ones), the absence
  window is aggregated per 10 s, the queue is capped by `maxWaitingTickets` (default 100,000; `full`
  refusals), and `wr_coordinator_storage_row_bytes` / `wr_ledger_tickets` are exported. No storage row
  grows with the queue any more (2 MB row limit).
- Reservations are refused in mode `off` (existing tickets are kept).
- Turnstile: `reserveVerifier: turnstile` requires a site key (configuration validation) and the edge
  secret (admin API, preflight); a missing secret at runtime skips Turnstile and logs `misconfigured`
  instead of refusing every visitor; Siteverify `hostname` must match the request.
- Replay revocations and outstanding leases are persisted; after a restart, the unknown part of the
  lease cap counts as outstanding until the longest lease has expired.
- Signed links and bypass cookies are bound to their hostname (MAC scope `ROOM_ID@hostname`).
  Links and bypass cookies issued by earlier versions no longer verify.
- A provisional cookie gets one leased slot per isolate.
- Early exit: never under `/__wr/`; prefixes match whole path segments.
- `STALE_SNAPSHOT_TTLS` edge variable (1–6, default 6) and `wr_edge_config_generation_min` gauge.
- `routes.sh`: exact matching of patterns and scripts (jq), drift corrected by `apply`, `delete`
  limited to the routes it manages and still pointing where it put them.
- k6: solves the proof of work, honours the minimum cookie age, retries `retry` answers; thresholds on
  reservations, retries, origin latency and optionally the admission rate.
- Admin API bodies are read with a byte limit (64 KiB), refused before reading when larger.
- `routes.sh`: route patterns are no longer expanded by the shell (`/*` used to list the root of the
  local filesystem instead of creating the catch-all route).
- Waiting pages and refusals logged with sampling, counted exactly (`wr_refused_total`, new
  `wr_reserve_refused_total` reasons).
- Log lines carry a `message` summary (`admit room=main path=lease`): Workers Logs showed them
  empty. Coordinator logs carry `level` too. `coordinator_error` reports the error in `error` instead
  of `message`.
- Session total lifetime (`sessionMaxMinutes`, `issuedMinute` in the session cookie).
- Responses that carry a waiting-room cookie are made private (`Cache-Control: private`).
- Whitelist blocks wider than `/8` (IPv4) or `/32` (IPv6) refused.
