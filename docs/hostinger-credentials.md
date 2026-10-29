# Hostinger credential isolation

`token_file` and `token_command` give Governor the raw Hostinger token. A secret store can protect
the saved token, but once Governor receives it, Governor has all of its permissions.

A `token_command` and the following HTTP request share a 15-second budget. The command's deadline
includes waiting for stdout to close. At the deadline Governor terminates the command and its
ordinary children and closes the output reader; credential output is never included in errors. The
command may print at most 8,192 bytes.

`request_command` lets a separate broker hold the token and return only authorized results. This
option needs the broker-capable Governor build; it is not available in v0.2.2.

## Guided setup

Install the matching Governor release first. For IPv4 verification, its `check-hostinger` must
return the VM's `ipv4` list. From a checkout of the same release on your computer, run:

```sh
bash tools/setup-hostinger-broker.sh <SSH-destination>
```

Keep the wizard and both Python files together in `tools/`. The SSH destination can be an alias from
your SSH configuration or `user@server`. You need Bash, Python 3, an interactive terminal, a
verified SSH host key and passwordless sudo on the server. The server needs Linux, systemd with
encrypted credentials, Python 3 and an active Governor installation. The wizard checks prerequisites
before requesting a token. It does not accept an unknown SSH host key for you.

Use an administrator's SSH account. Setup executes bundled Python as root, so its sudo access is
equivalent to full root access, not a restricted credential-manager command. Do not grant that
permission to Governor or workload consumers just to run the wizard. After setup, Governor's
separate sudo grant permits only the fixed, no-argument broker launcher.

