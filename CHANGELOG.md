# Changelog

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
