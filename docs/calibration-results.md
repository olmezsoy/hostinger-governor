# Calibration study results

These are fixed-seed simulator results, not live Hostinger measurements. Reproduce them with
`deno task sim:record`, which rewrites [calibration-results.json](calibration-results.json) with
every measurement, episode, decision and comparison. `deno task sim:check` reruns the studies and
fails if any outcome or limit count changes; CI runs it for each study.

## Model

The eight-week studies drive the real `Governor` class in `apply` mode from 2026-10-12, seed 13. The
workload doubles a seeded CI job stream, as the issue asks: 6 to 8 requested cores. Weekdays from
06:00 to 22:00 UTC run 0.5 to 6 hour jobs separated by 5 to 30 minute lulls; nights and weekends run
10 to 60 minute jobs separated by 30 to 120 minute lulls, so the bank refills on most nights. The
owner's box A traces are not in this repository, so this is a synthetic stand-in.

Hostinger's meter is box A's relation, 1.0463 times guest CPU plus 0.0193 cores, with interval noise
of 0.0214 + 0.0119u cores and a day-level wobble of 0.01 cores. Readings average the meter since the
previous reading, 1,500 to 2,100 seconds apart, and arrive through a 48-hour API window; the
governor drops the newest as it does in production. About one interval in 240 stretches to 2,701 to
3,750 seconds, since box A showed one interval over 2,700 seconds in ten days; S9 adds a 62-minute
interval every 31 readings. Kernel uptime runs a few milliseconds off the wall clock, so slots can
hold slightly more than 600 seconds, as on a real box. A hidden billing gap is charged on top of the
meter and never appears in readings. The credit limiter caps the VM at 30% of vCPUs at an empty
bank, stops earning while pressing, and lifts at 20%. In S5, once demand has reached 4.3 cores for
four hours in total from day 7, the sustained-use limiter caps the VM at 75% of vCPUs, cuts a
further 25% an hour down to 25%, and lifts three hours after demand, averaged over ten minutes,
falls below 4.3 cores.

## Studies

| Study | Scenario                          | Result | Credit limits | Learned gap | Evidence                                                                                                                                                                                                                                      |
| ----- | --------------------------------- | ------ | ------------: | ----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | gap 0                             | pass   |             0 |           0 | CPU 0.11% below static 1.05× + 0.04 at 5%, inside the 0.3% budget.                                                                                                                                                                            |
| S2    | gap 0.03                          | pass   |             1 |     0.04115 | One limit on day 3.0 teaches 0.041; the floor rises to 5.5%. The lift check predicts its recovery within 1%.                                                                                                                                  |
| S3    | gap 0.10                          | pass   |             1 |     0.11731 | One limit on day 0.6 teaches 0.117. Recovery took 0.90 times the lift check's prediction.                                                                                                                                                     |
| S4    | slope 1.046 to 1.07 at week 4     | pass   |             0 |           0 | The clamp acts 11.5 hours after the change and CUSUM alarms at 12.0; the hold is verified on day 29.6 and refits end at 1.075× + 0.065.                                                                                                       |
| S5    | sustained-use limit               | pass   |             0 |           0 | Classified sustained-use in apply and off; nothing learned, no off-mode widening.                                                                                                                                                             |
| S6    | neighbour steal                   | pass   |             0 |           0 | The first lift test passes; classified unknown, nothing learned.                                                                                                                                                                              |
| S7    | 48-hour API outage                | pass   |             0 |           0 | The stale fallback starts on day 15.0 and ends when readings resume on day 16.0.                                                                                                                                                              |
| S8    | reboot                            | pass   |             0 |           0 | History and calibration survive 15 minutes of downtime, checked at the first pass after it; the estimate restarts at 0 and the clamp from an empty bank, available on 99.4% of passes.                                                        |
| S9    | irregular spacing, 62-minute gaps | pass   |             0 |           0 | A fit qualifies across 97 intervals over 2,700 seconds, within 0.0011 of the slope and 0.0024 cores of the offset that the same seed fits with regular spacing; CPU is 0.09% lower. The clamp bridges the gaps, available on 99.5% of passes. |
| S10   | clock jump of an hour             | pass   |             0 |           0 | Seven slots are marked invalid and no pair uses the jump. The clamp bridges them, available on 99.5% of passes.                                                                                                                               |
| S11   | corrupted `history.json`          | pass   |             0 |           0 | The file is quarantined and rebuilt; passes continue. The clamp is unavailable after the rebuild.                                                                                                                                             |
| S12   | shadow against off                | pass   |             1 |     0.00658 | Identical ceilings through the same credit limit; 24 would-be changes logged.                                                                                                                                                                 |
| S13   | readings 50% noisier              | pass   |             0 |           0 | No limit. The fit's noise at 3 cores is 1.49 times the regular run's, and the premium raises the addition from 0.046 to 0.063, at 0.27% of CPU.                                                                                               |
| S14   | clamp on against clamp off        | pass   |             0 |           0 | No limit either way: the drift hold covers the change at the alarm. CPU with the clamp is within 0.01% of CPU without it.                                                                                                                     |

