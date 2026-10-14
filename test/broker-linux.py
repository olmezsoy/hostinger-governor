#!/usr/bin/env python3
"""Real systemd/credential/sudo integration, with an offline upstream fixture.

Only run as root on a disposable GitHub-hosted Linux runner. The normal smoke
test calls this after installation. No Hostinger account or real token is used.
"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import gzip
import hashlib
import pwd
import shlex
import socket
import tempfile
from wizard_driver import drive_wizard


def offline_source(source, overrides):
    """Execute the unchanged module, then override test-only external adapters."""
    return (
        '_fixture_entry_name = __name__\n__name__ = "governor_offline_fixture"\n'
        + "exec(compile("
        + repr(source)
        + ', "original-source", "exec"))\n'
        + "__name__ = _fixture_entry_name\n"
        + overrides
        + '\nif __name__ == "__main__":\n    entrypoint()\n'
    )


def show_failure(started, governor_io):
    """Print why the broker or Governor failed. CI uses a dummy token only."""
    journal = subprocess.run(
        [
            "/usr/bin/journalctl",
            "--since",
            "@" + str(started),
            "--no-pager",
            "--output=short-precise",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    print("--- journal since the wizard started ---")
    print("\n".join(journal.stdout.decode(errors="replace").splitlines()[-200:]))
    for path in sorted(governor_io.rglob("*")):
        if path.name in ("stdout", "stderr") and path.is_file():
            data = path.read_bytes()
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            if data:
                print("--- Governor sudo " + str(path.relative_to(governor_io)) + " ---")
                print(data[-4096:].decode(errors="replace"))


def ssh_setup_flow(setup, root, token):
    """Real localhost SSH and sudo, including enabled stdin/output logging."""
    account = "governor-setup-smoke"
    home = Path("/home") / account
    rule = Path("/etc/sudoers.d/governor-setup-smoke")
    assert not home.exists() and not rule.exists()
    subprocess.run(
        [
            "/usr/sbin/useradd",
            "--system",
            "--create-home",
            "--home-dir",
            str(home),
            "--shell",
            "/bin/sh",
            account,
        ],
        check=True,
    )
    user = pwd.getpwnam(account)
    home.chmod(0o755)
    keys = home / ".ssh"
    keys.mkdir(mode=0o755)
    os.chown(keys, user.pw_uid, user.pw_gid)
    private = keys / "separate-holder-key"
    private.write_text("dummy private SSH credential")
    private.chmod(0o600)
    os.chown(private, user.pw_uid, user.pw_gid)
    canary = keys / "world-readable-canary"
    canary.write_text("readable without ProtectHome")
    canary.chmod(0o644)
    os.chown(canary, user.pw_uid, user.pw_gid)
    setup_text = (root / "tools/setup-hostinger-broker.py").read_text()
    fixture = """
_fixture_original_run = run
def run(argv, **kwargs):
    if argv == ["/usr/sbin/ip", "-j", "address", "show"]:
        return b'[{"addr_info":[{"local":"93.184.216.34"}]}]'
    return _fixture_original_run(argv, **kwargs)
"""
    setup.SETUP_SOURCE = offline_source(setup_text, fixture)
    assert token not in setup.bundle_source()
    with tempfile.TemporaryDirectory(prefix="governor-ssh-smoke.") as directory:
        files = Path(directory)
        for name in ("host_key", "client_key"):
            subprocess.run(
                [
                    "/usr/bin/ssh-keygen",
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-f",
                    str(files / name),
                ],
                check=True,
            )
        authorized = keys / "authorized_keys"
        authorized.write_text((files / "client_key.pub").read_text())
        authorized.chmod(0o600)
        os.chown(authorized, user.pw_uid, user.pw_gid)
        (files / "sudo-io").mkdir(mode=0o700)
        (files / "governor-io").mkdir(mode=0o700)
        rule.write_text(
            "Defaults:"
            + account
            + ' log_input,log_output,iolog_dir="'
            + str(files / "sudo-io")
            + '"\n'
            # Governor discards broker stderr by design; record it for failures.
            + 'Defaults:governor log_output,iolog_dir="'
            + str(files / "governor-io")
            + '"\n'
            + account
            + " ALL=(root) NOPASSWD: /usr/bin/python3 -I -c *\n"
        )
        rule.chmod(0o440)
        subprocess.run(["/usr/sbin/visudo", "-cf", str(rule)], check=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = files / "sshd_config"
        config.write_text(
            f"""Port {port}
