#!/usr/bin/env python3
"""Bundle, unprivileged token bridge and root transaction for the SSH wizard."""

import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import pwd
import grp
import re
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from types import ModuleType
import select
import shlex
import signal

if "BROKER_SOURCE" not in globals():
    BROKER_SOURCE = Path(__file__).with_name("hostinger-broker.py").read_text()
BROKER = ModuleType("hostinger_reference")
exec(compile(BROKER_SOURCE, "hostinger-reference", "exec"), BROKER.__dict__)

CONFIG = Path("/etc/governor/config.json")
BROKER_CONFIG = BROKER.CONFIG
BROKER_DIR = BROKER_CONFIG.parent
ENCRYPTED = Path(BROKER.ENCRYPTED)
BROKER_CODE = Path(BROKER.WORKER)
HELPER = BROKER.HELPER
SUDOERS = BROKER.SUDOERS
HOST_KEY = Path("/var/lib/systemd/credential.secret")
LEGACY_TOKEN = Path("/etc/governor/hostinger-token")
API = BROKER.API
PROVIDER = ["/usr/bin/sudo", "-n", "--", str(HELPER)]
WRAPPER = BROKER.launcher_text()
SUDO_RULE = BROKER.sudo_rule()
SafeError = BROKER.Refused
NoRedirect = BROKER.NoRedirect
api_get = BROKER.api_body
require = BROKER.require
SETUP_MODES = ("preflight", "inspect", "apply")
FINGERPRINT_PATTERN = r"[a-f0-9]{64}"
PIPE_READY = b"GOVERNOR_TOKEN_PIPE_READY\n"
PIPE_OPEN_SECONDS = 30
ROOT_SETUP_SECONDS = 600
LOCAL_COMMAND_SECONDS = 30
QUICK_COMMAND_SECONDS = 5
CHILD_CLEANUP_SECONDS = 5
# check-hostinger makes two broker requests, each with Governor's deadline.
CONNECTION_CHECK_SECONDS = 2 * BROKER.REQUEST_SECONDS + QUICK_COMMAND_SECONDS
# Governor honours SIGTERM only between ticks, and publishes its first state
# after one plan lookup and one full tick. A tick may hold a history request
# (Governor's broker deadline) and a limit probe: 20 s capped, then 20 s
# restored. A lift test runs instead of both and is shorter. Pinned against
# governor.ts by governor_limit_test_ms in test/fixtures/hostinger-protocol.json.
GOVERNOR_LIMIT_TEST_SECONDS = 40
GOVERNOR_TICK_SECONDS = BROKER.REQUEST_SECONDS + GOVERNOR_LIMIT_TEST_SECONDS
# governor.service sets no TimeoutStopSec, so systemd waits its default 90 s
# for a tick to finish before killing the daemon. Outlast that wait.
SYSTEMD_STOP_SECONDS = 90
STOP_SECONDS = SYSTEMD_STOP_SECONDS + 15
# No Type= is set: start returns once ExecStartPre has applied the fallback.
START_SECONDS = 45
# Deno startup and scheduling get 15 s on top of the plan lookup and first tick.
FRESH_STATE_SECONDS = BROKER.REQUEST_SECONDS + GOVERNOR_TICK_SECONDS + 15
# The last status call may begin just before the deadline, then sleep once.
FRESH_STATE_WAIT_SECONDS = FRESH_STATE_SECONDS + QUICK_COMMAND_SECONDS + 1
# Rollback: stop, restore files, daemon-reload, start, is-active, fresh state.
# File restores are local renames; 15 s covers them and scheduling.
RECOVERY_SECONDS = (
    STOP_SECONDS
    + 15
    + LOCAL_COMMAND_SECONDS
    + START_SECONDS
    + LOCAL_COMMAND_SECONDS
    + FRESH_STATE_WAIT_SECONDS
)
# Rollback cancels the root deadline, so the bridge must outlive both phases.
BRIDGE_SECONDS = ROOT_SETUP_SECONDS + RECOVERY_SECONDS + 30


def provider_command():
    return ["/usr/bin/sudo", "-n", "--", str(HELPER)]


