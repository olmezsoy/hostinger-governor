# Study results

Every result on this page comes from simulation. None is a live Hostinger measurement.
[The credit estimate](estimate.md#what-real-hardware-has-shown) lists what real boxes have shown.

The simulations drive the real `Governor` class from `src/governor.ts`. Only its I/O is faked: the
clock, the kernel counters, the cap helper and Hostinger's API.

## Studies

`test/studies.ts` runs 20 studies. Each is eight simulated weeks on KVM 8 from 2026-10-12, with one
condition changed. S12 and S14 studied calibration modes that v1.0.0 no longer has, so the numbering
skips them.

The workload doubles a seeded CI job stream, 6 to 8 requested cores. Weekdays from 06:00 to 22:00
UTC run jobs of 0.5 to 6 hours with lulls of 5 to 30 minutes. Nights and weekends run shorter jobs
with lulls of 30 to 120 minutes. Every study starts with 8 idle hours, which fill the bank. No
production traces were available, so this is a synthetic stand-in.

Hostinger's meter is modelled on the relation two real KVM 8 boxes showed: 1.0463 × guest cores +
0.0193, with interval noise of 0.0214 + 0.0119 per busy core and a day-level wobble of 0.01 cores.
Readings average the meter since the previous one, 1,500 to 2,100 seconds apart, and about one
interval in 240 stretches to 2,701 to 3,750 seconds. They arrive through a 48-hour API window. The
credit limiter caps the VM at 30% of its vCPUs at an empty bank, stops earning while work presses,
and lifts at 20%.

[study-results.json](study-results.json) records seed 13. All 20 studies pass what `assessStudy()`
in `test/studies.ts` asks of them. The bank holds 34,560 core-seconds and the spending floor is
3,456.

| Study | Condition                                             | Credit limits | Lowest real bank | Final addition | CPU core-hours |
| ----- | ----------------------------------------------------- | ------------: | ---------------: | -------------: | -------------: |
| S1    | Billing equals the meter                              |             0 |            3,261 |          0.155 |        5,217.5 |
| S2    | 0.03 cores billed that readings do not show           |             0 |            2,266 |          0.155 |        5,217.5 |
| S3    | 0.10 cores billed that readings do not show           |             1 |                0 |          0.273 |        5,140.0 |
| S4    | Meter slope rises from 1.0463 to 1.07 on day 28       |             0 |            1,929 |          0.270 |        5,178.9 |
| S5    | Sustained-use limit from day 7                        |             0 |            3,286 |          0.155 |        5,212.0 |
| S6    | Neighbours steal 70% for six minutes on day 7         |             0 |            3,296 |          0.155 |        5,211.6 |
| S7    | No readings on days 14 and 15                         |             0 |            3,269 |          0.155 |        5,211.6 |
| S8    | Reboot on day 7, 15 minutes down                      |             0 |            3,238 |          0.155 |        5,217.2 |
| S9    | A 62-minute reading interval every 31 readings        |             0 |            2,917 |          0.117 |        5,210.8 |
| S10   | Clock an hour ahead for an hour on day 7              |             0 |            3,261 |          0.155 |        5,217.5 |
| S11   | Unreadable `persist.json` at a restart on day 7       |             0 |            3,292 |          0.155 |        5,217.3 |
| S13   | Readings 50% noisier                                  |             0 |            3,584 |          0.236 |        5,206.3 |
| S15   | Neighbours steal up to a core, billed at half of it   |             0 |            3,765 |          0.233 |        5,189.8 |
| S16   | 2% steal all the time, with S4's slope change         |             0 |            2,607 |          0.191 |        5,108.2 |
| S17   | Meter adds 0.5 cores from day 7, readings and billing |             0 |            2,091 |          0.666 |        4,918.8 |
| S18   | Readings at 8 times the meter from day 7              |             0 |            3,306 |          1.865 |        4,494.1 |
| S19   | No Hostinger API configured                           |             0 |            3,129 |          0.040 |        5,211.7 |
| S20   | Readings at half the meter from day 7                 |             0 |            3,306 |          0.107 |        5,172.2 |
| S21   | No readings for 2.4 hours on day 8, every core wanted |             0 |            3,306 |          0.190 |        5,976.3 |
| S22   | Clock three hours ahead for 30 hours from day 7       |             0 |            3,261 |          0.155 |        5,216.1 |

"Final addition" is the cores the own count adds to 1.05 × busy cores at the end of the run. It
starts at 0.04.

What the rows show:

- S1 delivers 0.11% more CPU than S19, the same run on the guest's own count alone.
- S2's hidden 0.03 cores cost no limit. The bank's low point is 2,266 where S1's is 3,261.
- S3 takes one limit on day 2.8, for 54 minutes. It raises the pad from 0.02 to 0.139 cores, and the
  remaining 53 days take no limit.
- S4, S13, S15, S16 and S17 show the addition following the readings. In S17 the box pays for the
  extra half core with 5.7% less CPU than S1.
- S5 and S6 each make the governor enter one limit that was not a credit limit. Neither raises the
  pad.
- S8's reboot found a full bank. The estimate came back at 31,114 core-seconds.
- S11's file is set aside and the estimate starts over from the readings. The 141,120 passes after
  it take no limit.
- S16 delivers 1.37% less CPU than S4. The neighbours take 2% either way, and the study allows 2.5%.
- S18 delivers 13.9% less CPU than S1. A reading counts for at most 1.3 × the guest's own count +
  0.3 cores, and the study allows 20%.
- S20's readings say less than the guest counted itself, so the own count stands in for them. It
  takes no limit and delivers 0.76% less CPU than S19. The addition learned before day 7 stays,
  since no usable reading replaces it.
- S21 loses its readings for 2.4 hours while every core is wanted. Samples are kept three hours, so
  the hole is longer than they can stand in for, and it counts at the most the VM could have spent.
  It takes no limit.
- S22's clock runs three hours ahead for 30 hours. The estimate carries on from the own count and
  takes no limit.

Outside a limit, the estimate ran above the real bank by 2,547 core-seconds at most in every study
but S3, where it reached 4,878. The floor holds back 3,456.

### Twelve seeds

Seeds 1 to 12 make 240 runs of 56 simulated days. They took 14 credit limits in total. 12 are in S3,
one per run, each the limit that teaches the 0.10-core gap. 2 are in S17, where the meter jumps half
a core: one each in seeds 7 and 12. In S3 the pad ended between 0.097 and 0.131 cores; seed 10's
0.097 is under the 0.10 its criterion asks for, and that run took no second limit. So 239 of the 240
runs pass. The other 18 studies took no limit in any seed.

### Floor choice

The floor was chosen on the first 17 studies, before S20 to S22 existed and before the fixes that
followed the pre-release review. Their 204 runs with three spending floors:

| Floor | Credit limits |
| ----: | ------------: |
|    5% |            52 |
|  7.5% |            20 |
|   10% |            15 |

CPU delivered differed by 0.17% between the 5% and 10% floors. v1.0.0 uses 10%. Rerunning this means
changing `LAW.floor` in `src/credits.ts`.

### Against the previous design

14 of the studies existed before v1.0.0. At seed 13 they take 1 credit limit, against 2 on the
previous design, and CPU delivered is within 0.02%.

## Week-long scenarios

`test/sim.ts` has 15 one-week scenarios with a second-by-second host model: hidden billing overhead,
noisy neighbours, per-vCPU limits, a stop, work outside the slice, and a real baseline of 30% where
the governor assumes the published 60%. The top of that file lists the model's assumptions. In these
scenarios Hostinger's readings report exactly what it bills, so an overhead shows in the readings.
S2 and S3 above cover billing the readings do not show.

Totals over the 15 scenarios at seed 1, against the unreleased v0.3.3 code in `apply` and `off`:

|                      |  v1.0.0 | v0.3.3 `apply` | v0.3.3 `off` |
| -------------------- | ------: | -------------: | -----------: |
| Throttles            |      32 |             43 |           46 |
| Throttled hours      |    92.0 |          248.7 |        241.1 |
| Core-hours delivered | 9,793.9 |        9,147.9 |      9,129.2 |

v1.0.0 delivers 7.1% more than `apply`. All 32 throttles are in the three scenarios where
Hostinger's real baseline is 30%. There the rules the governor replays are wrong, and only limits
can show it.

Seeds 2 to 5 add 60 runs. None has a throttle outside those three scenarios, and one has a false
limit.

## Detection scenarios

`deno task sim --detection` runs 25 scenarios for limit detection: an idle box at six levels of
neighbour steal, limits already on at the start, work outside an idle slice pressing on the cap,
back-to-back limits, and steady work near the cap with no limit at all.

|              | v1.0.0 | v0.3.3 `apply` | v0.3.3 `off` |
| ------------ | -----: | -------------: | -----------: |
| Throttles    |     45 |             58 |           48 |
| False limits |      2 |              2 |            2 |
| Probes       |    156 |            173 |          163 |

## A limit that begins during a probe cooldown

After a failed probe the governor waits 10 to 60 minutes before the next. A limit that begins in
that wait must still be recognised. v1.0.0 was compared with v0.3.2 on 2,376 such cases over KVM 1,
2, 4 and 8 with two steal models. No case goes unrecognised that v0.3.2 recognises. Of the 2,280
cases both versions could be measured on, 2,071 are within a minute of v0.3.2, 125 are faster and 84
slower.

- Timing, 288 cases: all within a minute of v0.3.2.
- No cooldown, 96 cases: all within a minute.
- Stale, 768 cases: 677 within a minute, 79 faster, 12 slower.
- Wide, 1,008 cases: 798 within a minute, 46 faster, 68 slower, 96 not comparable. 58 of the slower
  ones start with the estimate 30% under the floor. The floor is now twice as high, so the estimate
  has twice as far to climb before the ceiling opens. The slowest case is a KVM 1, 1,970 seconds
  against 250.
- Shape, 216 cases: 212 within a minute, 4 slower. 30 cases are not recognised within 90 minutes by
  either version.

These runs have no readings feed, so they exercise the guest's own count. No task in `deno.json`
reruns this comparison.

## What still costs a limit

Three conditions were pushed until something broke, at five seeds each:

| Condition                                                      | Runs | Credit limits |
| -------------------------------------------------------------- | ---: | ------------: |
| No readings for 1.5 to 6 hours, every core wanted              |   45 |             0 |
| No readings for 2 to 5 hours, normal workload                  |   20 |             0 |
| Readings at 50% or 80% of the meter                            |   10 |             0 |
| Readings at 95% of the meter                                   |    5 |             5 |
| Clock 1, 1.5 or 3 hours ahead, or 3 hours behind, for 30 hours |   20 |             0 |

Readings at 95% of the meter stay above the guest's own count at low load, so they pass for bills.
That is billing the readings do not show: each run takes one limit, and the pad ends at 0.19 cores.

Without a readings feed, a week of billing at 1.12 × the guest's CPU + 0.15 cores takes 5 limits
while the pad learns it, where v0.3.3 `off` took 2. With a feed the readings show that overhead and
the week takes none.

## Size and speed

`src/` went from 10,104 lines to 4,093, and the TypeScript under `test/` from 16,965 to 6,250. The
20 studies run in about a minute and a half in sequence. Each took a minute or more before.

## Rerun

Use the Deno version in `.tool-versions`.

```sh
deno task sim --studies          # every study, seed 13
deno task sim --studies S3       # one study
deno task sim --studies S3 5     # one study, seed 5
deno task sim:check              # fail if a recorded outcome or limit count changes
deno task sim:record             # rewrite docs/study-results.json
deno task sim                    # the week-long scenarios, seed 1
deno task sim "baseline 30%" 5 --episodes
deno task sim --detection        # the detection scenarios
```

The v0.3.3 columns come from `main` at `a6eebf2`, the last commit before v1.0.0.
