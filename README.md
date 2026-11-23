# hostinger-governor

Hostinger gives each VPS a CPU credit bank and limits the VM when it is empty, but publishes no
balance. The governor estimates the balance from Hostinger's own CPU readings and caps `user.slice`
so the bank does not run out. If Hostinger limits the VM anyway, the governor backs off until the
limit lifts.

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

![Diagram of how hostinger-governor works. Hostinger holds the CPU credit bank, and the VPS cannot read its balance. Every 30 seconds by default, governor.service reads CPU and steal from the kernel, updates its estimate of the bank, and sets one shared CPU quota on user.slice: every login, governor exec jobs, and services or Docker you enroll. Everything else is measured, not capped. Every 30 minutes it fetches Hostinger's CPU readings in the background. Settled readings are replayed through Hostinger's rules and move the estimate up or down. The guest's own count, 1.05 × use + 0.04 vCPU or more, covers the 30 to 100 minutes no settled reading reaches yet. After two hours without a reading, or with no token, the estimate runs on the own count alone. Spending: every vCPU while the estimate is high, then a glide onto the 10% spending floor; with no governor, the same load empties the bank and Hostinger limits the VPS. When steal follows demand during a 20-second probe at 0.2 vCPU, which runs only while user.slice has work to cut (at least 0.4 vCPU on KVM 4 and up, 0.3 on KVM 1 and 2), and burners do not then get all the CPU they ask for, or steal reaches 60% of demand and a quarter of the host limit, or burners find the VPS held at the plan's limit while work outside an idle user.slice presses on it, the governor treats the VPS as limited: it sets the estimate to 0 and holds user.slice below the host limit, down to 0.2 vCPU, until a lift test passes. At the lift, a limit whose first failed lift test found the VPS held at the plan's limit raises the pad billed on top of every reading and starts a quiet window before probing again. After any limit the estimate carries on from the guest's own count since the limit began. If the probe or cap check does not confirm a limit, the governor stays in Spending and retries in 10 minutes, doubling to 1 hour. A saved limit resumes on start. A restart keeps the estimate; after a reboot the time down counts at the most the VPS could have spent, or the estimate restarts at 0 without recent readings. While the daemon is not running, systemd holds user.slice, SSH included, at 0.2 vCPU by default.](docs/how-it-works.svg)

The governor measures the whole machine and caps workloads placed under `user.slice`:

- **Estimates the balance.** Every 30 minutes it fetches Hostinger's own CPU readings, through the
  API or the broker, and replays the settled ones through the published credit rules. Readings move
  the estimate both ways. No settled reading covers the last 30 to 100 minutes, so those come from
  `/proc/stat`: 1.05 × busy cores + 0.04, plus what the last day's readings showed above that. A
  reading under what the guest counted itself cannot be Hostinger's bill, so the own count stands in
  for it. A reading counts for at most 1.3 × the guest's count + steal + 0.3 cores, so a feed that
  breaks high cannot starve the box. Time nothing measured, as after a reboot or a hole in the
  readings, counts at the most the VM could have spent until readings settle past it. After a
  wall-clock step the estimate carries on from the own count.
  [The credit estimate](docs/estimate.md) has the details and the constants.
- **Fetches in the background.** A fetch starts after the ceiling update, with at most one in
  flight, so a slow provider or broker cannot delay CPU control. A failed fetch retries after a
  minute, doubling to 30 minutes. After two hours without a settled reading the estimate runs on the
  guest's own count alone, and `governor status` and `governor report` say since when. Without a
  Hostinger token or broker it always runs that way.
- **Spends it.** One shared CPU ceiling covers every login on the machine (`user.slice`). The
  ceiling is the baseline plus the balance's surplus over the spending floor, spread across 30
  minutes, minus what system services use. The floor is 10% of capacity. Work gets every core while
  the balance is high, and the balance glides onto the floor instead of emptying. In the week-long
  simulations the bank emptied only where Hostinger's real baseline was half the published one. See
  [study results](docs/study-results.md); a simulation is not a guarantee of live Hostinger
  behavior.
