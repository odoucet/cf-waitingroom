# Algorithm

The room controls the **admission rate**, not a stock of active users. Two settings drive it: the
admission rate `R` (users per minute) and the session duration `D` (sliding inactivity timeout).
Everything below lives in `src/core` as pure code with an injected clock; the Workers only add I/O.

## The cursor

The coordinator keeps an **admission cursor**: the time of the last slot handed out, where one slot
is `60 / R` seconds. While the cursor is behind the clock, capacity is free and the room is **open**;
when demand exceeds `R`, the cursor runs ahead of the clock and the difference is the wait of the next
visitor.

The cursor is the larger of two values:

- the **ticket cursor**: `admitAt` of the last reserved ticket;
- the **lease bucket**: a token bucket rebuilt from the real times at which isolates consumed leased
  slots (reported per second). It is replayed in chronological order on every RPC, so a late report
  of usage that happened while capacity was idle is absorbed by the bucket floor instead of being
  stacked on the cursor. The bucket depth is `burstSec` (5 s of `R`).

There is no hysteresis and no threshold to tune: open ⇔ `cursor ≤ now` (and mode `on`, not paused).

## Open mode: provisional cookie and leases

1. A first request without cookie is relayed to the origin with a signed **provisional cookie**. No
   slot is consumed: a bot that keeps no cookie never costs anything.
2. The next request carrying that cookie consumes one slot from the isolate's **lease** and receives a
   session cookie. Without a lease, the isolate refills it with one urgent RPC (with a timeout and the
   fail mode).
3. Leases are blocks of slots granted by the coordinator in the flush answer. Size: the claim rate
   observed by the isolate projected over the lease lifetime, with 50 % headroom, capped by
   `leaseBlockMax`, by a fair share (twice `cap / active isolates`) and by a global cap on all outstanding
   slots: `leaseMaxOutstandingSec` of `R` near capacity, `calmLeaseMaxOutstandingSec` when calm.
4. Unused slots are returned with the next flush; a lease that is never reported expires
   (optimistically assumed unused). Leases do not move the cursor, so dormant blocks spread over many
   isolates never cause false queueing; consumed slots do.

**Overshoot bound.** Slots consumed but not yet reported are bounded by the outstanding leases. In any
window, admissions are therefore at most `R × window + burstSec × R + outstanding cap` (plus one urgent
slot per isolate), and never more than `leaseBlockMax × isolates` beyond `R`. Tickets reserved at the
transition to the queue are scheduled after the outstanding leases, so the two paths do not overlap.
The simulations check this bound (`test/sim/lease-bound.test.ts`, `test/sim/peak.test.ts`).

**Calm.** When admissions over the last minute stay below `calmUtilization × R`, the snapshot TTL grows
to `calmSnapshotTtlSec`, leases live `calmLeaseSec`, and usage is reported lazily (when a lease is
exhausted or about to expire). This is what keeps the coordinator cheap at low traffic.

## Queue: reservations and tickets

When the room is not open (or in `queue_all`, or paused), new visitors get the waiting page plus a
provisional cookie. Once the cookie is `reserveMinAgeSec` old, the page's JavaScript calls
`POST /__wr/reserve` once, with a proof of work bound to the cookie (optional Turnstile hook):

```
admitAt = max(ticket cursor, lease bucket + outstanding leases, now − burstSec) + 60 / R_eff
ticket cursor = admitAt
```

The edge signs a **ticket** `{ticketNo, admitAt, issuedAt}` and the page shows an exact countdown,
reloading at `admitAt` plus up to 2 s of jitter (and on `visibilitychange`, because hidden tabs throttle
timers). The same provisional cookie always gets the same ticket: reloading the page never takes a
second slot. No reservation without a provisional cookie; the checks of `/__wr/reserve` and their
limits are in the [threat model](threat-model.md).

A request carrying a ticket is admitted when `now ≥ admitAt + pause offset` or `ticketNo ≤ earlyUpTo`,
not paused, and before `admitAt + redeemGraceSec`. The ticket is exchanged for a session cookie and the
origin response is returned directly (no extra reload). Redeemed ticket numbers are batched to the
coordinator.

Position and ETA are not estimated from an observed rate: `admitAt` is the ETA.