ListenAddress 127.0.0.1
HostKey {files / "host_key"}
PidFile {files / "sshd.pid"}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM yes
PermitRootLogin no
AllowUsers {account}
"""
        )
        Path("/run/sshd").mkdir(mode=0o755, exist_ok=True)
        known = files / "known_hosts"
        known.write_text(f"[127.0.0.1]:{port} " + (files / "host_key.pub").read_text())
        # Run the real Bash wizard, with only API/interface fixtures and browser
        # openers replaced. Its actual SSH command reaches the bridge and sudo.
        tools = files / "tools"
        tools.mkdir()
        (tools / "setup-hostinger-broker.sh").write_bytes(
            (root / "tools/setup-hostinger-broker.sh").read_bytes()
        )
        (tools / "setup-hostinger-broker.py").write_text(setup.SETUP_SOURCE)
        (tools / "hostinger-broker.py").write_text(setup.BROKER_SOURCE)
        client = files / "ssh_config"
        client.write_text(
            f"""Host governor-smoke-test
HostName 127.0.0.1
Port {port}
User {account}
IdentityFile {files / "client_key"}
UserKnownHostsFile {known}
IdentitiesOnly yes
"""
        )
        binaries = files / "bin"
        binaries.mkdir()
        ssh_wrapper = binaries / "ssh"
        ssh_wrapper.write_text(
            "#!/bin/sh\nexec /usr/bin/ssh -F " + shlex.quote(str(client)) + ' "$@"\n'
        )
        ssh_wrapper.chmod(0o755)
        for name in ("open", "xdg-open", "wslview"):
            opener = binaries / name
            opener.write_text("#!/bin/sh\nexit 0\n")
            opener.chmod(0o755)
        with (files / "sshd.log").open("wb") as log:
            daemon = subprocess.Popen(
                ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)],
                stdout=subprocess.DEVNULL,
                stderr=log,
            )
            try:
                for _ in range(50):
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        assert daemon.poll() is None
                        time.sleep(0.1)

                before = setup.CONFIG.read_bytes()

                def inspected_without_writes():
                    assert setup.CONFIG.read_bytes() == before
                    assert not setup.ENCRYPTED.exists()

                started = int(time.time())
                try:
                    transcript = drive_wizard(
                        tools / "setup-hostinger-broker.sh",
                        "governor-smoke-test",
                        token,
                        env={
                            **os.environ,
                            "PATH": str(binaries) + ":/usr/bin:/bin",
                            "TERM": "xterm",
                        },
                        # A successful apply finishes inside the root deadline;
                        # preflight and inspection are quick offline.
                        timeout=setup.ROOT_SETUP_SECONDS,
                        on_confirmation=inspected_without_writes,
                    )
                except AssertionError:
                    show_failure(started, files / "governor-io")
                    raise
                assert b"Operation-only broker verified" in transcript
            finally:
                daemon.terminate()
                daemon.wait(timeout=5)
        # sudo can compress its I/O files. Scan both compressed and plain logs,
        # including the real sshd log. None may contain the dummy bearer token.
        for item in files.rglob("*"):
            if item.is_file():
                content = item.read_bytes()
                if content.startswith(b"\x1f\x8b"):
                    content = gzip.decompress(content)
                assert token.encode() not in content, item
    rule.unlink()
    return private, canary


def main():
    assert os.geteuid() == 0 and sys.platform == "linux"
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "broker_setup", root / "tools/setup-hostinger-broker.py"
    )
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    cpus = sum(
        line.startswith("cpu") and line[3:4].isdigit()
        for line in Path("/proc/stat").read_text().splitlines()
    )
    token = "dummy.token.broker.integration"
    vm = {"vm_id": 12345, "cpus": cpus, "cpu_samples": 3}
    since = int(time.time())
    fixture = """
def api_body(token, suffix=""):
    require(__import__("hashlib").sha256(token.encode()).hexdigest() == "TOKEN_DIGEST", "Fixture credential mismatch.")
    require(not any(token in value for value in os.environ.values()), "Token present in process environment.")
    vm = {"id": 12345, "cpus": CPUS, "ipv4": [{"address":"93.184.216.34"}], "password": token}
    if suffix == "":
        return [vm]
    if "/metrics?" not in suffix:
        return vm
    now = int(time.time())
    return {"cpu_usage": {"unit": "%", "usage": {
        str(now - 5400): 10, str(now - 3600): 20, str(now - 1800): 30}}, "secret": token}
def upstream(token, value):
    for protected in ("/etc/governor/config.json", "/var/lib/governor/persist.json",
                      "/home/governor-setup-smoke/.ssh/separate-holder-key",
                      "/home/governor-setup-smoke/.ssh/world-readable-canary",
                      "/etc/key-manager/hostinger/token.cred"):
        require(not os.access(protected, os.R_OK), "Worker isolation failed.")
    require(os.geteuid() != 0, "Worker was root.")
    if value["operation"] == "vm":
        # Sanitization must remove token-bearing unrelated fields.
        return sanitize(api_body(token, "/12345"), value)
    if Path("/usr/local/libexec/governor-broker-smoke-hang").exists():
        time.sleep(120)
    return sanitize(api_body(token, "/12345/metrics?"), value)
