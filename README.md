# hostinger-governor

Manages CPU credit spending for workloads under `user.slice`, with a conservative balance estimate
and automatic recovery from Hostinger CPU limits.

Hostinger meters VPS CPU in credits
([How CPU credits work on Hostinger VPS](https://www.hostinger.com/support/how-cpu-credits-work-on-hostinger-vps/)).
A plan earns a baseline of 60% of its vCPUs, spends what it uses, and holds at most three hours of
full use. At zero the whole VPS drops to a fraction of its CPU (30% on KVM 2, 4 and 8) until the
balance rebuilds, and while work keeps pressing on that limit, nothing is earned. A busy server can
stay limited for as long as the load lasts.

The governor measures the whole machine and caps workloads placed under `user.slice`:

- **Estimates the balance.** It reads `/proc/stat` and kernel uptime, initially allowing for 5% more
  billed CPU than the guest sees, plus 0.08 vCPU. Boot identity prevents earning across stops. After
  a reboot, counter reset, or upgrade from v0.1, the estimate starts at zero because intervening CPU
  consumption is unknown. Long gaps between samples cannot earn credits.
- **Checks API history.** Every 30 minutes it fetches CPU history, validates units and values,
  excludes the newest bucket, and compares complete intervals with guest measurements. Failures
  retry with exponential backoff. History is diagnostic only and cannot increase the estimate. The
  API does not establish whether buckets match credit billing or their timestamp semantics.
- **Spends it.** One CPU ceiling covers every login on the machine (`user.slice`). The ceiling is
  the baseline plus the balance's surplus over a 20% floor, spread across 30 minutes, minus what
  system services use. Work gets every core while the balance is high, and the balance glides onto
  the floor instead of emptying. A week's simulation in the tests never empties it and uses about
  97% of the credits earned under its stated billing and background-load assumptions. Other tests
  cover reboots, clock jumps, missing readings, recovery, permissions, and API outages; the
  simulation is not a guarantee of live Hostinger behavior.
- **Tells a limit from noisy neighbours.** Steal can come from either. When steal appears, the
  governor compares steal with demand, cuts the quota for 20 seconds, then restores it. A limit's
  steal should follow demand. This is a heuristic; the guest cannot read the host's count of
  throttled scheduling periods.
- **Recovers on its own.** Under a limit it holds every login below the limit, so earning resumes.
  It accounts for services outside the slice and tightens every minute while demand still presses on
  the limit, down to a 20% quota of one core. A load test requires less than 15% demand steal and
  actual CPU delivery above the host limit. Tests start at the estimated recovery point, or after
  the earliest possible idle recovery time, and retry every two minutes. This lets recovery finish
  even when neighbour steal prevents the estimate from rising. The billing margin can continue
  learning beyond the old caps.
- **Keeps a fallback quota.** A 20% quota of one core applies before startup, after shutdown or a
  crash, and early in boot. The helper can change only `user.slice`.

Plans are read from Hostinger's API (KVM 1 to 8).

## Install

On the VPS, as root (systemd with cgroup v2; Ubuntu 22.04+ and Debian 12+ have it):

```sh
curl -fsSL https://github.com/olmezsoy/hostinger-governor/releases/latest/download/install.sh |
  sudo bash -s -- --vm-id <id> --token-file <path> --timezone Europe/Istanbul --consumer <user>
```

- `--vm-id`: your VM's id, from hPanel or `GET /api/vps/v1/virtual-machines`.
- `--token-file`: a Hostinger API token (hPanel → Account → API). It is copied to
  `/etc/governor/hostinger-token`, readable only by root and the governor. Treat it like a password:
  it can manage the account. To keep it in a secret store instead, set
  `"token_command": ["your-cli", "get", "hostinger"]` in the config.
- `--consumer`: accepted for compatibility. All users can read status; control requires root.
- `--baseline-share`: baseline fraction for a new config, default `0.6`. Existing configs are kept;
  change `baseline_share` there when you have evidence for different rules.

The installer verifies the release checksum and installs:

- the binary at `/usr/local/bin/governor`;
- a `governor` system user with one sudo rule, for `/usr/local/libexec/governor-cap`, which sets the
  ceiling;
- the `governor.service` unit;
- `/etc/governor/config.json`;
- `sysstat`, for report history.

Running the installer again updates the governor and revokes the old consumer group's request
access. The first v0.2 startup discards the v0.1 estimate, which may have been inflated.
`--uninstall` removes the daemon and its boot quota and lifts the ceiling. Workload routing
configured separately is kept; remove those service drop-ins or restore Docker's backup if you want
to undo that routing.

## Use it

| Who                        | How                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and other services | `governor status --json`, or read `/run/governor/state.json` (world-readable). Before starting heavy work, check `accepting`; it is false while Hostinger limits the machine.          |
| People                     | `governor report [hours]`: CPU, credits, Hostinger's readings, steal, each user's share, memory, swap, load, disk.                                                                     |
| Owners                     | `sudo governor limit off` when Hostinger support lifts a limit, `sudo governor limit on` to start one by hand, `sudo governor seed <core-seconds>` to set the balance.                 |
| Events                     | Executables in `/etc/governor/hooks.d` run as the `governor` user on `limit-start` and `limit-end`, with the event in `GOVERNOR_EVENT` and the state on stdin. See `examples/hooks.d`. |

A fresh install starts the estimate at zero because the real balance is unknown. It grows from
observed CPU use. Only root can seed a known balance; API history never seeds it automatically.

## Govern service workloads

All login sessions inherit the shared quota. Docker containers and system services need explicit
placement. `coverage.outsideCores` in `governor status --json` shows measured CPU outside the slice;
`coverage.recoveryBlocked` warns when those workloads alone prevent recovery. The estimate includes
that consumption, but the governor cannot reduce an unrelated cgroup's demand.

For an individual cron job, including root's cron, run:

```sh
governor exec -- /path/to/job arg1 arg2
```

This checks that the governor is accepting work and starts a systemd scope under the managed quota.
Root uses the system manager; other users use their user manager, which must be available. For a
service or the service activated by a systemd timer:

```sh
sudo governor enroll-service heavy-job.service
sudo systemctl restart heavy-job.service
```

Enrollment writes a `Slice=user.slice` drop-in and reloads systemd. The explicit restart applies it.
To place every cron child under the quota, enroll `cron.service` the same way. Existing processes
keep their placement until restarted. Check it with
`systemctl show heavy-job.service -p ControlGroup`.

For rootful Docker:

```sh
sudo governor configure-docker
sudo systemctl restart docker
```

The command preserves other daemon settings, validates the proposed config with `dockerd`, saves the
original in `/etc/docker/daemon.json.governor-backup`, and sets the default cgroup parent to
`user.slice` with the systemd cgroup driver. Existing containers must be recreated. Per-container or
Compose `cgroup_parent` overrides must also point to `user.slice`; daemon flags must not conflict
with the JSON settings. Check a running container's `/proc/<pid>/cgroup` to verify placement. These
settings follow
[Docker's cgroup-parent documentation](https://docs.docker.com/reference/cli/dockerd/#default-cgroup-parent).

## Baseline verification

Hostinger's article repeatedly states a 60% baseline and matching capacities, but still contains a
30% formula and a conflicting FAQ. The default follows the main table; it has not been confirmed
against your VPS's billing. Ask support to confirm your plan's rules. Under a truly idle workload,
the published model predicts recovery in 24 minutes at 60%, or 84 minutes at 30%. Recovery logs
record limit start and end, but background CPU and earning pauses make elapsed time alone
inconclusive. Do not intentionally exhaust a production VPS to measure it.

If support or measurements establish a 30% baseline, set `"baseline_share": 0.3` in
`/etc/governor/config.json`, run `sudo governor validate-config`, then restart `governor.service`.
Changing the baseline resets the estimate. Capacity and recovery thresholds use the configured
baseline too.

The governor keeps:

- top-process snapshots from hot or stolen moments in `/var/lib/governor/top/<day>.log`, for a week;
- its working state in `/var/lib/governor/persist.json`.

## Limits

- Sustained work above the baseline (4.8 vCPU on KVM 8) cannot fit; it runs slower instead. If that
  is your normal load, a plan with dedicated vCPUs is the fix.
- Hostinger also throttles sustained high use as potential abuse, on rules it does not publish. The
  governor treats any limit the same way, but it cannot know that rule in advance.
- System services and containers outside `user.slice` are measured, not capped. Enroll heavy work
  using the commands above. The governor cannot guarantee recovery while outside demand remains
  above the host limit.
- Hostinger may change its rules. They live in `src/plans.ts`; check that article when it announces
  changes.

Built for my own servers and shared as is. Issues and PRs are welcome but not promised a reply. MIT
license.
