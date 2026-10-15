# Operator access: admin API, metrics, dashboards

The operator endpoints of the Worker are the admin API (`/__wr/admin/v1/*`), the metrics
(`/__wr/metrics`) and the dashboard (`/__wr/dashboard`, `/__wr/dashboard/data`, and
`/__wr/dashboard/admin/*` for its controls). They are protected by a bearer token and by basic auth.
The dashboard can change the room like the admin API: its credentials are an administration secret.
Read-only views go through the metrics ([monitoring](monitoring.md): Prometheus, Grafana dashboard). By default they answer on every hostname of the script, including
the site's own hostnames.

The recommended production setup removes them from the site's hostnames entirely. They are then
served on the script's `workers.dev` hostname only:

```
https://shop.example.com/__wr/admin/...                  -> 404, like any unknown path
https://waitingroom.<account-subdomain>.workers.dev/__wr/... -> token / basic auth
https://waitingroom.<account-subdomain>.workers.dev/<other>  -> 404 (no queue, no relay to the origin)
```

That gives two independent layers:

1. **Hostname restriction** (`ADMIN_HOSTS`). Scanners of the site never find the endpoints.
2. **The secrets** (`WR_ADMIN_TOKEN`, metrics and dashboard credentials), checked in the Worker in
   constant time.

## 1. Restrict the operator endpoints to the `workers.dev` hostname

In your private `wrangler/waitingroom.jsonc`:

```jsonc
"workers_dev": true,
"preview_urls": false,
"vars": {
  // ...
  "ADMIN_HOSTS": "waitingroom.<account-subdomain>.workers.dev"
}
```

`wrangler deploy` prints the `workers.dev` URL of the script. The dashboard also shows it under
**Workers & Pages** → the script → **Settings** → **Domains & Routes**. `ADMIN_HOSTS` is a
comma-separated list, compared case-insensitively with the request hostname.

| `ADMIN_HOSTS` | Hostname of the request | Operator endpoints | Anything else |
|---|---|---|---|
| unset or empty | any | served (bearer token, basic auth) | waiting room |
| set | listed | served (bearer token, basic auth) | 404, no cookie, no call to the origin |
| set | not listed (the site) | 404, same answer as an unknown `/__wr/` path | waiting room (`/__wr/reserve`, `/__wr/status` included) |

Why the hostname can be trusted:
- Cloudflare picks the zone, then the route or the `workers.dev` script, from the requested hostname.
- A request that reaches the Worker through a route of the site's zone carries the site's hostname.
- A request to the `workers.dev` hostname never goes through the site's routes.

The restriction alone is not authentication. A `workers.dev` hostname is easy to guess: it is the
script name plus the account subdomain. It reduces the exposure; the secrets do the authentication.
Generate them with `openssl rand` as in the [installation](../INSTALL.md#6-set-the-secrets):
basic auth has no lockout, so a short or reused password is the weak point.

Keep `preview_urls: false`. A preview URL is another hostname, not listed in
`ADMIN_HOSTS`: it would run the site flow outside the zone.

### What changes for operators

| Topic | Effect |
|---|---|
| Admin calls | Use `ADMIN=https://waitingroom.<account-subdomain>.workers.dev/__wr/admin/v1`. Calls on the site's hostname answer 404. |
| Signed links (`POST pass`) | On the operator hostname, `host` is required: `{"label": "partner", "host": "shop.example.com", "path": "/"}`. The link points to `https://<host><path>`. An operator hostname is refused. |
| Propagation of changes | The Cache API does not work on `workers.dev`, so an admin call no longer refreshes the data center that served it. Every change, the kill switch included, reaches every data center within two snapshot TTLs: ≤ 20 s near capacity or while queueing, ≤ 60 s when calm, with the defaults. To cut the room off immediately, remove the routes (see the [runbook](runbook.md#rollback)). |
| Dashboard | It shows the isolate that answered the `workers.dev` request, in the data center closest to you. The global data comes from the coordinator and is identical. |
| WAF | `workers.dev` is not in your zone: your zone's WAF rules (country challenge, IP allowlists, rate limiting) do not apply. If you need them, use a dedicated hostname of your zone instead (below). |
| Cost | Unchanged: requests on `workers.dev` are billed like any Worker request. |

### Clients

Admin calls:

```sh
ADMIN=https://waitingroom.<account-subdomain>.workers.dev/__wr/admin/v1
curl -sS "$ADMIN/state" -H "Authorization: Bearer $WR_ADMIN_TOKEN"
```

Prometheus scrapes with basic auth:

```yaml
scrape_configs:
  - job_name: waiting-room
    scheme: https
    metrics_path: /__wr/metrics
    static_configs:
      - targets: ["waitingroom.<account-subdomain>.workers.dev"]
    basic_auth:
      username: prometheus
      password_file: /etc/prometheus/secrets/wr-metrics-password
```

Dashboard in a browser: answer the basic auth prompt.

### Checks

| Request | Expected |
|---|---|
| `https://waitingroom.<account-subdomain>.workers.dev/__wr/metrics` without basic auth | 401 (`WWW-Authenticate: Basic`) |
| Same, with basic auth | 200, Prometheus text |
| `https://waitingroom.<account-subdomain>.workers.dev/` | 404 |
| `https://shop.example.com/__wr/metrics` with valid basic auth | 404 |
| `https://shop.example.com/` | the site |

## Alternative: a dedicated hostname in your zone

`ADMIN_HOSTS` can also name a dedicated hostname of a zone, for example `wr-admin.example.com`. Attach
it to the Worker as a Custom Domain or a route.

Compared with `workers.dev`:
- your zone's WAF rules apply to it (IP allowlist, rate limiting);
- but it needs a DNS record and a route managed with the rest of the zone.

Never list a hostname of the site itself in `ADMIN_HOSTS`: that hostname would stop serving the site.

## Summary checklist

- [ ] `workers_dev: true`, `preview_urls: false` and `ADMIN_HOSTS` in the Worker configuration;
      deployed.
- [ ] Admin token, metrics and dashboard passwords generated with `openssl rand`, kept in a password
      manager.
- [ ] Prometheus and admin scripts point to `workers.dev`; runbook `ADMIN` points to `workers.dev`.
- [ ] Checks above pass.
