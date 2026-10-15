# Interaction with WAF rules

A common setup protects the site with a custom WAF rule that challenges visitors from outside a set of
countries (`XX`, `YY` are placeholders for your country codes), for example:

```
(not ip.geoip.country in {"XX" "YY"} and not cf.client.bot)  ->  Managed Challenge
```

## Order of execution

WAF custom rules, rate limiting rules and Transform Rules run **before** the Worker. A visitor who is
challenged sees the challenge page first; once it is solved (clearance cookie), the request reaches the
Worker and the waiting room applies. The room never sees the requests the WAF blocks or challenges.

## What to check

| Topic | Recommendation |
|---|---|
| Verified bots | Keep `not cf.client.bot` in the challenge rule: verified bots are not challenged. The Transform Rules then set `x-wr-bot` to `WR_BOT_SECRET` for the allowed categories only (see [routing](routing.md#verified-bots)); the room lets those through without a queue, and the other verified bots go through the room like visitors. |
| `POST /__wr/reserve` and `GET /__wr/status` | They are `fetch()` calls from the waiting page: a challenge on them cannot be solved and fails silently. Visitors who passed the challenge on the page normally hold a clearance cookie, but it expires (challenge passage, 30 minutes by default). Either set the challenge passage longer than the longest expected wait, or exclude these two paths from the challenge rule: `... and not http.request.uri.path in {"/__wr/reserve" "/__wr/status"}`. Excluding them is safe: a reservation requires a provisional cookie, which is only issued on a page that went through the challenge. |
| Reload at `admitAt` | It is a full page load: if the clearance expired meanwhile, the visitor solves the challenge, then is admitted (the ticket remains valid for `redeemGraceSec`). |
| `/__wr/admin/*`, `/__wr/metrics`, `/__wr/dashboard` | Recommended: serve them on the `workers.dev` hostname only (`ADMIN_HOSTS`, [operator access](operator-access.md)). They then answer 404 on the site. `workers.dev` is outside your zone, so these WAF rules do not apply to them there: they rely on their secrets. Without `ADMIN_HOSTS`: exclude the Prometheus addresses from the challenge rule for `/__wr/metrics`, and remember that the dashboard refreshes need the clearance cookie like the waiting page. |
| Webhooks and payment callbacks | Excluded from the Worker by routes; make sure the WAF does not challenge them either (unchanged from before). |
| Rate limiting on `/__wr/reserve` | Not provided, and not recommended: per-IP limits refuse legitimate visitors who share an address (companies, schools, carrier NAT). Use Turnstile (`reserveVerifier`) against scripts. |

## Effect on the figures

Challenged visitors who never solve the challenge never reach the Worker: they consume no slot and
do not appear in the room metrics. The admission rate `R` applies to the traffic that passes the WAF.
