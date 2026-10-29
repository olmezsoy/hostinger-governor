# Changelog

## v0.3.0

- Address issue #13: calibrate the margin and spending floor from this VPS's own record, opt-in
  through `calibration.mode`. `off`, the default, keeps the 1.05× + 0.08 margin, the 20% floor and
  `widen()`. `shadow` actuates the same way and logs what `apply` would decide. `apply` starts at
  1.05× + 0.04 with a 5% floor, tightens from Hostinger's readings and confirmed credit limits, and
  requires `hostinger.vm_id` and a token source or broker. Readings never raise the estimate the
  governor acts on. The first switch to `apply` drops what `shadow` learned and keeps what the
  readings and limits are doing: staleness, readings marked invalid, the holds and any cooldown.
  Raising `start`, `gap_start` or the start floor takes effect at the next daemon start.
- Keep 90 days of readings, ten-minute CPU slots, reading revisions, the last 50 limits and the last
  100 calibration decisions in `/var/lib/governor`: a daily `history.json` snapshot and an
  append-only `history.log` of what changed since. The files are private, bound to the plan and VM,
  and written after the pass sets its ceiling. History recorded without a VM binds to the one first
  configured, so adding `vm_id` keeps it; one bound to a VM stays bound when the config names none.
  Writes come to about 0.9 MB a day in the benchmark and 1.3 MB with a realistic 90-day file. A
  corrupt snapshot is quarantined and rebuilt without failing a pass, a record that fails
  validation, in the snapshot or a log line, is dropped alone, its decoded inputs included, and a
  torn log line costs only that write. The store checks that it only appends rows, so a slot sorted
  into place after a backward clock step reaches the log, and compaction syncs the directory after
  each rename, so a power cut can't pair the old snapshot with the new, empty log. At most 1,000
  reading revisions are kept. The daily snapshot is synced before its rename, and a leftover
  temporary file can't block a write. Losing `persist.json`, or one that doesn't parse, reruns the
  latest recorded evaluation from its inputs and recovers the whole calibration state, a drift
  change's verification included; without one, the newest decision since `apply` first ran holds the
  learned settings. The bank estimate restarts at 0, and the clamp with it. Off mode's widened
  margin is rebuilt from the legacy margin each limit record held at entry, before `apply`'s first
  start inherits it. One the daemon can't read stays for the next run, and with `persist.json`
  missing too the run writes no `persist.json`, so the next start still recovers. Every pass writes
  history before `persist.json`, syncing each log line, and a start that finds a newer recorded
  evaluation, by an evaluation serial rather than the clock, reruns it, so a crash or power cut
  between the two can't undo a reset or drop a decision. Every pass compares the whole history with
  what was written and appends the difference, so no change can miss the write. A failed write is
  retried as a snapshot every 10 minutes, and until it succeeds `persist.json` records that history
  is behind it. Recovered state is never older, by serial, than anything history recorded, and
  history that shows `apply` ran rules out `apply`'s first start. Calibration state is bound to the
  VM it learned from. A limit history recorded and `persist.json` missed or lost goes on as a limit,
  and one history shows lifted ends; a `persist.json` this run can't read rules out a first start,
  so it never grants `initial_balance`. The sustained-use cooldown follows from the limit records,
  and a failing evaluation's fallback, with the margin below the open estimate it keeps, is held
  every pass and kept in `persist.json`, so a restart, status (`failing`) and `--explain` show it
  too. A request in the seconds after a pass takes that pass's time, so nothing it records is later
  than the evaluation after it; the request and the pass decide that from one clock reading. A
  recovery without a recorded evaluation that verifies applies a reset among the newer decisions
  before raising to the newest, so a decision after the reset no longer undoes it. A reboot inside a
  slot comes back to that slot instead of reading as a clock step. If an evaluation fails, `apply`
  holds the 1.05× + 0.08 fallback, fires `calibration`, and acts on the open estimate less the
  clamp's last margin; lifted limits are still classified and sustained-use estimates restored, so
  off mode's `widen()` gate, the cooldown and the restore don't depend on the rest of calibration. A
  widening off learned from a limit entered in `apply` comes back with a lost `persist.json` too.
  `governor run` refuses to run as root, whose files the service couldn't read, and a second daemon
  exits instead of appending to the same history.
