# Changelog

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
