# The credit estimate

Hostinger publishes no credit balance. The governor keeps its own estimate in core-seconds and sets
the `user.slice` ceiling from it. The arithmetic is about 200 lines in `src/estimate.ts`. It does no
I/O, so the daemon and the simulations run the same code. `src/governor.ts` calls it on every pass.

The estimate has two parts. The anchor is the bank at the last settled reading from Hostinger. The
tail is the guest's own CPU count since then. There are no modes and no settings.
[Study results](study-results.md) shows what it does in simulation.

## The rules it replays

`src/plans.ts` holds Hostinger's published rules. A plan earns its baseline, 60% of its vCPUs, in
core-seconds every second, and spends what it uses. The bank holds at most 10,800 × (vCPUs −
baseline) core-seconds, three hours of full use. At zero Hostinger limits the VM to 30% of its
vCPUs, 40% on KVM 1, until the bank is back at 20%. While work presses on that limit, the bank earns
nothing.

On KVM 8 the baseline is 4.8 cores, the bank holds 34,560 core-seconds, the limit is 2.4 cores and
it lifts at 6,912.

Hostinger's API serves CPU readings for the last 48 hours, in percent of the plan, about one every
30 minutes. Each is the mean since the reading before it. The governor fetches them every 30
minutes, through the API or the [broker](hostinger-credentials.md). Hostinger may still revise the
newest reading of a fetch, so the governor leaves it out until a later fetch returns it behind a
newer one. The rest are settled.

## Anchor

`settle()` replays each settled reading through those rules. Over a reading's interval the bank
earns the baseline and pays the reading plus the pad, a constant that starts at 0.02 cores. The
result stays between zero and capacity. That is the bank at the reading's timestamp, and the anchor
moves there.

Readings move the estimate both ways. If Hostinger metered less than the tail charged, the estimate
rises when the reading settles. If it metered more, the estimate falls.

A reading is one mean over about half an hour. A bank that sits full for part of that time forgets
what it earned there. So `settle()` spreads the bill over the interval in the shape of the guest's
own count, sample by sample.

A reading counts when its interval is 900 to 2,700 seconds long. Nobody knows what a reading after a
longer interval averages. There the guest's own count stands in when samples cover the interval.
When they don't, nobody watched that time, and it counts at the most the VM could have spent. A hole
of more than about two hours in Hostinger's readings ends that way, because samples are kept three
hours.

The same goes for a reading whose interval began before the anchor, as the first one after a start,
a lift or a seed does. It averages time the anchor has already settled, so it cannot say how much of
its CPU ran after.

The anchor never reaches further back than the samples do. On a first start, after lost state, or
when the anchor is older than the three hours of samples kept, it is set to that moment with the
estimate the own count has, and readings move it from there. Readings from before the governor
watched are never replayed: they cannot say whether a limit stopped the bank earning then.

## Tail

No settled reading covers the last 30 to 100 minutes. `tail()` counts them from `/proc/stat`. Each
pass takes one sample of busy and stolen CPU, and each sample charges

```text
1.05 × busy cores + 0.04 cores
```

The 0.04 grows with what the readings show. For every settled reading, `settle()` records how far it
ran above 1.05 × the guest's busy cores over the same interval. It keeps the last 48, about a day.
From 8 on, the addition is their mean plus two standard deviations, and never less than 0.04. What
limits taught the pad comes on top. `margin()` computes it, and `governor status` prints the result
as `margin ×1.05 +0.04` or higher.

A sample earns the baseline unless work pressed on a limit during it, a probe or lift test ran, or
it spans more than two passes, which means the daemon was not watching. Such a sample still charges
what the kernel counted, but it is never laid beside a reading: it knows one mean over the whole
stop, and cannot check the several readings that fall inside it.

## Guard

A broken feed must not steer the box. Where samples cover at least 90% of a reading's interval,
`settle()` checks the reading against them.

A reading under the guest's own busy cores cannot be Hostinger's bill for them. The feed is broken,
and the own count stands in for that interval. In study S20, readings at half the meter cost no
limit.

A reading counts for at most 1.3 × the guest's busy cores + stolen cores + 0.3, so a feed that
breaks high cannot starve the box. In study S18, readings at eight times the meter cost no limit and
13.9% of the CPU.

A feed that reads a little low passes both checks. That is billing the readings do not show, and it
costs a limit before the pad learns it: readings at 95% of the meter took one limit in each of eight
seeds.