- Hold the daemon to 0.1% of one core averaged over a day with 90 days of history. The new
  `deno task bench:cpu` measures a day of control passes without the JIT, with the clamp replaying
  on every pass: 0.012 to 0.015% of a core on an M-series Mac, of which calibration and history add
  0.005 to 0.007%.
- Treat each reading as covering the interval since the previous one, 900 to 2,700 seconds apart, so
  `replay()` and the CPU comparison work with real spacing. Compare each newest reading with its
  later values; `newestFinal` reports seven days of comparisons without a revision.
- Fit Hostinger's meter, watch for upward drift with a one-sided CUSUM, and learn the billing gap
  from confirmed credit limits by bisecting a replay of settled readings. In `apply`, the acted
  estimate is the lower of the guest estimate and the readings replay plus 2.5% of capacity. Across
  reading gaps and clock-invalid time, the clamp bills the guest's count at the settings in force;
  learning bills the fitted meter across reading gaps. Each replay's base carries over, so the clamp
  stays on when its anchor ages out of history or a replay meets time no local sample covers; a
  reboot, a seed, `limit off` or a lost `persist.json` gives it a new anchor. Readings after
  intervals longer than 2,700 seconds are paired apart, in `longIntervals`, until data shows how
  Hostinger averages them.
- Treat a drift alarm as a temporary hold, not learned state. Once verified, it lasts until a fit on
  the readings after the change point qualifies; that fit, and each refit until its window has
  passed the change point, sets the margin against the one learned before the change, so an additive
  jump no longer leaves a higher multiplier behind. The alarm reads a slope only from pairs at three
  or more guest cores, so a small change at idle can't read as a multiplier of 2 or more. The fit's
  noise is never below what its light-load pairs show, and its slope bound resamples only days that
  hold a qualifying pair: idle weekend days set the multiplier as high as 1.233 after an `apply`
  start without `shadow`. A meter pair whose interval a later reading split is computed again over
  the new interval, or dropped. All three rules-mismatch tests replay to the recorded onset, so a
  short span after a lift no longer reads a gap of twice the real one, nor a 1-core meter jump as
  beyond a core, and a corroboration bills its rise only after the readings turned extreme. Readings
  are invalid for spacing when more than 12 of the last 24 hours are badly spaced, outages left out.
  On small plans a sustained-use fall must exceed the credit band's 0.3 cores as well as 20% of
  vCPUs an hour. Residuals beyond 6 σ never feed drift detection or a fit, readings at the 100% cap
  never feed drift detection, and readings marked invalid are replayed as gaps. A confirmed credit
  limit whose rise in billing agrees with the invalid readings' residual, within ±50% either way,
  makes them count again; a feed in the wrong units cannot. While readings are invalid or stale, a
  second confirmed credit limit within seven days raises a temporary hold by the full own-count
  result plus two σ; it ends when readings resume. In the recorded simulator run over ten seeds, a
  meter jump of up to 0.5 cores cost at most one limit and one of up to a core at most two; the CI
  gate allows one, one, three and four limits for jumps of 0.25, 0.5, 0.75 and 1 core.
  `governor calibrate --explain [--json]` replays the recorded decision read-only, and
  `sudo governor calibrate --reset` returns calibration to its configured start.
- Keep the seconds each slot pressed on a limit, so Hostinger's earning is replayed for the rest of
  it: a 30-second lift test no longer costs its slot all its earning, and the lift check predicts
  recovery times again. The clamp, a lower bound, keeps counting such a slot as earning nothing.
- Classify every limit at its lift as credit, sustained-use or unknown. Only a confirmed credit
  limit teaches, in every mode, so `off` now widens its margin at the lift rather than at the first
  failed lift test. After a sustained-use limit the allowance stays at or below the baseline for
  three hours, and the estimate its reset hid is restored from the guest's own count. On KVM 1 a
  sustained-use first cap must also clear the credit band. A failed lift test places the cap only if
  it found limited evidence or a later test failed too, so neighbours' steal after a lift can't make
  a credit limit sustained-use. Recovery times or gaps that the pinned rules cannot explain, judged
  from the detected lift, latch a rules mismatch, which falls back to `widen()` learning. A limit
  whose gap a reboot or clock jump leaves unmeasurable still raises the floor. The floor replays the
  settings in force, holds included. A raise made while readings are unusable is undone when the
  readings that return are corroborated as a meter change, so a jump during an outage no longer
  leaves the floor at 10%.
