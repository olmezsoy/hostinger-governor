import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from types import ModuleType, SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.error
import shutil
from wizard_driver import drive_wizard

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "tools/setup-hostinger-broker.sh").read_text()
SOURCE = (ROOT / "tools/setup-hostinger-broker.py").read_text()
REMOTE = ModuleType("credential_setup_test")
REMOTE.__file__ = str(ROOT / "tools/setup-hostinger-broker.py")
exec(compile(SOURCE, "embedded-credential-setup", "exec"), REMOTE.__dict__)
REAL_WAIT_FOR_DAEMON = REMOTE.wait_for_daemon
REAL_RUN = REMOTE.run
TOKEN = "dummy.token.for.testing"
VM = {"id": 12345, "cpus": 8, "ipv4": [{"address": "93.184.216.34"}], "ipv6": []}
METRICS = {"cpu_usage": {"unit": "%", "usage": {str(int(time.time()) - 1800): 12.3}}}
INTERFACES = json.dumps(
    [{"addr_info": [{"local": "93.184.216.34"}, {"local": "127.0.0.1"}]}]
).encode()
COUNTERS = "\n".join("cpu" + str(i) + " 0 0 0" for i in range(8))


class ValidationTests(unittest.TestCase):
    def test_worker_identity_refuses_shared_groups_and_invalid_existing_users(self):
        governor = SimpleNamespace(pw_name="governor", pw_uid=1001, pw_gid=1001)
        worker = SimpleNamespace(
            pw_name="key-manager-hostinger",
            pw_uid=999,
            pw_gid=999,
            pw_dir="/nonexistent",
            pw_shell="/usr/sbin/nologin",
        )
        group = SimpleNamespace(gr_gid=999, gr_mem=[])
        with patch.object(
            REMOTE.pwd,
            "getpwnam",
            side_effect=lambda name: governor if name == "governor" else worker,
        ), patch.object(REMOTE.grp, "getgrnam", return_value=group), patch.object(
            REMOTE.pwd, "getpwall", return_value=[governor, worker]
        ), patch.object(
            REMOTE.os, "getgrouplist", return_value=[999]
        ):
            REMOTE.validate_worker_identity(missing_ok=False)
            group.gr_mem = ["other-user"]
            with self.assertRaises(REMOTE.SafeError):
                REMOTE.validate_worker_identity()
            group.gr_mem = []
            worker.pw_shell = "/bin/bash"
            with self.assertRaises(REMOTE.SafeError):
                REMOTE.validate_worker_identity()

    def validate(self, responses):
        with patch.object(REMOTE, "run", return_value=INTERFACES), patch.object(
            REMOTE, "api_get", side_effect=responses
        ), patch.object(REMOTE.Path, "read_text", return_value=COUNTERS):
            return REMOTE.validate_vm(TOKEN)

    def test_matches_server_and_verifies_metrics(self):
        self.assertEqual(
            self.validate([[VM], VM, METRICS]),
            {
                "vm_id": 12345, "cpus": 8, "cpu_samples": 1,
                "verified_ipv4": ["93.184.216.34"],
            },
        )

    def test_wrong_account_refused(self):
        other = {**VM, "ipv4": [{"address": "1.1.1.1"}]}
        with self.assertRaisesRegex(REMOTE.SafeError, "exactly one VPS"):
            self.validate([[other]])

    def test_ipv6_only_vm_can_be_identified_without_ipv4(self):
        vm = {**VM, "ipv4": None, "ipv6": [{"address": "2606:4700:4700::1111"}]}
        interfaces = json.dumps([
            {"addr_info": [{"local": "2606:4700:4700::1111"}]}
        ]).encode()
        with patch.object(REMOTE, "run", return_value=interfaces), patch.object(
            REMOTE, "api_get", side_effect=[[vm], vm, METRICS]
        ), patch.object(REMOTE.Path, "read_text", return_value=COUNTERS):
            result = REMOTE.validate_vm(TOKEN)
        self.assertEqual(
            result, {"vm_id": 12345, "cpus": 8, "cpu_samples": 1, "verified_ipv4": []}
        )

    def test_ambiguous_vm_refused(self):
        with self.assertRaisesRegex(REMOTE.SafeError, "exactly one VPS"):
            self.validate([[VM, VM]])

    def test_wrong_cpu_count_refused(self):
        with self.assertRaisesRegex(REMOTE.SafeError, "CPU count"):
            self.validate([[VM], {**VM, "cpus": 4}])

    def test_vm_cpu_count_uses_the_brokers_hardware_bounds(self):
        counters = "\n".join(
            "cpu" + str(i) + " 0 0 0" for i in range(REMOTE.BROKER.MAX_VCPUS + 1)
        )
        with patch.object(REMOTE, "run", return_value=INTERFACES), patch.object(
            REMOTE,
            "api_get",
            side_effect=[[VM], {**VM, "cpus": REMOTE.BROKER.MAX_VCPUS + 1}],
        ), patch.object(REMOTE.Path, "read_text", return_value=counters):
            with self.assertRaisesRegex(REMOTE.SafeError, "Invalid upstream VM"):
                REMOTE.validate_vm(TOKEN)

    def test_bad_metrics_refused(self):
        for metric in (
            {"unit": "cores", "usage": {"0": 12}},
            {"unit": "%", "usage": {"0": 101}},
            {"unit": "%", "usage": {}},
            {"unit": "%", "usage": {"1.5": 12}},
            {"unit": "%", "usage": {"-1": 12}},
            {"unit": "%", "usage": {str(time.time() + 100000): 12}},
        ):
            with self.assertRaises(REMOTE.SafeError):
                self.validate([[VM], VM, {"cpu_usage": metric}])

    def test_redirect_does_not_forward_credentials(self):
        with self.assertRaisesRegex(REMOTE.SafeError, "redirect refused"):
            REMOTE.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://other.example"
            )

    def test_http_errors_never_print_response_or_token(self):
        error = urllib.error.HTTPError(
            REMOTE.API, 401, TOKEN, {}, io.BytesIO(TOKEN.encode())
        )
        opener = SimpleNamespace(open=Mock(side_effect=error))
        with patch.object(REMOTE.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(REMOTE.SafeError) as raised:
                REMOTE.api_get(TOKEN)
        self.assertEqual(str(raised.exception), "Hostinger returned HTTP 401")
        self.assertNotIn(TOKEN, str(raised.exception))

    def test_bad_token_rejected_before_api_or_filesystem(self):
        for payload in (
            b"",
            b"secret with whitespace",
            b"abc\ncredential",
            b"a" * 8193,
        ):
            with patch.object(
                REMOTE.sys, "argv", ["setup", "--fifo", "/fake-pipe", "inspect"]
            ), patch.object(
                REMOTE, "fifo_input", return_value=io.BytesIO(payload)
            ), patch.object(
                REMOTE.resource, "setrlimit"
            ), patch.object(
                REMOTE.signal, "signal"
            ), patch.object(
                REMOTE.signal, "alarm"
            ), patch.object(
                REMOTE.os, "umask"
            ), patch.object(
                REMOTE, "preflight"
            ) as preflight:
                with self.assertRaises(REMOTE.SafeError):
                    REMOTE.main()
                preflight.assert_not_called()

    def test_unsafe_permissions_or_symlinks_refused(self):
        for info in (
            SimpleNamespace(st_mode=0o100660, st_uid=0),
            SimpleNamespace(st_mode=0o120777, st_uid=0),
            SimpleNamespace(st_mode=0o100600, st_uid=999),
        ):
            with self.assertRaises(REMOTE.SafeError):
                REMOTE.protected(
                    SimpleNamespace(lstat=lambda: info, __str__=lambda: "unsafe")
                )


class FreshStateTests(unittest.TestCase):
    def wait(self, states):
        clock = {"monotonic": 0}

        def sleep(seconds):
            clock["monotonic"] += seconds

        with patch.object(
            REMOTE, "run", side_effect=[json.dumps(state).encode() for state in states]
        ) as runner, patch.object(
            REMOTE.time, "monotonic", side_effect=lambda: clock["monotonic"]
        ), patch.object(
            REMOTE.time, "sleep", side_effect=sleep
        ):
            result = REAL_WAIT_FOR_DAEMON(1000)
        return result, runner.call_count

    def test_shutdown_state_in_the_same_millisecond_is_not_fresh(self):
        result, count = self.wait([{"updatedAt": 1000}, {"updatedAt": 1001}])
        self.assertEqual(result, {"updatedAt": 1001})
        self.assertEqual(count, 2)

    def test_malformed_status_cannot_count_as_fresh_publication(self):
        result, count = self.wait(
            [
                None,
                [],
                {"updatedAt": "2000"},
                {"updatedAt": True},
                {"updatedAt": float("inf")},
                {"updatedAt": float("nan")},
                {"updatedAt": 1001},
            ]
        )
        self.assertEqual(result, {"updatedAt": 1001})
        self.assertEqual(count, 7)

    def test_never_publishing_times_out_without_a_real_sleep(self):
        clock = {"monotonic": 0}

        def sleep(seconds):
            clock["monotonic"] += seconds

        with patch.object(
            REMOTE, "run", return_value=b'{"updatedAt":999}'
        ), patch.object(
            REMOTE.time, "monotonic", side_effect=lambda: clock["monotonic"]
        ), patch.object(
            REMOTE.time, "sleep", side_effect=sleep
        ):
            with self.assertRaisesRegex(
                REMOTE.SafeError, "did not publish fresh state"
            ):
                REAL_WAIT_FOR_DAEMON(1000)
        self.assertEqual(clock["monotonic"], REMOTE.FRESH_STATE_SECONDS)


class DeadlineTests(unittest.TestCase):
    def test_service_deadlines_outlast_governors_longest_tick(self):
        unit = (ROOT / "install.sh").read_text()
        # STOP_SECONDS assumes systemd's default stop timeout for the unit.
        self.assertNotIn("TimeoutStopSec", unit)
        self.assertGreater(REMOTE.STOP_SECONDS, REMOTE.SYSTEMD_STOP_SECONDS)
        self.assertGreater(
            REMOTE.SYSTEMD_STOP_SECONDS,
            REMOTE.GOVERNOR_LIMIT_TEST_SECONDS + REMOTE.BROKER.REQUEST_SECONDS,
        )
        self.assertGreater(
            REMOTE.FRESH_STATE_SECONDS,
            REMOTE.GOVERNOR_LIMIT_TEST_SECONDS,
        )

    def test_limit_test_budget_matches_governor(self):
        contract = json.loads(
            (ROOT / "test/fixtures/hostinger-protocol.json").read_text()
        )
        self.assertEqual(
            REMOTE.GOVERNOR_LIMIT_TEST_SECONDS * 1000,
            contract["governor_limit_test_ms"],
        )

    def test_root_and_bridge_deadlines_cover_setup_and_recovery(self):
        restart = (
            REMOTE.LOCAL_COMMAND_SECONDS
            + REMOTE.STOP_SECONDS
            + REMOTE.START_SECONDS
            + REMOTE.LOCAL_COMMAND_SECONDS
            + REMOTE.FRESH_STATE_WAIT_SECONDS
        )
        # The connection check, two private-file checks, then the restart.
        checks = REMOTE.CONNECTION_CHECK_SECONDS + 2 * REMOTE.QUICK_COMMAND_SECONDS
        self.assertGreater(REMOTE.ROOT_SETUP_SECONDS, checks + restart)
        self.assertGreaterEqual(REMOTE.RECOVERY_SECONDS, restart)
        self.assertGreater(
            REMOTE.BRIDGE_SECONDS, REMOTE.ROOT_SETUP_SECONDS + REMOTE.RECOVERY_SECONDS
        )

    def test_rollback_cancels_the_forward_deadline(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            REMOTE.signal, "alarm"
        ) as alarm, contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(
                REMOTE.rollback(
                    Path(directory),
                    None,
                    b"{}",
                    changed=False,
                    legacy_moved=False,
                    published=[],
                    broker_directory_created=False,
                )
            )
        alarm.assert_called_once_with(0)


class TransactionTests(unittest.TestCase):
    def test_old_shutdown_state_cannot_verify_a_new_daemon_that_never_publishes(self):
        clock = {"wall": 1000.0, "monotonic": 0.0}
        state = {"updatedAt": 0, "credits": {"balance": 5000}, "accepting": True}

        def runner(argv, **kwargs):
            if argv[:2] == ["/usr/bin/systemctl", "stop"]:
                # The old daemon finishes its tick, then publishes one last
                # state while shutting down. A boundary taken before stop
                # would accept that write as fresh.
                clock["wall"] += 1
                state["updatedAt"] = int(clock["wall"] * 1000)
            if (
                argv[:2] == ["/usr/bin/systemctl", "start"]
                and self.config.read_bytes() == self.original
            ):
                # Only the restored daemon is capable of publishing fresh state.
                state["updatedAt"] = int(clock["wall"] * 1000) + 1
            if argv == ["/usr/local/bin/governor", "status", "--json"]:
                return json.dumps(state).encode()
            return self.runner(argv, **kwargs)

        def sleep(seconds):
            clock["monotonic"] += seconds
            clock["wall"] += seconds

        with patch.object(
            REMOTE, "wait_for_daemon", side_effect=REAL_WAIT_FOR_DAEMON
        ), patch.object(
            REMOTE.time, "time", side_effect=lambda: clock["wall"]
        ), patch.object(
            REMOTE.time, "monotonic", side_effect=lambda: clock["monotonic"]
        ), patch.object(
            REMOTE.time, "sleep", side_effect=sleep
        ), contextlib.redirect_stderr(
            io.StringIO()
        ), self.assertRaisesRegex(
            REMOTE.SafeError, "did not publish fresh state"
        ):
            self.invoke(runner)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.helper.exists())
        self.assertFalse(list(self.config.parent.glob(".hostinger-setup.*")))

    def check_interrupt(self, mutation, *, before=False):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        REMOTE.LEGACY_TOKEN.chmod(0o640)
        real_replace = os.replace
        real_mkdir = Path.mkdir
        interrupted = False

        def interrupt_around(wanted, change):
            nonlocal interrupted
            if not wanted or interrupted:
                return change()
            interrupted = True
            if not before:
                change()
            raise KeyboardInterrupt()

        def replace(source, target):
            wanted = {
                "token": Path(source) == REMOTE.LEGACY_TOKEN,
                "publish": target == self.encrypted,
                "config": target == self.config,
            }.get(mutation, False)
            return interrupt_around(wanted, lambda: real_replace(source, target))

        def mkdir(path, *args, **kwargs):
            return interrupt_around(
                mutation == "directory" and path == self.broker_dir,
                lambda: real_mkdir(path, *args, **kwargs),
            )

        with patch.object(REMOTE.os, "replace", side_effect=replace), patch.object(
            REMOTE.Path, "mkdir", mkdir
        ), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
            KeyboardInterrupt
        ):
            self.invoke()
        self.assertTrue(interrupted)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(REMOTE.LEGACY_TOKEN.read_bytes(), b"previous.raw.token\n")
        self.assertEqual(REMOTE.LEGACY_TOKEN.stat().st_mode & 0o777, 0o640)
        self.assertFalse(self.broker_dir.exists())
        self.assertFalse(self.helper.exists())
        self.assertFalse(list(self.config.parent.glob(".hostinger-setup.*")))

    def test_interrupt_after_token_move_restores_the_old_token(self):
        self.check_interrupt("token")

    def test_interrupt_after_publication_archives_the_published_file(self):
        self.check_interrupt("publish")

    def test_interrupt_after_config_swap_restores_the_old_configuration(self):
        self.check_interrupt("config")

    def test_interrupt_after_directory_creation_removes_the_directory(self):
        self.check_interrupt("directory")

    def test_interrupt_before_token_move_keeps_the_old_token(self):
        self.check_interrupt("token", before=True)

    def test_interrupt_before_publication_cleans_up_without_archiving(self):
        self.check_interrupt("publish", before=True)
        self.assertFalse(list(self.backups.rglob("rejected-*")))

    def test_interrupt_before_config_swap_keeps_the_old_configuration(self):
        self.check_interrupt("config", before=True)

    def test_interrupt_before_directory_creation_completes_rollback(self):
        self.check_interrupt("directory", before=True)

    def check_failure_phase(self, phase):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        REMOTE.LEGACY_TOKEN.chmod(0o640)
        failed = False

        def runner(argv, **kwargs):
            nonlocal failed
            command = {
                "visudo": "/usr/sbin/visudo",
                "useradd": "/usr/sbin/useradd",
                "validate": "/usr/local/bin/governor",
                "interrupted": "/usr/local/bin/governor",
            }.get(phase)
            if not failed and argv[0] == command:
                failed = True
                if phase == "interrupted":
                    raise KeyboardInterrupt()
                raise REMOTE.SafeError("injected " + phase)
            return self.runner(argv, **kwargs)

        real_replace = os.replace

        def replace(source, target):
            nonlocal failed
            if phase == "partial_publish" and target == self.broker_code and not failed:
                failed = True
                raise OSError("injected partial publish")
            return real_replace(source, target)

        def user(name):
            if phase == "useradd" and name == "key-manager-hostinger":
                raise KeyError(name)
            return SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())

        wait = Mock(
            side_effect=[
                REMOTE.SafeError("injected verification failure"),
                {"credits": {"balance": 34560}, "accepting": True},
            ]
        )
        stderr = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(REMOTE.os, "replace", side_effect=replace))
            stack.enter_context(patch.object(REMOTE.pwd, "getpwnam", side_effect=user))
            if phase == "permission":
                stack.enter_context(
                    patch.object(
                        REMOTE.subprocess,
                        "run",
                        return_value=SimpleNamespace(returncode=0),
                    )
                )
            if phase == "verification":
                stack.enter_context(patch.object(REMOTE, "wait_for_daemon", wait))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            with self.assertRaises((REMOTE.SafeError, OSError, KeyboardInterrupt)):
                self.invoke(runner)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(REMOTE.LEGACY_TOKEN.read_bytes(), b"previous.raw.token\n")
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.sudoers.exists())
        self.assertFalse(self.broker_dir.exists())
        self.assertFalse(list(self.config.parent.glob(".hostinger-setup.*")))
        self.assertNotIn(TOKEN, stderr.getvalue())
        if phase == "verification":
            self.assertEqual(wait.call_count, 2)

    def test_partial_publish_rolls_back(self):
        self.check_failure_phase("partial_publish")

    def test_visudo_failure_rolls_back(self):
        self.check_failure_phase("visudo")

    def test_useradd_failure_rolls_back(self):
        self.check_failure_phase("useradd")

    def test_validate_config_failure_rolls_back(self):
        self.check_failure_phase("validate")

    def test_interrupted_apply_rolls_back(self):
        self.check_failure_phase("interrupted")

    def test_private_permission_failure_rolls_back(self):
        self.check_failure_phase("permission")

    def test_post_restart_verification_failure_rolls_back_and_verifies_recovery(self):
        self.check_failure_phase("verification")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="governor-key-test.")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "etc/governor/config.json"
        self.config.parent.mkdir(parents=True)
        self.original = json.dumps(
            {
                "hostinger": {"vm_id": None, "token_file": "/missing-token"},
                "slice": "user.slice",
                "timezone": "Europe/Istanbul",
                "baseline_share": 0.6,
                "tick_seconds": 30,
            }
        ).encode()
        self.config.write_bytes(self.original)
        self.broker_dir = self.root / "etc/key-manager/hostinger"
        self.encrypted = self.broker_dir / "token.cred"
        self.broker_config = self.broker_dir / "config.json"
        self.broker_code = self.root / "libexec/governor-hostinger.py"
        self.broker_code.parent.mkdir()
        self.helper = self.broker_code.parent / "governor-hostinger"
        self.sudoers = self.root / "etc/sudoers.d/governor-hostinger"
        self.sudoers.parent.mkdir()
        self.key = self.root / "host-key"
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.lock = self.root / "setup.lock"
        self.calls = []
        real_open = os.open
        real_fstat = os.fstat
        real_mkdtemp = tempfile.mkdtemp

        def open_in_fixture(path, flags, mode=0o777, **kwargs):
            path = (
                self.lock
                if str(path) == "/run/governor-credential-setup.lock"
                else path
            )
            return real_open(path, flags, mode, **kwargs)

        def fstat_in_fixture(fd):
            values = list(real_fstat(fd))
            values[4] = 0
            return os.stat_result(values)

        def temp_in_fixture(*args, **kwargs):
            if kwargs.get("dir") == "/var/backups":
                kwargs["dir"] = self.backups
            return real_mkdtemp(*args, **kwargs)

        patches = [
            patch.object(REMOTE, "CONFIG", self.config),
            patch.object(REMOTE, "ENCRYPTED", self.encrypted),
            patch.object(REMOTE, "BROKER_DIR", self.broker_dir),
            patch.object(REMOTE, "BROKER_CONFIG", self.broker_config),
            patch.object(REMOTE, "BROKER_CODE", self.broker_code),
            patch.object(REMOTE, "HELPER", self.helper),
            patch.object(REMOTE, "SUDOERS", self.sudoers),
            patch.object(
                REMOTE.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
            ),
            patch.object(
                REMOTE.subprocess, "run", return_value=SimpleNamespace(returncode=1)
            ),
            patch.object(REMOTE, "HOST_KEY", self.key),
            patch.object(
                REMOTE, "LEGACY_TOKEN", self.config.parent / "hostinger-token"
            ),
            patch.object(
                REMOTE, "protected", return_value=SimpleNamespace(st_mode=0o100400)
            ),
            patch.object(REMOTE, "validate_worker_identity"),
            patch.object(REMOTE.os, "open", side_effect=open_in_fixture),
            patch.object(REMOTE.os, "fchown"),
            patch.object(REMOTE.os, "fstat", side_effect=fstat_in_fixture),
            patch.object(REMOTE.tempfile, "mkdtemp", side_effect=temp_in_fixture),
            patch.object(
                REMOTE.pwd,
                "getpwnam",
                return_value=SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()),
            ),
            patch.object(
                REMOTE,
                "wait_for_daemon",
                return_value={"credits": {"balance": 34560}, "accepting": True},
            ),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def runner(self, argv, *, data=None, timeout=30, env=None, explain=False):
        self.calls.append((argv, data, env))
        if argv[0] == "/usr/bin/systemd-creds":
            if argv[1] == "setup":
                self.key.write_bytes(b"fake-host-key")
            elif argv[1] == "encrypt":
                self.assertIn("--with-key=host", argv)
                self.assertIn(
                    "--name="
                    + (
                        "previous-hostinger-token"
                        if b"previous" in data
                        else "hostinger-token"
                    ),
                    argv,
                )
                Path(argv[-1]).write_bytes(b"FAKE-CIPHERTEXT")
            elif argv[1] == "decrypt":
                return (
                    b"previous.raw.token\n"
                    if "--name=previous-hostinger-token" in argv
                    else TOKEN.encode()
                )
        if argv[0] == "/usr/sbin/runuser" and argv[-1] == "check-hostinger":
            return json.dumps({
                "vm_id": 12345, "cpus": 8, "cpu_samples": 24, "ipv4": ["93.184.216.34"],
            }).encode()
        return b""

    def invoke(self, runner=None, fingerprint=None, verified_ipv4=("93.184.216.34",)):
        vm = {
            "vm_id": 12345, "cpus": 8, "cpu_samples": 24,
            "verified_ipv4": list(verified_ipv4),
        }
        digest = fingerprint or hashlib.sha256(self.original).hexdigest()
        with patch.object(REMOTE, "run", side_effect=runner or self.runner):
            return REMOTE.apply(
                TOKEN, json.loads(self.original), self.original, vm, digest
            )

    def test_success_only_persists_ciphertext_and_preserves_other_settings(self):
        result = self.invoke()
        self.assertTrue(result["configured"])
        cfg = json.loads(self.config.read_bytes())
        self.assertEqual(
            cfg["hostinger"],
            {"vm_id": 12345, "request_command": REMOTE.provider_command()},
        )
        for key in ("slice", "timezone", "baseline_share", "tick_seconds"):
            self.assertEqual(cfg[key], json.loads(self.original)[key])
        self.assertEqual(self.encrypted.read_bytes(), b"FAKE-CIPHERTEXT")
        self.assertEqual(self.encrypted.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertEqual(json.loads(self.broker_config.read_bytes()), {"vm_id": 12345})
        self.assertIn("key-manager-hostinger", self.broker_code.read_text())
        self.assertIn('""', self.sudoers.read_text())
        self.assertEqual(self.broker_dir.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.helper.stat().st_mode & 0o777, 0o755)
        self.assertEqual(
            self.helper.read_text(), REMOTE.BROKER.launcher_text(self.broker_code)
        )
        self.assertEqual(self.sudoers.read_text(), REMOTE.BROKER.sudo_rule(self.helper))
        self.assertEqual(
            (Path(result["backup"]) / "config.json").read_bytes(), self.original
        )
        for path in self.root.rglob("*"):
            if path.is_file():
                self.assertNotIn(TOKEN.encode(), path.read_bytes())
        for argv, data, env in self.calls:
            self.assertNotIn(TOKEN, " ".join(argv))
            self.assertNotIn(TOKEN, str(env))
            self.assertNotIn("seed", argv)

    def test_post_install_rejects_a_broker_with_the_right_cpus_but_wrong_ipv4(self):
        def runner(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser" and argv[-1] == "check-hostinger":
                return json.dumps({
                    "vm_id": 12345, "cpus": 8, "cpu_samples": 24,
                    "ipv4": ["198.51.100.2"],
                }).encode()
            return self.runner(argv, **kwargs)

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(
            REMOTE.SafeError, "IPv4 addresses do not match this server"
        ):
            self.invoke(runner)
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_post_install_names_an_older_governor_without_ipv4_output(self):
        def runner(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser" and argv[-1] == "check-hostinger":
                return json.dumps({"vm_id": 12345, "cpus": 8, "cpu_samples": 24}).encode()
            return self.runner(argv, **kwargs)

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(
            REMOTE.SafeError, "install the matching Governor release"
        ):
            self.invoke(runner)
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_ipv6_only_preflight_configures_without_ipv4_output(self):
        def runner(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser" and argv[-1] == "check-hostinger":
                return json.dumps({"vm_id": 12345, "cpus": 8, "cpu_samples": 24}).encode()
            return self.runner(argv, **kwargs)

        result = self.invoke(runner, verified_ipv4=())
        self.assertTrue(result["configured"])

    def test_ipv6_only_preflight_still_rejects_a_cpu_mismatch(self):
        def runner(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser" and argv[-1] == "check-hostinger":
                return json.dumps({
                    "vm_id": 12345, "cpus": 4, "cpu_samples": 24, "ipv4": [],
                }).encode()
            return self.runner(argv, **kwargs)

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(
            REMOTE.SafeError, "restricted Hostinger broker"
        ):
            self.invoke(runner, verified_ipv4=())
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_restart_failure_restores_original_config_and_archives_ciphertext(self):
        starts = 0

        def failing_runner(argv, **kwargs):
            nonlocal starts
            if argv[:2] == ["/usr/bin/systemctl", "start"]:
                starts += 1
                if starts == 1:
                    raise REMOTE.SafeError("Injected restart failure")
            return self.runner(argv, **kwargs)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(REMOTE.SafeError):
            self.invoke(failing_runner)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.sudoers.exists())
        self.assertFalse(self.broker_dir.exists())
        self.assertFalse(self.encrypted.exists())
        self.assertEqual(starts, 2)
        archived = {path.name for path in self.backups.rglob("rejected-*")}
        self.assertEqual(
            archived,
            {
                "rejected-hostinger-token.cred",
                "rejected-hostinger-config.json",
                "rejected-libexec-governor-hostinger.py",
                "rejected-libexec-governor-hostinger",
                "rejected-sudoers.d-governor-hostinger",
            },
        )
        self.assertNotIn(TOKEN, stderr.getvalue())

    def test_failed_connection_check_explains_governors_error_but_never_the_token(self):
        for stderr, expected in (
            (
                b"\x1b[31merror\x1b[0m: Uncaught (in promise) Error: Hostinger request "
                b"command failed\n    at file:///src/main.ts:12:3\n",
                "A local setup command failed: runuser (error: Uncaught (in promise) "
                "Error: Hostinger request command failed)",
            ),
            (b"error: " + TOKEN.encode() + b"\n", "Governor's connection check failed."),
        ):

            def failed_check(argv, **kwargs):
                if argv[0] != "/usr/sbin/runuser":
                    return self.runner(argv, **kwargs)
                failed = SimpleNamespace(returncode=1, stdout=b"", stderr=stderr)
                with patch.object(REMOTE.subprocess, "run", return_value=failed):
                    return REAL_RUN(argv, **kwargs)

            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
                REMOTE.SafeError
            ) as raised:
                self.invoke(failed_check)
            self.assertEqual(str(raised.exception), expected)
            self.assertEqual(self.config.read_bytes(), self.original)

    def test_migration_retires_readable_token_to_an_encrypted_backup(self):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        REMOTE.LEGACY_TOKEN.chmod(0o640)
        result = self.invoke()
        self.assertFalse(REMOTE.LEGACY_TOKEN.exists())
        archive = Path(result["backup"]) / "previous-token.cred"
        self.assertEqual(archive.read_bytes(), b"FAKE-CIPHERTEXT")
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        for path in self.root.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"previous.raw.token", path.read_bytes())

    def test_failed_migration_restores_old_token_bytes_and_permissions(self):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        REMOTE.LEGACY_TOKEN.chmod(0o640)

        def failed_check(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser":
                raise REMOTE.SafeError("connection check failed")
            return self.runner(argv, **kwargs)

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
            REMOTE.SafeError
        ):
            self.invoke(failed_check)
        self.assertEqual(REMOTE.LEGACY_TOKEN.read_bytes(), b"previous.raw.token\n")
        self.assertEqual(REMOTE.LEGACY_TOKEN.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_stop_failure_does_not_skip_file_restores_or_delete_recovery_files(self):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        REMOTE.LEGACY_TOKEN.chmod(0o640)

        def failed_rollback(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser":
                raise REMOTE.SafeError("injected setup failure")
            if argv[:2] == ["/usr/bin/systemctl", "stop"]:
                raise REMOTE.SafeError("injected stop failure")
            return self.runner(argv, **kwargs)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(REMOTE.SafeError):
            self.invoke(failed_rollback)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(REMOTE.LEGACY_TOKEN.read_bytes(), b"previous.raw.token\n")
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.sudoers.exists())
        self.assertEqual(len(list(self.config.parent.glob(".hostinger-setup.*"))), 1)
        self.assertIn("staging", stderr.getvalue())

    def test_failed_token_restore_keeps_plaintext_recovery_file_private(self):
        REMOTE.LEGACY_TOKEN.write_bytes(b"previous.raw.token\n")
        real_replace = os.replace

        def fail_restore(source, target):
            if Path(source).name == "previous-token" and target == REMOTE.LEGACY_TOKEN:
                raise OSError("injected restore failure")
            return real_replace(source, target)

        def failed_check(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser":
                raise REMOTE.SafeError("injected setup failure")
            return self.runner(argv, **kwargs)

        with patch.object(
            REMOTE.os, "replace", side_effect=fail_restore
        ), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
            REMOTE.SafeError
        ):
            self.invoke(failed_check)
        self.assertEqual(self.config.read_bytes(), self.original)
        stage = next(self.config.parent.glob(".hostinger-setup.*"))
        self.assertEqual(stage.stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            (stage / "previous-token").read_bytes(), b"previous.raw.token\n"
        )
        self.assertFalse(self.helper.exists())

    def test_rollback_checks_fresh_state_and_keeps_staging_if_governor_cannot_recover(
        self,
    ):
        def failed_check(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser":
                raise REMOTE.SafeError("injected setup failure")
            return self.runner(argv, **kwargs)

        with patch.object(
            REMOTE, "wait_for_daemon", side_effect=REMOTE.SafeError("not recovered")
        ) as wait, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
            REMOTE.SafeError
        ):
            self.invoke(failed_check)
        wait.assert_called_once()
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertTrue(list(self.config.parent.glob(".hostinger-setup.*")))

    def test_runtime_credential_failure_rolls_back(self):
        def failing_runner(argv, **kwargs):
            if argv[0] == "/usr/sbin/runuser":
                return b'{"vm_id":999,"cpus":8}'
            return self.runner(argv, **kwargs)

        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(
            REMOTE.SafeError
        ):
            self.invoke(failing_runner)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.sudoers.exists())
        self.assertFalse(self.broker_dir.exists())
        self.assertFalse(self.encrypted.exists())

    def test_stale_validation_refused_before_changes(self):
        with self.assertRaisesRegex(REMOTE.SafeError, "changed since validation"):
            self.invoke(fingerprint="0" * 64)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_existing_credential_is_not_overwritten(self):
        self.broker_dir.mkdir(parents=True)
        self.encrypted.write_bytes(b"existing encrypted data")
        with self.assertRaisesRegex(REMOTE.SafeError, "refusing to overwrite"):
            self.invoke()
        self.assertEqual(self.encrypted.read_bytes(), b"existing encrypted data")
        self.assertEqual(self.config.read_bytes(), self.original)


class ScriptTests(unittest.TestCase):
    def test_public_sources_bundle_into_valid_python_with_posix_shell_quoting(self):
        quoted = subprocess.check_output(
            [
                sys.executable,
                "-I",
                str(ROOT / "tools/setup-hostinger-broker.py"),
                "bundle",
                "--quote",
            ],
            text=True,
        ).strip()
        compiler = (
            'import sys; compile(sys.argv[1], "bundled-setup", "exec"); print("valid")'
        )
        command = (
            shlex.quote(sys.executable)
            + " -I -c "
            + shlex.quote(compiler)
            + " "
            + quoted
        )
        result = subprocess.run(
            ["/bin/sh", "-c", command], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "valid\n")
        self.assertNotIn(TOKEN, command)

    def test_wizard_library_unchanged(self):
        marker = "# STAGES: author this section."
        self.assertEqual(
            hashlib.sha256(SCRIPT.split(marker)[0].encode()).hexdigest(),
            "36ddf7aa3a7da152768664bddc48451a6a738f44840eb94e1c5cb014c531c02d",
        )

    def test_bundled_broker_matches_repository_source(self):
        expected = (ROOT / "tools/hostinger-broker.py").read_text()
        self.assertEqual(REMOTE.BROKER_SOURCE.strip(), expected.strip())
        self.assertNotIn("LoadCredentialEncrypted=", REMOTE.WRAPPER)
        self.assertIn('""', REMOTE.SUDO_RULE)

    def test_token_is_never_exported_or_saved_in_env(self):
        stages = SCRIPT.split("# STAGES: author this section.", 1)[1]
        self.assertNotIn("write_env ", stages)
        self.assertNotIn("set_secret ", stages)
        self.assertNotIn("export HOSTINGER_SETUP_TOKEN", stages)
        self.assertIn("StrictHostKeyChecking=yes", stages)
        self.assertIn("bridge $mode $fingerprint", stages)
        self.assertIn("ask_secret HOSTINGER_SETUP_TOKEN", stages)


class BridgeTests(unittest.TestCase):
    # Emulate only sudo and the remote account/API. FIFO delivery, the bundled
    # entry point, fingerprint flow and subprocess streams are real. The fake
    # sudo refuses any stdin bytes, like an input logger would observe.
    FAKE_SUDO = """
import os, sys, hashlib
from types import ModuleType
assert sys.stdin.buffer.read() == b""
assert not {"HOSTINGER_SETUP_TOKEN", "BASH_ENV", "HTTP_PROXY"}.intersection(os.environ)
module = ModuleType("setup_test_receiver")
exec(compile(sys.argv[1], "bundled-setup", "exec"), module.__dict__)
os.environ["SUDO_UID"] = str(os.getuid())
module.os.geteuid = lambda: 0
module.preflight = lambda: ({"hostinger": {}}, b"fixture config")
module.validate_vm = lambda token: {"vm_id": 12345, "cpus": 8, "cpu_samples": 3}
module.apply = lambda token, cfg, original, vm, fingerprint: {
    "configured": True, "fingerprint": fingerprint,
    "token_sha256": hashlib.sha256(token.encode()).hexdigest()}
sys.argv = ["setup", *sys.argv[2:]]
module.main()
"""

    def test_bridge_entrypoint_disables_core_dumps_before_reading_a_token(self):
        def entered(mode, fingerprint):
            core.assert_called_once_with(REMOTE.resource.RLIMIT_CORE, (0, 0))
            umask.assert_called_once_with(0o077)
            return 0

        with patch.object(
            REMOTE.sys, "argv", ["setup", "bridge", "inspect"]
        ), patch.object(REMOTE.resource, "setrlimit") as core, patch.object(
            REMOTE.os, "umask"
        ) as umask, patch.object(
            REMOTE, "bridge", side_effect=entered
        ):
            self.assertEqual(REMOTE.main(), 0)

    def test_bridge_entrypoint_exits_with_the_root_transaction_status(self):
        for status in (0, 1, 3):
            stderr = io.StringIO()
            with patch.object(
                REMOTE.sys, "argv", ["setup", "bridge", "preflight"]
            ), patch.object(REMOTE.resource, "setrlimit"), patch.object(
                REMOTE.os, "umask"
            ), patch.object(
                REMOTE, "bridge", return_value=status
            ), contextlib.redirect_stderr(
                stderr
            ), self.assertRaises(
                SystemExit
            ) as raised:
                REMOTE.entrypoint()
            self.assertEqual(raised.exception.code, status)
            self.assertEqual(stderr.getvalue(), "")

    def invoke(self, mode, fingerprint=""):
        stdout, stderr = io.BytesIO(), io.BytesIO()
        command = [sys.executable, "-I", "-c", self.FAKE_SUDO, REMOTE.bundle_source()]
        self.assertNotIn(TOKEN, " ".join(command))
        with patch.object(
            REMOTE.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(TOKEN.encode()))
        ), patch.object(
            REMOTE.sys, "stdout", SimpleNamespace(buffer=stdout)
        ), patch.object(
            REMOTE.sys, "stderr", SimpleNamespace(buffer=stderr)
        ):
            status = REMOTE.bridge(mode, fingerprint, root_command=command)
        self.assertEqual(status, 0, stderr.getvalue().decode())
        self.assertNotIn(TOKEN.encode(), stdout.getvalue() + stderr.getvalue())
        return stdout.getvalue()

    def test_inspect_then_fingerprint_then_apply_uses_fifo_and_empty_sudo_stdin(self):
        result = json.loads(self.invoke("inspect"))
        expected = hashlib.sha256(b"fixture config").hexdigest()
        self.assertEqual(result["config_hash"], expected)
        applied = json.loads(self.invoke("apply", result["config_hash"]))
        self.assertTrue(applied["configured"])
        self.assertEqual(applied["fingerprint"], expected)
        self.assertEqual(
            applied["token_sha256"], hashlib.sha256(TOKEN.encode()).hexdigest()
        )

    def test_preflight_does_not_send_a_token(self):
        self.assertIn(
            b"supports the restricted Hostinger broker", self.invoke("preflight")
        )

    def test_bridge_cleans_the_environment_before_starting_sudo(self):
        with patch.dict(
            os.environ,
            {"HOSTINGER_SETUP_TOKEN": TOKEN, "BASH_ENV": "/dummy", "HTTP_PROXY": TOKEN},
        ):
            self.invoke("inspect")

    def test_root_never_opening_the_pipe_is_bounded_and_sends_no_token(self):
        stdout, stderr = io.BytesIO(), io.BytesIO()
        receiver = (
            "import sys,time; assert sys.stdin.buffer.read() == b''; time.sleep(10)"
        )
        command = [sys.executable, "-I", "-c", receiver]
        started = time.monotonic()
        with patch.object(REMOTE, "PIPE_OPEN_SECONDS", 0.02), patch.object(
            REMOTE.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(TOKEN.encode()))
        ), patch.object(
            REMOTE.sys, "stdout", SimpleNamespace(buffer=stdout)
        ), patch.object(
            REMOTE.sys, "stderr", SimpleNamespace(buffer=stderr)
        ):
            with self.assertRaisesRegex(REMOTE.SafeError, "no token was sent"):
                REMOTE.bridge("inspect", root_command=command)
        self.assertLess(time.monotonic() - started, 2)
        self.assertNotIn(TOKEN.encode(), stdout.getvalue() + stderr.getvalue())

    def test_partial_ready_marker_cannot_bypass_the_handshake_deadline(self):
        receiver = "import os,time; os.write(1, b'GOVERNOR_TOKEN_PIPE'); time.sleep(3)"
        started = time.monotonic()
        with patch.object(REMOTE, "PIPE_OPEN_SECONDS", 0.2), patch.object(
            REMOTE.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(TOKEN.encode()))
        ):
            with self.assertRaisesRegex(REMOTE.SafeError, "no token was sent"):
                REMOTE.bridge(
                    "inspect", root_command=[sys.executable, "-I", "-c", receiver]
                )
        self.assertLess(time.monotonic() - started, 1)

    def test_setup_refuses_raw_sudo_stdin_before_any_configuration_change(self):
        with patch.object(REMOTE.sys, "argv", ["setup", "inspect"]), patch.object(
            REMOTE.resource, "setrlimit"
        ), patch.object(REMOTE.os, "umask"), patch.object(
            REMOTE.signal, "signal"
        ), patch.object(
            REMOTE.signal, "alarm"
        ), patch.object(
            REMOTE, "preflight"
        ) as preflight:
            with self.assertRaisesRegex(REMOTE.SafeError, "not sudo stdin"):
                REMOTE.main()
        preflight.assert_not_called()


class PipeSafetyTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory(prefix="governor-pipe-test.")
        self.addCleanup(fixture.cleanup)
        self.directory = Path(fixture.name)
        self.pipe = self.directory / "token"
        os.mkfifo(self.pipe, 0o600)
        for item in (
            patch.object(REMOTE.os, "geteuid", return_value=0),
            patch.dict(os.environ, {"SUDO_UID": str(os.getuid())}),
        ):
            item.start()
            self.addCleanup(item.stop)

    def test_refuses_an_unprivileged_receiver(self):
        with patch.object(REMOTE.os, "geteuid", return_value=999):
            with self.assertRaisesRegex(REMOTE.SafeError, "requires sudo"):
                REMOTE.fifo_input(self.pipe)

    def test_refuses_a_public_or_wrong_owner_directory_before_opening(self):
        for permissions, owner in ((0o755, os.getuid()), (0o700, os.getuid() + 1)):
            self.directory.chmod(permissions)
            with patch.dict(os.environ, {"SUDO_UID": str(owner)}), patch.object(
                REMOTE.os, "open"
            ) as opened:
                with self.assertRaisesRegex(
                    REMOTE.SafeError, "Unsafe token pipe directory"
                ):
                    REMOTE.fifo_input(self.pipe)
                opened.assert_not_called()

    def test_refuses_a_public_pipe_regular_file_or_symlink_before_opening(self):
        self.pipe.chmod(0o666)
        for kind in ("public", "file", "symlink"):
            if kind == "file":
                self.pipe.unlink()
                self.pipe.write_bytes(b"not a token")
                self.pipe.chmod(0o600)
            elif kind == "symlink":
                self.pipe.unlink()
                self.pipe.symlink_to(self.directory / "missing")
            with patch.object(REMOTE.os, "open") as opened:
                with self.assertRaisesRegex(REMOTE.SafeError, "Unsafe token pipe\\."):
                    REMOTE.fifo_input(self.pipe)
                opened.assert_not_called()

    def test_refuses_a_pipe_swapped_between_validation_and_open(self):
        holding = os.open(self.pipe, os.O_RDWR)
        real_fstat = os.fstat

        def swapped(fd):
            values = list(real_fstat(fd))
            values[1] += 1
            return os.stat_result(values)

        try:
            with patch.object(REMOTE.os, "fstat", side_effect=swapped), patch.object(
                REMOTE.os, "close", wraps=os.close
            ) as closed, contextlib.redirect_stdout(io.StringIO()) as stdout:
                with self.assertRaisesRegex(REMOTE.SafeError, "pipe changed"):
                    REMOTE.fifo_input(self.pipe)
                closed.assert_called_once()
                self.assertEqual(stdout.getvalue(), "")
        finally:
            os.close(holding)