- **Tells a limit from noisy neighbours.** Steal can come from either. When steal appears, the
  governor compares steal with demand, cuts the quota for 20 seconds, then restores it. A limit's
  steal should follow demand. The probe runs only while the slice's own demand, its busy CPU and its
  share of the steal, is at least 0.4 cores (0.3 cores on KVM 1 and 2): below that the cut removes
  too little. A probe that passes is not enough either. On a real, nearly idle box its two short
  measurements scored noise and started false limits, so the governor then runs its burners, busy
  loops on more cores than the plan's limit allows. A VM that delivers what they ask is under no
  limit, and the probe is overruled. Steal of 60% of demand counts as a limit without a probe only
  when it is also a quarter of the host limit in cores; otherwise a busy slice is still probed. Work
  outside an idle slice can still press on a limit: when the whole VM sits near the host limit (85%
  of it up to +0.1 cores) with 15% steal or more, the burners decide without a probe, and there only
  a VM they find held at the plan's limit starts a limit. After a confirmed credit lift, for as long
  as full use takes to spend the 20% a lift leaves (36 minutes at cost on every plan, a few minutes
  less with the margin, measured from the last failed lift test), only evident steal starts a limit.
  Failed probes and cap checks back off from 10 minutes, doubling to an hour. Obvious or sharply
  increased steal can bypass that cooldown. This is a heuristic; the guest cannot read the host's
  count of throttled scheduling periods, so detection can be delayed and neighbours can cause false
  alarms.
- **Helps the VPS recover.** Under a limit it sets the estimate to zero and reduces login and
  enrolled-workload demand so earning can resume. It accounts for services outside the slice and
  tightens every minute while demand still presses on the limit, down to a 20% quota of one core,
  where the slice's own demand would feel the tighter quota. A load test requires less than 15%
  demand steal and actual CPU delivery above the host limit. Tests start at the estimated recovery
  point, or after the earliest possible idle recovery time. Failed tests back off for 2, 4, 8, then
  15 minutes from completion. Probe and test intervals still count toward billed CPU, but cannot
  tighten the quota or masquerade as outside demand.
- **Learns one thing from limits.** The first lift test that fails says what holds the VM. If it
  finds the VM held at the plan's limit, that is Hostinger's credit limit, and the bank emptied
  while the estimate still showed credits. The governor turns those credits into a rate, multiplies
  it by 1.25 and adds it to the pad, the cores it bills on top of every reading. A limit whose first
  failed test finds the VM held higher is something else, such as Hostinger's sustained-use limit,
  and teaches nothing. Neither does one whose first test passes, or one that found the estimate
  already empty, as when work outside the slice spends the bank. Whatever the limit was, the
  estimate carries on from what the guest's own count rebuilt since it began. Nothing from before
  the limit comes back.
- **Keeps a fallback quota.** The default is 20% of one core before startup, after shutdown or a
  crash, and early in boot. Operators can choose a different fallback. The helper can change only
  `user.slice`; recovery and probe floors still use 20%.

The plan uses configured `vcpus`, or the kernel's CPU count when unset, with Hostinger's KVM rules.
Startup and CPU control never wait for the provider. Use `governor check-hostinger` to verify the
provider's VM details and addresses separately.

The estimate has no modes and no settings. With a Hostinger token or broker configured, it follows
the readings. Without one it runs on the guest's own count. The `calibration`, `readings` and
`recovery` blocks of a v0.3 config still load; the daemon ignores them and logs one line naming
them. `sudo governor calibrate --reset` puts the pad and the addition learned from readings back to
their start.

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
- `--consumer`: accepted for compatibility. All users can read status in `/run/governor/state.json`;
  control requires root.
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
access. Before it stops the running daemon, it checks the existing config with the new binary and
stops the upgrade if that fails, for example on a key the new version doesn't know. It also gives
back to the `governor` user any of its state files a root run created, which the service couldn't
read otherwise. The first v1.0.0 start carries a v0.3 estimate over and starts from zero on anything
older; the [changelog](CHANGELOG.md) lists what carries over. `--uninstall` removes the daemon and
its boot quota and lifts the ceiling. Workload routing configured separately is kept; remove those
service drop-ins or restore Docker's backup if you want to undo that routing.