## Steal

On the one box where it was measured, Hostinger's readings rose by about half a core per core the
neighbours stole. Until a reading settles, the tail charges every stolen core whole.

A credit limit also shows as steal, and that steal is not billed. A limit delivers no more than the
plan's limit. So `billedSteal()` charges steal only while the VM delivers more than 0.1 cores above
the plan's limit, and never during a known limit. At or under that, the steal may be a limit nobody
has recognised yet. Charged there, the estimate would fall, the ceiling would stay shut, and the
steal that reveals a limit would not grow.

## Unknown time

Two cases have no sample.

A reading no sample covers, as across a reboot or while the daemon was stopped, is billed as it is,
and that time earns nothing. A limit may have come and gone unseen, and one pauses earning while
work presses on it, which a reading cannot show. So the estimate stays a lower bound until the bank
is next known full.

Time since the anchor that no sample covers, as after a reboot, counts at the most the VM could have
spent: every vCPU busy at the margin. On KVM 8 at the starting margin that is 3.64 cores above the
baseline, 38% of the bank per hour. It holds until readings settle past the hole. Holes under 60
seconds are ignored, because the wall clock and uptime drift apart a little.

## Clock

Readings carry Hostinger's clock and samples the box's own. When the wall clock moves more than 60
seconds against uptime within one pass, it has stepped, forward or back. No earlier sample can be
laid beside a reading any more, so the anchor moves to that moment with the estimate the own count
had, and readings move it again from there. Readings the new clock places in the future were settled
under the old one and are dropped, and so is a fetch that was sent under it.

Uptime starts over at a reboot, so no pass can compare it with the wall clock. There the clock has
gone back if it reads before the last saved pass, or if it says the new boot began before that pass.
Then the estimate starts over from zero.

A step also resets when the bank was last known, which is a time on the old clock. What a limit
teaches is measured from the step.

Readings that end more than two hours before the box's clock move nothing. Either the feed stopped
or the clock is wrong. In studies S22, S24 and S25, a clock three hours ahead, three hours behind
and 90 minutes ahead cost no limit.

## Spending

`allowedCores()` in `src/credits.ts` spends the estimate. The floor is 10% of capacity. Above it the
VM may bill the baseline plus the surplus over the floor spread across 30 minutes. Below it the
shortfall is made up over an hour. The margin comes off that allowance, then the cores busy outside
the slice. The ceiling moves in steps of 10% of one core, from 20% to every vCPU.