## Overbooking

Some visitors reserve and never come back. A ticket whose `admitAt + redeemGraceSec` passed without
redemption counts as a no-show. Over a sliding window (`absenceWindowSec`), the coordinator computes the
absence ratio `a` (at least 20 samples) and sets:

```
R_eff = min(R / (1 − a), overbookCap × R) × brakeFactor
```

`R_eff` spaces tickets; leases use `R × brakeFactor` (no no-shows there). Absences that were not
anticipated by the ratio applied when the ticket was issued accumulate a **credit**, spent by moving
`earlyUpTo` forward: those tickets may enter before their `admitAt`, which the waiting page notices
with its optional status check (`GET /__wr/status`, every ~60 s). With 30 % no-shows, the observed rate
stays within ±10 % of `R` once the grace period has elapsed (`test/sim/abandons.test.ts`).

## Safety brake (optional)

Every edge counts each session at most once per minute: `+1` on the current minute, `−1` on the minute
the session was previously counted in (carried by its cookie). The estimate of active users is the sum
of the minutes inside `D`. Once a minute, above `brake.activesThreshold` the coordinator multiplies the
rate by a factor decreasing linearly to `brake.minFactor` at `brake.activesLimit`. It counts sessions
seen within `D`, so it reads higher than the real concurrency.

## Replay protection

A ticket presented twice in the same isolate is refused locally. Across isolates, the coordinator keeps
the tag of the isolate that redeemed it first; a second redemption is not counted and the ticket is
added to a revocation list `[ticketNo, winnerTag]` distributed with the snapshot. Session cookies carry
the ticket number and the issuing isolate's tag: copies are refused at their next request after the
snapshot reaches the isolate (≤ one TTL), the first redemption keeps its session
(`test/sim/replay.test.ts`).

## Pause

While paused nothing is admitted (tickets can still be reserved). When the pause ends, every ticket
issued so far is shifted by the pause duration (`pauseOffsets` in the snapshot) and the ticket cursor
moves forward by the same amount: resuming does not release the tickets whose `admitAt` passed during the
pause all at once.

## Flushes

Every RPC is a billed Durable Object request, so each kind of delta has its own cadence:

| Delta | Cadence |
|---|---|
| Redeemed tickets | once per snapshot TTL |
| Leased slots used | once per TTL near capacity; when calm, when the lease is exhausted or about to expire |
| Session counts (per minute) | every minute with the brake on, every five minutes otherwise |
| Plain counters (bypasses, provisional cookies, errors) | every five minutes |

Isolates with nothing to send read the snapshot from the Cache API (per data center); a stale but
recent snapshot is used while a refresh runs in the background.

**Convergence and outages.** In normal operation a change reaches every isolate within two snapshot
TTLs. When an isolate cannot refresh (coordinator unreachable), it keeps using its last snapshot for
`STALE_SNAPSHOT_TTLS` TTLs (6 by default, 1 for the strict setting), still admitting with its lease
and its last known pause and rate, then applies the fail mode. `wr_edge_config_generation_min`
shows an isolate still working with an older configuration.

**Delivery.** Deltas only travel with flushes; reservations carry none. Each isolate has at most one
batch without answer: it is resent unchanged, with the same `seq`, until the coordinator answers, and
no newer batch leaves before that. A timeout does not cancel an RPC that the coordinator may already
have applied, so the coordinator treats a `seq` at or below the last one of that isolate as a
duplicate: acknowledged, not applied again, answered with the lease granted to it the first time
(`wr_batch_duplicates_total`). Deltas recorded meanwhile wait for the next batch. Every batch is thus
applied exactly once and in order. The last `seq` of each isolate is persisted with the state it
produced: a batch applied after the last persisted state is lost with its effects on restart, and its
resend is applied again; numbers skipped that way are counted (`wr_batch_gaps_total`).

## Persistence and restart

- The configuration is written on every change; the state (absence window, minute counters, lease
  usage, pause, counters, per-minute history, last batch per isolate) by an alarm set 5 s after the
  first change, and by any RPC when the last write is more than 10 s old. The object hibernates
  after 10 s without a request or an event and loses its memory (the next request restarts it): the
  alarm writes every change before that, so a quiet period loses nothing. A deployment or a crash
  can still lose the last 5 s.
