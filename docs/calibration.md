# Calibration

Calibration tightens the margin and the spending floor from this VPS's own record: Hostinger's CPU
readings and confirmed credit limits. It starts in `off`.

- `off` keeps today's behavior: 1.05 times guest CPU plus 0.08 cores, a 20% spending floor, and
  `widen()` after a confirmed credit limit. Everything below still runs and is logged as would-be.
- `shadow` actuates exactly like `off` and logs the decisions `apply` would make.
- `apply` starts at 1.05 times guest CPU plus 0.04 cores with a 5% floor, then acts on the
  calibration. A margin a confirmed limit widened earlier survives the switch. What `shadow` learned
  doesn't carry into the first switch, but what the readings and limits are doing does, as across a
  reset: staleness, readings marked invalid, both holds and any cooldown. The spending floor is
  separate from Hostinger's 20% lift point.

The governor never reads Hostinger's article, and readings never raise the estimate it acts on.

## Configuration

Add the settings to `/etc/governor/config.json`. These are the defaults:

```json
{
  "calibration": {
    "mode": "off",
    "start": { "mul": 1.05, "add": 0.04, "floor": 0.05 },
    "gap_start": 0,
    "premium_ref": 0.0348,
    "sigma_ref": [0.0214, 0.0119],
    "floor_max": 0.10,
    "gap_max": 0.2,
    "fit": { "days": 14, "min_pairs": 48, "min_cores": 3, "min_days": 3 },
    "cusum": { "k": 0.5, "h": 10, "verify_readings": 48, "verify_z": 0.5 },
    "clamp": { "enabled": true, "tolerance": 0.025 },
    "learning": {
      "onset_margin_s": 300,
      "eta_sigmas": 3,
      "hold_sigmas": 2,
      "plausible_extra": 0.02,
      "confirm_days": 7
    },
    "stale": { "pause_s": 7200, "fallback_s": 86400 },
    "sustained_cooldown_s": 10800
  },
  "readings": { "use_newest": false },
  "recovery": { "quota_period_ms": null }
}
```

