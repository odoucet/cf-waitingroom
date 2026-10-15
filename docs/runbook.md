# Runbook

All commands assume `ADMIN=https://<host>/__wr/admin/v1` and `TOKEN=$WR_ADMIN_TOKEN`. With `ADMIN_HOSTS`
(recommended), `<host>` is the operator hostname (`waitingroom.<account-subdomain>.workers.dev`,
[operator access](operator-access.md)).

## Cut-over from the managed waiting room

1. **Deploy without routes.**
   - `npx wrangler deploy --config wrangler/waitingroom.jsonc` (before the secrets: a secret cannot
     always be set on a Worker that does not exist yet)
   - set the secrets (`WR_KEYS`, `WR_KEY_CURRENT`, `WR_ADMIN_TOKEN`, `WR_METRICS_*`, optionally
     `WR_BYPASS_SECRET`, `WR_TURNSTILE_SECRET` and `WR_BOT_SECRET`, the latter with the same value as
     the bot Transform Rule). Set every secret you may need during an event now: adding one
     later restarts the coordinator.
   - optionally, the two bot Transform Rules ([routing](routing.md#verified-bots)).
   - check the operator endpoints ([operator access](operator-access.md#checks)).
   - `curl -H "Authorization: Bearer $TOKEN" $ADMIN/preflight` must answer `{"ok":true,...}`. Otherwise
     fix what `errors` lists: with an invalid room id, binding or keys, every protected path would
     answer 503.
2. **Test on a test hostname or path of the zone** (not on `workers.dev`: the Cache API needs a
   zone). `routes.sh apply deploy/test.env` with `HOSTS="wr-test.example.com"` (proxied DNS record to
   the same origin), or `PROTECTED="/wr-test/*"` on the real hostname. Check:
   - first visit → origin page + provisional cookie; second → session cookie; then no `Set-Cookie`;
   - origin caching unchanged (`cf-cache-status` identical to the same URL outside the room);
   - `PUT mode {"mode":"queue_all"}` → waiting page, countdown, admission after `admitAt`;
   - `PUT mode {"mode":"off"}` → everything relayed;
   - static, API and webhook paths never reach the Worker (no `__Host-wr_*` cookie, Worker metrics flat);
   - `/__wr/metrics` scraped by Prometheus.
3. **Load test** the test hostname with k6 (`deploy/k6/load.js`), with `admissionsPerMinute` set low
   enough to force the queue. The script solves the proof of work like the page does; Turnstile cannot
   be solved by a script, so keep `reserveVerifier: none` on the test room. Set
   `MAX_ADMISSIONS_PER_SEC` (about `R / 60 × 1.2`) to check the rate the origin sees. Watch
   `wr_admissions_total`, `wr_cursor_lag_seconds`, `wr_coordinator_requests_total`,
   `wr_coordinator_errors_total` and the Worker CPU time.
4. **Set the production configuration** (`PATCH config`: `R`, `D`, brake) and `mode` `on`.
5. **Run the preflight again** (`$ADMIN/preflight`, `{"ok":true}`) right before the change below.
   `routes.sh apply` runs it itself (`PREFLIGHT_URL`, `WR_ADMIN_TOKEN`) and creates nothing if it fails.
6. **Back to back**, pause the managed waiting room in the dashboard and run
   `routes.sh apply deploy/routes.env` (production hostnames). Then remove the test routes:
   `routes.sh delete deploy/test.env`.
7. Watch for 30 minutes: `wr_open`, `wr_utilization`, `wr_fail_open_total`, origin load, error rates.

Visitors holding a cookie of the managed room simply go through the new flow (open mode: one extra
page view before their session cookie).

## Rollback

1. Remove the routes: `deploy/scripts/routes.sh delete deploy/routes.env`.
2. Re-enable the managed waiting room.

Requests stop reaching the Worker as soon as the route change propagates (seconds). Nothing else
needs to be reverted; the coordinator keeps its state for a later attempt.

## Misconfiguration

`misconfigured` logs and 503 answers on every protected path mean that the room id, the
`COORDINATOR` binding or the keys are invalid (a secret deleted or mistyped, a bad deployment). The
Worker refuses the traffic instead of relaying it unprotected. `$ADMIN/preflight` lists the cause;
fix the secret or redeploy the previous version. If that takes too long, remove the routes
(rollback, step 1): the origin is then unprotected, by an explicit decision.

## Kill switch

No deployment needed:

```sh
curl -X PUT "$ADMIN/mode" -H "Authorization: Bearer $TOKEN" -d '{"mode":"off"}'
```

Every request is relayed (valid sessions too). Every data center applies it within two snapshot TTLs
(≤ 20 s near capacity, ≤ 60 s when calm); without `ADMIN_HOSTS`, the data center that served the call
applies it at once. Back with
`{"mode":"on"}`. If the admin API itself is unreachable, remove the routes (rollback, step 1).

## Pause admissions

```sh
curl -X PUT "$ADMIN/pause" -H "Authorization: Bearer $TOKEN" -d '{"paused":true}'
```

Nobody is admitted (sessions continue); waiting pages show the pause. Visitors who arrive during the
pause still get a place, behind the others. When resumed, waiting tickets are shifted by the pause
duration. Meanwhile the current wait (`wr_cursor_lag_seconds`) is the wait once admissions resume. Use it when the origin is in trouble; use `PATCH config
{"admissionsPerMinute": ...}` to slow down without stopping.

## During a traffic event

- **Freeze deployments.** Any new version of the Worker, `wrangler secret put` included, restarts
  the coordinator object: state is reloaded from SQLite and the high-water marks, but the restart
  skips up to 10 s of slots, may lose the last 5 s of changes and counts the lease cap as outstanding
  for up to two minutes. (The coordinator also restarts after 10 s without traffic; its state is
  written before, so only the margins apply.)
- Change the rate live (`PATCH config`), not by redeploying.
- If `wr_tickets_absent_total` grows much faster than usual, or `wr_reserve_refused_total` jumps, scripts
  are probably reserving slots: enable Turnstile (`PATCH config` with `reserveVerifier` and
  `turnstileSiteKey`; `WR_TURNSTILE_SECRET` must already be set, see [Turnstile](#turnstile)). Raising `reservePowBits` helps
  only against naive scripts and slows down low-end phones.
- Watch `wr_cursor_lag_seconds` (current wait), `wr_absence_ratio`, `wr_admission_rate_effective`,
  `wr_coordinator_errors_total`, and the Durable Object request rate in the Cloudflare dashboard (soft
  limit ≈ 1,000 req/s per object; queue mode costs about one request per queued human).

## Key rotation

1. Add the new key next to the current one: `WR_KEYS={"1":"<old>","2":"<new>"}`, keep `WR_KEY_CURRENT=1`. Outside traffic events: each secret change restarts the coordinator.
2. Switch signing: `WR_KEY_CURRENT=2`. Check `$ADMIN/preflight` after each secret change.
3. After `max(sessionMinutes, ticket lifetime, longest signed link)`, remove key `1`.

Removing a key invalidates the cookies and links it signed: visitors go back through the normal
flow (open mode: one extra page view).

## Alerts

- `wr_edge_config_generation_min < wr_config_generation` for more than two snapshot TTLs: some
  isolates did not get the last change (pause, rate, kill switch). Look at `coordinator_error` logs;
  `STALE_SNAPSHOT_TTLS=1` shortens how long they keep admitting on old state.
- `wr_coordinator_storage_row_bytes` above 1 MB, `wr_reserve_refused_total{reason="full"}`: see below.

## Turnstile

Set `WR_TURNSTILE_SECRET` first, outside traffic events (a secret change restarts the coordinator),
ideally at installation time; check the preflight. When needed, enable it live with
`PATCH config {"reserveVerifier":"turnstile","turnstileSiteKey":"..."}`: the admin API refuses
Turnstile without the secret or the site key.

## Queue limits

- `wr_reserve_refused_total{reason="full"}` grows: the queue reached `maxWaitingTickets`. Visitors
  without a ticket retry every 30–60 s. Raise the limit (`PATCH config`) only if the wait it implies
  (`maxWaitingTickets / R_eff` minutes) is acceptable.
- Alert when `wr_coordinator_storage_row_bytes` exceeds 1 MB (a row is limited to 2 MB). With the
  default chunking it stays around 100–150 kB; a larger value points to an unexpected growth.

## Coordinator unavailable

With `FAIL_MODE=open`, visitors without a session are relayed and `wr_fail_open_total` grows; with
`FAIL_MODE=closed`, they get a static `503` (`fail_mode` logs). Valid sessions are unaffected either way, except
on isolates started during the outage that find no snapshot in the data-center cache: they cannot
check expiry and revocations, so session holders get the fail mode too. Check the Durable Object status and errors in the dashboard and the
`coordinator_error` logs (`kind`: timeout, overloaded, other). If the outage lasts, consider the rollback.