- In `apply`, hold at least 1.05× + 0.08 after a day of stale or invalid readings, and release the
  hold when readings resume and the fit finds one of them normal, so a feed that comes back broken
  after an outage keeps both holds and the fallback's clock. Readings beyond 6 σ that agree with the
  rise the own-count hold's limits measured count again, so a real jump during an outage still ends
  the hold. An outage of more than 6 hours counts as staleness, not as bad spacing, so readings are
  usable as soon as they return. A downward meter step beyond 6 σ keeps the readings invalid, and
  the fallback in force, until `calibrate --reset`: no billing evidence can confirm a meter that
  reads low.
- Reject configuration keys the governor doesn't know, anywhere in the file, so a misspelt setting
  fails `governor validate-config` instead of leaving its default in force. `apply` needs a token
  source or broker as well as `hostinger.vm_id`. The broker reports a wrong unit or value as
  `invalid_metrics`, so a brokered box alerts with `readings-invalid` as a direct one does. The
  direct API path takes a reading's timestamp only as the broker does, digits alone, so `"1.5"` or
  `"1e3"` no longer passes on one path and fails on the other. Both accept a reading up to 5 minutes
  ahead of this box's clock, which v0.2.5 rejected, so a slightly slow clock doesn't fail fetches. A
  value too large for a float is invalid metrics on the broker too, not a failed fetch, and a
  response without `cpu_usage` and its `usage` mapping is a failed fetch on the direct path too, not
  an empty one.
- `limit on` while a limit is already detected leaves it going, so its record still gets its lift
  and class. Requests run in the order they were sent, so `limit on` and `limit off` sent together
  no longer run the other way round, and a lift never lands before its record's entry.
- Add hooks `limit-classified` for sustained-use and unknown limits, `calibration`, `rules-mismatch`
  and `readings-invalid`, delivered after the pass sets its quota, and `credits.law` and
  `credits.calibration` in public state, whose `applied` is the settings in force: the legacy margin
  in `off` and `shadow`. `credits.anchor.applied`, always false in v0.2.5, is true while the
  readings lower the balance `apply` acts on; the hold while calibration fails shows as `failing`
  instead. `calibration` fires when learning tightens the learned settings under a higher hold too,
  once a pass and only when something changed. Reports count runway and reserve against the spending
  floor. `--explain` prints the learned settings whenever they differ from those in force, as in
  `shadow`. `learning.onset_margin_s` may be 0.
- Add an optional `recovery.quota_period_ms: 10`: a 10 ms quota period while limited, through a
  third `governor-cap` argument. It is off by default and unverified against Hostinger's scheduling.
  A failed restore of the default is retried after 15 minutes.
- Add eight-week calibration studies S1 to S14 to the simulator. CI checks each recorded outcome
  with `deno task sim:check`, and that the features each study relies on ran: the lift check
  predicted, the clamp was available, drift detection alarmed. `deno task sim:jumps` runs meter
  jumps of 0.25 to 1 core over ten seeds, during an outage and with a feed at 8x the meter, against
  the v0.3.0 criteria. `deno task sim:legacy` keeps `off` on the legacy scenarios as recorded, and
  `bench:cpu` fails above the 0.1% budget; CI runs all three. A randomized test drives the daemon
  through restarts, lost and corrupt `persist.json`, reboots, stops, clock jumps, resets and a meter
  jump, and checks after every step that nothing loosens, recovery gives back the state, and
  `calibrate --explain` equals the daemon's state.
- Address issue #12: the VM read returns the VM's IPv4 addresses next to its CPU count, and
  `governor check-hostinger` prints them as an `ipv4` array, so a deployment can require one of them
  to be among the host's own addresses. Each must be a canonical dotted quad: anything else in the
  list rejects the response, a null field means no addresses, and an older broker that omits the
  field gets a warning. The setup wizard's post-install check also requires the broker to return one
  of the addresses preflight matched to a local interface.
- Run provider diagnostics in the background after the pass sets its ceiling, with at most one
  request in flight and the 30-minute schedule and retry backoff measured from completion, so a slow
  or hung broker can't delay a pass. New requests pause while limited. Startup sizes the plan from
  `vcpus` or the kernel's CPU count and no longer asks Hostinger. Shutdown waits for the active
  request, and the installer sets `KillMode=mixed` so systemd signals only the daemon first. A
  `token_command` runs in its own session, shares a 15-second budget with the HTTP request that
  follows, and its output is capped at 8,192 bytes.