""".replace(
        "CPUS", str(cpus)
    ).replace(
        "TOKEN_DIGEST", hashlib.sha256(token.encode()).hexdigest()
    )
    setup.BROKER_SOURCE = offline_source(setup.BROKER_SOURCE, fixture)
    compile(setup.BROKER_SOURCE, "offline-broker-fixture", "exec")
    private, canary = ssh_setup_flow(setup, root, token)
    assert setup.ENCRYPTED.stat().st_mode & 0o777 == 0o600
    assert not os.path.lexists(setup.LEGACY_TOKEN)

    def check(command, data=None, success=True):
        retry_until = time.monotonic() + 5
        while True:
            result = subprocess.run(
                command,
                input=data,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=35,
            )
            assert token.encode() not in result.stdout + result.stderr
            # The just-restarted daemon may hold the lock while warming its API
            # history. Retry only the explicit busy outcome, never cooldown or
            # another failure that could hide the cache regression.
            if (
                success
                and result.returncode
                and b"Hostinger broker is busy; retry shortly" in result.stderr
                and time.monotonic() < retry_until
            ):
                time.sleep(0.1)
                continue
            break
        assert (result.returncode == 0) == success, (result.returncode, result.stderr)
        return result

    # Exercise the real CLI, launcher, sudo grant, credential mount and worker.
    command = [
        "/usr/sbin/runuser",
        "-u",
        "governor",
        "--",
        "/usr/local/bin/governor",
        "check-hostinger",
    ]
    for _ in range(3):
        assert json.loads(check(command).stdout) == {
            "vm_id": 12345,
            "cpus": cpus,
            "cpu_samples": 2,
        }
    # The readable canary is accessible outside the sandbox but not inside it.
    # The actual dummy private key also verifies separate Unix ownership.
    worker_uid = pwd.getpwnam("key-manager-hostinger").pw_uid
    assert worker_uid != private.stat().st_uid
    check(
        [
            "/usr/sbin/runuser",
            "-u",
            "key-manager-hostinger",
            "--",
            "/usr/bin/test",
            "-r",
            str(canary),
        ]
    )
    check(
        [
            "/usr/sbin/runuser",
            "-u",
            "key-manager-hostinger",
            "--",
            "/usr/bin/test",
            "-r",
            str(private),
        ],
        success=False,
    )
    broker = ["/usr/sbin/runuser", "-u", "governor", "--", *setup.PROVIDER]
    check(broker + ["--worker"], success=False)
    for body, message in (
        ({"version": 1, "operation": "vm", "vm_id": 54321}, b"VM is not authorized"),
        (
            {"version": 1, "operation": "reboot", "vm_id": 12345},
            b"Operation is not authorized",
        ),
    ):
        refused = check(broker, json.dumps(body).encode(), success=False)
        assert message in refused.stderr, refused.stderr
    for protected in (setup.ENCRYPTED, setup.HOST_KEY):
        check(
            [
                "/usr/sbin/runuser",
                "-u",
                "governor",
                "--",
                "/usr/bin/test",
                "-r",
                str(protected),
            ],
            success=False,
        )
    # Expire only this dummy cache, then verify the real systemd deadline. The
    # supervisor must return and leave no running worker, not just contain a
    # RuntimeMaxSec string in its source.
    subprocess.run(["/usr/bin/systemctl", "stop", "governor.service"], check=True)
    Path("/usr/local/libexec/governor-broker-smoke-hang").touch(mode=0o644)
    cache = Path("/var/lib/key-manager-hostinger/metrics.json")
    cached = json.loads(cache.read_text())
    cached["at"] = -1000
    cache.write_text(json.dumps(cached))
    now = int(time.time() * 1000)
    started = time.monotonic()
    check(
        broker,
        json.dumps(
            {
                "version": 1,
                "operation": "metrics",
                "vm_id": 12345,
                "from": now - 3_600_000,
                "to": now,
            }
        ).encode(),
        success=False,
    )
    elapsed = time.monotonic() - started
    # The hung worker must reach systemd's RuntimeMaxSec, not fail early for
    # an unrelated reason, and must still return inside Governor's deadline.
    assert setup.BROKER.WORKER_SECONDS - 1 <= elapsed, elapsed
    assert elapsed < setup.BROKER.REQUEST_SECONDS, elapsed
    while True:
        running = subprocess.run(
            [
                "/usr/bin/systemctl",
                "is-active",
                "--quiet",
                "governor-hostinger-request.service",
            ],
            check=False,
        )
        if running.returncode != 0:
            break
        assert time.monotonic() - started < setup.BROKER.REQUEST_SECONDS
        time.sleep(0.1)
    journal = subprocess.run(
        [
            "/usr/bin/journalctl",
            "--since",
            "@" + str(since),
            "--no-pager",
            "--output=cat",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    assert token.encode() not in journal.stdout + journal.stderr
    print(
        "Broker Linux integration passed: isolated credential, CLI/cache, authorization, redaction, deadline"
    )


if __name__ == "__main__":
    main()
