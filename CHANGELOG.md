# Changelog

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