class InteractiveWizardTests(unittest.TestCase):
    def drive(self, choice):
        with tempfile.TemporaryDirectory(prefix="governor-wizard-test.") as directory:
            root = Path(directory)
            calls = root / "calls"
            shutil.copy(ROOT / "test/fixtures/wizard-ssh.py", root / "ssh")
            (root / "ssh").chmod(0o755)
            for name in ("open", "xdg-open", "wslview"):
                (root / name).write_text("#!/bin/sh\nexit 0\n")
                (root / name).chmod(0o755)
            drive_wizard(
                ROOT / "tools/setup-hostinger-broker.sh",
                "fixture-vps",
                TOKEN,
                choice=choice,
                env={
                    **os.environ,
                    "PATH": str(root) + os.pathsep + os.environ["PATH"],
                    "TERM": "xterm",
                    "GOVERNOR_WIZARD_TEST_LOG": str(calls),
                },
            )
            return calls.read_text().splitlines()

    def test_declining_confirmation_never_calls_apply_and_secret_is_hidden(self):
        self.assertEqual(self.drive("n"), ["preflight", "inspect"])

    def test_accepting_confirmation_calls_apply_after_inspection_and_secret_is_hidden(
        self,
    ):
        self.assertEqual(self.drive("y"), ["preflight", "inspect", "apply"])


if __name__ == "__main__":
    unittest.main()