- No storage row grows with the queue (a row is limited to 2 MB): the ledger of recent tickets is
  stored in chunks of 4,096 tickets, one row each, and only the chunks that changed are written; the
  absence window is aggregated per 10 s. The queue is capped by `maxWaitingTickets` (100,000 by
  default): beyond, reservations are refused with `retry` (`wr_reserve_refused_total{reason="full"}`).
  `wr_coordinator_storage_row_bytes` reports the largest row.
- Nonces are written to their own table before the reservation is answered, and kept 24 h (the
  longest `provisionalWindowSec`): after a restart, a nonce still gets its ticket, never a second one.
  The edge and the coordinator both refuse a provisional cookie older than `provisionalWindowSec`,
  which is also its `Max-Age`.
- High-water marks of the ticket cursor and of the ticket numbers are written **ahead** (10 s of
  slots) whenever a ticket crosses them, before the answer leaves the object. After a restart, the
  coordinator resumes from them: no slot and no ticket number is ever handed out twice, at the cost of
  at most 10 s of skipped slots.
- Mode and pause are kept. The active-user estimate cannot drop below the last persisted value until a
  full session window has elapsed. That floor is persisted and carried, never extended, by the
  following restarts: re-arming it on each restart would freeze the estimate through a quiet period.
- Leases and replay revocations are persisted with the state (a revocation forces an immediate
  write): a revoked session stays revoked across a restart. Leases granted after the last persisted
  state are unknown, so after a restart the rest of the lease cap counts as outstanding until the
  longest possible lease (`max(calmLeaseSec, 2 × snapshotTtlSec)`) has expired: meanwhile only urgent
  single slots are granted, and the global cap holds.
- Reservations are refused in mode `off` (existing tickets are kept for when the room comes back).

Restarts are frequent: besides deployments and secret changes, the coordinator restarts after every
quiet period of more than 10 s (hibernation). The margins above (skipped slots, lease cap counted as
outstanding) apply each time.

`test/sim/restart.test.ts` restarts the coordinator in the middle of a queue and during a pause.

## Failure handling

Coordinator errors (timeout, overload, unavailability) and the absence of any usable snapshot go
through the `FAIL_MODE` Worker variable (`open` relays, `closed` answers a static 503; unset means
`closed`), are logged and counted (`wr_fail_open_total`, `wr_coordinator_errors_total`). The fail mode
never comes from the snapshot, so a fresh isolate applies it before it has ever reached the coordinator. Valid sessions
do not depend on the coordinator once the isolate holds a snapshot: an isolate that has never received
one loads it (data-center cache or coordinator) before honouring a session cookie, because idle expiry,
total lifetime and revocations come with it. If it cannot, the request goes through the fail mode and
the session cookie is neither renewed nor cleared.

## Simulations

`test/sim/harness.ts` drives one `CoordinatorCore` and N `EdgeCore` isolates with a deterministic clock
and PRNG: human visitors (think time, session length, no-shows), cookie-less bots, ticket copies,
coordinator restarts and pauses. Scenarios (figures anonymised from an e-commerce site with ~2k active users):

| Scenario | Assertion |
|---|---|
| Peak: demand from ~1,800 to ~5,000 actives in 10 min, 40 isolates | sustained rate ≤ 1.02 `R`; any 60 s ≤ `R` + bound and ≤ 1.1 `R`; real actives ≤ 1.05 × `R × mean session` |
| Bots: 300 cookie-less requests/min, open and queueing | zero slot consumed; one reservation per queued human; no ghost in the queue |
| Abandons: 30 % no-shows | absence ratio ≈ 0.3; `R_eff ≤ 1.5 R`; rate within ±10 % of `R` after the grace period |
| Low traffic: 30, 50, 70 % of `R`, 50 isolates | no waiting page, no reservation, cursor never ahead of the clock |
| Lease bound: flash crowd on a calm room | overshoot ≤ outstanding cap + burst, back to `R` within two minutes |
| Replay: one ticket presented 100 times on 20 isolates | one admission counted; one session alive after one TTL |
| Restart while queueing / while paused | no ticket number or slot re-issued; mode and pause kept; rate stays at `R` |