Set `mode` to `shadow` to begin the [rollout](#rollout). Run `sudo governor validate-config`, then
restart the daemon. `apply` requires `hostinger.vm_id` and a token source or broker: without
readings it would run its start settings unchecked. A positive `gap_start` raises the start addition
by `gap_start` times the multiplier; a qualifying fit then includes it in the margin formula. The
start settings bound the learned ones from below: raising `start`, `gap_start` or the start floor
takes effect at the next daemon start, and lowering them changes nothing until a reset. Validation
rejects a key it does not know anywhere in the file, so a misspelt setting cannot leave its default
in force unnoticed, and bounds each learning setting: `confirm_days` to 90, the history's span.

## History

The governor keeps its evidence in `/var/lib/governor`, bound to the plan and VM ID and private
(mode 0600). History recorded without a VM had no readings, so it binds to the VM first configured,
and the next snapshot records it at once; history bound to a VM stays bound when the config names
none. Only a different VM sets it aside, so adding `vm_id`, as the rollout's second step does, keeps
what was gathered before:

- 90 days of readings, ten-minute UTC CPU slots, reading revisions and exact interval means;
- the last 50 limit records and the last 100 calibration decisions;
- the inputs of the latest evaluation and of the latest gap diagnosis, for `calibrate --explain`.

`history.json` is a daily snapshot. Recorded inputs in it are references to rows it already holds,
and its payload is compressed, so 90 days stay below 1 MB on KVM 8. Between snapshots, every write
appends one line to `history.log`: only the rows, records and fields that changed, found by
comparing values. Writes come when a slot closes and after a fetch, after the pass has set its
ceiling. Once a day the governor writes a new snapshot through a temporary file and rename, then
starts an empty log. The snapshot's generation tells the reader which log lines extend it, so lines
left by a crash during compaction are ignored, and a torn last line only ends the replay early.

The daemon and `calibrate --explain` read the snapshot and its log the same way. Missing or invalid
history is rebuilt without failing a control pass; an invalid snapshot moves to
`history.json.bad-<unix>` with its log, and only the three newest quarantined copies are kept. A log
that ends early keeps the lines before it, and the next write compacts. A record that fails
validation, in the snapshot or in a log line, is dropped alone and logged. History keeps at most
1,000 reading revisions, so a feed that revises its whole window on every fetch can't outgrow the
file. A history file the daemon cannot read at all, after an EACCES or EIO, stays in place: that run
starts with empty history and writes none, and the next start reads the file again.

Losing `persist.json`, or finding its calibration state invalid, must not loosen anything or drop
what calibration was doing. The governor reruns the latest evaluation from the inputs history
recorded for it and, once its digest verifies, takes the state it gives: the learned settings, gap
and rules-mismatch latch, both holds, a drift change and how far its verification got, drift
detection and the fit, limits still waiting for a diagnosis, the stale clock, readings marked
invalid and any cooldown, and the start that decides which limits may teach. In `apply`'s first
start that state still begins from the configured start, or from the margin off widened, wherever it
came back from. An evaluation or decision recorded in `apply` shows `apply` already ran, even before
it made a decision, so a lost `persist.json` can't start `apply` over and let limits from before a
reset teach it. Without a recorded evaluation that verifies, the newest decision made since `apply`
first ran holds the learned settings, gap, latch and any drift change still holding, in any mode:
from then on `off` and `shadow` share that state, and a reset's decision holds the start. Drift
detection and an unverified change's verification then resume with readings that arrive from there
on. Whatever comes back, its serial is at least every serial history recorded, so no later start
takes an old decision, a reset above all, as newer. A lost `persist.json` still restarts the bank
estimate at 0, as a reboot does, and the clamp restarts from an empty bank with it;
`initial_balance` applies only to a first start. A `persist.json` that didn't parse, or that this
run can't read, counts as lost even when no history exists yet, as on the first start after
upgrading from v0.2.5: it is existing state, not a new install. A history file this run can't read,
after an EACCES or EIO, rules out a first start too: the bank starts at 0 and `persist.json` isn't
written, so the next start recovers from that history. Off mode's legacy margin comes back too,
before anything inherits it, so `apply`'s first start keeps it as well. Each limit record made
outside `apply` holds the legacy margin in force at its entry, which already sums every earlier
widening, v0.2.5's and any from records no longer kept, and one `widen()` learned from adds its step
on top. A record also keeps the legacy margin its widening left, whatever mode the limit began in: a
limit entered in `apply` and lifted in `off` widens off's margin, which its entry settings, apply's,
can't give back. The saved margin only adds to that.

The open limit comes back from whichever file a crash or a loss left newer. A record history shows
lifted ends the limit. One still open goes on as a limit when `persist.json` lost it or never saved
it, as across a reboot: the bank starts at 0, the recovery ceiling holds the box, and the first pass
tests the lift. Left alone, that record never got its lift or class, and the box ran as if unlimited
until detection opened a new record without the first one's evidence. The sustained-use cooldown
follows from the limit records too, so it holds whichever file is newer. One protocol starts the
daemon (`openGovernor`): reading `persist.json`, what its state rules out, then history. The chaos
test and the simulator's restarts use it too, and the chaos test's restarts, crashes and lost files
land inside credit limits as well as between them.

Every pass writes history before `persist.json`, and each log line is synced to disk first, so a
crash or a power cut between the two leaves `persist.json` behind history, never ahead of it. The
store compares the whole history with what it last wrote and appends only the difference, so no
change has to remember to mark history for writing. Rows are only appended, or replaced with their
array, so it reads only the rows appended since, and a pass costs 0.04 ms without the JIT. It checks
that rule rather than trusting it: an array it saw before must still end its known part with the
same row, or it reads the array whole. Before that check, a slot sorted into place after a backward
clock step looked appended and never reached the log. The snapshot's directory is synced after the
rename, and so is the new log's, so a power cut can't pair the old snapshot with the new, empty log.
A record whose decoded inputs fail their check loses only those inputs; once, at the end of the
log's replay, it failed the whole history. A write that fails leaves history behind: the next is a
whole snapshot, tried every 10 minutes while the disk keeps failing, and until one succeeds
`persist.json`, still written every pass, records that history is behind it. Holding it back instead
would lose what was learned meanwhile at the next restart. Every evaluation and reset counts a
serial, which `persist.json`, the recorded evaluation and each decision carry, so a start tells
which is newer without trusting the wall clock. A start that finds a newer recorded evaluation
reruns it, so the state it missed comes back, a reset included. Without one that verifies, a reset
among the newer decisions applies first, and the learned settings then take at least the newest
decision's after it, since they only tighten: raising to the newest alone kept what the reset had
cleared whenever a decision followed it. The open limit's record comes from history, whose copy is
never the older one, unless `persist.json` says history fell behind it. A limit record in
`persist.json` that fails validation takes history's copy; without one, the limit goes on without a
record and teaches nothing. A limit still open when `apply` first starts is diagnosed by it, as what
the limits are doing carries across that switch.

Calibration state is evidence about one VM's meter, like history. `persist.json` records the VM it
learned from, and a state from another VM starts over with this VM's history. A config without a VM
has no readings, so nothing can come from another meter; the VM stays recorded for the next check.

A reboot inside a slot keeps that slot open with its mark, and the passes back fill it. Closing it
at the reboot left the next slot back with the same start, which history read as a clock step: it
marked the first clock-invalid and dropped the second, on most reboots.

If an evaluation fails, nothing may loosen. In `apply` the governor holds the 1.05× + 0.08 fallback,
as for invalid readings, and acts on the open estimate less the clamp's margin below it at the first
failure, until an evaluation succeeds; each change of the settings in force fires `calibration`, and
the failure is logged hourly. Acting on the open estimate alone ran `apply` looser than `off`,
unchecked and unannounced. The hold applies wherever the estimates are read, every pass, and
`persist.json` keeps it (`evaluationFailed`), so the passes between evaluations, a restart, status
(`credits.calibration.failing`) and `--explain` all hold the same fallback. Kept only in the
estimates, it lasted one pass: the next rebuilt them and acted on the open estimate again. It still
classifies lifted limits, which needs only their records, and restores a sustained-use limit's
estimate from the guest's own count: off mode's `widen()` gate, the cooldown and the restore never
depend on the rest of calibration. The first pass after every start evaluates, so the clamp and
`--explain` agree with the daemon from it, not from the next slot, and so does the pass a reboot
resets the bank on.

A `persist.json` that doesn't parse moves to `persist.json.bad-<unix>`, of which the three newest
are kept, and counts as lost. One the daemon can't read, after an EACCES or EIO, stays in place:
that run starts as if it were lost and doesn't write it, and the next start reads it again.
`governor run` refuses to run as root, whose files the service could not read, and only one daemon
runs at a time: a second exits instead of appending to the same history.

## Readings

Each reading covers the interval since the previous timestamp. Intervals of 900 to 2,700 seconds can
be paired and replayed. Longer or shorter ones, and time no reading covers, are gaps: the clamp and
gap learning bridge them as described below, and the no-limit bound stops at them. The newest
reading of each fetch stays out of the settled readings unless `readings.use_newest` is enabled. A
newest timestamp that disappears on the next fetch never becomes a settled reading. A reading may be
up to five minutes ahead of this box's clock.

The governor compares each newest reading with its value in later fetches, newest again or settled,
and records a revision when it moves by more than 0.01 percentage points. `newestFinal` turns true
after seven days of such comparisons without any revision. It is evidence for `use_newest`; it does
not change it.

A pair is a settled reading and the guest's mean CPU over exactly its interval. The mean comes from
the local samples while the two-hour sample buffer still covers the interval, which keeps job
transitions inside ten-minute slots from distorting it. Readings that settle later pair from slots.
A reading a later fetch fills in between two others starts the next one's interval later, so that
pair is dropped and computed again while the samples last; the first one computed used to stay.
Pairing needs 99% local coverage and excludes limited, test, reboot and invalid-clock slots, and
time the daemon did not watch: after a stop longer than two passes, one sample spreads its average
over the whole stop.

Nobody has confirmed that a reading after a longer interval averages over all of it; box A showed
one such interval in ten days. Readings after 2,700 seconds to six hours stay out of pairing, and
replays bridge their intervals. Each is still paired with the guest's mean CPU over the whole
interval and over its last half hour, logged as `long reading interval:` and kept in history.
`credits.calibration.longIntervals` reports their count and their mean residual against the fit
under each reading, in cores (`whole`, `lastHalfHour`) and in σ (`zWhole`, `zLastHalfHour`); the log
line carries each one's residuals. If over a few weeks they match the whole interval within the
usual noise, widening the valid range is a change the data backs.

## Meter fit and margin

A fit needs 48 pairs at three or more guest cores across at least three UTC days, so idle boxes
never qualify. It is ordinary least squares of reading cores on guest cores over 14 days. The
multiplier `aHi` is the 97.5th percentile over 1,000 fixed-seed resamples of UTC days, or the fitted
slope when that is higher. A day is resampled once it holds 16 qualifying pairs, a third of the 48,
or once it is whole and holds at least one; a fit needs two such days, because resampling one day
shows no day-to-day spread and the bound would equal the slope itself. A day without a qualifying
pair carries no slope, though its pairs still count in the fit. Resampling idle weekend days drew
sets of mostly idle days: an `apply` start on a Thursday, without the 14 days of `shadow`, set the
multiplier to 1.086 to 1.233 against a slope near 1.04, and the multiplier only tightens. Residual
noise gives σ(u). Once ten pairs under three cores exist, σ(u) is never below what they show, √(π/2)
times their mean absolute residual, so a line through the residuals that reaches zero at idle can't
make every idle reading extreme. Under load the line rises past that floor, so the premium is
unchanged. Refits run at most daily. Readings marked invalid, and any residual beyond 6 σ against
the fit in force, never enter a refit: like drift detection, the fit must not let a bad feed tighten
the margin. A real jump in the meter is then left to limits until readings are valid again (see
Drift detection). After a drift change, refits never reach back past its change point, so no window
mixes the meter from before a change with the meter after it.

A reading at the 100% cap only bounds the meter from below. It never counts as a normal residual and
never reaches drift detection, so a jump clipped at the cap cannot pass for valid readings; one
already beyond 6 σ against the fit still counts as extreme. Fits keep capped readings: leaving them
out cost S1 0.05% of CPU and helped no meter jump.

From a fit, the margin keeps the box a premium below the baseline at the floor, by Hostinger's count
plus the learned gap. The premium scales `premium_ref` by the measured noise. The multiplier rounds
up to 0.001. Without a qualifying fit, the start stands for a zero gap, and a learned gap raises the
addition by the gap times the multiplier.

## Limits and classification

A limit is classified once, at its lift, from the delivered CPU recorded every 30 minutes while
steal showed the slice pressing on it by at least 0.3 cores. Delivery closer to demand than that
measures the demand, not Hostinger's cap; a slice the governor holds low can still see steal.

| Class         | Caps while pressing                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| credit        | flat at the plan's limit, ±0.3 cores, or flat at most 0.6 cores apart below it                                                                      |
| sustained-use | at least 45% of vCPUs and above the credit band at first, or falling by 20% of vCPUs an hour or more between any two caps at least 30 minutes apart |
| unknown       | anything else, including a limit no lift test found limited                                                                                         |

Hostinger states that sustained use loses 25% of vCPUs an hour; the 20% threshold leaves room for
caps sampled every 30 minutes. A fall must also exceed the credit band's 0.3 cores: on KVM 1 and 2,
20% an hour is 0.1 or 0.2 cores between rows, inside a flat cap's noise. On KVM 1, 45% of vCPUs is
0.45 cores, inside the credit band of 0.4 ± 0.3, so a high first cap must exceed 0.7 cores there; on
larger plans 45% is above the band already. Without pressing caps, the burner delivery of the first
lift test whose burners ran into the limit stands in for the cap; a test that passed measured the VM
after the lift. A failed test ran into the limit if it found limited evidence or a later test still
failed. After Hostinger's lift, neighbours' steal alone can fail a test, and its delivery, 4 cores
in one probe, read as a sustained-use cap: the credit limit's estimate was restored and it taught
nothing. A sustained-use limit holds until 3 hours after use falls, so more tests fail.
Classification adds to the existing confirmation: a limit can teach only if a lift test during it
failed with limited evidence. Readings never change the class.

- **Credit.** In `off` and `shadow`, `widen()` updates the legacy margin at the lift. In every mode
  the gap diagnosis below runs; `apply` acts on it.
- **Sustained-use.** Nothing is learned. For three hours after the lift the allowance stays at or
  below the baseline. Within a day of the lift, and only while no later limit has begun, the open
  estimate is restored to the pre-entry estimate advanced over the guest's own count, with no
  earning while it pressed on the limit. Readings don't bound it, so a box without readings restores
  too; in `apply` the clamp still holds the acted estimate to the readings.
- **Unknown.** Nothing is learned or restored.

Each classification is logged as `limit-classified`; a sustained-use or unknown limit also fires the
hook. A flat cap below the pinned limit is classified credit because it fits a credit limit under
harsher rules; its readings decide whether the pinned rules still hold.

## Gap learning

Readings settle 30 to 90 minutes after their interval. A credit limit's diagnosis waits until valid
settled readings cover `t_lo`, five minutes before the onset. If they do not within two hours of the
lift, or readings are invalid by then, it uses the guest's own charges instead, moving the gap by at
most 0.01 cores. Readings marked invalid count as a gap in the replay.

One limit alone is too noisy to trust an own-count result in full. A repeat is not: while readings
are invalid or stale, the second confirmed credit limit within seven days takes the full own-count
result, plus `hold_sigmas` σ of allowance across the whole span, since all of it is estimated. That
is two σ, against the three permanent learning takes: a temporary hold that runs low costs a limit
the next repeat corrects, while a learned gap that runs low keeps costing them. That full step goes
into a temporary hold, not the learned gap: limits stop the bleeding while the feed is unusable, and
when readings resume the hold ends and the refit owns the meter side. The governor's charges in that
replay used the settings in force at entry, which may hold more than the gap does, such as the stale
fallback's 0.08, so the hold covers those settings plus the step as well. A broken feed still cannot
tighten anything, because only confirmed credit limits raise the hold. Without usable readings
nothing tells harsher rules from a jump in the meter, so the plausible bound and `gap_max` do not
gate the hold; a gap beyond a whole core, from the detected lift, is still a rules mismatch. The
learned gap takes only the capped 0.01-core step, and it too faces only the whole-core bound:
neither `gap_max`, the low-cap bound nor the suspect gate judges it, because without usable readings
they can't tell harsher rules from a meter jump either, and a step this small can't run away. With
`gap_start` at `gap_max`, the first such step had latched a permanent rules mismatch. Holding the
own-count result to `gap_max` latched a rules mismatch in all 10 simulated seeds of a 0.75-core jump
during an outage, up from 1, and in all 10 at 1 core, up from 7. It added 7 limits over those 20
runs and left the fallback in force for most of the run, and the step is too small to matter.
Readings that a confirmed limit corroborates end the invalid state instead (see Drift detection).

The replay starts from the last anchor before `t_lo`:

- a certified full bank: across consecutive slots at capacity, a lower bound for the bank that earns
  the baseline and pays the governor's charge plus the gap's upper bound has itself reached
  capacity. A slot that pays more lowers that bound, and certification lasts only while it stays at
  capacity;
- a previous credit limit's onset, at an empty bank;
- a previous credit limit's lift, at Hostinger's 20% lift point. A lift test runs up to 15 minutes
  after the real lift, so gap learning and holds anchor at the last test that still found the limit:
  an upper bound for the bank, so the gap is never under-learned. The clamp and the rules-mismatch
  tests anchor at the detected lift, whose bank is a lower bound while the slice stays held until
  the governor notices the lift. All three mismatch tests also replay to the recorded onset, the
  latest plausible one, rather than `t_lo`, so a mismatch needs even the smallest gap to break the
  rules: to `t_lo`, five minutes earlier, a repeat limit an hour after a lift read 0.366 cores for a
  true 0.18, past `gap_max`, and the whole-core test read a 1-core meter jump as 1.024 cores, 0.975
  to the onset. From an anchor that isn't a lift, such as a certified-full bank, they replay to the
  recorded onset too;
- for the clamp only, a reboot: an empty bank at the first reading after the box came back. The
  slots cannot cover the downtime, so only a lower bound is known.

Bisection finds the gap at which settled readings first reach zero at `t_lo`. The governor flags the
slot a limit entered in from that slot's start, but the replay lets it earn until the limit began.
From a previous lift the limit is over, so the slots until the governor detected the lift earn too,
and the guest's own charges follow Hostinger's earning rule: a lift test does not stop the bank
earning. The clamp, a lower bound, keeps those slots as flagged. During a limit a slot earns for the
share of its time that didn't press on the limit: each slot keeps the seconds its samples pressed,
so a 30-second lift test costs its 10-minute slot 30 seconds of earning, not all of it. Replays of
the governor's own estimate, for the floor, a sustained-use restore and clock-invalid bridging,
likewise earn for the time the estimate earned: each slot keeps the seconds it didn't, through a
probe, a lift test, pressing or time no sample saw. A slot from before that was kept counts whole,
and so does a limited slot in the clamp, a lower bound: earning for the rest of it there let two
jump-study seeds pay an extra limit before readings were corroborated. The clamp, a lower bound,
still counts a limited slot that pressed at all as earning nothing: in two legacy `apply` scenarios,
letting it earn for the rest cost an extra limit each. Across a gap in the readings, the replay
bills Hostinger's fitted relation at the guest's CPU plus the gap under test. The governor's own
charge would not do, because its premium would bias the gap. When a gap needs bridging before a fit
qualifies, or bridged time exceeds 10% of the span, the diagnosis uses the guest's own charges
instead.

Estimated time is the part of the reading covering `t_lo` plus any bridged time. Each estimated
second adds three σ of allowance at the guest's load in it, using the fit's noise or, before a fit
qualifies, `sigma_ref`, so bridging raises the learned gap rather than lowering it. Then:

- **Explained.** If the readings reach zero without a gap, the gap stays and drift detection handles
  the meter.
- **Plausible.** At most `min(upper bound, 0.167) + 0.02` cores: learned.
- **Suspect.** Above that: learned only if a second credit limit within seven days lands within 0.02
  cores, and then the larger value. Until then it raises no floor either. Raising the floor for
  suspect limits pinned it at 7 to 10% in 15 of 20 simulated runs of 0.75- and 1-core meter jumps,
  cost up to 0.22% of the CPU and prevented no limit.
- **Rules mismatch.** Above `gap_max`, above the plausible bound for a flat cap below the pinned
  limit, or beyond any gap up to a whole core. The tests take the central estimate from the detected
  lift, without the allowance, so a mismatch needs even the low estimate past them. During a drift
  change the fit does not describe the meter the span crossed, and readings a limit corroborates
  show a meter change, so neither tests the rules. The pinned rules do not hold, so a billing gap
  means nothing. The governor alerts with `rules-mismatch`, applies at least 1.05× + 0.08, and from
  then on learns from each credit limit with `widen()`, as `off` does. Only an operator reset clears
  it.

After learning, or for an explained limit, the governor replays its own estimate from the anchor
with the margin now in force, holds included. Whatever it still shows at `t_lo` raises the floor, up
to `floor_max`. A hold explains its share until it ends, and what ends it carries that share on: the
fit after a meter change, or readings that resume. A floor raised while readings can't be used is
provisional, because nothing then tells optimism the margin misses from a meter change not yet
measured. Readings that a limit or the own-count hold corroborates show the change, and the floor
returns to where it was before those raises; readings the fit finds normal again make them stay. In
the jump study, 15 of the 20 runs with a meter jump during an outage now end with the floor at 5%
instead of 10%, with the same limits and 0.5 to 3.2 more core-hours of CPU each. The other five
latch a rules mismatch, their readings never count again, and the floor stays at 10%. The first
credit limit has no earlier anchor and no gap, logged with the note `no earlier anchor`; the
estimate it showed at entry raises the floor the same way, and its lift anchors the next diagnosis.
In `apply` that is the clamped estimate the governor acted on. A reboot, an invalid clock or missing
slots between the anchor and `t_lo` leave the gap not measurable, logged with the note
`gap not measurable`: the estimate at entry raises the floor too, up to `floor_max`, so a box that
reboots between limits still learns.

A daily upper bound on the gap is plausibility evidence only. For each span of at least 24 hours
from a sync to the next sync, limit's earliest plausible onset or reading gap, bisection finds the
largest gap that keeps the readings replay off zero; no limit came, so billing ran at most that far
above the readings. A bank that refills to capacity in between forgives every earlier shortfall, so
dividing the bank by the time since the sync would understate the bound.

## Lift check

Once settled readings cover a credit limit's lift, the governor predicts the recovery time by
replaying readings plus the learned gap from an empty bank at onset to the 20% lift point. Pressing
until the governor first holds the slice below the limit is expected, and lift tests press on
purpose; a limit that pressed again after recovery began is skipped. Past the lift, readings carry
the load the lift released, so the replay stops at the next limit's onset or at 1/0.7 times the
actual recovery, whichever comes first: the longest prediction that could still match. A replay that
has not reached the lift point by then predicts nothing. While readings are invalid or do not yet
reach that end, the check retries for two days after the lift. If the actual time from onset to lift
is more than 1.5 times the prediction, it logs `rules-mismatch`. A recovery faster than 0.7 times
the prediction cannot be told apart from the load after the lift, so the window leaves it unjudged.
A second mismatch within 30 days, by lift time, latches the rules mismatch above.

## Drift detection

Each new pair updates a one-sided CUSUM of residuals against the last fit. An alarm opens a drift
change: a temporary hold, never learned state, since an additive jump read as a steeper slope would
otherwise stay a higher multiplier. The alarm reads the change both ways, as a slope from the
residuals since the CUSUM last left zero and as an offset from the clearly shifted pairs among them,
and the hold covers both at every load. Only pairs at three or more guest cores, where a fit
qualifies, read the slope: near idle, a small offset divided by a tiny load read as a multiplier of
2 to 3.3 on the simulated meter's own day-to-day wobble. Capped readings take part in neither. From
three pairs on, the hold rises to their mean residual when that is more (`drift-hold`). After 48
pairs the change is verified (`cusum-keep`) if their mean residual is at least 0.5 σ against the old
fit; otherwise it is withdrawn (`cusum-revert`) and, having changed nothing learned, leaves nothing
behind.

A verified change holds until a fit on the readings after its change point alone qualifies. That fit
sets the learned margin, tightening only against the margin learned before the change. Limits during
the change were explained by it, and the fit now carries it, so the gap they taught is dropped; the
floor stays. Until the 14-day window has moved past the change point, each daily refit sets the
margin the same way, against the one from before the change, keeping the floor and any gap learned
since. A fit on the first few days can split a change wrongly into slope and offset, as S4's slope
change was first read partly as an offset; a later fit replaces that split rather than adding to it.
Under a rules mismatch, refits only tighten, so `widen()` steps stay. The status shows the change as
`credits.calibration.cusum.pending`.

A residual beyond 6 σ never enters the CUSUM or a pending verification: it is not evidence of drift,
and a bad feed must not tighten the margin. Three in a row mark readings invalid until three normal
residuals arrive; those three then reach drift detection too, so a jump that stays under 6 σ at high
load still alarms.

While readings are invalid from extreme residuals, any confirmed credit limit can corroborate them,
unless a verified drift change holds. A second change opened from that change's point would let the
fit after it mix both meters, so readings that turn extreme meanwhile stay invalid until three
normal readings or a reset, and the own-count hold carries the box. Its replay bills the settled
readings up to where they turned extreme and the fit plus a rise after that, from its anchor, the
detected lift for a repeat; reading gaps before that point are bridged with the fit alone, since
they crossed the old meter, and billing the rise there too made it come out low. It bisects the
rise, up to the VM's vCPUs, that empties the bank at `t_lo`. The invalid readings play no part in
it. If their mean residual over the same span is positive and within ±50% of that rise, either way,
so neither exceeds the other by more than half, they track billing: they count again
(`readings-corroborated`) and a verified drift change opens from where they turned extreme, holding
the fit raised by their mean residual since. A units change cannot show the same rise in limits, so
a broken feed stays invalid and tightens nothing. The first limit counts too: a 0.5-core jump turns
readings extreme at low load at once, so waiting for a repeat would cost a second limit. Readings
that are not corroborated stay out of refits. A corroborating limit learns nothing itself: the rise
it measured empties the bank at `t_lo`, so no optimism is left for the floor, and the drift change
it opens carries the meter. Replaying its own estimate at the old margin instead pinned the floor at
`floor_max` after every jump of 0.75 cores or more. The rise bills the time after the last settled
reading too, up to `t_lo`.

## Estimates

The open estimate follows the guest's CPU with the settings in force. In `apply`, settled readings
plus the learned gap are replayed from the last anchor and advanced with the same settings: the
clamp. Across a gap in the readings, the clamp bills the guest's count at the settings in force, as
it does after the newest reading, so irregular readings leave it available. The governor acts on the
lower of the open estimate and the clamp plus 2.5% of capacity. The clamp can lower it but never
raise it above the open estimate. A tracking estimate replays the fitted meter without the premium,
across reading gaps too, for evidence only. Every fetch logs the open, clamp, tracking and acted
estimates; each limit record keeps the tracking estimate at onset.

The clamp needs an unbroken replay from its anchor. A reboot gives it a new one, an empty bank at
the first reading after the first whole slot back: the first slot usually starts partway through,
and a reading in it covers time no local sample saw. A start without `persist.json` gives one the
same way. Clock-invalid time is bridged like a reading gap: the governor counts CPU on kernel
uptime, so its busy time there still holds and only placing it in wall time fails. Each run of
clock-invalid slots, with the holes beside it, is billed at the run's own busy rate with the
settings in force, and readings ending in it are bridged rather than replayed. Earning goes on:
nothing says it stopped. The tracking estimate bridges it the same way with the fit; gap learning
does not. A run during a limit keeps the limit across it, and the share of its time that pressed on
it.

Each evaluation replays from the newest anchor in history. Once a replay has run, its base at the
newest reading carries over to the next evaluation, which continues from it when history has no
anchor left, or when the replay from history's anchor meets time no local sample covers. The bank
there sums up everything before it, so the clamp doesn't turn off when its only anchor ages out of
the 90-day history, and an evaluation with no new reading keeps the base as it is. On a busy box the
bank may rarely certify full; in the simulator's CI workload it does so only on the first night.
`governor seed` and `governor limit off` set the base at the operator's bank. The operator's bank is
newer evidence than any anchor before it, so a base grown from it goes before history's anchor until
history has a newer one. A reset keeps the base, billing the start's gap from there on. A rebuilt
history has no anchor to bridge from: the clamp then stays off until the next certified-full bank,
credit-limit lift or seed, and the governor acts on the open estimate alone, as v0.2.5 did.

## Stale and invalid readings

Two hours without a new settled reading pause fitting and drift detection. Readings are invalid when
a fetch has the wrong unit or values, when more than 12 of the last 24 hours fall in intervals
outside 900 to 2,700 seconds, or after three extreme residuals. An interval over 6 hours counts as
an outage, which staleness covers, not as spacing, so readings that resume after one are usable at
once. The bad spacing is measured in hours, not as a share of the time counted: as a share, needing
20 counted hours, it never judged a day with an outage over 4 hours, however its readings were
spaced. The extreme test needs only a fit, so it still catches a broken feed on a box that went too
idle to refit. Readings that turn invalid partway through an evaluation are unusable for the rest of
it too: a limit diagnosed in it waits for the next. Invalid readings pause the same way and alert
once with `readings-invalid`. A brokered box alerts the same way: the broker reports a wrong unit or
value as `invalid_metrics`.

A fetch with the wrong unit or values is rejected whole, so nothing from it is stored. Readings that
extreme residuals mark invalid stay in history, but every replay treats them as a gap, from the
first of the three extreme readings until the first of three normal ones. The clamp keeps running
and bridges them with the settings in force, so an inflated feed cannot pin the estimate low; gap
learning bridges them with the fit and counts them as bridged time.
`credits.calibration.invalidSpans` lists them, and `calibrate --reset` keeps them.

After 24 hours stale or invalid, `apply` holds at least 1.05× + 0.08 (`stale-fallback`). A full
own-count step from a repeat limit raises a second, temporary hold (`ownHold`), at any time while
readings are unusable. Both end when fresh, valid settled readings resume (`readings-resumed`),
including readings a limit corroborates. Readings that come back are judged before they end
anything: a hold ends only once the fit finds a fresh pair normal, with no run of extreme residuals
under way, and until then the fallback's clock keeps running from the outage. The first reading
after an outage spans it, so it can't be paired; the hold waits for the next. Readings that come
back beyond 6 σ can still end an own-count hold: the confirmed credit limits that raised it measured
the rise in billing, and if the readings' mean residual agrees with that rise, without the hold's
allowance, both positive and within ±50% either way, they count again as if a limit had corroborated
them (`readings-corroborated`), and a verified drift change carries the meter. Otherwise the hold
that keeps the box from limits would also keep any limit from corroborating a real jump during an
outage, and the readings would stay invalid for good: in the jump study it held 312 hours in two of
ten 0.75-core seeds. A units change shows no such rise. Before this, a feed that came back at 8x the
meter after a two-day outage ended both holds, from 1.05× + 0.36 to 1.05× + 0.04, and restarted the
24-hour clock when it turned invalid. Neither changes the learned settings, which only tighten until
an operator reset, a fit after a drift change, or readings that show a meter change behind a floor
raised while they couldn't be used.

A downward step in the meter can leave the readings invalid until an operator acts. Corroboration
needs a rise, and downward CUSUM only logs. A step beyond 6 σ at the box's usual load, about 0.13
cores near idle and 0.41 at 4 cores with box A's noise, keeps the readings invalid and the fallback
in force until the readings return to the fit or `calibrate --reset`. That is deliberate. No billing
evidence can confirm a meter that now reads low: the governor keeps its estimate of the bank above
the floor, so the bank never runs out where the old meter says it should. Taking the readings on
their own consistency would trust a feed that broke low. The fallback costs a busy box about what
0.03 to 0.05 more addition cost in the studies, 0.2 to 0.6% of CPU, and an idle box nothing, since
its bank stays full. `readings-invalid` alerts, and `invalidSpans` shows where the step began: check
the feed, then reset.

## Hooks and state

Hooks receive the existing state payload, after the pass has applied its quota. `rules-mismatch` and
`readings-invalid` alert in every mode, and so does `limit-classified` for a sustained-use or
unknown limit; a credit limit's classification is only logged, and fires `calibration` when it
teaches. `calibration` fires in `apply` once a pass, when the settings in force or the learned ones
differ from what the last one showed, whatever changed them: a decision, a limit that tightens them
under a higher hold, a failing evaluation or a request. Comparing each decision with the one
recorded before it fired at `apply`'s first decision after `shadow` though nothing changed. It
doesn't alert on its own: a latched rules mismatch, which applies at least 1.05× + 0.08, fires
`rules-mismatch` alone. Ending the hold fires it only if the hold was above the learned settings;
`readings-resumed`, `readings-corroborated` and `drift-hold` have no hook of their own. Every rules
mismatch, from a lift check or a gap diagnosis, is logged and listed in
`credits.calibration.mismatches` until the next reset or `apply`'s first start; only the one that
latches alerts. Every decision is a JSON log line with its trigger, inputs, digest, previous and new
settings, and mode.

`state.json` adds `credits.law.floor` and `credits.calibration`: mode, start, the settings in force
(`applied`: in `off` and `shadow`, the legacy margin and 20% floor) and the learned ones
(`learned`), any stale or invalid `hold`, the gap and its upper bound, the fit, the CUSUM state,
`apiStaleSince`, `readingsInvalid`, `newestFinal`, `longIntervals`, the estimates, `rulesMismatch`,
`mismatches`, `invalidSpans`, `ownHold`, any sustained-use cooldown, the last limit's class and
diagnosis, and `failing`, the time a failing evaluation began and the margin below the open estimate
it holds, or null. In `apply`, `credits.balance`, `percent` and `minutesAtFull` report the acted
estimate; the open estimate is in `credits.calibration.estimates.open`.

## Explain and reset

Inspect the recorded state and its evidence as root or the governor user:

```sh
sudo -u governor governor calibrate --explain --json
```

The command defaults to text; `--json` returns structured evidence. It makes no API requests or
changes. It reruns the recorded evaluation, classification and lift checks included, from its input
state, configuration and evidence, verifies its digest, and recomputes the current estimates and the
last diagnosis from the inputs it recorded, the earlier limit a replay from its lift reads among
them: history keeps 50 limit records, and 49 later ones had changed a rerun's gap from 0.140 to
0.044. Two runs on the same files give the same output. `evidence.fit` is the fit the replayed
decision used; `evidence.candidateFit` is a fresh candidate, which may differ when it would not
tighten the margin. The text form shows the same status fields as the JSON, one topic per line: the
settings in force and, under a hold, the learned ones and every hold; the readings' state; any
cooldown; and the long reading intervals. A configuration change takes effect in this output only
after the daemon restarts.

To return the calibration margin, floor and learned gap to the configured start:

```sh
sudo governor calibrate --reset
sudo governor tick
```

Only root can send this request. A reset is logged and clears the rules-mismatch latch. It returns
the learned state to the start: margin, floor, gap, fit and drift detection. It keeps what readings
and limits are doing now: staleness, readings marked invalid, both holds and any sustained-use
cooldown. A residual alarm ends, though: it was judged against the fit the reset drops, and only a
fit could end it. The readings it marked stay out of fits and replays, the next fit judges new
readings again, and the holds end once readings are usable. A meter change point stays, so the next
fit still doesn't reach back past it, and so does a verified drift change's, though no fit after it
qualified yet: its hold ends, but the next fit doesn't mix the meters on either side of it. It does
not change off mode's legacy margin. Past limit records are kept; limits from before the reset
cannot teach the new calibration.

## Recovery quota period

The optional `recovery.quota_period_ms: 10` sets the managed slice's quota period to 10 ms while
limited and restores systemd's default at the lift. Its effect on Hostinger's unpublished scheduling
windows is unverified. The period goes to the helper when it changes, and on the daemon's first pass
while the option is on or a period is still set, so turning the option off restores systemd's
default and a restart during a limit sets 10 ms again after the service's fallback reset it. If the
helper rejects a period, the quota is set alone, and the helper is asked again after 15 minutes or
once the wanted period changes, so a transient failure cannot leave 10 ms in place. Restoring the
default is retried the same way when this run set 10 ms; one this run never set was already reset by
the service's fallback, so a helper without the argument isn't asked again. The fallback quota and
`uninstall` also reset the period. Upgrade the supplied helper before enabling it; custom
`governor-cap` helpers must accept a third argument, `10` or `default`. No new sudo grant is needed.

## Daemon CPU and disk

The daemon's budget is 0.1% of one core averaged over a day, with 90 days of history. Measure the
governor's own work for one simulated day, without the JIT as release binaries run:

```sh
deno task bench:cpu        # the last credit-limit anchor 30 days back
deno task bench:cpu 90     # no anchor for 90 days, the longest replay
```

Each pass takes requests, ticks and saves, as the daemon does. The benchmark restarts a daemon whose
`persist.json` is intact, so the clamp replays from history's anchor on every pass, and it fails if
the clamp runs on fewer than 99% of passes. On an M-series Mac a day takes 10.1 to 13.0 seconds of
CPU, 0.012 to 0.015% of a core, the high end with the machine loaded, with every log line synced and
history compared on every pass. The v0.2.5 daemon does 6.1 to 6.6 seconds of the same work, measured
on an earlier day, so calibration and history add about 4 to 6 seconds a day. The benchmark fakes
`/proc`, cgroup files and the cap helper, which the v0.2.5 daemon measured at 0.03 to 0.04% of a
core with them. Even with a VPS core three times slower than the Mac's, the total stays near 0.06%.

History writes hand about 0.89 MB a day to the filesystem in the benchmark: the log lines plus one
330 KB snapshot, instead of rewriting the whole file on every write. A realistic 90-day file on KVM
8 is 727 KB, which brings the day to about 1.3 MB. `persist.json` is still rewritten on every pass,
as in v0.2.5. It is about 48 KB, nearly all of it the last two hours of 30-second samples.

To check a production box, compare the daemon's user and system time across 24 hours:

```sh
pid=$(systemctl show -p MainPID --value governor.service)
a=$(awk '{print $14 + $15}' "/proc/$pid/stat"); sleep 86400
b=$(awk '{print $14 + $15}' "/proc/$pid/stat")
echo "scale=4; ($b - $a) / $(getconf CLK_TCK) / 864" | bc    # percent of one core
```

## Rollout

Run at least 14 days in `shadow`, inspect `calibrate --explain`, then choose whether to enable
`apply`. Shadow shows how well the estimates track settled readings; it cannot prove that tighter
settings are safe. After any limit, review its class, its diagnosis and the stored tracking
estimate.

## Simulator studies

Run the fixed-seed eight-week studies with:

```sh
deno task sim --calibration      # print every study
deno task sim --calibration S3   # one study
deno task sim:check              # fail if a recorded outcome changes
deno task sim:record             # rewrite docs/calibration-results.json
```

The synthetic workload doubles a seeded CI job stream: busy weekdays, quiet nights and weekends. It
is not a replay of the owner's production traces, which are not in this repository. The model has an
affine meter with interval noise and day-level wobble, irregular readings served through a 48-hour
API window, a credit limiter and a sustained-use limiter. The
[study results](calibration-results.md) record outcomes and exceptions.