v0.3 used a 5% floor in `apply` and 20% in `off`. [Study results](study-results.md#floor-choice) has
the runs behind 10%.

## Credit limits

Limit detection is v0.3.2's with the hardening #23 merged, and one change: a probe that passes only
earns a burner test, and the burners decide. Only a VM they find held at the plan's limit starts a
limit. The [README](../README.md#how-it-works) describes detection. It looks at the last five
minutes, or the last three passes where `tick_seconds` makes those longer. This section covers what
a limit does to the estimate.

On entry the bank is empty, since that is what a credit limit means, and the estimate goes to zero.
The governor keeps what the limit found: the lowest the estimate read in the 20 minutes before
entry. The estimate rises under a limit nobody has recognised yet, so its value at entry would
overstate what the limit found. While the limit lasts, the estimate rises on the guest's own count
and stops at 20%, Hostinger's lift point. Readings are not replayed until the lift.

At the lift the estimate carries on from what the own count rebuilt since the limit began, and the
anchor is set there. Nothing from before the limit comes back. What the limit found may have been
spent while it lasted. And the anchor from before, replayed through a limit that work pressed on,
would earn what the bank did not.

Whether it was a credit limit is decided by the first lift test that fails with a clear result. A
lift test runs burners on more cores than the plan's limit allows, outside the slice.

| What the burners find                                                     | Meaning                                       | Pad       |
| ------------------------------------------------------------------------- | --------------------------------------------- | --------- |
| Three quarters of what they ask delivered                                 | No limit: it lifts, whatever neighbours take  | Unchanged |
| The VM held at the plan's limit + 0.1 cores or less, 15% of demand stolen | Hostinger's credit limit                      | May rise  |
| The VM held more than 0.3 cores above the plan's limit                    | Something else, such as a sustained-use limit | Unchanged |
| Anything between, or nothing measured                                     | Nothing: the next test decides                | Unchanged |

Later tests do not change a clear answer, however low a cap falls. A reboot forgets it, because the
limit may have lifted while the VM was down. A limit whose first test passes was the neighbours, or
over already, and teaches nothing.

After a credit limit the governor expects no other for as long as full use takes to spend the 20%
Hostinger lifts at, counted from the last test that still found the limit. Until then only evident
steal starts a limit.

The pad is the one thing the governor learns. A confirmed credit limit means the bank emptied while
the estimate still showed credits. `billingGap()` divides those credits by the time since the bank
was last known, an hour at least. The bank is known when the estimate is full, when it is empty, and
at the lift of a credit limit, where Hostinger's bank has reached 20%. If the estimate stands under
20% there, the difference counts with the credits, until the estimate next runs empty. The result is
a rate in cores that Hostinger billed and its readings did not show. `learnedPad()` adds 1.25 times
that rate to the pad, at most 1 core per limit. The pad is billed on top of every reading and added
to the tail's charge.

A limit that found the estimate already empty teaches nothing. The estimate saw it coming, as when
work outside the slice spends the bank, and no billing was missed.

A rate over 0.2 cores is not a billing gap. Something else emptied the bank, such as readings that
went missing. The first such limit teaches nothing. It was a credit limit all the same, so the
estimate restarts at the lift. A second within a day teaches, because two in a day show the rules
themselves are off.

The own count's addition, pad included, stops at the baseline less 1.05 × (the plan's limit − 0.2
cores): 2.49 cores on KVM 8 and 0.39 on KVM 1. The governor leaves the VM 0.2 cores under the plan's
limit while a limit recovers. With a larger addition it would hold the box harder in normal running
than it does then.

A limit an operator declared with `governor limit on` teaches nothing. Neither does one that a
reboot or `governor seed` interrupted.

Nothing lowers the pad except `sudo governor calibrate --reset`. Limits the slice did not cause can
still raise it a little when the estimate is just above empty as they begin. In the detection
scenario where 8 cores outside the slice empty the bank 32 times in two days, the pad ends at 0.027
cores.

## Stale readings and no readings

After two hours without a settled reading the estimate is stale. It keeps running on the guest's own
count from the last anchor. `credits.staleSince` in public state gives the time of the last settled
reading, and `governor status` and `governor report` warn. A failed fetch retries after a minute,
doubling to 30 minutes. When readings return, the replay picks up from the anchor.

With no Hostinger token or broker there are no readings. The estimate starts at zero, or at
`initial_balance`, and runs on the own count at 1.05 × busy cores + 0.04. In study S19 that took no
limit in eight weeks and delivered 0.11% less CPU than the same run with readings.

## Restarts

A daemon restart keeps the estimate. The time it was stopped is charged from the kernel's counters
and earns nothing. When readings settle past the stop, they are billed as they are, and the stop
still earns nothing.

A reboot keeps the estimate too when readings are fresh. Samples from before the reboot keep their
place in time, and the time down counts as unknown time. In study S8 a 15-minute reboot with a full
bank left the estimate at 31,114 of 34,560 core-seconds. Without fresh readings a reboot restarts
the estimate at zero, because nothing says what ran while the VM was down.

A `persist.json` that does not parse, or holds no state, is renamed `persist.json.bad-<time>` or
passed over, and the estimate starts over from zero. The three newest such files are kept. A changed
plan, baseline or VM id also starts it over.

`initial_balance` counts on a first start only, and only when it is above zero. A first start has no
`persist.json` and no `daemon.lock` in `/var/lib/governor`. The daemon leaves that lock file behind
from its first run, v0.3 included, so state that goes missing later is lost state and starts from
zero.

## State, commands and logs

`/var/lib/governor/persist.json` holds the estimate: the balance, the anchor, the pad, the last 48
differences, three hours of samples and 72 hours of settled readings. It is schema 3. The
[changelog](../CHANGELOG.md) says what a v0.3 file carries over.

`sudo governor calibrate --reset` puts the pad back to 0.02 and forgets the 48 differences. The
estimate stays. `sudo governor seed <core-seconds>` states the bank, and the estimate stands on that
until readings settle past it.

After each fetch the daemon logs an `estimate:` line with the balance, anchor, margin and pad. When
a limit raises the pad it logs a `calibration:` line and fires the `calibration` hook. Each lift
logs a `recovery observation:` line: how long the recovery took, the idle minimum the configured
baseline predicts, and whether a lift test confirmed the limit.

## Constants

| What                                  | Value                               | Where                                 |
| ------------------------------------- | ----------------------------------- | ------------------------------------- |
| Own count                             | 1.05 × busy cores + 0.04            | `ESTIMATE.mul`, `ESTIMATE.add`        |
| Pad at start                          | 0.02 cores                          | `ESTIMATE.pad`                        |
| Readings behind the addition          | Last 48, from 8 on                  | `ESTIMATE.excessKept`, `excessMin`    |
| Stale after                           | 2 hours                             | `ESTIMATE.staleMs`                    |
| Guard                                 | Own count to 1.3 × it + steal + 0.3 | `settle()`                            |
| Sample cover a reading needs          | 90% of its interval                 | `settle()`                            |
| Steal charged above                   | Plan's limit + 0.1 cores            | `billedSteal()`                       |
| Hole ignored                          | Under 60 seconds                    | `UNCOVERED_SLACK_S`                   |
| Remainder of a reading ignored        | Under 1 second                      | `settle()`                            |
| Clock step                            | Over 60 seconds in one pass         | `CLOCK_STEP_S` in `governor.ts`       |
| Most the own count adds               | Baseline − 1.05 × (limit − 0.2)     | `mostAdded()`, never under 0.04       |
| Pad learned per limit                 | 1.25 × the rate, at most 1 core     | `learnedPad()`                        |
| Largest rate taken as a billing gap   | 0.2 cores                           | `BILLING_GAP_MAX`                     |
| Shortest time a rate is measured over | 1 hour                              | `billingGap()`                        |
| Floor, spend time, refill time        | 10%, 30 minutes, 60 minutes         | `LAW` in `src/credits.ts`             |
| Valid reading interval                | 900 to 2,700 seconds                | `validSpacing()` in `credits.ts`      |
| A credit limit at a failed lift test  | Limit + 0.1 cores, 15% stolen       | `limitGone()` in `governor.ts`        |
| No credit limit at a failed lift test | More than limit + 0.3 cores         | `limitGone()` in `governor.ts`        |
| A limit lifts                         | 75% of what the burners ask         | `liftConfirmed()` in `credits.ts`     |
| What a limit found                    | Lowest estimate in 20 minutes       | `ONSET_MS` in `governor.ts`           |
| Samples kept                          | 3 hours                             | `KEEP_MS` in `governor.ts`            |
| Readings fetched and kept             | 48 hours, 72 hours                  | `FETCH_WINDOW_MS`, `READINGS_KEEP_MS` |
| Fetch interval, first retry           | 30 minutes, 1 minute                | `src/diagnostics.ts`                  |

Rows without a file are in `src/estimate.ts`.

## What real hardware has shown

Measured on real boxes:

- Hostinger's readings against the guest's own count on two KVM 8 boxes over 10 days: 1.0463 × guest
  cores + 0.0193. On one live box: 1.0075 × guest cores + 0.106. Both sit inside the guard.
- Readings rising by about half a core per stolen core, on one box.
- 19 false credit limits in 13 days on a live box running v0.3.1 in `apply`. v0.3.2's detection
  gates were written to stop them, and v1.0.0 keeps those gates.
- Two more on that box on 2026-11-23, while it was 93 to 97% idle with a full bank. An hourly
  one-core burst woke its vCPUs with a moment of steal, and the probe passed on noise: 22 probes in
  two and a half days measured 1 to 26% steal with the slice cut and 1 to 25% restored, with no
  pattern, and three passed. Each time v0.3.1 held every login at 0.2 cores for 23 minutes. The
  box's slice demand sat at 0.28 to 0.41 cores, so v0.3.2's 0.4-core gate would have cleared it by
  2%. [Study results](study-results.md#a-real-boxs-false-limits-replayed) has the replay.
- The newest reading compared with its later values for seven days, under v0.3: none was revised.

Never observed on a governed box:

- a real credit limit;
- a drift or jump in Hostinger's meter;
- a sustained-use limit;
- whether Hostinger bills stolen CPU;
- any plan below KVM 8.

So the design assumes Hostinger bills what its readings show plus a small constant, and that a
settled reading is final. If real billing runs above the readings, or Hostinger revises a settled
reading upward, the box takes a limit, the pad learns the difference, and that costs throttled time.
v0.3 had the same exposure in `apply`. Everything else on this page and in
[study results](study-results.md) comes from simulation.