def run(argv, *, data=None, timeout=LOCAL_COMMAND_SECONDS, env=None):
    result = subprocess.run(
        argv,
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=env,
    )
    require(
        result.returncode == 0, "A local setup command failed: " + Path(argv[0]).name
    )
    return result.stdout


def protected(path, *, directory=False):
    info = path.lstat()
    require(
        (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        and info.st_uid == 0
        and not info.st_mode & 0o022,
        "Unsafe owner, permissions or file type: " + str(path),
    )
    return info


def vm_ips(vm):
    return {
        str(ipaddress.ip_address(item["address"]))
        for key in ("ipv4", "ipv6")
        for item in (vm.get(key) or [])
        if isinstance(item, dict) and item.get("address")
    }


def validate_vm(token):
    interfaces = json.loads(run(["/usr/sbin/ip", "-j", "address", "show"]))
    local_ips = {
        str(ipaddress.ip_address(item["local"]))
        for link in interfaces
        for item in link.get("addr_info", [])
        if item.get("local") and ipaddress.ip_address(item["local"]).is_global
    }
    require(
        local_ips,
        "This server has no public interface address to match against Hostinger.",
    )
    machines = api_get(token)
    require(isinstance(machines, list), "Unrecognized VPS-list response.")
    matches = [vm for vm in machines if isinstance(vm, dict) and vm_ips(vm) & local_ips]
    require(
        len(matches) == 1,
        "Token must identify exactly one VPS matching this server IP.",
    )
    vm_id = matches[0].get("id")
    require(
        type(vm_id) is int and 0 < vm_id <= BROKER.MAX_VM_ID,
        "Hostinger returned an invalid VM ID.",
    )
    vm = api_get(token, "/" + str(vm_id))
    require(
        isinstance(vm, dict) and vm.get("id") == vm_id and vm_ips(vm) & local_ips,
        "VM details do not match this server.",
    )
    validated_vm = BROKER.sanitize(vm, {"operation": "vm", "vm_id": vm_id})
    cpus = sum(
        bool(re.match(r"^cpu\d+\s", line))
        for line in Path("/proc/stat").read_text().splitlines()
    )
    require(
        validated_vm["cpus"] == cpus,
        "Hostinger CPU count does not match this server; configuration was not changed.",
    )
    end = int(time.time() * 1000)
    request = {
        "vm_id": vm_id,
        "operation": "metrics",
        "from": end - BROKER.CHECK_WINDOW_MS,
        "to": end,
    }
    body = api_get(token, BROKER.request_suffix(request))
    validated = BROKER.sanitize(body, request)
    usage = validated["cpu_usage"]["usage"]
    require(isinstance(usage, dict) and len(usage) > 0, "CPU metrics are missing.")
    return {"vm_id": vm_id, "cpus": cpus, "cpu_samples": len(usage)}


def validate_worker_identity(*, missing_ok=True):
    governor = pwd.getpwnam("governor")
    try:
        group = grp.getgrnam(BROKER.WORKER_ACCOUNT)
    except KeyError:
        group = None
    if group is not None:
        require(
            group.gr_gid not in (0, governor.pw_gid) and not group.gr_mem,
            "Worker group is shared with another account.",
        )
    try:
        account = pwd.getpwnam(BROKER.WORKER_ACCOUNT)
    except KeyError:
        require(missing_ok, "The worker account was not created.")
        return
    require(group is not None, "Existing worker account has no dedicated group.")
    require(
        account.pw_gid == group.gr_gid
        and account.pw_uid not in (0, governor.pw_uid)
        and account.pw_dir == "/nonexistent"
        and account.pw_shell == "/usr/sbin/nologin"
        and set(os.getgrouplist(BROKER.WORKER_ACCOUNT, group.gr_gid)) == {group.gr_gid},
        "Existing worker account is not isolated as expected.",
    )
    # NSS may contain another user whose primary group is the worker's group,
    # even when gr_mem is empty. Refuse that shared credential identity too.
    require(
        all(
            user.pw_name == BROKER.WORKER_ACCOUNT
            or (user.pw_uid != account.pw_uid and user.pw_gid != group.gr_gid)
            for user in pwd.getpwall()
        ),
        "Worker primary group is shared with another account.",
    )


def preflight():
    require(os.geteuid() == 0, "Remote setup must run through sudo.")
    for command in (
        "/usr/sbin/ip",
        "/usr/bin/systemd-creds",
        "/usr/bin/systemd-run",
        "/usr/bin/systemctl",
        "/usr/sbin/runuser",
        "/usr/sbin/visudo",
        "/usr/sbin/useradd",
        "/usr/sbin/groupadd",
        "/usr/local/bin/governor",
    ):
        require(
            os.access(command, os.X_OK), "Required command is unavailable: " + command
        )
    help_result = subprocess.run(
        ["/usr/local/bin/governor", "check-hostinger", "--help"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=QUICK_COMMAND_SECONDS,
    )
    require(
        help_result.returncode == 0
        and BROKER.CAPABILITY.encode() in help_result.stdout,
        "Governor needs the operation-only broker update before this wizard can run.",
    )
    protected(CONFIG.parent, directory=True)
    protected(CONFIG)
    original = CONFIG.read_bytes()
    cfg = json.loads(original)
    h = cfg.get("hostinger", {})
    if h is None:
        h = {}
    require(isinstance(h, dict), "Invalid Hostinger configuration.")
    require(
        not h.get("token_command") and not h.get("request_command"),
        "A custom token command or broker already exists; migrate it manually.",
    )
    require(
        not h.get("token_file") or h["token_file"] == str(LEGACY_TOKEN),
        "A custom token path exists; migrate it manually before running this wizard.",
    )
    if os.path.lexists(LEGACY_TOKEN):
        info = protected(LEGACY_TOKEN)
        require(
            info.st_size <= BROKER.MAX_TOKEN_BYTES and not info.st_mode & 0o007,
            "The existing token file is oversized or readable by unrelated users.",
        )
    for target in (BROKER_DIR, BROKER_CODE, HELPER, SUDOERS):
        require(
            not os.path.lexists(target),
            "Broker setup files already exist; they will not be overwritten: "
            + str(target),
        )
    for directory in (
        Path("/etc"),
        Path("/etc/sudoers.d"),
        Path("/usr"),
        Path("/usr/local"),
        Path("/usr/local/libexec"),
        Path("/var"),
        Path("/var/backups"),
    ):
        protected(directory, directory=True)
    if BROKER_DIR.parent.exists():
        info = protected(BROKER_DIR.parent, directory=True)
        require(
            info.st_mode & 0o001,
            "/etc/key-manager must be traversable for the isolated worker; it was not changed.",
        )
    if os.path.lexists(HOST_KEY):
        info = protected(HOST_KEY)
        require(
            not info.st_mode & 0o077,
            "The existing host encryption key has unsafe permissions.",
        )
    validate_worker_identity()
    run(["/usr/bin/systemctl", "is-active", "--quiet", "governor.service"])
    return cfg, original


def write_private(path, content, mode=0o600, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fchown(stream.fileno(), 0, gid)
        os.fsync(stream.fileno())


def wait_for_daemon(since):
    deadline = time.monotonic() + FRESH_STATE_SECONDS
    while time.monotonic() < deadline:
        try:
            state = json.loads(
                run(
                    ["/usr/local/bin/governor", "status", "--json"],
                    timeout=QUICK_COMMAND_SECONDS,
                )
            )
            # A shutdown write can share the stop boundary's millisecond. Only
            # a strictly later write proves the new process has published.
            updated = state.get("updatedAt") if isinstance(state, dict) else None
            if (
                type(updated) in (int, float)
                and math.isfinite(updated)
                and updated > since
            ):
                return state
        except (SafeError, OSError, ValueError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise SafeError("Governor did not publish fresh state after restart.")


def stop_governor():
    run(["/usr/bin/systemctl", "stop", "governor.service"], timeout=STOP_SECONDS)


def start_governor():
    """Start Governor after stop_governor() and wait for its first publication."""
    # stop_governor() returned after the old daemon's shutdown write, so this
    # boundary cannot be satisfied by the previous process.
    since = int(time.time() * 1000)
    run(["/usr/bin/systemctl", "start", "governor.service"], timeout=START_SECONDS)
    run(["/usr/bin/systemctl", "is-active", "--quiet", "governor.service"])
    return wait_for_daemon(since)


def rollback(
    stage,
    backup,
    original,
    *,
    changed,
    legacy_moved,
    published,
    broker_directory_created
):
    # Every recovery step has its own timeout (RECOVERY_SECONDS in total). Stop
    # the forward deadline so it cannot interrupt a restore partway through.
    signal.alarm(0)
    failures = []

    def attempt(name, action):
        try:
            action()
        except BaseException:
            failures.append(name)

    def restore_config():
        write_private(
            stage / "restore.json",
            original,
            mode=0o640,
            gid=pwd.getpwnam("governor").pw_gid,
        )
        os.replace(stage / "restore.json", CONFIG)

    def restore_token():
        previous = stage / "previous-token"
        if os.path.lexists(previous):
            os.replace(previous, LEGACY_TOKEN)
        else:
            require(os.path.lexists(LEGACY_TOKEN), "Previous token is missing.")

    if changed:
        attempt("stop governor", stop_governor)
        attempt("restore configuration", restore_config)
    if legacy_moved:
        attempt("restore previous token", restore_token)
    for target in reversed(published):
        if os.path.lexists(target):
            attempt(
                "archive " + target.name,
                lambda target=target: os.replace(
                    target, backup / ("rejected-" + target.name)
                ),
            )
    if broker_directory_created and BROKER_DIR.exists():
        attempt("remove broker directory", BROKER_DIR.rmdir)
    if changed:
        attempt("reload systemd", lambda: run(["/usr/bin/systemctl", "daemon-reload"]))
        attempt("start governor and verify fresh state", start_governor)
    if failures:
        print(
            "Rollback needs attention: "
            + ", ".join(failures)
            + ". Protected backup: "
            + str(backup)
            + "; preserved staging: "
            + str(stage),
            file=sys.stderr,
        )
    elif backup:
        print(
            "Setup failed; original configuration restored and Governor verified. Backup: "
            + str(backup),
            file=sys.stderr,
        )
    return not failures


def encrypt_verified(raw, target, name):
    run(
        [
            "/usr/bin/systemd-creds",
            "encrypt",
            "--with-key=host",
            "--name=" + name,
            "-",
            str(target),
        ],
        data=raw,
    )
    os.chmod(target, 0o600)
    recovered = run(
        ["/usr/bin/systemd-creds", "decrypt", "--name=" + name, str(target), "-"]
    )
    require(hmac.compare_digest(recovered, raw), "Encrypted token verification failed.")


def bundle_source():
    setup = globals().get("SETUP_SOURCE")
    if setup is None:
        setup = Path(__file__).read_text()
    return (
        "BROKER_SOURCE = "
        + repr(BROKER_SOURCE)
        + "\nSETUP_SOURCE = "
        + repr(setup)
        + '\nexec(compile(SETUP_SOURCE, "governor-setup", "exec"))\n'
    )


def fifo_input(path):
    require(os.geteuid() == 0, "FIFO receiver requires sudo.")
    pipe = Path(path)
    owner = int(os.environ.get("SUDO_UID", "0"))
    parent = pipe.parent.lstat()
    require(
        pipe.is_absolute()
        and stat.S_ISDIR(parent.st_mode)
        and parent.st_uid == owner
        and not parent.st_mode & 0o077,
        "Unsafe token pipe directory.",
    )
    info = pipe.lstat()
    require(
        stat.S_ISFIFO(info.st_mode)
        and info.st_uid == owner
        and not info.st_mode & 0o077,
        "Unsafe token pipe.",
    )
    fd = os.open(pipe, os.O_RDONLY | os.O_NOFOLLOW)
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
        os.close(fd)
        raise SafeError("Token pipe changed during setup.")
    sys.stdout.write(PIPE_READY.decode())
    sys.stdout.flush()
    return os.fdopen(fd, "rb")


def wait_for_pipe_ready(stream):
    deadline = time.monotonic() + PIPE_OPEN_SECONDS
    received = b""
    while received != PIPE_READY:
        ready, _, _ = select.select(
            [stream], [], [], max(0, deadline - time.monotonic())
        )
        require(
            ready, "Privileged setup did not open the token pipe; no token was sent."
        )
        # readline() after select can still block forever on a partial line.
        part = os.read(stream.fileno(), len(PIPE_READY) - len(received))
        received += part
        require(
            part and PIPE_READY.startswith(received),
            "Privileged setup did not open the token pipe; no token was sent.",
        )


def bridge(mode, fingerprint="", *, root_command=None):
    require(mode in SETUP_MODES, "Invalid bridge mode.")
    require(
        not fingerprint or re.fullmatch(FINGERPRINT_PATTERN, fingerprint),
        "Invalid fingerprint.",
    )
    raw = (
        b""
        if mode == "preflight"
        else sys.stdin.buffer.read(BROKER.MAX_TOKEN_BYTES + 1)
    )
    if mode != "preflight":
        BROKER.validate_token(raw)
    command = root_command or [
        "/usr/bin/sudo",
        "-n",
        "/usr/bin/python3",
        "-I",
        "-c",
        bundle_source(),
    ]
    with tempfile.TemporaryDirectory(prefix="governor-token-pipe.") as directory:
        pipe = Path(directory) / "token"
        holding = None
        child = None
        try:
            args = [mode] + ([fingerprint] if fingerprint else [])
            if mode != "preflight":
                os.mkfifo(pipe, 0o600)
                os.chmod(pipe, 0o600)
                # Keep a reader/writer open until the receiver confirms that it
                # owns a read descriptor. No token bytes enter this placeholder.
                holding = os.open(pipe, os.O_RDWR | os.O_NOFOLLOW)
                args = ["--fifo", str(pipe), *args]
            child = subprocess.Popen(
                [*command, *args],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=BROKER.ENV,
            )
            if mode != "preflight":
                wait_for_pipe_ready(child.stdout)
                writer = os.open(pipe, os.O_WRONLY | os.O_NOFOLLOW)
                os.close(holding)
                holding = None
                with os.fdopen(writer, "wb") as stream:
                    stream.write(raw)
            # Setup operations have their own deadlines. This also bounds a
            # wedged bridge; closing its FIFO gives an unread receiver EOF.
            output, errors = child.communicate(timeout=BRIDGE_SECONDS)
            sys.stdout.buffer.write(output)
            sys.stderr.buffer.write(errors)
            return child.returncode
        finally:
            if holding is not None:
                os.close(holding)
            if child is not None and child.poll() is None:
                try:
                    child.kill()
                except PermissionError:
                    pass  # sudo/root may outlive its unprivileged caller
                try:
                    child.communicate(timeout=CHILD_CLEANUP_SECONDS)
                except subprocess.TimeoutExpired:
                    pass  # the privileged transaction has its own deadline
            if child is not None:
                child.stdout.close()
                child.stderr.close()


def apply(token, cfg, original, vm, expected_hash):
    require(
        hmac.compare_digest(hashlib.sha256(original).hexdigest(), expected_hash),
        "Configuration changed since validation. Run the wizard again.",
    )
    with BROKER.request_lock("/run/governor-credential-setup.lock"):
        require(
            CONFIG.read_bytes() == original, "Configuration changed during validation."
        )
        for target in (BROKER_DIR, BROKER_CODE, HELPER, SUDOERS):
            require(
                not os.path.lexists(target),
                "Broker files appeared during validation; refusing to overwrite them.",
            )
        stage = Path(tempfile.mkdtemp(prefix=".hostinger-setup.", dir=CONFIG.parent))
        backup = None
        changed = False
        published = []
        broker_directory_created = False
        legacy_moved = False
        remove_stage = True
        try:
            run(["/usr/bin/systemd-creds", "setup"])
            host_key_info = protected(HOST_KEY)
            require(
                not host_key_info.st_mode & 0o077,
                "Host encryption key permissions are unsafe.",
            )
            encrypted = stage / "token.cred"
            encrypt_verified(token.encode(), encrypted, "hostinger-token")
            try:
                grp.getgrnam(BROKER.WORKER_ACCOUNT)
            except KeyError:
                run(["/usr/sbin/groupadd", "--system", BROKER.WORKER_ACCOUNT])
            try:
                pwd.getpwnam(BROKER.WORKER_ACCOUNT)
            except KeyError:
                run(
                    [
                        "/usr/sbin/useradd",
                        "--system",
                        "--gid",
                        BROKER.WORKER_ACCOUNT,
                        "--home-dir",
                        "/nonexistent",
                        "--no-create-home",
                        "--shell",
                        "/usr/sbin/nologin",
                        BROKER.WORKER_ACCOUNT,
                    ]
                )
            validate_worker_identity(missing_ok=False)
            h = dict(cfg.get("hostinger") or {})
            h.update({"vm_id": vm["vm_id"], "request_command": provider_command()})
            h.pop("token_file", None)
            h.pop("token_command", None)
            cfg["hostinger"] = h
            governor = pwd.getpwnam("governor")
            write_private(
                stage / "config.json",
                (json.dumps(cfg, indent=2) + "\n").encode(),
                mode=0o640,
                gid=governor.pw_gid,
            )
            write_private(
                stage / "broker-config.json",
                json.dumps({"vm_id": vm["vm_id"]}).encode(),
                mode=0o644,
            )
            write_private(stage / "broker.py", BROKER_SOURCE.encode(), mode=0o644)
            write_private(
                stage / "helper", BROKER.launcher_text(BROKER_CODE).encode(), mode=0o755
            )
            write_private(
                stage / "sudoers", BROKER.sudo_rule(HELPER).encode(), mode=0o440
            )
            run(["/usr/sbin/visudo", "-cf", str(stage / "sudoers")])
            backup = Path(tempfile.mkdtemp(prefix="governor-api.", dir="/var/backups"))
            write_private(backup / "config.json", original)
            if os.path.lexists(LEGACY_TOKEN):
                protected(LEGACY_TOKEN)
                retired = LEGACY_TOKEN.read_bytes()
                require(
                    len(retired) <= BROKER.MAX_TOKEN_BYTES,
                    "The old token changed during setup.",
                )
                archived = backup / "previous-token.cred"
                encrypt_verified(retired, archived, "previous-hostinger-token")
                # Staging is root-only. Restore this exact file, including its
                # original permissions, if any later installation step fails.
                # Each rollback flag is set before its change: an interrupt
                # between the two must still trigger that undo step, and each
                # step tolerates a change that never happened.
                legacy_moved = True
                os.replace(LEGACY_TOKEN, stage / "previous-token")
                del retired
            if not BROKER_DIR.parent.exists():
                BROKER_DIR.parent.mkdir(mode=0o755)
                os.chmod(BROKER_DIR.parent, 0o755)
            protected(BROKER_DIR.parent, directory=True)
            broker_directory_created = True
            BROKER_DIR.mkdir(mode=0o755)
            os.chmod(BROKER_DIR, 0o755)
            for source, target in (
                (encrypted, ENCRYPTED),
                (stage / "broker-config.json", BROKER_CONFIG),
                (stage / "broker.py", BROKER_CODE),
                (stage / "helper", HELPER),
                (stage / "sudoers", SUDOERS),
            ):
                require(
                    not os.path.lexists(target),
                    "Broker target appeared; refusing overwrite.",
                )
                published.append(target)
                os.replace(source, target)
            changed = True
            os.replace(stage / "config.json", CONFIG)
            run(["/usr/local/bin/governor", "validate-config"])
            # The daemon receives only sanitized API results. No runtime credential
            # is installed on governor.service and no command can return the token.
            check = json.loads(
                run(
                    [
                        "/usr/sbin/runuser",
                        "-u",
                        "governor",
                        "--",
                        "/usr/bin/env",
                        "-i",
                        "PATH=/usr/bin:/bin",
                        "/usr/local/bin/governor",
                        "check-hostinger",
                    ],
                    # VM details and metrics can each consume the full command
                    # budget, plus a quick command's allowance for CLI startup.
                    timeout=CONNECTION_CHECK_SECONDS,
                )
            )
            require(
                check.get("vm_id") == vm["vm_id"] and check.get("cpus") == vm["cpus"],
                "Governor cannot use the restricted Hostinger broker.",
            )
            for private_path in (ENCRYPTED, HOST_KEY):
                access = subprocess.run(
                    [
                        "/usr/sbin/runuser",
                        "-u",
                        "governor",
                        "--",
                        "/usr/bin/test",
                        "-r",
                        str(private_path),
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=QUICK_COMMAND_SECONDS,
                    env={"PATH": "/usr/bin:/bin"},
                )
                require(
                    access.returncode == 1,
                    "Governor can read a private credential file.",
                )
            run(["/usr/bin/systemctl", "daemon-reload"])
            # is-active alone only proves the process started; start_governor()
            # also requires a state write from the new process.
            stop_governor()
            state = start_governor()
            return {
                **vm,
                "configured": True,
                "balance": state["credits"]["balance"],
                "accepting": state["accepting"],
                "backup": str(backup),
            }
        except BaseException:
            # If rollback itself raises, keep staging and its restore files.
            remove_stage = False
            remove_stage = rollback(
                stage,
                backup,
                original,
                changed=changed,
                legacy_moved=legacy_moved,
                published=published,
                broker_directory_created=broker_directory_created,
            )
            raise
        finally:
            if remove_stage:
                shutil.rmtree(stage)


def main():
    if sys.argv[1:] in (["bundle"], ["bundle", "--quote"]):
        code = bundle_source()
        print(shlex.quote(code) if "--quote" in sys.argv else code)
        return
    # Both the SSH bridge and root receiver hold plaintext briefly. Disable
    # dumps before either path reads it; the local wizard's limit is not remote.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    if len(sys.argv) in (3, 4) and sys.argv[1] == "bridge":
        sys.exit(bridge(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else ""))

    def expired(*_):
        raise SafeError("Privileged setup deadline reached.")

    def interrupted(*_):
        # Give rollback one uninterrupted attempt. SIGKILL or a machine crash
        # cannot be recovered in-process; the private backup/staging remains.
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            signal.signal(getattr(signal, name), signal.SIG_IGN)
        raise SafeError("Setup interrupted; attempting recovery.")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(ROOT_SETUP_SECONDS)
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        signal.signal(getattr(signal, name), interrupted)
    token_stream = None
    if len(sys.argv) in (4, 5) and sys.argv[1] == "--fifo":
        token_stream = fifo_input(sys.argv[2])
        sys.argv = [sys.argv[0], *sys.argv[3:]]
    require(
        len(sys.argv) in (2, 3) and sys.argv[1] in SETUP_MODES,
        "Invalid setup mode.",
    )
    if sys.argv[1] == "preflight":
        preflight()
        print("Governor supports the restricted Hostinger broker.", flush=True)
        return
    try:
        require(
            token_stream is not None,
            "Token input must use the protected FIFO, not sudo stdin.",
        )
        token = BROKER.validate_token(token_stream.read(BROKER.MAX_TOKEN_BYTES + 1))
    finally:
        if token_stream is not None:
            token_stream.close()
    cfg, original = preflight()
    vm = validate_vm(token)
    configured = (cfg.get("hostinger") or {}).get("vm_id")
    require(
        not configured or configured == vm["vm_id"],
        "The configured VM differs from this server; no configuration was changed.",
    )
    if sys.argv[1] == "inspect":
        result = {**vm, "config_hash": hashlib.sha256(original).hexdigest()}
    else:
        require(
            len(sys.argv) == 3 and re.fullmatch(FINGERPRINT_PATTERN, sys.argv[2]),
            "Missing validation fingerprint.",
        )
        result = apply(token, cfg, original, vm, sys.argv[2])
    print(json.dumps(result), flush=True)


def entrypoint():
    try:
        main()
    except SafeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except BaseException as error:
        print(
            "Setup stopped safely: " + type(error).__name__ + ". No token is printed.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    entrypoint()
