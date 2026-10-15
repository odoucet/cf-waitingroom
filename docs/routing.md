# Routing: what is intercepted, and what it costs

## Principle

Only useful traffic reaches the Worker. Routes are attached to the protected paths. Static assets,
API/XHR calls, webhooks and payment callbacks are excluded by **routes without a Worker**:
Cloudflare picks the most specific matching route, and a route without a Worker "negates" less
specific patterns ([Cloudflare docs: routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
These routes are managed by `deploy/scripts/routes.sh` through the API, from a config file
(`deploy/routes.env.example`), not with wrangler: removing them is the rollback.

Example for `shop.example.com`:

| Pattern | Worker | Why |
|---|---|---|
| `shop.example.com/__wr/*` | `waitingroom` | Reserved prefix: reservation, status (and admin, metrics, dashboard when `ADMIN_HOSTS` is not set, see [operator access](operator-access.md)). Always routed. |
| `shop.example.com/*` | `waitingroom` | Protected scope (default `/*`). |
| `shop.example.com/static/*` | none | Static assets. |
| `shop.example.com/api/*` | none | XHR/API: a JSON client should not receive a waiting page in the middle of a session. |
| `shop.example.com/webhooks/*`, `/payment/callback/*` | none | Server-to-server calls (payment providers…) must never be queued. |

Route patterns only accept `*` at the start of the hostname and at the end of the path, and cannot
contain a query string. Matching is case-sensitive.

## Inside the Worker

What routes cannot express (file extensions scattered in the tree) is handled by an **early exit**
at the very top of the handler: `EARLY_EXIT_EXTENSIONS` and `EARLY_EXIT_PREFIXES` are compared to the
path before any I/O, and the request is relayed with `fetch(request)`.

The early exit trusts the path alone, so it is restricted:
- `GET` and `HEAD` only;
- never under `/__wr/` (an unknown `/__wr/x.js` answers 404, it is not relayed);
- prefixes match whole segments: `/static` covers `/static/…`, not `/static-checkout`;
- refused for path forms that some origins resolve to a dynamic page: `;` (path parameters,
  `/cart;.js` or `/static/..;/cart` on Tomcat/Spring), encoded `/` or `\` (`%2F`, `%5C`), and a script
  followed by a path (`/index.php/x.css`, PATH_INFO; also `.aspx`, `.jsp`, `.cgi`…). These requests go
  through the room like any page.

The remaining condition is on the origin: **it must serve the listed extensions from static files
only**. If `/orders/checkout.json` reaches the checkout controller (Rails formats, many APIs) or
`/invoice.pdf` is generated on the fly, do not list `json` or `pdf`: anyone could skip the queue
through them. With nginx, for example, serve them with `try_files $uri =404;` in a location of their
own. The example configuration lists only images, fonts, media, CSS and JavaScript.

The Worker runs before the Cloudflare cache. Its `fetch()` goes through the zone cache, so origin
responses keep being cached as before
([how the cache works with Workers](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)).
The Worker never changes what is cached: when it must set a cookie, it copies the response
(`new Response(body, response)`, body streamed, not read) after the cache lookup. That response is
then made private to the browser: `public`, `s-maxage` and `proxy-revalidate` are removed from
`Cache-Control`, `private` is added unless `private` or `no-store` is already there, and
`CDN-Cache-Control` and `Surrogate-Control` are removed. A shared cache downstream (corporate proxy,
another CDN) therefore never stores a waiting-room cookie and hands it to other visitors. Responses
without a cookie keep their headers untouched.

## What happens to each request, and what it costs

Prices: Workers Paid includes 10 M requests and 30 M CPU-ms per month ($0.30 per extra million
requests); Durable Objects include 1 M requests ($0.15 per extra million).

| Traffic | Path | Worker invoked | Coordinator (DO) call | Cookies set | Main CPU work |
|---|---|---|---|---|---|
| Excluded prefix (route without Worker) | cache/origin directly | no (free) | no | none | none |
| Static extension elsewhere (early exit) | relay | yes (1 request) | no | none | path comparison |
| Valid session | relay, streamed | yes | no | at most one per user per minute (sliding expiry and counting) | 1 HMAC verify (+1 sign once a minute) |
| Whitelist: verified bot (`x-wr-bot: <WR_BOT_SECRET>`), secret header | relay | yes | no | none | constant-time compare |
| Whitelist: signed link `?wr_pass=` | 302 to the same URL without the token | yes | no | bypass cookie | 1 verify + 1 sign |
| Whitelist: bypass cookie | relay | yes | no | at most one per minute | 1 verify |
| Whitelist: IP/CIDR | relay | yes | snapshot needed (memory/cache) | none | CIDR match |
| First visit, open mode | relay | yes | no (snapshot from memory or cache) | provisional cookie | 1 sign |
| Second request, open mode | relay | yes | none if the isolate holds a lease, else one flush | session cookie | 1 verify + 1 sign |
| Visitor while queueing (no ticket) | waiting page (HTML or JSON) | yes | no | provisional cookie | 1 sign, template |
| `POST /__wr/reserve` (page JavaScript) | JSON ticket | yes | **1 reservation** | ticket cookie | 1 verify + 1 sign |
| Reload at `admitAt` | relay | yes | no (redemption batched) | session cookie | 1 verify + 1 sign |
| `GET /__wr/status` (every ~60 s, optional) | JSON | yes | no (snapshot) | none | none |
| Mode `off` | relay | yes | no (snapshot) | none | none |
| Cookie-less bot while queueing | waiting page, no JavaScript run | yes | no | provisional cookie (discarded) | 1 sign, template |

Measured on Node.js 26 (Web Crypto, same algorithms): HMAC-SHA256 verify ≈ 0.11 ms, sign ≈ 0.12 ms,
admission decision < 0.001 ms. The heaviest request path (verify + sign) therefore stays well under
the 1 ms CPU budget; confirm the production p99 with the Workers CPU time metrics after the cut-over.

Background work: each isolate flushes its deltas (admissions, redeemed tickets, session counts) in
one RPC that also returns the snapshot. Flush cadence is described in
[algorithm.md](algorithm.md#flushes) and its cost in [cost-model.md](cost-model.md).

## Verified bots

Two Transform Rules of the zone (created by hand, see [installation](../INSTALL.md#optional-let-verified-search-engines-skip-the-queue))
handle the `x-wr-bot` header, read by the Worker (`BOT_HEADER`):

1. **remove** it when the request is not a verified bot of an allowed category, so that a client value
   never reaches the Worker or the origin;
2. **set** it to `WR_BOT_SECRET` when `cf.client.bot` is set **and** `cf.verified_bot_category` is in
   the allowed list.

The two expressions are exact opposites, so their order does not matter. Rule filters see the original
request. Phase `http_request_late_transform` (**Modify Request Header** in the dashboard); if that
phase is managed by another tool for your zone, add both rules there.

The Worker lets a request through only when the header equals `WR_BOT_SECRET` (constant-time
comparison), then removes it before the origin. The guarantee does not depend on the rules: where
they are missing, a client still cannot produce the secret, and verified bots simply go through the
room like visitors. `GET /__wr/admin/v1/preflight` reports `botBypass`.

Default categories:

| Category | Why it bypasses the queue |
|---|---|
| `Search Engine Crawler` | A crawler that meets a waiting page indexes it instead of the site. |
| `Page Preview` | Link previews in messaging and social apps, shared most at the start of an event. |
| `Advertising & Marketing` | Landing-page checks of ad networks: a waiting page may get ads disapproved. |

Every other verified bot goes through the room like a visitor: AI crawlers and assistants, SEO tools,
archivers, monitoring, feed fetchers and so on. In open mode it is relayed; while queueing, it gets the
waiting page and, without JavaScript, never reserves a slot. Add `Monitoring & Analytics` if an
external uptime probe must see the site during a queue (in both expressions). With `cf.client.bot`
alone, every verified bot skips the queue.

The category values are listed in the
[verified bot categories](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/).
`cf.verified_bot_category` is documented without a plan restriction, but check that the rule editor
of your zone accepts it before relying on it.

## Not intercepted on purpose

- Responses are never modified, except those that carry a waiting-room cookie: `Set-Cookie` is added
  and caching is made private ([above](#inside-the-worker)). Status and body are always untouched.
- WebSocket upgrades are relayed untouched (no cookie is added on a `101`).
- The reserved prefix `/__wr/` is never relayed to the origin.
- The bypass header is removed before the origin sees it; other headers and cookies are forwarded.