Upgrade by running the installer again, which also updates `governor-cap`. Existing configuration,
credit estimates and the legacy margin are kept, and calibration starts in `off`. The installer
checks the configuration with the new binary before it stops the daemon, so a key v0.3.0 doesn't
know stops the upgrade with the old daemon still running; fix or remove the key and run the
installer again. It also hands state files an earlier `sudo governor run` left root-owned back to
the governor user. A limit in progress during the upgrade is classified at its lift from the caps it
presses on after the upgrade, and widens the margin only if it was a credit limit. A brokered box
also needs the matching release's broker. The release publishes `hostinger-broker.py` beside the
binaries; [Hostinger credentials](docs/hostinger-credentials.md) shows how to fetch it on the VPS,
check it against `SHA256SUMS` and install it as `/usr/local/libexec/governor-hostinger.py`. Until
then a wrong unit or value from Hostinger makes readings go stale instead of raising
`readings-invalid`. Hook authors: `limit-classified`, `rules-mismatch` and `readings-invalid` are
new events, and they fire in every mode, `off` included: for a sustained-use or unknown limit, a
latched rules mismatch, and readings marked invalid. `calibration` fires only in `apply`. To try it,
set `hostinger.vm_id` and `"calibration": { "mode": "shadow" }`, then see
[Calibration](docs/calibration.md).

## v0.2.5

- Address issue #5: add root-only `governor tick` to run one control pass through the running daemon
  and wait for persisted and public state writes. Serialize requests with timed passes without
  postponing their timer. Report unavailable daemons, failed passes and timeouts to callers.
- Fold intervals shorter than `min(5 seconds, tick_seconds / 2)` into the next sample so counter
  noise cannot tighten recovery quotas. Apply queued commands and publish state on every pass. Keep
  timed control running if the optional control socket fails. Cover synchronous completion,
  concurrent requests, timed ticks and failures, plus real limit/quota verification at the
  production cadence in the Linux smoke test. Test the real control pass through the socket,
  including state-write and quota failures.

Upgrade by running the installer again, or restart the daemon after replacing the binary. Both the
CLI and running daemon need the new binary for `governor tick`. Existing configuration and credit
estimates are kept.

## v0.2.4

- Fix issue #3: embed V8's `--jitless` flag in release, CI and local compiled binaries so the
  runtime no longer needs executable memory for JIT compilation. Governor has no WebAssembly
  dependencies.
- Document an optional daemon MDWE drop-in for systemd v255+, including sudo, JIT hooks and rollback
  requirements. Its restart check discards the previous daemon's public state, so it cannot pass
  before the new daemon sets its ceiling. CI follows those steps, then runs quota control and broker
  integration with the opt-in enabled. The installer keeps the setting opt-in for older hosts.
- Require `version`, `status --json` and `report 1` to run under MDWE as root and a regular user.
  Install a JIT-enabled build of the current source, verify CPU control, and require that build to
  abort under MDWE as a negative control. This does not test a historical release binary.
- Share build commands through named tasks that compile with the Deno running the task. Keep the JIT
  fixture in a temporary directory that the smoke test removes on exit.
- Cover Ubuntu 22.04, 24.04 and 26.04, plus native ARM64 execution on 24.04. Check the production
  broker sudo grant with sudo-rs separately from full broker integration on 24.04. Run release
  packaging and its 24.04 smoke gate on pull requests, with publication restricted to version tags.

Upgrade by running the installer again. Existing configuration and v0.2 credit estimates are kept.
Read-only services can keep `MemoryDenyWriteExecute=yes` with the new binary. Daemon hardening is
optional and applies to hooks too. Remove the MDWE drop-in before installing a JIT-enabled binary.

## v0.2.3

- Address issue #1: configurable `fallback_cpu_percent`, default 20% of one vCPU. Validate it
  against the VM size, use it before startup and after stopping, and mirror it into the boot quota
  during installation. Invalid or unreadable configuration falls back to 20%. Recovery and probe
  floors remain unchanged. Document outside workloads, baseline and host-limit constraints.