Some passes are weaker evidence than their status suggests:

- S1 must stay within 0.3% of static CPU. It uses 0.11% less: the simulated meter is box A's, so the
  fit asks for 1.052× + 0.046, close to the 1.05× + 0.04 start.
- S14 no longer shows the clamp preventing a limit. With the clamp off, the drift used to empty the
  bank 13.2 hours after the change, after the CUSUM alarm at 12.0 hours. The alarm now opens a hold
  that covers the change as a steeper slope and as an offset at once, which is enough on this seed.
  The clamp still acts first, at 11.5 hours; while the open estimate charges more than Hostinger's
  meter, it is lower than the readings replay, so the clamp binds only once the meter drifts above
  the margin.
- S11 passes its own criteria, but the clamp is available on only 12% of passes: a rebuilt history
  has no anchor to replay from. On this workload the bank's lower bound certifies full only on day
  0, before the first job, and later anchors come only from a credit limit's lift. Without the
  clamp, the governor acts on the open estimate, as v0.2.5 did. S10's clock jump no longer stops the
  clamp: it bridges the clock-invalid hour with the guest's own count.
- S11 raises a CUSUM alarm on day 21.7 that verification withdraws on day 22.8. While it is pending,
  its hold costs 2.8 core-hours, 0.05% of the CPU. After the history rebuild, drift detection judges
  residuals against the four-day fit from day 10.1 until a refit changes the margin, which none
  does.
- S12 compares ceilings in shadow and off with the S4 drift. Its single limit, on day 46.6, comes
  from the drift that off mode cannot see; shadow logs the tightening it would have made, including
  each refit in the 14 days after the change.

## Meter jumps

A real jump in Hostinger's meter raises readings and billing together. `deno task sim:jumps` adds
one from day 7 and runs each size over seeds 1 to 10 for 21 days, next to the same seed without it,
where no seed has a limit. It checks the criteria set for v0.3.0, and all pass. "Allowed" is the
guest CPU the final margin allows at the floor, against what box A's relation plus the jump and the
0.0348-core premium would allow.

| Jump       | Limits per seed | Over 10 seeds | Criterion | Allowed / correct | What handles it                                         |
| ---------- | --------------: | ------------: | --------: | ----------------- | ------------------------------------------------------- |
| 0.25 cores |               0 |             0 |       ≤ 1 | −0.6% to +0.4%    | CUSUM in every seed                                     |
| 0.5 cores  |           0 – 1 |             6 |       ≤ 1 | −0.6% to +0.6%    | CUSUM in 6 seeds, corroboration at the first limit in 4 |
| 0.75 cores |           1 – 2 |            17 |       ≤ 3 | −0.8% to +0.6%    | Corroboration in every seed                             |
| 1 core     |           1 – 2 |            18 |       ≤ 4 | −1.0% to +0.4%    | Corroboration in every seed                             |

- **No inflation.** Every final multiplier equals the same seed's without the jump, and the addition
  carries the jump and the premium. The study checks each final multiplier against two bounds. #13's
  is the largest of the last post-change fit's slope bound, rounded up to 0.001, box A's 1.051 and
  the multiplier learned before the jump; every seed meets it with at most 0.001 to spare. That fit
  sets the multiplier itself, so the study also holds it to the larger of the same seed's multiplier
  without the jump and the one learned before the jump, which every seed meets exactly. Before
  refits after a change reset to the margin from before it, an early refit's wider slope bound
  stayed, up to 0.005 above the seed without the jump.
