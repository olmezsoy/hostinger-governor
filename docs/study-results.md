# Study results

Every result on this page comes from simulation. None is a live Hostinger measurement.
[The credit estimate](estimate.md#what-real-hardware-has-shown) lists what real boxes have shown.

The simulations drive the real `Governor` class from `src/governor.ts`. Only its I/O is faked: the
clock, the kernel counters, the cap helper and Hostinger's API.

## Studies

`test/studies.ts` runs 23 studies. Each is eight simulated weeks on KVM 8 from 2026-10-12, with one
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

[study-results.json](study-results.json) records seed 13. All 23 studies pass what `assessStudy()`
in `test/studies.ts` asks of them. The bank holds 34,560 core-seconds and the spending floor is
3,456.

| Study | Condition                                              | Credit limits | Lowest real bank | Final addition | CPU core-hours |
| ----- | ------------------------------------------------------ | ------------: | ---------------: | -------------: | -------------: |
| S1    | Billing equals the meter                               |             0 |            3,263 |          0.155 |        5,217.7 |
| S2    | 0.03 cores billed that readings do not show            |             0 |            2,265 |          0.155 |        5,217.7 |
| S3    | 0.10 cores billed that readings do not show            |             1 |                0 |          0.274 |        5,139.8 |
| S4    | Meter slope rises from 1.0463 to 1.07 on day 28        |             0 |            1,929 |          0.270 |        5,179.1 |
| S5    | Sustained-use limit from day 7                         |             0 |            3,282 |          0.155 |        5,201.3 |
| S6    | Neighbours steal 70% for six minutes on day 7          |             0 |            3,295 |          0.155 |        5,211.1 |
| S7    | No readings on days 14 and 15                          |             0 |            3,270 |          0.155 |        5,211.6 |
| S8    | Reboot on day 7, 15 minutes down                       |             0 |            3,238 |          0.155 |        5,217.4 |
| S9    | A 62-minute reading interval every 31 readings         |             0 |            2,918 |          0.117 |        5,211.0 |
| S10   | Clock an hour ahead for an hour on day 7               |             0 |            3,289 |          0.155 |        5,217.4 |
| S11   | Unreadable `persist.json` at a restart on day 7        |             0 |            3,293 |          0.155 |        5,217.0 |
| S13   | Readings 50% noisier                                   |             0 |            3,584 |          0.236 |        5,206.5 |
| S15   | Neighbours steal up to a core, billed at half of it    |             0 |            3,765 |          0.233 |        5,190.1 |
| S16   | 2% steal all the time, with S4's slope change          |             0 |            2,607 |          0.191 |        5,108.4 |
| S17   | Meter adds 0.5 cores from day 7, readings and billing  |             0 |            2,091 |          0.666 |        4,919.0 |
| S18   | Readings at 8 times the meter from day 7               |             0 |            3,306 |          1.865 |        4,494.2 |
| S19   | No Hostinger API configured                            |             0 |            3,129 |          0.040 |        5,212.0 |
| S20   | Readings at half the meter from day 7                  |             0 |            3,306 |          0.107 |        5,172.4 |
| S21   | No readings for 2.4 hours on day 8, every core wanted  |             0 |            3,306 |          0.190 |        5,977.3 |
| S22   | Clock three hours ahead for 30 hours from day 7        |             0 |            3,216 |          0.155 |        5,216.0 |
| S23   | S3's 0.10 cores, and neighbours who steal under limits |             1 |                0 |          0.234 |        5,052.5 |
| S24   | Clock three hours behind for 12 hours on day 7         |             0 |            3,289 |          0.155 |        5,207.7 |
| S25   | Clock 90 minutes ahead for 12 hours, every core wanted |             0 |            3,306 |          0.172 |        5,977.4 |

"Final addition" is the cores the own count adds to 1.05 × busy cores at the end of the run. It
starts at 0.04.

What the rows show:

- S1 delivers 0.11% more CPU than S19, the same run on the guest's own count alone.
- S2's hidden 0.03 cores cost no limit. The bank's low point is 2,265 where S1's is 3,263.
- S3 takes one limit on day 2.8, for 54 minutes. It raises the pad from 0.02 to 0.139 cores, and the
  remaining 53 days take no limit.
- S4, S13, S15, S16 and S17 show the addition following the readings. In S17 the box pays for the
  extra half core with 5.7% less CPU than S1.
- S5 and S6 each make the governor enter one limit that was not a credit limit. Neither raises the
  pad.
- S8's reboot found a full bank. The estimate came back at 31,114 core-seconds.
- S11's file is set aside and the estimate starts over from zero. The 141,120 passes after it take
  no limit.
- S16 delivers 1.37% less CPU than S4. The neighbours take 2% either way, and the study allows 2.5%.
- S18 delivers 13.9% less CPU than S1. A reading counts for at most 1.3 × the guest's own count +
  0.3 cores, and the study allows 20%.
- S20's readings say less than the guest counted itself, so the own count stands in for them. It
  takes no limit and delivers 0.76% less CPU than S19. The addition learned before day 7 stays,
  since no usable reading replaces it.
- S21 loses its readings for 2.4 hours while every core is wanted. Samples are kept three hours, so
  the hole is longer than they can stand in for, and it counts at the most the VM could have spent.
  It takes no limit.
- S22, S24 and S25 run with a wrong clock: three hours ahead, three hours behind, and 90 minutes
  ahead with every core wanted. The estimate carries on from the own count and none takes a limit.
- S23 is S3 with neighbours who take 3% of the VM and keep taking it while Hostinger limits it. The
  governor's recovery ceiling cuts what the VM delivers during the limit, and the limit still counts
  as a credit limit, because only the sample that showed it is judged. It takes one limit on day
  2.9, for 32 minutes, and the pad ends at 0.108 cores.

Outside a limit, the estimate at seed 13 ran above the real bank by 2,547 core-seconds at most in
every study but the two with 0.10 hidden cores, where it reached 4,878 (S3) and 5,067 (S23). The
floor holds back 3,456. Other seeds come closer, as the next section shows.

### Twelve seeds

Seeds 1 to 12 make 276 runs of 56 simulated days, and 275 pass their criteria. They took 26 credit
limits:

- 12 in S3 and 12 in S23, one per run, each the limit that teaches the 0.10-core gap. The pad ended
  between 0.101 and 0.133 cores.
- 2 in S17, where the meter jumps half a core: one each in seeds 7 and 12.

The other 20 studies took no limit in any seed.

The run that fails is S5 at seed 12. The governor starts no limit while the sustained-use cap sits
above the plan's limit. When the cap has fallen to 2 cores it looks like a credit limit, and in that
run the estimate stood at 9% as it began, so the governor took the difference for a billing gap and
raised the pad to 0.25 cores. That costs 2.7% of the run's CPU until
`sudo governor calibrate --reset`. The other 11 seeds learn nothing from it.

The floor is not wide in every seed. The most the estimate ran above the real bank, outside a limit,
over the 12 seeds:

| Study                        | Most above the bank | Seeds past the 3,456 floor |
| ---------------------------- | ------------------: | -------------------------: |
| S17, meter jumps half a core |               5,539 |                          5 |
| S2, 0.03 hidden cores        |               3,452 |                          0 |
| S4, meter slope rises        |               3,213 |                          0 |
| The 18 others without a gap  |               2,769 |                          0 |

S17 passes the floor in five seeds and takes a limit in two of them. S2 comes within 4 core-seconds
of it.

### Floor choice

The floor was chosen on the first 17 studies, before S20 to S25 existed and before the fixes that
followed the two pre-release reviews. It has not been rerun since. Their 204 runs with three
spending floors:

| Floor | Credit limits |
| ----: | ------------: |
|    5% |            52 |
|  7.5% |            20 |
|   10% |            15 |

CPU delivered differed by 0.17% between the 5% and 10% floors. v1.0.0 uses 10%. Rerunning this means
changing `LAW.floor` in `src/credits.ts`.

### Against the previous design

14 of the studies existed before v1.0.0. At seed 13 they take 1 credit limit, against 2 on the
previous design, and CPU delivered is within 0.01%.

## Week-long scenarios

`test/sim.ts` has 15 one-week scenarios with a second-by-second host model: hidden billing overhead,
noisy neighbours, per-vCPU limits, a stop, work outside the slice, and a real baseline of 30% where
the governor assumes the published 60%. The top of that file lists the model's assumptions. In these
scenarios Hostinger's readings report exactly what it bills, so an overhead shows in the readings.
S2 and S3 above cover billing the readings do not show.

Totals over the 15 scenarios at seed 1, against the unreleased v0.3.3 code in `apply` and `off`:

|                      |  v1.0.0 | v0.3.3 `apply` | v0.3.3 `off` |
| -------------------- | ------: | -------------: | -----------: |
| Throttles            |      27 |             43 |           46 |
| Throttled hours      |    80.3 |          248.7 |        241.1 |
| Core-hours delivered | 9,798.7 |        9,147.9 |      9,129.2 |

v1.0.0 delivers 7.1% more than `apply`, but one scenario carries most of that. With a hidden
overhead and a per-vCPU limit, `apply` stayed throttled for 141.8 hours of its week and delivered
132.8 core-hours where v1.0.0 delivers 660.4. Without that scenario v1.0.0 delivers 1.4% more, and
throttled hours go from 106.9 to 80.3.

All 27 throttles are in the three scenarios where Hostinger's real baseline is 30%. There the rules
the governor replays are wrong, and only limits can show it.

Seeds 2 to 5 add 60 runs. None has a throttle outside those three scenarios, and one has a false
limit.

## Detection scenarios

`deno task sim --detection` runs 25 scenarios for limit detection: an idle box at six levels of
neighbour steal, limits already on at the start, work outside an idle slice pressing on the cap,
back-to-back limits, and steady work near the cap with no limit at all.

|              | v1.0.0 | v0.3.3 `apply` | v0.3.3 `off` |
| ------------ | -----: | -------------: | -----------: |
| Throttles    |     46 |             58 |           48 |
| False limits |      0 |              2 |            2 |
| Probes       |    158 |            173 |          163 |

Both false limits of the earlier design came from a probe that passed on a host with noisy
neighbours. The burners now decide those.

## A limit that begins during a probe cooldown

After a failed probe the governor waits 10 to 60 minutes before the next. A limit that begins in
that wait must still be recognised. v1.0.0 was compared with v0.3.2 on 2,376 such cases over KVM 1,
2, 4 and 8 with two steal models. No case goes unrecognised that v0.3.2 recognises. Of the 2,280
cases both versions could be measured on, 1,990 are within a minute of v0.3.2, 122 are faster and
168 slower. The burner test that now follows a probe takes 35 seconds, and that is the median
difference. 100 of the slower cases are within two minutes.

- Timing, 288 cases: 276 within a minute of v0.3.2, 12 slower.
- No cooldown, 96 cases: 90 within a minute, 6 slower.
- Stale, 768 cases: 657 within a minute, 79 faster, 32 slower.
- Wide, 1,008 cases: 761 within a minute, 43 faster, 108 slower, 96 not comparable. Many of the
  slower ones start with the estimate under the floor, which is now twice as high, so the estimate
  has twice as far to climb before the ceiling opens. The slowest case is a KVM 1, 2,005 seconds
  against 250.
- Shape, 216 cases: 206 within a minute, 10 slower. 30 cases are not recognised within 90 minutes by
  either version.

These runs have no readings feed, so they exercise the guest's own count. No task in `deno.json`
reruns this comparison.

## What still costs a limit

These conditions were pushed until something broke, at eight seeds each:

| Condition                                                               | Runs | Credit limits |
| ----------------------------------------------------------------------- | ---: | ------------: |
| No readings for 1.5 to 6 hours, every core wanted                       |   48 |             0 |
| No readings for 2 to 5 hours, normal workload                           |   24 |             0 |
| Readings at 50% or 80% of the meter                                     |   16 |             0 |
| Readings at 95% of the meter                                            |    8 |             8 |
| Clock 45 to 180 minutes ahead or behind for 12 hours, two workloads     |   80 |             0 |
| 0.10 hidden cores with 2% or 3% steal, with and without it under limits |   16 |            16 |

Readings at 95% of the meter stay above the guest's own count at low load, so they pass for bills.
That is billing the readings do not show: each run takes one limit, and the pad ends between 0.098
and 0.205 cores.

With a wrong clock the estimate ran at most 5.4% of capacity above the bank. The last row is S23's
condition: one limit per run, the one that teaches the gap.

Without a readings feed, a week of billing at 1.12 × the guest's CPU + 0.15 cores takes 3 or 4
limits over five seeds while the pad learns it, where v0.3.3 `off` took 2. With a feed the readings
show that overhead and the week takes none.

## A real box's false limits, replayed

This section is the one on this page that rests on real measurements. On 2026-11-23 a KVM 8 box on
v0.3.1 took two false credit limits, at 07:01 and 08:31 UTC. It was 93 to 97% idle, Hostinger's
readings showed 3.5 to 5.2% of its vCPUs in use, and the bank was full. Each limit held every login
at 0.2 cores for 23 minutes. The cause: an hourly burst of about one core woke the vCPUs with 0.3
cores of steal for one pass, which is 11 to 12% of the little demand in the five-minute window. The
probe then measured 3% and 7% of demand stolen, cut and restored, and later 7% and 13%, and passed
both times.

The box's own per-pass samples and the probe measurements its journal logged were replayed through
each release's `Governor`. The burners are taken to get their CPU, which is what the box's own lift
tests found 24 minutes later. Eight variants cover what is not known: the eight passes before the
first event that the box no longer held, on either side of v0.3.2's gate; what a probe one pass
later would have measured; and a burst 5% larger.

| Release                           | Variants with a limit | Limits | Held at 20% for |
| --------------------------------- | --------------------: | -----: | --------------: |
| v0.3.1                            |                8 of 8 |      2 |      47 minutes |
| v0.3.2                            |                7 of 8 | 0 to 2 | 0 to 47 minutes |
| v1.0.0 before the burners decided |                7 of 8 | 0 to 2 | 0 to 47 minutes |
| v1.0.0                            |                0 of 8 |      0 |               0 |

v0.3.2's gate, at least 0.4 cores of slice demand before a probe, clears this box by 2%: its window
sat at 0.28 to 0.41 cores. In v1.0.0 a probe that passes is followed by the burners, and only a VM
they find held at the plan's limit starts a limit. The estimate stays full in every variant.

The harness and the box's data are not in the repository, so no task reruns this.
`test/governor_test.ts` holds the same case as a unit test.

## Upgrading from v0.3.2

A reviewer's harness runs v0.3.2 for one to three days, stops it, and starts v1.0.0 on the
`persist.json` it left. 14 such upgrades were run on KVM 2, 4 and 8: with and without a readings
feed, in `apply` and `off`, after a limit that work had pressed on, with a learned billing gap, in a
probe cooldown, and during a limit.

- In the 9 upgrades outside a limit, v1.0.0 took no limit afterwards. Its estimate stood between
  4.2% of capacity under the real bank and 3.3% over. The exception is a host that bills more than
  its readings show: 12.4% over, where a v0.3.2 restart read 10.6% over. Neither took a limit.
- Of the 5 upgrades during a limit, 1 took no limit afterwards. The other 4 are on hosts that bill
  more than their readings show, and each took 1 more limit, where a v0.3.2 restart took none. The
  limit in force is carried with its ceiling and its lift-test clock, but what it would have taught
  is not.

No task in `deno.json` reruns this.

## Size and speed

`src/` went from 10,104 lines to 4,149, and the TypeScript under `test/` from 16,965 to 6,857. The
23 studies run in under two minutes in sequence. Each took a minute or more before.

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
