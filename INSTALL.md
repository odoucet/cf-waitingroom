# Installation

This guide takes you from an empty Cloudflare account to a waiting room running on a test hostname.
The production switch-over (the managed waiting room is paused, the routes are created on the real
hostname) is in the [runbook](docs/runbook.md#cut-over-from-the-managed-waiting-room).

Allow one to two hours the first time. Nothing in steps 1 to 6 touches your site's traffic: the
Worker receives no request from your site until step 7 creates routes.

## What you are going to create

| Object | Created by | What it does |
|---|---|---|
| Worker `waitingroom` | `wrangler deploy` (step 5) | One script with two parts. The **edge** handler runs on every protected request: checks the cookie, relays to the origin or shows the waiting page. The **coordinator** Durable Object (SQLite) holds the global state of the room; the edge calls it through a Durable Object binding. |
| Secrets of `waitingroom` | `wrangler secret put` (step 6) | Signing keys, admin token, metrics and dashboard credentials. |
| `waitingroom.<account-subdomain>.workers.dev` | `wrangler deploy` (step 5) | Operator hostname: admin API (bearer token), metrics (basic auth) and dashboard with live controls (basic auth). Serves nothing else. |
| Worker routes in your zone | `deploy/scripts/routes.sh` (step 7) | Send the protected paths of your site to `waitingroom`; exclude static, API and webhooks. |
| Transform Rules (optional) | dashboard, by hand (step 7) | Let verified search engine crawlers skip the queue. |

```
                                          ┌─ waitingroom Worker ──────────────┐
visitor ──► Cloudflare (your zone) ──route──► edge handler ──fetch──► cache / origin
                                          │      │                            │
                                          │      └─DO binding─► Coordinator   │
                                          │                     (Durable Object)
                                          └───────────────────────────────────┘
operator / Prometheus ──► waitingroom.<account-subdomain>.workers.dev/__wr/...  (bearer token / basic auth)
```

### Do not create the Worker in the dashboard

The Cloudflare dashboard (**Workers & Pages** → **Create**) offers to start from a template, from
"Hello World", from static files or from a Git repository. **None of them applies here.** The
Worker is created by `wrangler deploy` from your machine, with its name, binding, Durable Object
migration and variables taken from `wrangler/waitingroom.jsonc`. If you started the dashboard wizard,
cancel it. If it already created a Worker named `waitingroom`, delete it first
(**Settings** → **Delete**), or pick another name in step 3.

The dashboard is used only to read IDs (step 2).

## Prerequisites

- A Cloudflare account with **Workers Paid** ($5/month: Durable Objects, CPU limits, request volume).
  Dashboard → **Workers & Pages** → **Plans**.
- The site's zone on that account, with the site's hostnames **proxied** (orange cloud in
  **DNS** → **Records**). Worker routes only run on proxied hostnames.
- Node.js ≥ 22 and npm.
- For step 7: `bash`, `curl` and `jq`.
- `openssl` to generate secrets, and a password manager to keep them: Cloudflare never shows a secret
  again once it is set, and some are needed later (key rotation, Prometheus, the bot Transform Rule).

## 1. Get the code and check it

```sh
git clone https://github.com/odoucet/cf-waitingroom.git
cd cf-waitingroom
npm ci
npm test        # optional: unit tests, simulations and integration tests in the Workers runtime
```

Run every `wrangler` command below **from the repository root**: the configuration files use paths
relative to it.

## 2. Log in and collect the IDs

```sh
npx wrangler login     # opens a browser, OAuth consent for your Cloudflare account
npx wrangler whoami    # shows the account name and the account ID
```

If your user has several accounts, wrangler asks which one to use on every command; set
`CLOUDFLARE_ACCOUNT_ID=<account ID>` in your shell to avoid that. On a server or in CI, use an API
token instead of `login`: dashboard → **My Profile** → **API Tokens** → **Create Token** → template
**Edit Cloudflare Workers**, then `export CLOUDFLARE_API_TOKEN=...`.

Write down:

| Value | Where | Used in |
|---|---|---|
| Account ID | `wrangler whoami`, or dashboard → **Workers & Pages**, right column | `CLOUDFLARE_ACCOUNT_ID` (optional) |
| Account `workers.dev` subdomain | dashboard → **Workers & Pages**, right column (**Subdomain**) | `ADMIN_HOSTS` (step 3) |
| Zone ID | dashboard → your domain → **Overview**, right column (**API** → **Zone ID**). Not the ID in the dashboard URL: that one is the account ID. | `deploy/*.env` (step 7) |

If the account has never used Workers, it has no `workers.dev` subdomain yet: open **Workers &
Pages** once and choose one when asked (it cannot be changed freely afterwards), or let
`wrangler deploy` ask for it in step 5.

## 3. Write the configuration file

```sh
cp wrangler/waitingroom.example.jsonc wrangler/waitingroom.jsonc
```

The copy is git-ignored. Keep the real one (and the route configs of step 7) in a private
repository of yours.

| Field | Value |
|---|---|
| `name` | `waitingroom` (or your choice; it is also `SCRIPT` in step 7). |
| `vars.ROOM_ID` | `main` is fine for a single site. `[a-z0-9-]`, ≤ 32 characters. Changing it later starts a new, empty room. |
| `vars.WR_BOOTSTRAP_CONFIG` | Initial rate `R` (`admissionsPerMinute`) and session duration `D` (`sessionMinutes`). Applied once, when the room is created; afterwards the admin API changes them live. See [configuration](docs/configuration.md#choosing-r-and-d). |
| `vars.FAIL_MODE` | What visitors get if the coordinator is unreachable: `closed` (static 503, protects the origin) or `open` (relay everything, protects revenue). |
| `vars.EARLY_EXIT_EXTENSIONS` | Keep only extensions your origin serves from **static files**. Never list one that a controller can answer (`json`, `pdf`…): see [routing](docs/routing.md#inside-the-worker). |
| `vars.LOCATION_HINT` | Region of the Durable Object, near your origin and visitors (`weur`, `enam`, `apac`…). Only honoured when the object is first created. |
| `vars.ADMIN_HOSTS` | `waitingroom.<account-subdomain>.workers.dev`, with the subdomain of step 2 and the script `name`. |

Every variable is described in [configuration](docs/configuration.md#worker-variables).

## 4. Know what a deployment does

The coordinator Durable Object lives in the same script as the edge handler. **Every new version of
the script restarts it**: `wrangler deploy`, and also each `wrangler secret put`, which publishes a new
version. The state is reloaded from SQLite, but up to 10 s of admission slots are skipped and the
outstanding leases are forgotten. Harmless while the site is calm; never do it during a traffic
event ([runbook](docs/runbook.md#during-a-traffic-event)). Mode, pause, rate and whitelist changes go
through the admin API and restart nothing.

## 5. Deploy the Worker

```sh
npx wrangler deploy --config wrangler/waitingroom.jsonc
```

Expected: a build step (`node scripts/build-templates.mjs`), the bundle size, then
`Deployed waitingroom` followed by its URL `https://waitingroom.<account-subdomain>.workers.dev`.
If that URL differs from `ADMIN_HOSTS`, fix `ADMIN_HOSTS` and deploy again. In the dashboard,
**Workers & Pages** now lists `waitingroom`, and **Storage & Databases** → **Durable Objects** lists
the `Coordinator` namespace. The object itself is created by the first call from the edge handler.

The Worker has no secret yet: that is expected. Without routes it receives no traffic from your site,
and on `workers.dev` the operator endpoints answer 404 until their secrets exist. Deploy first: setting
a secret on a Worker that does not exist yet may fail with `No access to the specified resource`.

## 6. Set the secrets

Generate the values and save them in your password manager before setting them:

```sh
openssl rand -base64 32   # signing key: needed again for every key rotation
openssl rand -hex 32      # admin token
openssl rand -hex 24      # metrics password (Prometheus needs it)
openssl rand -hex 24      # dashboard password
openssl rand -hex 32      # bot secret (step 7, Transform Rule value), if you use the bot bypass
openssl rand -hex 32      # server-to-server bypass header value, if you need one
```

Then set them one by one; each command prompts for the value:

```sh
npx wrangler secret put WR_KEYS --config wrangler/waitingroom.jsonc          # {"1":"<signing key>"}
npx wrangler secret put WR_KEY_CURRENT --config wrangler/waitingroom.jsonc   # 1
npx wrangler secret put WR_ADMIN_TOKEN --config wrangler/waitingroom.jsonc
npx wrangler secret put WR_METRICS_USER --config wrangler/waitingroom.jsonc       # e.g. prometheus
npx wrangler secret put WR_METRICS_PASSWORD --config wrangler/waitingroom.jsonc
npx wrangler secret put WR_DASHBOARD_USER --config wrangler/waitingroom.jsonc     # optional, grants administration
npx wrangler secret put WR_DASHBOARD_PASSWORD --config wrangler/waitingroom.jsonc # optional
npx wrangler secret put WR_BOT_SECRET --config wrangler/waitingroom.jsonc         # optional, bot bypass
```

Each `secret put` publishes a new version of the Worker at once: no redeploy is needed.

`WR_KEYS` is a JSON object: type `{"1":"` + the base64 key + `"}` exactly, without spaces or
newlines. The other optional secrets (`WR_BYPASS_SECRET`, `WR_TURNSTILE_SECRET`) are described in
[configuration](docs/configuration.md#secrets). Set now every secret you might need later, Turnstile
included: adding one during a traffic event would restart the coordinator (step 4).

Check the configuration with the preflight endpoint:

```sh
ADMIN=https://waitingroom.<account-subdomain>.workers.dev/__wr/admin/v1
curl -sS "$ADMIN/preflight" -H "Authorization: Bearer <admin token>"
```

It must answer `{"ok":true,...}`. Otherwise `errors` lists what is wrong (room id, binding, keys):
fix the secret (`secret put` again) or the configuration (`wrangler deploy` again). Any other path of
the `workers.dev` hostname answers 404: that is expected, the site is not served there.

The operator hostname is public and protected by these secrets only (admin token, metrics
and dashboard passwords): keep them long and random. See [operator access](docs/operator-access.md).

## 7. Create the routes, on a test hostname first

Routes decide which requests of your zone run the Worker. They are not in `wrangler/waitingroom.jsonc`
on purpose: they are the switch that turns the room on and off (rollback = remove the routes).
`deploy/scripts/routes.sh` manages them through the Cloudflare API, from a small config file.

### What the script creates

With `HOSTS="shop.example.com"`, `PROTECTED="/*"` and `EXCLUDED="/static/* /api/*"`:

| Pattern | Worker | Why |
|---|---|---|
| `shop.example.com/*` | `waitingroom` | Pages to protect. One route per hostname × protected path. |
| `shop.example.com/__wr/*` | `waitingroom` | Endpoints of the waiting page (reservation, status). Always created, even if the protected paths do not cover it. |
| `shop.example.com/static/*`, `shop.example.com/api/*` | none | A route without a Worker wins over the less specific `/*`: these requests go straight to the cache and the origin, the Worker does not run and costs nothing. |

It touches nothing else: not DNS, not the WAF, not the cache, not the managed waiting room, and not
the other routes of the zone. `delete` removes only the routes listed by the config, and only while
they still point where the script put them.

### Run it

Create an API token: **My Profile** → **API Tokens** → **Create Token** → **Custom token**. Add the
permission **Workers Routes** → **Edit** (category **Developer Platform**). Limit **Zone Resources**
to the site's zone.

Choose a test hostname: a new **proxied** DNS record, e.g. `wr-test.example.com`, pointing to the same
origin (the origin must answer for that `Host`). The Cache API, used by the edge, does not work on
`workers.dev`: tests must run on a hostname of your zone.

```sh
cp deploy/routes.env.example deploy/test.env    # git-ignored, like any deploy/*.env
# edit deploy/test.env: ZONE_ID, HOSTS="wr-test.example.com", EXCLUDED, PREFLIGHT_URL
export CLOUDFLARE_API_TOKEN=<token> WR_ADMIN_TOKEN=<admin token>
deploy/scripts/routes.sh plan deploy/test.env     # read it: what would be created
deploy/scripts/routes.sh apply deploy/test.env    # runs the preflight first, creates nothing if it fails
```

wrangler reads `CLOUDFLARE_API_TOKEN` too, and prefers it to `wrangler login`: with this routes-only
token exported, `wrangler deploy` and `wrangler secret put` fail with an authentication error. Run
them in another shell, `unset CLOUDFLARE_API_TOKEN` first, or add **Workers Scripts** → **Edit**
(account level) to the token so that one token does both.

Without a file argument, the script reads `deploy/routes.env`.

### Optional: let verified search engines skip the queue

Without this, verified bots go through the room like any visitor (no ticket without JavaScript). To
let search engine crawlers, link previews and ad checks through, create two Transform Rules once, in
the dashboard: your domain → **Rules** → **Transform Rules** → **Modify Request Header** →
**Create rule**, with **Edit expression**:

| Rule | Expression | Action |
|---|---|---|
| `wr bot header: remove` | `not (cf.client.bot and cf.verified_bot_category in {"Search Engine Crawler" "Page Preview" "Advertising & Marketing"})` | **Remove**, header `x-wr-bot` |
| `wr bot header: set` | `cf.client.bot and cf.verified_bot_category in {"Search Engine Crawler" "Page Preview" "Advertising & Marketing"}` | **Set static**, header `x-wr-bot`, value = the `WR_BOT_SECRET` of step 6 |

The two expressions are exact opposites, so the order of the rules does not matter. Details and
categories: [routing](docs/routing.md#verified-bots).

## 8. Check the test hostname

```sh
curl -s -o /dev/null -D - https://wr-test.example.com/ | grep -i set-cookie   # __Host-wr_... provisional cookie
curl -s -o /dev/null -D - https://wr-test.example.com/static/app.css | grep -ic __Host-wr   # 0: excluded path
```

Then force the queue and watch a browser go through it:

```sh
curl -sS -X PUT "$ADMIN/mode" -H "Authorization: Bearer $WR_ADMIN_TOKEN" \
  -d '{"mode":"queue_all"}'
# open https://wr-test.example.com/ in a private window: waiting page, countdown, then the site
# back to normal: same call with {"mode":"on"}
```

The full checklist (cache behaviour, metrics, k6 load test) is step 2 and 3 of the
[runbook](docs/runbook.md#cut-over-from-the-managed-waiting-room).

## 9. Go to production

Follow the [runbook](docs/runbook.md#cut-over-from-the-managed-waiting-room) from step 4: set the
production rate, run the preflight, then in a single change pause the managed waiting room and run
`deploy/scripts/routes.sh apply deploy/routes.env` with the real `HOSTS`. Remove the test routes with
`deploy/scripts/routes.sh delete deploy/test.env`.

## Updating

- Code, variables, secrets: `npx wrangler deploy` or `wrangler secret put`, outside traffic events
  only (each one restarts the coordinator, step 4).
- Rate, session duration, mode, pause, whitelist: admin API, any time, no deployment
  ([configuration](docs/configuration.md#operational-configuration)).

## Uninstalling

1. Remove the routes: `deploy/scripts/routes.sh delete <config file>`, for each config you applied.
   The site is served directly by the origin again within seconds. Delete the two Transform Rules
   if you created them.
2. `npx wrangler delete --config wrangler/waitingroom.jsonc` (deletes the Durable Object and its data
   too).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `You need to register a workers.dev subdomain` | First Worker of the account: accept the prompt, or choose a subdomain in **Workers & Pages**. |
| Preflight `ok:false`, or every page answers 503 with `misconfigured` in the logs | A secret is missing or malformed (`WR_KEYS` not valid JSON, key shorter than 32 bytes, `WR_KEY_CURRENT` not a key of `WR_KEYS`) or `ROOM_ID` is invalid. `errors` names it. |
| 404 on `/__wr/admin/v1/...` | Called on the site's hostname while `ADMIN_HOSTS` is set (use `workers.dev`), or `WR_ADMIN_TOKEN` is not set. |
| The test hostname never shows a waiting-room cookie | DNS record not proxied, route missing (`routes.sh plan` shows `create`), or the path is excluded. |
| `routes.sh` answers HTTP 403 or 404 from the Cloudflare API | `ZONE_ID` holds the account ID (the one in the dashboard URL) instead of the zone ID, or the token lacks **Workers Routes → Edit** on that zone. |
| `routes.sh apply` stops on `preflight failed` | The Worker is not ready: the message lists `errors`, fix them (step 6). |
| Logs | `npx wrangler tail --config wrangler/waitingroom.jsonc`, or dashboard → `waitingroom` → **Observability**. |