- Add `schemaVersion: 1` to public state and hook snapshots without changing the persisted credit
  schema. Existing estimates survive upgrade. Built-in readers accept legacy snapshots without the
  field and reject unknown versions.
- Run hooks on a bounded background FIFO, after quota application, with captured event state. Each
  hook has its own `hook_timeout_seconds`, default 60, including time blocked on stdin. Kill its
  ordinary process group when the parent exits, at the deadline or shutdown; failures cannot hold up
  CPU control or later notifications. Limit payload/backlog memory and log drops without logging
  hook output.
- Add an operation-only `hostinger.request_command` adapter. A separate broker can return VM details
  and CPU readings without giving Governor a bearer token. Validate the versioned protocol, enforce
  response and lifetime limits, redact command errors and refuse ambiguous token sources.
- Add `governor check-hostinger` for read-only connection checks and a restricted Linux/systemd
  reference broker with encrypted worker-only credentials, fixed GET endpoints, VM authorization,
  request limits and a separate provider identity. Existing token options remain supported.
- Add a generic SSH setup wizard with hidden token entry, VPS verification, confirmation before
  installation and rollback tests. Provision the isolated worker and retire an installer-managed raw
  token into a verified encrypted backup. Refuse to copy a raw token over a broker installation.
  Share successful metrics across authorized request windows so connection checks do not consume the
  daemon's next request. Report temporary busy/cooldown refusals without accepting arbitrary error
  text. Add a dummy-token Linux integration test for the real credential/sudo/systemd path.
- Keep setup tokens out of sudo's logged stdin with a private FIFO bridge. Share API transport,
  security limits and validation with the bundled broker. Attempt every rollback step independently,
  preserve recovery files on incomplete rollback and verify fresh service state after recovery.
  Cover early failures, partial publication, failed restores and hidden-input/confirmation behavior.
  Extend the Linux test to localhost SSH, enabled sudo I/O logging, journal inspection, separate key
  ownership and a readable canary proving `ProtectHome`. Bound the worker's full lifecycle below the
  25-second caller deadline.
- Report unsupported public schemas cleanly from `status`, `report` and `exec`. Run child CLI tests
  with explicit permissions and keep writable test data separate from tracked fixtures.
- Verify setup against the new daemon's publication, not its predecessor's shutdown state. Record
  rollback intent before file changes so interrupts cannot skip restores. Test the real freshness
  check, FIFO safety refusals, stalled receivers and environment cleanup. Reuse broker VM validation
  and request construction, name setup deadlines, and document root authority and manual rotation.
  The Linux integration test now drives the actual Bash wizard through localhost SSH; offline
  adapters are installed after loading unchanged modules, without slicing source text.
- Size setup's stop and fresh-state waits from Governor's longest tick (a history request plus a
  limit test) and systemd's stop timeout, so a limit test in progress cannot roll back a good
  install. Rollback cancels the overall setup deadline and relies on its own step deadlines.
- Remove obsolete `CPUAccounting=yes` from the generated boot drop-in. Fail startup if systemd
  cannot apply the fallback, instead of starting without that cap.

Upgrade with the installer. Existing configuration and v0.2 estimates are kept. The default
fallback, credit rules and report formats are unchanged. Choosing a larger fallback is an explicit
availability tradeoff, not an automatic safety guarantee. A stale status file alone does not apply
the fallback.

Hooks no longer log stdout/stderr. Each event captures state at notification time, and the FIFO
holds at most 16 waiting events with payloads limited to 1 MiB. Overflows are logged and dropped;
delivery is best-effort. Hooks that start background work must wait for those children, since the
runner now kills remaining ordinary children when the parent exits. Move daemonized work to a
separate supervised service before upgrading.

Editing `fallback_cpu_percent` changes runtime behavior after a restart. Re-run the matching
installer to update the early-boot quota too. Broker setup is optional and separate from the regular
installer; upgrades do not automatically migrate or revoke existing tokens.

## v0.2.2

- Retire inherited, quota-only `user.slice` drop-ins into recoverable backups before installation.
  Check shadowed files too. Refuse mixed-setting files or quotas in the main unit before changing
  the installation, so unrelated settings are kept and stale persistent caps cannot override the
  boot fallback. Stop the old governor before migrating quotas and maintain a safe runtime cap.
