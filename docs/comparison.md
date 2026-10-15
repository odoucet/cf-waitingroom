# Comparison with Cloudflare Waiting Room

Cloudflare Waiting Room is a managed product that works out of the box on any plan that includes it,
with scheduled events, random queueing and a dashboard. This project makes different trade-offs for
one specific need: tight control of the admission rate on a single site. This page states the
documented behaviours of the managed product that motivated it, with links to the Cloudflare
documentation (quoted October 2026), and the figures observed on an e-commerce site with ~2k active
users at peak.

## Documented behaviours

**State is per data center.** "The Waiting Room state … is maintained at the local data center level
… Each data center works with its own Waiting Room state … Queueing starts when the slots run out
within the Worker … The Waiting Room state is updated with global information every few seconds."
([About Waiting Room](https://developers.cloudflare.com/waiting-room/about/))

**Limits are targets.** "Waiting Room queues traffic at the data-center level … the configured traffic
limits … are target values … A waiting room might queue traffic from a specific data center before the
waiting room reaches its limit." ([Monitor a waiting room](https://developers.cloudflare.com/waiting-room/how-to/monitor-waiting-room/))

**Budgets follow historical traffic, and propagation takes time.** "Waiting Room is a distributed
system, and achieving perfect global counting in real time is challenging … Data center budgets are
allocated based on the historical traffic … the global state propagation process takes approximately two
minutes … temporary overshooting may occur." ([Troubleshooting](https://developers.cloudflare.com/waiting-room/troubleshooting/))

**Abandoned places are kept five minutes.** A queued user's "place in line is held for five minutes after
the last refresh"; in FIFO mode, users who abandoned a bucket hold it until they expire. The waiting page
refreshes every 20 seconds. ([Troubleshooting](https://developers.cloudflare.com/waiting-room/troubleshooting/),
[Waiting Room cookie](https://developers.cloudflare.com/waiting-room/reference/waiting-room-cookie/))

## What was observed, and how this project handles it

| Observed (anonymised) | Cause per the documentation | Here | Proof |
|---|---|---|---|
| Visitors queued with ~30 % of the active-user threshold used; waits of 20–30 s (one page refresh) | Per data center budgets from historical traffic: a "cold" data center queues while global capacity is free | One global cursor; isolates admit from leases while the cursor is behind the clock; dormant leases do not move the cursor | `test/sim/low-traffic.test.ts`: 30–70 % of `R` on 50 isolates, zero waiting page |
| During a steep 10-minute ramp, ~1.76× the active-user threshold admitted | Global budget consumed in parallel by all data centers before resynchronisation (~2 min) | Admissions bounded by `R` plus the outstanding leases and the bucket depth; tickets scheduled after outstanding leases | `test/sim/peak.test.ts`: ramp from ~1,800 to ~5,000 demanded actives, real actives ≤ 1.05 × target |
| ~1,800 people shown in queue all day for 300–500 actives, 36-minute ETA without any peak | Bucket-based FIFO, abandoned places kept 5 minutes, every cookie-less bot request creating a new entry | Slots only reserved with a provisional cookie, a proof of work and a minimum cookie age; exact `admitAt` instead of an estimate; no-shows compensated by overbooking | `test/sim/bots.test.ts` (zero slot for bots), `test/sim/abandons.test.ts` (30 % no-shows, rate within ±10 %) |

## Trade-offs

| | Managed Waiting Room | cf-waitingroom |
|---|---|---|
| Control variable | active users and new users per minute (targets) | admission rate `R` (and an optional brake on estimated actives) |
| Accuracy | approximate, per data center, ~2 min propagation | global cursor; overshoot bounded and tested |
| Queue display | estimated wait, 20 s refresh | exact countdown to `admitAt`, reload once |
| Abandoned places | held 5 minutes | not held: skipped (never reserved, or compensated as no-shows) |
| Bots | each request may create a queue entry | no slot without a cookie; a proof of work per reservation (optional Turnstile) |
| Features | scheduled events, random queue, customisation in the dashboard, multi-room | one queue mode (FIFO by slot), pause, kill switch, whitelist, signed links |
| Operations | fully managed | you run two Workers, a Durable Object, routes and secrets |
| Scale | Cloudflare network | one coordinator object per room (≈ 1,000 req/s soft limit) |
