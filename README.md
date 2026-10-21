# hostinger-governor

Manages CPU credit spending for workloads under `user.slice`, with a conservative balance estimate
and automatic recovery from Hostinger CPU limits.

## Hostinger referral discount

> [!TIP]
> **[Get 20% off your first Hostinger plan](https://www.hostinger.com/pricing/vps-hosting?REFERRALCODE=ASNVARDA3ZHG)**
>
> When I researched my own Hostinger plan, the influencer codes I found on YouTube gave 10% off.
> This referral link gives you 20% instead. It's free to use, and I may earn a commission if you buy
> through it.
>
> Open the full link; the code `ASNVARDA3ZHG` on its own won't apply the referral. Before paying,
> check that your cart shows the 20% `REF_REFERRALDISCOUNT` discount.
>
> It's for new customers who haven't already been referred. Eligible services include hosting, VPS,
> AI automation apps, email and AI Builder plans. Domain-related services aren't eligible. The
> discount is for your first eligible purchase, not renewals.

## How it works

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
- **Helps the VPS recover.** Under a limit it reduces login and enrolled-workload demand so earning
  can resume. It accounts for services outside the slice and tightens every minute while demand
  still presses on the limit, down to a 20% quota of one core. A load test requires less than 15%
  demand steal and actual CPU delivery above the host limit. Tests start at the estimated recovery
  point, or after the earliest possible idle recovery time. Failed tests back off for 2, 4, 8, then
  15 minutes from completion. Probe and test intervals still count toward billed CPU, but cannot
  tighten the quota or masquerade as outside demand. Obvious or sharply increased steal can bypass a
  neighbour-probe cooldown. These remain heuristics, so detection can be delayed and neighbours can
  cause false alarms. The margin learns only after healthy burners show delivery consistent with an
  ongoing host limit. A first test that passes leaves the margin unchanged and never restores old
  credits.
- **Keeps a fallback quota.** The default is 20% of one core before startup, after shutdown or a
  crash, and early in boot. Operators can choose a different fallback. The helper can change only
  `user.slice`; recovery and probe floors still use 20%.

Plans are read from Hostinger's API (KVM 1 to 8).

## Install

On the VPS, as root (systemd with cgroup v2; Ubuntu 22.04+ and Debian 12+ have it):

```sh
curl -fsSL https://github.com/olmezsoy/hostinger-governor/releases/latest/download/install.sh |
  sudo bash -s -- --vm-id <id> --token-file <path> --timezone Europe/Istanbul
```

- `--vm-id`: your VM's id, from hPanel or `GET /api/vps/v1/virtual-machines`.
- `--token-file`: a Hostinger API token (hPanel → Account → API). It is copied to
  `/etc/governor/hostinger-token`, readable only by root and the governor. Treat it like a password:
  it can manage the account. To keep it in a secret store instead, set
  `"token_command": ["your-cli", "get", "hostinger"]` in the config. Both options give Governor the
  raw token. For operation-only access without disclosing the token, use `request_command` instead.
  See [Hostinger credential isolation](docs/hostinger-credentials.md).
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

Release binaries and `deno task compile` embed V8's `--jitless` flag, so they run without allocating
executable memory at runtime. A service that directly runs `governor status` or `governor report`
can set `MemoryDenyWriteExecute=yes`. For a one-shot report:

```sh
sudo systemd-run --wait --pipe -p MemoryDenyWriteExecute=yes /usr/local/bin/governor report 1
```

The installer leaves daemon hardening opt-in because `governor.service` needs sudo for CPU ceilings
and optional broker requests. **The daemon opt-in requires systemd v255 or later.** Before v255,
including Ubuntu 22.04 and Debian 12, systemd implies `NoNewPrivileges=yes` for `User=` services
with this setting, which prevents sudo. CI tests the opt-in on Linux 6.8 and later.

Check `systemctl --version`, then create a dedicated drop-in:

```sh
sudo systemctl edit governor.service --drop-in=80-memory-deny-write-execute.conf
```

Add:

```ini
[Service]
MemoryDenyWriteExecute=yes
```

Restart without the previous daemon's public state, then check that the new daemon accepts work
after setting its CPU ceiling. A plain restart could pass on the state the old daemon wrote while
stopping. This removes only the runtime snapshot; credit estimates in `/var/lib/governor` are kept.

```sh
sudo systemctl stop governor.service
sudo rm -f /run/governor/state.json
sudo systemctl start governor.service
sudo governor exec --wait 60 -- /usr/bin/true
grep NoNewPrivs "/proc/$(systemctl show governor.service --property=MainPID --value)/status"
```

The last command must print `NoNewPrivs: 0`.

Hooks and other processes the daemon starts, including its sudo helpers, inherit the restriction.
Jobs started with `governor exec` run under their caller's settings instead. Hooks that start JIT
runtimes such as Node.js or Java will fail unless those runtimes use a compatible execution mode.
Remove this drop-in before installing or rolling back to a binary built with JIT enabled:

```sh
sudo rm /etc/systemd/system/governor.service.d/80-memory-deny-write-execute.conf
sudo systemctl daemon-reload
sudo systemctl restart governor.service
```

Running the installer again updates the governor and revokes the old consumer group's request
access. The first v0.2 startup discards the v0.1 estimate, which may have been inflated.
`--uninstall` removes the daemon and its boot quota and lifts the ceiling. Workload routing
configured separately is kept; remove those service drop-ins or restore Docker's backup if you want
to undo that routing.

For guided operation-only API setup after installing Governor, run
`bash tools/setup-hostinger-broker.sh <SSH-destination>` from a checkout of the matching release. It
verifies the VPS, hides token input, asks before changing the server and restores the original
configuration if setup fails. See
[the setup requirements and migration notes](docs/hostinger-credentials.md#guided-setup).

## Use it

| Who                        | How                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and other services | `governor status --json`, or read `/run/governor/state.json` (world-readable). Before starting heavy work, check `accepting`; it is false while Hostinger limits the machine.          |
| People                     | `governor report [hours]`: CPU, credits, Hostinger's readings, steal, each user's share, memory, swap, load, disk.                                                                     |
| Owners                     | `sudo governor limit off` when Hostinger support lifts a limit, `sudo governor limit on` to start one by hand, `sudo governor seed <core-seconds>` to set the balance.                 |
| Events                     | Executables in `/etc/governor/hooks.d` run as the `governor` user on `limit-start` and `limit-end`, with the event in `GOVERNOR_EVENT` and the state on stdin. See `examples/hooks.d`. |

A fresh install starts the estimate at zero because the real balance is unknown. It grows from
observed CPU use. Only root can seed a known balance; API history never seeds it automatically.

To run one control pass immediately, as root:

```sh
sudo governor tick
```

The command talks to the running daemon over its private `/run/governor/tick.sock` Unix socket. It
processes queued `limit` and `seed` requests, runs the same control pass as a timed tick, and
returns successfully only after `/var/lib/governor/persist.json` and `/run/governor/state.json` are
written. Calls run in sequence. Timed ticks keep their configured interval; an on-demand pass does
not restart the timer. Normal CPU measurements, API calls and limit probes still run, so a pass can
take time. Hooks continue in the background.

Verification scripts can check a limit without sleeping until the next tick:

```sh
sudo governor limit on
sudo governor tick
governor status --json
sudo governor limit off
sudo governor tick
governor status --json
```

`tick` exits nonzero if the daemon is unavailable, control or state writing fails, or no reply
arrives within 120 seconds. A timeout does not cancel an already requested pass. Both the CLI and
daemon must support `tick`; restart the daemon after upgrading the binary.

Public `/run/governor/state.json` and `governor status --json` include `"schemaVersion": 1`. Hook
snapshots use the same version. This describes the public format, not the persisted credit estimate
or the resource report's separate `schema` field. Consumers should reject unsupported versions and
tolerate additional fields within a supported version. Older releases omit the field; the built-in
reader accepts that legacy format during upgrades.

## Choose a fallback quota

The default `fallback_cpu_percent` is `20`, meaning **0.2 of one vCPU**, not 20% of the whole VPS.
On an eight-vCPU box, `150` means 1.5 cores shared by everyone in `user.slice`, including SSH and
enrolled services. A larger fallback can keep those services responsive while Governor is stopped.
It also gives up some credit protection.

Add the setting to the existing `/etc/governor/config.json`, keeping its other fields:

```json
{ "fallback_cpu_percent": 150 }
```

Validate and restart Governor:

```sh
sudo governor validate-config
sudo systemctl restart governor.service
```

Runtime fallback calls read the current configuration. Re-run the matching-version installer to copy
the setting into the early-boot quota too; installation and upgrades keep existing configuration.
Missing fields use the default. Values must be whole numbers from 20 to the VM's vCPU count
times 100. Invalid or unreadable configuration uses the emergency default of 20 when applying a
fallback.

Choose the value from the **verified baseline**, the CPU available while Hostinger limits the VM,
and the peak CPU used by services outside `user.slice`. Under an aggregate host limit, leave enough
room that:

```text
fallback cores + peak outside cores + headroom < min(baseline cores, host-limit cores)
```

For example, with the configured KVM 8 baseline of 4.8 cores, an aggregate limit of 2.4 cores, 0.4
cores outside the slice and 0.2 cores of headroom, a 150% fallback totals 2.1 cores. That fits those
assumptions. It is not a guarantee if Hostinger applies per-vCPU limits, the baseline differs,
outside usage spikes, or billing overhead exceeds the allowance. Keep 20 if those assumptions are
unknown. Outside services alone can prevent recovery; the slice quota cannot constrain them.

This setting applies during service startup and after stopping or crashing. A stale status file
alone does **not** activate a watchdog or change the cap. It also does not change the 20% quota used
for detection probes or the governor's recovery floor.

## Hook delivery

Place notification executables in `/etc/governor/hooks.d`. Hooks run as the `governor` user, with
`GOVERNOR_EVENT=limit-start` or `limit-end` and the captured public state on stdin. CPU quota
control happens first. Delivery runs in the background, preserving event order and alphabetical hook
order, so a slow notification destination cannot delay the control loop.

Each hook has its own deadline. `hook_timeout_seconds` defaults to 60 and accepts 1 to 300 seconds.
It includes startup and writing stdin, even if the hook never reads it or ignores SIGTERM. Governor
kills the hook's ordinary process group at the deadline, cleans up children left behind when the
hook exits, and cancels active and queued work on shutdown. Hooks should finish their own children
before exiting, not launch detached background jobs.

Delivery is best-effort, not durable: at most 16 events wait behind the active event and each
payload is limited to 1 MiB. Full queues or oversized payloads are dropped with a log message. Hook
failures are logged without copying their stdout or stderr into the daemon's logs. Notification
failure never changes credit accounting or job admission. Use a separate durable delivery process if
you need guaranteed notifications. See `examples/hooks.d` for a starting point.

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
It exits 3 without running the command if work is not accepted. For cron jobs that should wait
instead of skipping an attempt, use a bounded wait, up to 86400 seconds:

```sh
governor exec --wait 3600 -- /path/to/job arg1 arg2
```

Waiting does not reserve credits or guarantee a later run. Check exit codes and use a queue or retry
policy if every job must eventually run. The wait uses a monotonic deadline.

Root uses the system manager; other users use their user manager, which must be available. Scopes
use `CPUWeight=1` so batch competes at low priority with sibling services. For an agent with its own
login user, the containing user slice still competes with web services under `user.slice`. Set its
weight explicitly, replacing `<uid>` with that user's numeric UID:

```sh
sudo systemctl set-property user-<uid>.slice CPUWeight=1
```

Weights affect siblings under contention; they are not CPU reservations. Enrollment alone does not
prioritize services over every login. Keep latency-sensitive services outside the slice if they must
avoid probe cuts, but account for their uncapped CPU use. For a service or the service activated by
a systemd timer:

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

## Resource reports

`governor report` exposes credits, reserve-aware burst runway, earning rate, quota and recovery,
per-user CPU, and CPU, steal, memory and load charts. Choose readable text, an HTML table-and-chart
layout, or structured JSON for your own integration:

```sh
governor report
governor report 24 --format html
governor report --format json
```

All formats are built in and read-only. No extra runtime, messaging account or Hostinger token is
needed. Connect the output to Slack, Telegram, a web dashboard, or whatever you use. Delivery and
command handling stay in your integration. The [report guide](docs/resource-reports.md) covers the
data format and editable layout, including a browser preview template.

For development, use Deno 2.9.7, matching CI and release builds. `deno task check` runs formatting,
lint, type checks and tests. Installer migration tests also run with
`python3 -m unittest discover -s test -p '*_test.py'`. Release binaries need neither runtime
installed to produce resource reports.

## Baseline verification

The directly fetched Hostinger article states a 60% baseline and matching capacities, but still
contains a 30% formula. Search-index copies have also shown different per-plan tables. The default
follows the directly fetched main table; it has not been confirmed against your VPS's billing. Ask
support to confirm your plan's rules. Under a truly idle workload, the published model predicts
recovery in 24 minutes at 60%, or 84 minutes at 30%. Each completed episode logs a
`recovery observation` with elapsed time, the configured idle minimum, a recovery prediction based
on observed charged CPU and conservative earning pauses, and the baseline share. Read it with
`journalctl -u governor.service`. Compare repeated real episodes with support's answer; the guest
cannot prove the host's earning pauses, billing, or exact lift time. Probe backoff can also delay
noticing a lift. The governor does not change the baseline automatically. Do not intentionally
exhaust a production VPS to measure it.

If support or measurements establish a 30% baseline, set `"baseline_share": 0.3` in
`/etc/governor/config.json`, run `sudo governor validate-config`, then restart `governor.service`.
Changing the baseline resets the estimate. Capacity and recovery thresholds use the configured
baseline too.

The governor keeps:

- top-process snapshots from hot or stolen moments in `/var/lib/governor/top/<day>.log`, for a week;
- its working state in `/var/lib/governor/persist.json`.

## Rule changes

Hostinger can change its CPU credit rules. The watcher compares article content, not the relative
"Updated ... ago" label, which can be stale in cached HTML. It records an absolute modification
timestamp when one is available.

`rules/hostinger-cpu-credits.json` records the version this code was reviewed against: a fingerprint
of the article text, the numbers the code depends on, and the sentences they come from. It does not
copy the article.

The `Rules watch` workflow fetches the article every four hours. When the text differs from the
record, it opens an issue labelled `hostinger-rules` with the reviewed and live numbers, numbers it
can no longer find, contradictions inside the article, the new or changed lines, and whether the
code still agrees. Each version is reported once: a version counts as reported only when its exact
marker appears in an issue or comment from the workflow or someone with verified write access, so an
outside comment cannot silence an alert. Closing an issue without accepting it silences that
version. The page is read in one step without the GitHub token, and the issue is written in another
that never sees the page. Until a record exists, the first run opens an issue showing what the
watcher reads from the live page.

To accept a version, update `src/plans.ts` if the rules changed, then record the article and commit:

```sh
deno task rules:accept
git diff rules/
```

`rules:accept` refuses a record missing any essential number (baseline, capacity formula, lift and
earning-pause thresholds, and the table row and limit for each plan) or one the code disagrees with.
`deno task check` enforces the same on the committed record. It covers the plan parameters in
`src/plans.ts` and `EARNING_PAUSE_SHARE`, which the simulator models; the rest of the article,
including the leftover 0.30 earning formula and the FAQ's 20% limit, is reported for review but not
enforced. `deno task rules:check` compares without writing.

The daemon never reads the article. A help-center page is not a billing API: it contradicts itself
today, it can lag or lead real billing changes, and a governor that obeyed it would let anyone who
can edit or spoof that page decide how hard your VPS runs. Rule changes reach the governor as
reviewed releases; recovery observations are supporting evidence, not a trigger.

GitHub can delay or skip scheduled runs, and disables schedules in public repositories after 60 days
without activity. To hear about a watcher that stopped, create a check with a dead man's switch such
as [healthchecks.io](https://healthchecks.io) (period 4 hours, grace 12 hours) and save its ping URL
as the repository secret `RULES_WATCH_HEARTBEAT_URL`. Every run pings it. Failed runs, unreadable
pages and missing essential numbers ping `/fail`, even if an issue was successfully posted. The
service also alerts when pings stop. Without the secret, no heartbeat requests are sent.

## Emergency access

The default fallback is a shared 20% quota of one CPU; `fallback_cpu_percent` can change it.
Repeated crashes can leave SSH sessions and enrolled services with very little CPU. From a root
shell or the provider console:

```sh
sudo systemctl stop governor.service
sudo systemctl set-property --runtime user.slice CPUQuota=
```

This removes credit protection until the daemon restarts. Fix the configuration or service failure,
then run `sudo systemctl start governor.service` to reapply protection. Raising the fallback is not
universally safe when the host limits individual vCPUs.

## Simulations

Run repository checks with the Deno version pinned in CI, currently 2.9.7:

```sh
deno task check
python3 -m unittest discover -s test -p '*_test.py'
```

The test task needs unrestricted `--allow-run` because Deno requires that permission to signal
negative PIDs for hook process-group cleanup. Tests also invoke Bash and the Deno CLI. This does not
widen the daemon's sudo grants. Child CLI tests use explicit permissions, not unrestricted
`deno eval`. Writable test data stays in ignored `test/.tmp` directories and each test removes its
own directory. Tracked `test/fixtures` remains read-only. The Linux smoke test only runs on
disposable GitHub-hosted runners. `deno task smoke:linux <binary>` builds a JIT-enabled copy of the
current source in its own temporary directory and removes it on exit. This fixture verifies
installation and CPU control, then must abort under MDWE as a negative control. The jitless binary
must run `version`, `status --json` and `report 1` under MDWE as root and a regular user. On systemd
255+, the smoke test also applies the daemon drop-in and checks work admission before broker tests.

| Runner       | Architecture     | Broker coverage                                                                                                |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Ubuntu 22.04 | x86_64           | Skipped; systemd 249 lacks encrypted credentials.                                                              |
| Ubuntu 24.04 | x86_64 and ARM64 | Full localhost SSH, sudo I/O logging, credential and systemd flow with an offline API fixture and dummy token. |
| Ubuntu 26.04 | x86_64           | Production sudo grant with sudo-rs; full broker integration is not run.                                        |

The release workflow also runs on pull requests. It builds both Linux packages and runs the full
Ubuntu 24.04 x86_64 smoke test before publication. Only a `v*` tag can execute the publish step; the
other CI matrix jobs are separate checks.

The supplied second-by-second simulator runs the real governor against seeded workloads:

```sh
deno task sim "hidden overhead" 5 --episodes
deno task sim "paused earning debits CPU" 5
```

It models neighbour steal, billing overhead, stops, outside workloads, alternate baselines, and
aggregate or per-vCPU limits. Scheduling and host earning windows are assumptions. The original
model freezes a growing bank while pressing; the `paused earning debits CPU` scenarios instead
subtract CPU consumption during pauses. `used_pct` compares billed CPU with the theoretical
baseline, including paused time, not actual earned-credit utilization. Neither model validates live
billing.

## Limits

- Sustained work above the baseline (4.8 vCPU on KVM 8) cannot fit; it runs slower instead. If that
  is your normal load, a plan with dedicated vCPUs is the fix.
- Hostinger also throttles sustained high use as potential abuse, on rules it does not publish. The
  governor treats any limit the same way, but it cannot know that rule in advance.
- System services and containers outside `user.slice` are measured, not capped. Enroll heavy work
  using the commands above. The governor cannot guarantee recovery while outside demand remains
  above the host limit.
- An aggregate quota cannot guarantee recovery under per-vCPU throttling. The simulator's packed
  per-vCPU case remains limited even at the 20% slice floor, because uncapped system work shares the
  same throttled vCPU. Aggregate outside CPU can look harmless while a single vCPU is overloaded.
  Reduce or reroute that work and verify the deployed rules; probe backoff alone cannot fix it.
- Hostinger may change its rules. They live in `src/plans.ts`; check that article when it announces
  changes.

Built for my own servers and shared as is. Issues and PRs are welcome but not promised a reply. MIT
license.