- Support enrollment of bare service templates such as `xfs_scrub@.service` without loading an
  instance. Verify a real template instance in the Linux smoke test.
- Explain reserve rebuilding in public state and reports without treating it as a host limit or
  closing job admission. Keep compatible v0.2 estimates on upgrade. Mark CPU sample warmup and use
  reserve-aware, margin-adjusted runway in text reports too.
- Add channel-neutral resource reports with readable text tables, an HTML table-and-chart layout,
  and structured JSON through `governor report [hours] --format text|html|json`. Include an editable
  browser preview template. No bot, credentials, extra runtime or delivery mechanism is bundled.
  Test missing readings, recovery, warmup, rates, runway and HTML escaping.
- Watch Hostinger's CPU credit article. A scheduled workflow opens an issue when the article
  changes, with the reviewed and live numbers, numbers it can no longer find, contradictions inside
  the article, the changed lines, and whether the code still agrees. Only markers from the workflow
  or verified maintainers count as reported, failures are reported once per kind, and an optional
  heartbeat alerts when the watcher stops running or cannot read all essential rules. Bot markers
  inside quoted article content cannot suppress other versions.
- `rules/hostinger-cpu-credits.json` records the reviewed version (a fingerprint, the numbers and
  their source sentences, not the article). `deno task rules:accept` refuses incomplete records, and
  `deno task check` keeps `src/plans.ts` and the new `EARNING_PAUSE_SHARE` in line with the record.
  The daemon still never reads the article.

Upgrade by running the installer again. Existing v0.2 configuration and estimates are kept. Resource
reports are built in; connect their output using `docs/resource-reports.md`. The baseline, credit
policy and 20% fallback are unchanged.

## v0.2.1

- Exclude probe and lift-test intervals from quota control, outside-demand estimates, and recovery
  warnings while continuing to bill their CPU. Reset pending tests and learning across reboots.
- Back failed lift tests off for 2, 4, 8, then 15 minutes after completion. Allow evident or sharply
  increased steal to bypass a failed neighbour probe's cooldown.
- Defer margin learning until healthy burners show delivery consistent with an ongoing limit. Failed
  burners and ambiguous delivery cannot widen the margin. A first passing test leaves the margin
  unchanged without assuming a false alarm or restoring unproven credits.
- Add bounded `governor exec --wait <seconds>` and low-weight batch scopes. Document per-user
  weights, cron retry behavior, the fallback escape hatch, and the limits of aggregate quotas.
- Log recovery timing, predicted duration, conservative earning pauses, and baseline assumptions.
  Add the supplied simulator with alternate paused-billing scenarios and week-long regression tests.
- Remove the obsolete `--consumer` flag from the install example and extend the Linux smoke test to
  verify batch scope weight.

Upgrade by running the installer again. Existing v0.2 state and configuration are kept. The 20%
fallback and 60% default baseline are unchanged; live Hostinger billing still needs verification.

## v0.2.0

- Use kernel uptime and boot identity for CPU accounting and status freshness. Reboots, counter
  resets, and upgrades from v0.1 start the estimate at zero. Unknown intervals cannot earn credits.
- Make API history diagnostic only. Validate metric units and values, omit the newest bucket,
  invalidate replay certainty across gaps, compare complete guest intervals, and back off retries.
- Measure steal relative to demand. Tighten recovery quotas every minute using measured outside
  consumption and demand. Verify lift with delivered CPU and a 15% steal threshold, with independent
  tests after the earliest possible recovery time and two-minute retries.
- Require root for control requests and verify ownership at the daemon. Revoke legacy consumer write
  access. Restrict the privileged cap helper to `user.slice` and install a boot fallback quota.
- Add a configurable baseline and allow billing margins to keep learning beyond the previous caps.
  Keep the documented 60% default, with guidance for verifying the deployed rules.
- Count all CPU in the managed slice, including containers and services. Add `governor exec`,
  `enroll-service`, and `configure-docker` for workload placement and expose outside demand in
  status.
- Validate installer arguments and config, update package indexes before installing sysstat, and add
  regression tests for accounting, recovery, permissions, API failures, and installation.

Upgrade by running the installer again. The v0.1 estimate is discarded and rebuilds from observed
usage. `limit` and `seed` now require root. Service enrollment requires a restart; existing Docker
containers require recreation. API history no longer raises the balance automatically.