- **The floor.** A corroborating limit learns nothing itself, so the floor stays at 5% in every
  corroborated run. Replaying its own estimate at the old margin had pinned the floor at 10% after
  every jump of 0.75 cores or more and in half the 0.5-core seeds. Two 0.5-core limits fall inside a
  CUSUM drift change and raise the floor, which a drift change keeps: seed 5's to 10% and seed 3's
  to 7.1%. Seed 3 had no limit before the fit's idle noise got its floor; at near-idle load its jump
  now stays under 6 σ, so CUSUM, not the extreme test, sees it first.
- **How long the drift hold lasts.** After a CUSUM alarm, verification takes 24 to 48 hours and the
  verified hold 11 to 23 more, until a fit on the readings after the change qualifies. A
  corroborated change holds 33 to 39 hours. The fit's slope bound resamples at least two days that
  are whole or hold a third of its pairs. Resampling a single whole day, which the first fit after a
  change could do before, made the bound equal the slope, since one day shows no day-to-day spread.
  The largest bound after a change is now 1.045. Requiring three such days instead lengthened every
  hold by about 12 hours, cost up to 0.13% of the CPU and added a limit in one legacy scenario. A
  fit of the offset alone, with the slope fixed, would not help: a corroborated hold already is the
  old slope with a raised offset, and after an alarm most of the time is the 48-reading
  verification, which no fit replaces. The 11 to 23 verified hours do cover a steeper slope as well,
  up to 6% of the CPU at saturation at 0.25 cores, but without it a real change in slope, as in S4,
  would go uncovered until the refit.
- **A broken feed.** Readings at 8x the meter from day 7 fire `readings-invalid` in every seed,
  tighten no learned setting from day 7 on, cost no limit, and hold 1.05× + 0.08 from day 8 to the
  end.

During a three-day API outage from day 7 no readings arrive to corroborate the jump, and the
own-count hold carries it. When readings return beyond 6 σ, they count again once their mean
residual agrees with the rise the hold's limits measured, and the hold ends. These runs are
reported, not judged against the criteria:

| Jump       | Limits per seed | Over 10 seeds | Own-count hold          | Rules mismatch latched |
| ---------- | --------------: | ------------: | ----------------------- | ---------------------: |
| 0.75 cores |           2 – 3 |            21 | 54 to 58 hours, 9 seeds |                      1 |
| 1 core     |           2 – 5 |            33 | 55 to 58 hours, 4 seeds |                      6 |

- Before a hold waited for readings it could judge, the first returning reading ended it, and the
  box paid the limits that then corroborated the readings: 32 at 0.75 cores and 40 at 1 core.
  Waiting alone, without the agreement test, kept the hold to the end of the run, 312 hours, in two
  0.75-core seeds.

- The hold's allowance is two σ across the span. Against three, it takes the same limits in every
  seed and delivers 30 core-hours more over the ten 0.75-core runs, 0.2%, and 15 more at 1 core. The
  runs without an outage never use the hold, since corroboration comes first.
- At 1 core the own count sits on the 1-core rules-mismatch bound: true billing runs 0.92 to 1.07
  cores above the governor's charges, and over the 80 minutes or so after a lift the interval noise
  takes the estimate past a core in 6 seeds. Those latch, and `widen()` then learns. The tests
  replay to the recorded onset: to `t_lo`, five minutes earlier, seed 9's estimate came to 1.024
  cores instead of 0.975 and latched too, which cost it 3 more limits and 103 core-hours.
- One 0.75-core latch, seed 10, is an open problem. The mismatch test starts at the detected lift
  with 6,912 credits, Hostinger's 20% lift point, as a lower bound. Here the guest ran 6.6 cores
  from the moment the host lifted the cap, so the bank was already down to about 6,750 when the
  governor saw the lift, and the estimate comes to 1.002 cores against 0.87 true, 1.03 to `t_lo`.

## Legacy scenarios