The three steps are to create a token in hPanel, enter it privately and verify the matching VPS,
then confirm installation. The navigation follows
[Hostinger's token instructions](https://www.hostinger.com/support/10840865-what-is-hostinger-api/).
The token stays out of arguments, environment variables and local files. It travels over SSH stdin
to an unprivileged bridge. That bridge gives sudo `/dev/null` as stdin and delivers the token
through a temporary FIFO in a private directory. A FIFO carries bytes in memory, not in a regular
file. The receiver checks its owner, permissions and file type before accepting input. The bridge
removes the FIFO after the request. Both remote processes disable core dumps before reading a token.

After installation, the wizard checks the broker's VM ID and CPU count again. When preflight matched
an IPv4 address to a local interface, the broker must return at least one of those verified
addresses too. An IPv6-only match retains the VM-ID and CPU checks because the broker returns no
IPv6 addresses.

This avoids recording the token when sudo's `log_input` is enabled. Sudo can still log the public
setup source and non-secret results. It does not receive token bytes on its logged input stream. See
[sudo's I/O logging documentation](https://www.sudo.ws/docs/man/1.9.14/sudoers.man.pdf). Root or a
compromised SSH login account can still inspect the setup process. After successful setup, only
host-bound ciphertext is retained for the installed token.

The wizard creates an isolated worker account and installs the fixed launcher and sudo rule. It
keeps other configuration and credit estimates, verifies both broker operations as Governor, and
restarts only Governor. It refuses existing broker installations and custom token commands or paths.
For the installer's `/etc/governor/hostinger-token`, it makes and verifies an encrypted root-only
backup before retiring the readable file. Failure restores the previous configuration and token
file, if present. Failed broker files are archived in the protected backup directory. A worker
account, host encryption key and sanitized cache may remain after rollback. If rollback itself
fails, each remaining restore is still attempted. The script preserves the root-only staging
directory and prints the failed steps, staging path and backup path for manual recovery. Staging can
contain a previous plaintext token awaiting restoration; do not discard it before completing
recovery. A successful rollback verifies the service and fresh state, then removes staging. Graceful
interrupts trigger recovery too. A forced kill or machine crash cannot run rollback; keep the
protected backup and staging files for manual recovery in that case.

Setup and rollback stop Governor before marking the new start. They require a state write strictly
after that boundary. The old daemon's shutdown write cannot certify a new process that never
publishes, even if the service reports active. Governor finishes its current tick and any active
diagnostics request before it stops and publishes only after its first tick, and a tick may include
a 40-second limit test. Setup therefore waits up to 105 seconds for stopping, covering systemd's
default 90-second stop timeout plus a margin, and 55 seconds for fresh state, covering one long tick
and startup. Startup uses configured vCPUs or the kernel's CPU count without contacting Hostinger.
Rollback has its own step deadlines; the overall setup deadline does not interrupt it.

The wizard does not rotate or revoke Hostinger tokens. Revoke an old token in hPanel after verifying
migration if it is no longer used elsewhere. Other copies of a token and existing credential-manager
grants are outside this script's scope. Switching the config to `request_command` by hand does not
remove old token files. The regular installer keeps direct-token support, but refuses `--token-file`
when an existing config selects a broker. External provisioning must stop passing that option too.

## Governor configuration

```json
{
  "hostinger": {
    "vm_id": 1234567,
    "request_command": ["/usr/bin/sudo", "-n", "--", "/usr/local/libexec/governor-hostinger"]
  }
}
```

Do not combine `request_command` with either token option. The executable path must be absolute.
Governor runs the command without a shell, with a clean environment and `PATH=/usr/bin:/bin`.

## Command protocol

Governor sends one JSON object on stdin, followed by a newline and EOF. It does not pass URLs,
headers, credentials or operation arguments on the command line. The protocol is versioned.

VM details:

```json
{ "version": 1, "operation": "vm", "vm_id": 1234567 }
```

CPU metrics use Unix timestamps in milliseconds. Governor requests at most 48 hours:

```json
{
  "version": 1,
  "operation": "metrics",
  "vm_id": 1234567,
  "from": 1791500000000,
  "to": 1791543200000
}
```

The command exits zero and writes one JSON response on stdout:

```json
{
  "version": 1,
  "vm_id": 1234567,
  "data": { "cpus": 8, "ipv4": [{ "address": "192.0.2.1" }] }
}
```

For metrics, `data` contains the usual `cpu_usage` object with a percent `unit` and a `usage`
mapping from Unix seconds to numeric percentages. Governor validates readings and keeps the newest
bucket out of its calculations, using it only to track revisions, unless `readings.use_newest` is on
([calibration](calibration.md#readings)). The VM ID and protocol version in the response must match
the request.

VM `ipv4` entries contain only an `address` validated as IPv4. The reference broker drops every
other address field, IPv6 and unrelated provider data. Governor validates addresses again before
returning them. A null `ipv4` field, which Hostinger's schema allows, and an omitted one from an
older broker are accepted as an empty list; malformed fields or any non-IPv4 address reject the VM
response.

An authorized request may instead receive `{"version":1,"vm_id":1234567,"error":"busy"}` or the
fixed code `rate_limited`, with exit status zero. Governor reports a temporary refusal with a retry
instruction. A metrics request may also receive the fixed code `invalid_metrics` when Hostinger
returned metrics no CPU percentage can be: a unit other than percent, a timestamp that isn't Unix
seconds, a value that isn't a number from 0 to 100, or a reading stamped more than five minutes
ahead. Governor then treats the readings as invalid, as it does on its own API path, and alerts once
with `readings-invalid`. No arbitrary error text is accepted through this channel.

Responses are limited to 4 MiB. Governor attempts to stop a command after 25 seconds. A privileged
broker must also bound its own lifetime because an unprivileged caller may not be able to terminate
it or its workers. Errors never fall back to direct token-based requests. Governor retains local
accounting and uses its existing retry backoff. It does not log broker stdout, stderr or upstream
error text.

The daemon starts diagnostics in the background after applying the CPU ceiling, with at most one
request in flight. A slow or hung request cannot delay this pass or the next one. The usual
30-minute schedule and exponential retry backoff remain; failed requests retry from completion. New
requests pause while limited. A request already in flight can finish and publish after the limit
starts, and provider work can overlap local limit tests. Shutdown stops new diagnostics and waits
for the active request within its existing deadline, so a privileged worker finishes before the next
daemon can start another request. Results from before a reboot or counter reset are discarded
without interrupting that worker. Scheduling starts fresh for each daemon, so a previous request
cannot postpone the first diagnostics check after restart. With a direct token, each restart that
reaches a full pass can make another provider request; the broker shares cached results across
restarts for its 60-second window. In calibration's `off` and `shadow` modes, provider readings
never change the ceiling, credit estimate or job admission. In `apply` they can lower the estimate
the governor acts on and tighten its margin and floor, never the reverse; see
[Calibration](calibration.md).

Re-run the regular Governor installer when upgrading. Its `KillMode=mixed` service setting sends the
initial stop signal to the daemon so its broker launcher can finish; systemd still cleans up
remaining children afterward. Replacing only the binary keeps the old service setting. This also
lets an active probe or lift test, including its CPU burners, finish before stopping. Hooks still
cancel their own process groups. The 40-second limit-test budget plus a 25-second broker request
fits within systemd's default 90-second stop timeout.

The installer doesn't touch an installed broker, and the setup wizard refuses to overwrite its
files. Replace the broker's source with the matching release's copy as root. The release publishes
`hostinger-broker.py` beside the binaries, so on the VPS, after upgrading Governor:

```sh
cd "$(mktemp -d)"
base=https://github.com/olmezsoy/hostinger-governor/releases/download/v$(governor version)
curl -fsSLO "$base/hostinger-broker.py" && curl -fsSLO "$base/SHA256SUMS" &&
  grep ' hostinger-broker.py$' SHA256SUMS | sha256sum -c - &&
  sudo install -o root -g root -m 0644 hostinger-broker.py /usr/local/libexec/governor-hostinger.py
```

A checkout of that release has the same file at `tools/hostinger-broker.py`.

The launcher and sudo rule stay as they are, and the next request runs the new source. Until then an
older broker reports a wrong unit or value as a plain failure, so readings go stale instead of
raising `readings-invalid`, and a broker older than the IPv4 change omits `ipv4`.

The reference broker uses nested budgets: a 15-second API timeout, 18-second worker runtime,
23-second `systemd-run` timeout, 24-second launcher alarm and Governor's 25-second command deadline.
Systemd bounds the start job and worker startup at three seconds, and stop at one second. Startup,
runtime and stop together fit inside the outer command budget. The shared protocol fixture tests
these limits, cooldown, connection-check window, capability marker, temporary error codes and the
non-IPv4 values both sides must reject. Hooks and token commands use their own runners because they
need process-group cleanup, while a broker has bounded JSON output and can be privileged.

Run `governor check-hostinger` as the daemon's Unix user to test both operations without changing
the credit estimate. It prints the VM ID, CPU count, an `ipv4` array of address strings and the
number of complete CPU readings. A deployment can require an address in `ipv4` to match one of the
host's own addresses, in addition to checking the CPU count. An empty list cannot verify the host's
identity. An older broker that omits the field produces a warning on stderr while stdout remains
JSON. A present empty or null list does not trigger the upgrade warning. Upgrade both Governor and
the installed broker to obtain addresses. The reference broker refreshes a cached VM response that
lacks `ipv4` once after an upgrade, even within the 60-second cache window; subsequent requests
share the new result. Failed refreshes still consume the rate allowance.

## Reference broker

[tools/hostinger-broker.py](../tools/hostinger-broker.py) supplies a Linux/systemd implementation.
It needs separate root provisioning. Selecting `request_command` does not install it or grant sudo
access automatically.

Its no-argument launcher starts a short-lived `key-manager-hostinger` worker. Only that worker gets
the encrypted Hostinger credential. The worker cannot access home directories, including unrelated
SSH keys, or Governor's private configuration and state. It permits only GET requests for the
configured VM's details and recent CPU metrics, verifies HTTPS, refuses redirects, ignores proxy
environment variables and returns only the validated CPU count, IPv4 addresses and CPU metrics. Each
operation permits at most one upstream attempt per minute; failed attempts count too. The one
exception is the single refresh of a VM response cached by an older broker without `ipv4`.
Successful metric requests cache a rolling 48-hour window, then filter it to each caller's
authorized interval. Connection checks and daemon fetches share that cache for one minute despite
differing timestamps. Request locking prevents concurrent workers. A check during an in-flight
request may report `busy`; a failed upstream attempt can report `rate_limited` during cooldown.
Neither means the connection configuration is broken.

Home-directory keys are blocked by `ProtectHome`. Keys outside home directories rely on their Unix
permissions; the broker cannot discover every secret path on a server. Keep them private to their
own accounts. The broker deliberately keeps the direct client's tested `Deno/2.9.7` User-Agent
because Hostinger edge filtering rejected Python's default during deployment testing.

Provision these paths as root:

| Path                                       | Owner / mode | Content                                           |
| ------------------------------------------ | ------------ | ------------------------------------------------- |
| `/etc/key-manager/hostinger/`              | root / 0755  | Broker configuration and encrypted credential     |
| `/etc/key-manager/hostinger/config.json`   | root / 0644  | `{"vm_id":1234567}`                               |
| `/etc/key-manager/hostinger/token.cred`    | root / 0600  | Host-bound encrypted `hostinger-token` credential |
| `/usr/local/libexec/governor-hostinger.py` | root / 0644  | Reference broker source                           |
| `/usr/local/libexec/governor-hostinger`    | root / 0755  | Fixed launcher below                              |
| `/etc/sudoers.d/governor-hostinger`        | root / 0440  | Exact no-argument sudo rule below                 |

Create the `key-manager-hostinger` system user and group with no login shell, no home directory and
no access to other credentials. Keep all parent directories root-owned and non-writable by other
users. The public broker configuration must be traversable by the worker. Do not loosen an existing
secret directory's permissions to make it work; use a separate provisioning path instead.

The fixed launcher:

```sh
#!/bin/sh
[ "$#" -eq 0 ] || { echo "Arguments are not authorized." >&2; exit 2; }
exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /usr/bin/python3 -I /usr/local/libexec/governor-hostinger.py
```

The sudo rule allows no arguments. Validate it with `visudo` before use:

```sudoers
governor ALL=(root) NOPASSWD: /usr/local/libexec/governor-hostinger ""
```

Encrypt the token through stdin with `systemd-creds encrypt --with-key=host --name=hostinger-token`.
Never put it in command arguments, environment variables, logs or a checked-in file. The launcher
uses `LoadCredentialEncrypted` for the isolated worker, not for `governor.service`. Systemd creates
the worker's private cache directory at `/var/lib/key-manager-hostinger`.

Keep broker credentials and sudo grants under your credential-management policy. The Governor
installer does not create, rotate or remove them. On uninstall, revoke this separate sudo grant and
retire the worker and credential when nothing else needs them.

Protected migration archives are not deleted automatically. After verifying migration and revoking
unused old tokens, review those archives under your backup-retention policy. Removing files alone
does not revoke a token or remove copies from server snapshots.

## Rotate an installed broker token

The wizard refuses existing broker installations. Rotation is a manual administrator operation;
schedule it before the expiry chosen in hPanel. An expired token disables API diagnostics, not local
CPU accounting or quota control. Calibration loses its readings too: in every mode, fitting and
drift detection pause after two hours, and after a day `apply` holds at least 1.05× + 0.08 until
readings resume ([stale readings](calibration.md#stale-and-invalid-readings)). Do not delete the
installed broker to make the wizard run again.

1. Create a replacement token in the same Hostinger account. Keep the old token valid until the new
   one has passed a connection check.
2. Deliver it using your credential manager's private input mechanism. Never put it in command
   arguments, environment variables or sudo's logged input. A root shell launched through an
   I/O-logged sudo session is not a safe place to type the replacement token either.
3. As root, encrypt it into a new file in a root-only staging directory with
   `systemd-creds encrypt --with-key=host --name=hostinger-token - <staged-credential>`. The token
   belongs on the command's private stdin; `<staged-credential>` is only the ciphertext output path.
   Verify decryption against the supplied token in memory without printing either value. See the
   [systemd-creds reference](https://github.com/systemd/systemd/blob/main/man/systemd-creds.xml) for
   input paths and credential names.
4. Preserve the current encrypted credential in a root-only backup. Make the new ciphertext
   root-owned, mode 0600, then atomically replace `/etc/key-manager/hostinger/token.cred`. Keep the
   configured VM ID, worker account and sudo rule unchanged.
5. Wait at least 90 seconds for an existing worker and its one-minute cached results to expire. Run
   `governor check-hostinger` as the Governor Unix user. Both VM details and CPU metrics must
   succeed. A busy or rate-limited response is temporary; wait 60 seconds and retry. The short-lived
   worker loads the new credential on its next run, so Governor does not need a restart.
6. If verification fails, restore the previous ciphertext atomically and repeat the wait and check.
   Once the replacement works, revoke the old token in hPanel if no other integration uses it, then
   retire backup copies according to your retention policy. Set a reminder for the new expiry.

These steps assume an administrator-controlled credential channel. If you do not have one, arrange
that first rather than pasting a token into a recorded terminal or relaxing the broker's sudo grant.

This protects against credential extraction and excessive API authority by Governor or other
unprivileged consumers. Root, a compromised worker, or theft of both the encrypted file and the host
encryption key can still expose the token. Host-only encryption does not protect a complete VPS
snapshot. Central management does not require putting every credential under one readable Unix
identity.
