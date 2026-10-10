# hostinger-governor

Keeps a Hostinger VPS from running out of CPU credits, while spending every credit it can on real
work.

Hostinger meters VPS CPU in credits
([How CPU credits work on Hostinger VPS](https://www.hostinger.com/support/how-cpu-credits-work-on-hostinger-vps/)).
A plan earns a baseline of 60% of its vCPUs, spends what it uses, and holds at most three hours of
full use. At zero the whole VPS drops to a fraction of its CPU (30% on KVM 2, 4 and 8) until the
balance rebuilds, and while work keeps pressing on that limit, nothing is earned. A busy server can
stay limited for as long as the load lasts.

The governor is one small daemon that owns this problem for the whole machine:

- **Mirrors the balance.** The API reports no balance, so it keeps a conservative estimate from
  `/proc/stat`. It assumes Hostinger bills 5% more CPU than the guest sees, plus 0.08 vCPU. Every 15
  minutes it replays Hostinger's own CPU readings through the rules to anchor the estimate.
- **Spends it.** One CPU ceiling covers every login on the machine (`user.slice`). The ceiling is
  the baseline plus the balance's surplus over a 20% floor, spread across 30 minutes, minus what
  system services use. Work gets every core while the balance is high, and the balance glides onto
  the floor instead of emptying. A week's simulation in the tests never empties it and uses about
  97% of the credits earned.
- **Tells a limit from noisy neighbours.** Steal can come from either. When steal appears, the
  governor cuts demand for 20 seconds, then restores it. A limit's steal follows demand; neighbours'
  does not.
- **Recovers on its own.** Under a limit it holds every login below the limit, so earning resumes.
  It widens its own safety margin by the drift the limit proved, and runs your hooks. Once the
  balance is back at the recovery point, it confirms the lift with a short load test.
- **Fails safe.** If the daemon stops or crashes, systemd sets a ceiling under the baseline.

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
- `--consumer`: users allowed to run `governor limit` and `governor seed`.

The installer verifies the release checksum and installs:

- the binary at `/usr/local/bin/governor`;
- a `governor` system user with one sudo rule, for `/usr/local/libexec/governor-cap`, which sets the
  ceiling;
- the `governor.service` unit;
- `/etc/governor/config.json`;
- `sysstat`, for report history.

Running the installer again updates the governor. `--uninstall` removes it and lifts the ceiling.

## Use it

| Who                        | How                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts and other services | `governor status --json`, or read `/run/governor/state.json` (world-readable). Before starting heavy work, check `accepting`; it is false while Hostinger limits the machine.          |
| People                     | `governor report [hours]`: CPU, credits, Hostinger's readings, steal, each user's share, memory, swap, load, disk.                                                                     |
| Owners                     | `governor limit off` when Hostinger support lifts a limit, `governor limit on` to start one by hand, `governor seed <core-seconds>` to set the balance.                                |
| Events                     | Executables in `/etc/governor/hooks.d` run as the `governor` user on `limit-start` and `limit-end`, with the event in `GOVERNOR_EVENT` and the state on stdin. See `examples/hooks.d`. |

A fresh install starts the estimate at zero, because the real balance is unknown. The first anchor
to Hostinger's readings, within about 15 minutes, raises it.

The governor keeps:

- top-process snapshots from hot or stolen moments in `/var/lib/governor/top/<day>.log`, for a week;
- its working state in `/var/lib/governor/persist.json`.

## Limits

- Sustained work above the baseline (4.8 vCPU on KVM 8) cannot fit; it runs slower instead. If that
  is your normal load, a plan with dedicated vCPUs is the fix.
- Hostinger also throttles sustained high use as potential abuse, on rules it does not publish. The
  governor treats any limit the same way, but it cannot know that rule in advance.
- System services outside `user.slice` are measured, not capped.
- Hostinger may change its rules. They live in `src/plans.ts`; check that article when it announces
  changes.

Built for my own servers and shared as is. Issues and PRs are welcome but not promised a reply. MIT
license.