`deno task sim` runs the original week-long scenarios with seed 1. Each cell is credit limits /
paused hours / lift tests / percent of earned credits used. Off mode is what installs run by
default. Main is commit `c639987`, the last commit before v0.3.0: v0.2.5 plus #7, #11 and #14, which
add documentation and IPv4 addresses and move diagnostics off the control pass. It is reproduced
with `git worktree add ../main c639987` and `deno task sim` there. Apply runs the same scenarios
with `"calibration": { "mode": "apply" }`.

| Scenario                                            | main (`c639987`)       | v0.3.0 off             | v0.3.0 apply            |
| --------------------------------------------------- | ---------------------- | ---------------------- | ----------------------- |
| normal                                              | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 96.8        |
| noisy neighbours                                    | 0 / 0 / 0 / 95.3       | 0 / 0 / 0 / 95.3       | 0 / 0 / 0 / 96.3        |
| hidden overhead                                     | 2 / 0.15 / 8 / 99.8    | 2 / 0.15 / 8 / 99.8    | 2 / 0.15 / 8 / 99.9     |
| paused earning debits CPU, overhead                 | 2 / 0.15 / 8 / 99.8    | 2 / 0.16 / 8 / 99.8    | 2 / 0.15 / 8 / 98.4     |
| hidden overhead, per-vCPU limit                     | 1 / 139.4 / 537 / 26.3 | 1 / 139.4 / 537 / 26.3 | 1 / 143.37 / 553 / 24.4 |
| hidden overhead, per-vCPU, spread                   | 2 / 0.2 / 8 / 99.8     | 2 / 0.2 / 8 / 99.8     | 1 / 0.1 / 4 / 100       |
| real baseline 30% (article wrong)                   | 12 / 1.94 / 156 / 99.6 | 11 / 1.79 / 145 / 99.7 | 12 / 1.9 / 152 / 99.7   |
| services outside slice +5 cores 6h                  | 0 / 0 / 0 / 96.3       | 0 / 0 / 0 / 96.3       | 0 / 0 / 0 / 97.4        |
| stopped 3h at a low bank                            | 0 / 0 / 0 / 95.6       | 0 / 0 / 0 / 95.6       | 0 / 0 / 0 / 96.8        |
| normal, services not enrolled                       | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 96.9        |
| normal, batch at idle weight                        | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 95.9       | 0 / 0 / 0 / 96.8        |
| paused earning debits CPU, baseline 30%             | 11 / 1.85 / 152 / 99.1 | 11 / 1.83 / 150 / 99.1 | 12 / 1.98 / 166 / 99    |
| baseline 30%, two weeks                             | 11 / 1.72 / 139 / 99.8 | 11 / 1.73 / 138 / 99.8 | 12 / 2 / 160 / 99.8     |
| hidden overhead + heavy neighbours                  | 3 / 0.22 / 12 / 99.8   | 3 / 0.22 / 12 / 99.8   | 1 / 0.07 / 4 / 100      |
| hidden overhead + heavy neighbours, per-vCPU spread | 3 / 0.31 / 12 / 99.7   | 3 / 0.31 / 12 / 99.7   | 1 / 0.1 / 5 / 100       |

Off mode's final margin differs from main's in three ways. A confirmed credit limit now widens the
margin at its lift rather than at its first failed lift test, from the estimate at entry; in hidden
overhead, its paused-earning and spread variants, the three baseline-30% scenarios and the heavy
neighbours, per-vCPU spread scenario, that moves the multiplier by at most 0.011. In the real
baseline 30% scenario off sees 11 limits instead of 12, so one fewer `widen()` step leaves it at
1.9388× + 0.30 instead of main's 1.9376× + 0.32. In hidden overhead, per-vCPU limit, the per-vCPU
cap holds the one limit for 139 hours, its record is classified unknown, and the classification gate
keeps `widen()` from running: off ends at 1.05× + 0.08, where main widened to 1.07× + 0.10. In
apply, a hidden overhead of 12% plus 0.15 cores costs no more limits than off. Before the lift-side
fix it cost one more: a replay from the previous lift stopped earning until the governor detected
that lift, so the diagnosis under-learned the gap. With a wrong baseline, each limit's readings need
more than a whole core of gap, which latches a rules mismatch, and apply then learns with `widen()`
as off does.
