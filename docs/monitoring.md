# Monitoring with Prometheus and Grafana

The Worker exposes Prometheus metrics on `/__wr/metrics`, behind basic auth
(`WR_METRICS_USER` / `WR_METRICS_PASSWORD`). The list and meaning of every series are in
[interfaces](interfaces.md#metrics). `deploy/grafana/waitingroom.json` is a ready-made Grafana
dashboard for them: the read-only view to give a customer or an on-call screen. The page served by
the Worker (`/__wr/dashboard`) has live controls, so its credentials are for operators only.

## 1. Scrape the metrics

```yaml
scrape_configs:
  - job_name: waiting-room
    scheme: https
    metrics_path: /__wr/metrics
    scrape_interval: 30s
    static_configs:
      - targets: ["waitingroom.<account-subdomain>.workers.dev"]
    basic_auth:
      username: prometheus
      password_file: /etc/prometheus/secrets/wr-metrics-password
```

Each scrape costs one Durable Object request (the coordinator renders the text): 30 s is about 86,000
requests a month, well inside the included million. Every series carries a `room` label; several
rooms (one Worker each) can share the job.

Check: `curl -u prometheus:<password> https://waitingroom.<account-subdomain>.workers.dev/__wr/metrics`
must answer the Prometheus text, starting with `wr_build_info`.

## 2. Import the dashboard

Grafana 10 or later, with a Prometheus data source that scrapes the job above:

1. **Dashboards** → **New** → **Import** → **Upload dashboard JSON file**, and pick
   `deploy/grafana/waitingroom.json`.
2. Save. At the top of the dashboard, choose the **Prometheus** data source and the **Room** (all
   rooms by default).

With file provisioning, copy the file into a directory read by a dashboard provider; the data source
is a dashboard variable, so the file needs no change.

The dashboard uid is `cf-waitingroom`: importing a newer version of the file replaces the dashboard.

## 3. What the dashboard shows

| Row | Panels |
|---|---|
| Now | mode, paused, open or queueing, current wait, waiting visitors, utilisation, active users, fail-open over 5 minutes; rate `R` and effective rate, absence ratio, brake factor, isolates, configuration generation, projected monthly cost, version |
| Admissions and queue | admissions per minute by path against `R` and the effective rate; waiting visitors and wait; tickets reserved, redeemed and absent; waiting pages; utilisation, absence ratio and brake; active users; provisional cookies issued and claimed |
| Whitelist, bots and refusals | bypasses by kind, reservations refused by reason, tokens refused and replays |
| Health | coordinator errors and fail-open; configuration propagation (coordinator generation and edge minimum); isolates and outstanding leases; largest SQLite row (red above 1 MB) and ledger size; edge batch duplicates and gaps; lease slots by state |
| Durable Object usage and cost | coordinator requests per second by kind (red at the ≈ 1,000 req/s soft limit), SQLite rows written, monthly projection of usage and cost |

Every panel has a description (the `i` next to its title). Two annotations mark **configuration
changes** (rate, mode, pause, any setting) and **coordinator restarts** (a deployment or a secret
change loses edge batches).

Rates are computed over 5 minutes: the edge counters reach the coordinator with the flushes, in
batches, and up to five minutes late. Shorter windows make them spiky; per-minute values are
`rate(...[5m]) * 60`.

## 4. Suggested alerts

The [runbook](runbook.md#alerts) explains what to do for each.

| Alert | Expression | For |
|---|---|---|
| Metrics missing | `absent(wr_build_info)` or `up{job="waiting-room"} == 0` | 5m |
| Fail-open | `increase(wr_fail_open_total[5m]) > 0` | 0m |
| Coordinator errors | `sum(rate(wr_coordinator_errors_total[5m])) * 60 > 5` | 5m |
| Change not propagated | `min(wr_edge_config_generation_min) < max(wr_config_generation)` | 2m |
| Storage row too large | `max(wr_coordinator_storage_row_bytes) > 1e6` | 0m |
| Queue full | `increase(wr_reserve_refused_total{reason="full"}[5m]) > 0` | 0m |
| Near the Durable Object limit | `sum(rate(wr_coordinator_requests_total[5m])) > 500` | 5m |
| Kill switch left on | `wr_mode{mode="off"} == 1` | 1h |