For guided operation-only API setup after installing Governor, run
`bash tools/setup-hostinger-broker.sh <SSH-destination>` from a checkout of the matching release. It
verifies the VPS, hides token input, asks before changing the server and restores the original
configuration if setup fails. See
[the setup requirements and migration notes](docs/hostinger-credentials.md#guided-setup).

## Use it

| Who                        | How                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and other services | `governor status --json`, or read `/run/governor/state.json` (world-readable). Before starting heavy work, check `accepting`; it is false while Hostinger limits the machine.                             |
| People                     | `governor report [hours]`: CPU, credits, Hostinger's readings, steal, each user's share, memory, swap, load, disk.                                                                                        |
| Owners                     | `sudo governor limit off` when Hostinger support lifts a limit, `sudo governor limit on` to start one by hand (a limit already detected goes on), `sudo governor seed <core-seconds>` to set the balance. |
| Events                     | Executables in `/etc/governor/hooks.d` run as the `governor` user on limit and calibration events, with the event in `GOVERNOR_EVENT` and the state on stdin. See `examples/hooks.d`.                     |

A fresh install starts the estimate at zero because the real balance is unknown. It grows from
observed CPU use, and with a Hostinger token or broker the readings move it from the first pass on.
Readings from before the install are not replayed. Root can state a known balance with
`governor seed`. `initial_balance` in the config does the same for the very first start only: once a
daemon has run on the box, missing state is lost state and starts from zero.

To run one control pass immediately, as root:

```sh
sudo governor tick
```

The command talks to the running daemon over its private `/run/governor/tick.sock` Unix socket. It
processes queued `limit`, `seed` and `calibrate --reset` requests, runs the same control pass as a
timed tick, and returns successfully only after `/var/lib/governor/persist.json` and
`/run/governor/state.json` are written. Calls run in sequence. Timed ticks keep their configured
interval; an on-demand pass does not restart the timer. A pass less than
`min(5 seconds, tick_seconds / 2)` after the last measured pass reuses its measurements while
applying queued commands, setting the quota and writing state. Its CPU use accumulates into the next
sample. This prevents tiny, noisy intervals from tightening a recovery quota or triggering a limit
probe. Limit probes run when a fresh sample is available and can take time. Readings fetches and
hooks continue in the background without delaying the pass.

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

If the control socket cannot start or stops accepting connections, the daemon logs the failure and
continues its timed passes. Fix the socket problem and restart the daemon to restore on-demand
ticks.

Public `/run/governor/state.json` and `governor status --json` include `"schemaVersion": 1`. Hook
snapshots use the same version. This describes the public format, not the persisted credit estimate
or the resource report's separate `schema` field. Consumers should reject unsupported versions and
tolerate additional fields within a supported version. Older releases omit the field; the built-in
reader accepts that legacy format during upgrades.

v1.0.0 keeps `schemaVersion: 1` and changes three fields under `credits`:

- `credits.calibration` is gone.
- `credits.staleSince` is new. It is the timestamp, in milliseconds, of the last settled reading
  once none has arrived for two hours. Otherwise it is null.
- `credits.anchor.applied` is true while the estimate stands on Hostinger's readings.

`credits.margin` still holds what the guest's own count charges, `mul` × busy cores + `add`, and
`credits.law.floor` is now 0.1.

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
`GOVERNOR_EVENT` naming `limit-start`, `limit-end` or `calibration`, and the captured public state
on stdin. CPU quota control happens first. Delivery runs in the background, preserving event order
and alphabetical hook order, so a slow notification destination cannot delay the control loop.

`limit-start` fires when the governor detects a limit and `limit-end` when a lift test passes.
`governor limit on` and `governor limit off` fire neither. `calibration` fires when a credit limit
raises the pad. `limit-classified`, `rules-mismatch` and `readings-invalid` no longer fire. Stale
readings have no hook; watch `credits.staleSince` in the public state. See
[the credit estimate](docs/estimate.md#credit-limits).

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

For development, use the Deno version in `.tool-versions`, which CI and release builds install.
`deno task check` runs formatting, lint, type checks and tests, and stops under any other Deno
version. Installer migration tests also run with
`python3 -m unittest discover -s test -p '*_test.py'`. Release binaries need neither runtime
installed to produce resource reports.

## Baseline verification

The directly fetched Hostinger article states a 60% baseline and matching capacities, but still
contains a 30% formula. Search-index copies have also shown different per-plan tables. The default
follows the directly fetched main table; it has not been confirmed against your VPS's billing. Ask
support to confirm your plan's rules. Under a truly idle workload, the published model predicts
recovery in 24 minutes at 60%, or 84 minutes at 30%. Each completed episode logs a
`recovery observation` with elapsed time, the configured idle minimum, a recovery prediction based
on observed charged CPU and conservative earning pauses, the baseline share, and whether a lift test
confirmed the limit. Read it with `journalctl -u governor.service`. While a limit lasts,
`governor report` shows how long it has run, the earliest idle recovery under the configured
baseline and the estimated earning pauses. Compare repeated real episodes with support's answer; the
guest cannot prove the host's earning pauses, billing, or exact lift time. Lift-test backoff can
also delay noticing a lift. The governor does not change the baseline automatically. Do not
intentionally exhaust a production VPS to measure it.

If support or measurements establish a 30% baseline, set `"baseline_share": 0.3` in
`/etc/governor/config.json`, run `sudo governor validate-config`, then restart `governor.service`.
Changing the baseline resets the estimate. Capacity and recovery thresholds use the configured
baseline too.

The governor keeps:

- top-process snapshots from hot or stolen moments in `/var/lib/governor/top/<day>.log`, for a week;
- its working state in `/var/lib/governor/persist.json`: the estimate, three hours of CPU samples
  and 72 hours of settled readings. It is private to the governor.

v0.3 also kept `history.json` and `history.log` there. v1.0.0 neither reads nor writes them, and you
can delete them.

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

Run repository checks with the Deno version in `.tool-versions`, which CI installs. Every task
except the rules watcher's stops under any other version:

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
deno task sim                                 # 15 week-long scenarios, seed 1
deno task sim "hidden overhead" 5 --episodes  # scenarios by name, seeds 1 to 5
deno task sim --detection                     # 25 limit-detection scenarios
deno task sim --studies S3                    # one eight-week study
deno task sim:check                           # all 23 studies against docs/study-results.json
deno task sim:record                          # rewrite that record
```

The week-long scenarios model neighbour steal, billing overhead, stops, outside workloads, alternate
baselines, and aggregate or per-vCPU limits. Scheduling and host earning windows are assumptions.
The original model freezes a growing bank while pressing; the `paused earning debits CPU` scenarios
instead subtract CPU consumption during pauses. `used_pct` compares billed CPU with the theoretical
baseline, including paused time, not actual earned-credit utilization. The 23 studies in
`test/studies.ts` each change one condition over eight weeks: a billing gap, a meter jump, a broken
feed, an API outage, a hole in the readings, a reboot, lost state, a wrong clock. They run in under
two minutes in sequence.

[Study results](docs/study-results.md) has the numbers. No model here validates live billing.

## Limits

- The estimate assumes Hostinger bills what its readings show plus a small constant. If real billing
  runs above the readings, the box takes a credit limit, the pad learns the difference, and that
  costs throttled time. v0.3 had the same exposure in `apply`.
- Little of this is verified on real hardware. Measured: Hostinger's readings against the guest's
  own count on two KVM 8 boxes over 10 days (1.0463 × guest cores + 0.0193) and on one live box
  (1.0075 × guest cores + 0.106); readings rising about half a core per stolen core on one box; and
  19 false credit limits in 13 days on a live box running v0.3.1 in `apply`, which v0.3.2's
  detection gates were written to stop.
- Never observed on a governed box: a real credit limit, a drift or jump in Hostinger's meter, a
  sustained-use limit, whether Hostinger bills stolen CPU, or any plan below KVM 8. What the
  governor does in those cases comes from [simulation](docs/study-results.md) only.
- Sustained work above the baseline (4.8 vCPU on KVM 8) cannot fit; it runs slower instead. If that
  is your normal load, a plan with dedicated vCPUs is the fix.
- Hostinger also throttles sustained high use as potential abuse, on rules it does not publish. The
  governor tells that limit from a credit limit by its first failed lift test: a VM held more than
  0.1 cores above the plan's limit is not under a credit limit, and the limit teaches nothing. A
  sustained-use limit that holds the VM at or under that looks like a credit limit and is treated as
  one. The governor cannot predict either.
- A settled reading is taken as final. If Hostinger revised older readings upward, the estimate
  would miss the difference until a limit taught the pad. Seven days of comparing the newest reading
  with its later values on a real box showed no revision.
- `tick_seconds` above 100 leaves limit detection fewer than the three passes in five minutes it
  needs, so no limit is recognised. The daemon logs a warning at start. The default is 30.
- System services and containers outside `user.slice` are measured, not capped. Enroll heavy work
  using the commands above. The governor cannot guarantee recovery while outside demand remains
  above the host limit. Limits that outside work causes can still raise the pad a little, when the
  estimate is just above empty as they begin, and only `sudo governor calibrate --reset` lowers it.
- An aggregate quota cannot guarantee recovery under per-vCPU throttling. Uncapped system work can
  share a throttled vCPU with the slice, and the 20% slice floor does not help there. Aggregate
  outside CPU can look harmless while a single vCPU is overloaded. Reduce or reroute that work and
  verify the deployed rules; lift-test backoff alone cannot fix it.
- Limit detection's thresholds are in cores: a probe needs 0.4 cores of slice demand, and the
  pinned-at-the-cap entry needs the VM between 85% of the host limit and 0.1 cores above it. The
  simulations in this repository model KVM 8 only, so on smaller plans, where the host limit is 0.4
  to 1.2 cores, they are unvalidated.
- Readings lag by 30 to 100 minutes. A jump in Hostinger's meter inside that window is invisible
  until a reading settles, and can cost a limit first.
- Hostinger may change its rules. They live in `src/plans.ts`; check that article when it announces
  changes.

Built for my own servers and shared as is. Issues and PRs are welcome but not promised a reply. MIT
license.
