import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = (Path(__file__).resolve().parents[1] / "install.sh").read_text()
SELECT = SCRIPT.split(
    "# Fallback quota selection (isolated installer-test entry point).", 1
)[1].split("# End fallback quota selection.", 1)[0]
BOOT = SCRIPT.split(
    "# Boot quota generation (isolated installer-test entry point).", 1
)[1].split("# End boot quota generation.", 1)[0]


UPGRADE = SCRIPT.split(
    "# Upgrade configuration check (isolated installer-test entry point).", 1
)[1].split("# End upgrade configuration check.", 1)[0]
OWNERSHIP = SCRIPT.split(
    "# State ownership repair (isolated installer-test entry point).", 1
)[1].split("# End state ownership repair.", 1)[0]


class UpgradeCheckTest(unittest.TestCase):
    def run_check(self, binary_exit, config=True):
        with tempfile.TemporaryDirectory(prefix="governor-upgrade.") as directory:
            root = Path(directory)
            config_path = root / "config.json"
            if config:
                config_path.write_text('{"tick_secnds":30}')
            calls = root / "calls"
            binary = root / "governor-new"
            binary.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> " + str(calls)
                + "\nexit " + str(binary_exit) + "\n"
            )
            bin_dir = root / "bin"
            bin_dir.mkdir()
            body = UPGRADE.replace("/etc/governor/config.json", str(config_path)).replace(
                "/usr/local/bin", str(bin_dir)
            )
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    "set -euo pipefail\nbinary=" + str(binary) + "\n" + body + "echo reached\n",
                ],
                capture_output=True,
                text=True,
            )
            # The staged copy is gone whether the check passed or failed.
            self.assertEqual(list(bin_dir.iterdir()), [])
            return result, calls.read_text() if calls.exists() else ""

    def test_the_new_binary_runs_from_beside_its_destination_not_tmp(self):
        # A noexec /tmp would refuse to run it and stop every upgrade.
        self.assertIn("mktemp /usr/local/bin/", UPGRADE)
        self.assertNotIn("mktemp -d", UPGRADE)

    def test_a_config_the_new_binary_rejects_stops_before_the_daemon_does(self):
        result, calls = self.run_check(1)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("reached", result.stdout)
        self.assertEqual(calls, "validate-config\n")
        self.assertIn("running governor is unchanged", result.stderr)
        self.assertLess(
            SCRIPT.index("# Upgrade configuration check"),
            SCRIPT.index("systemctl stop governor.service"),
        )

    def test_an_accepted_or_absent_config_continues(self):
        result, calls = self.run_check(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reached", result.stdout)
        self.assertEqual(calls, "validate-config\n")
        result, calls = self.run_check(1, config=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, "")


class StateOwnershipTest(unittest.TestCase):
    def test_only_the_governors_own_single_link_files_are_handed_back(self):
        with tempfile.TemporaryDirectory(prefix="governor-state.") as directory:
            root = Path(directory)
            for name in ("persist.json", "history.json", "history.log", "notes.txt"):
                (root / name).write_text("{}")
            (root / "persist.json.bad-1").write_text("{}")
            os.symlink(root / "notes.txt", root / "history.json.tmp")
            os.link(root / "notes.txt", root / "history.log.bad-1")
            # Top snapshots, as v0.2.5 and an earlier root `governor run` wrote them.
            (root / "top").mkdir()
            (root / "top" / "2026-10-27.log").write_text("## snapshot\n")
            os.symlink(root / "notes.txt", root / "top" / "2026-10-26.log")
            os.link(root / "notes.txt", root / "top" / "2026-10-25.log")
            (root / "top" / "notes.txt").write_text("")
            # As root the files would be root's; here they are this user's.
            body = (
                OWNERSHIP.replace("/var/lib/governor", str(root))
                .replace("-user root", "-user " + str(os.getuid()))
                .replace("chown -h governor:governor --", "printf '%s\\n'")
            )
            result = subprocess.run(["bash", "-c", body], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            # Each name is relative to the directory find opened (-execdir), so a top/ swapped for a
            # link after find chose its files can't redirect chown. GNU find prefixes ./, BSD doesn't.
            for line in result.stdout.split():
                self.assertNotIn("/", line.removeprefix("./"), line)
            handed = sorted(Path(line).name for line in result.stdout.split())
            self.assertEqual(
                handed,
                [
                    "2026-10-27.log",
                    "history.json",
                    "history.log",
                    "persist.json",
                    "persist.json.bad-1",
                    "top",
                ],
            )

    def test_a_top_directory_that_is_a_link_is_not_entered(self):
        with tempfile.TemporaryDirectory(prefix="governor-state.") as directory:
            root = Path(directory) / "lib"
            elsewhere = Path(directory) / "elsewhere"
            root.mkdir()
            elsewhere.mkdir()
            (elsewhere / "2026-10-27.log").write_text("")
            os.symlink(elsewhere, root / "top")
            body = (
                OWNERSHIP.replace("/var/lib/governor", str(root))
                .replace("-user root", "-user " + str(os.getuid()))
                .replace("chown -h governor:governor --", "printf '%s\n'")
            )
            result = subprocess.run(["bash", "-c", body], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
        self.assertIn("-execdir chown -h governor:governor -- {} +", OWNERSHIP)
        self.assertNotIn("-exec chown", OWNERSHIP)


class BootFallbackTest(unittest.TestCase):
    def test_token_copy_is_refused_for_a_broker_before_installation_changes(self):
        guard = SCRIPT.split(
            "# Broker token-copy guard (isolated installer-test entry point).", 1
        )[1].split("# End broker token-copy guard.", 1)[0]
        with tempfile.TemporaryDirectory(prefix="governor-token-guard.") as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"hostinger":{"request_command":["/usr/bin/broker"]}}')
            body = guard.replace("/etc/governor/config.json", str(config))
            result = subprocess.run(
                ["bash", "-c", "token_file=/root/token\n" + body],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("cannot be used", result.stderr)
        self.assertLess(
            SCRIPT.index("# Broker token-copy guard"),
            SCRIPT.index(
                "systemctl stop governor.service",
                SCRIPT.index("# Broker token-copy guard"),
            ),
        )

    def generate(self, value, success=True):
        with tempfile.TemporaryDirectory(prefix="governor-boot-test.") as directory:
            root = Path(directory)
            config = root / "operator-config.json"
            config.write_text(
                '{"fallback_cpu_percent":150,"preserve":"operator-setting"}'
            )
            boot = root / "etc/systemd/system/user.slice.d/10-governor.conf"
            boot.parent.mkdir(parents=True)
            boot.write_text("[Slice]\nCPUQuota=20%\n")
            body = (
                (SELECT + BOOT)
                .replace("/usr/local/bin/governor", "fixture_governor")
                .replace("/etc/systemd", str(root / "etc/systemd"))
            )
            prefix = (
                "set -euo pipefail\nfixture_governor() { "
                '[[ "$*" == "fallback --print" ]] || exit 98; '
                '[[ "$BOOT_SUCCESS" == yes ]] || return 1; '
                'printf "%s\\n" "$BOOT_VALUE"; }\n'
            )
            result = subprocess.run(
                ["bash", "-c", prefix + body],
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "BOOT_VALUE": value,
                    "BOOT_SUCCESS": "yes" if success else "no",
                },
            )
            return result, boot.read_text(), config.read_text()

    def test_default_and_custom_boot_quotas(self):
        for value in ("20", "150"):
            result, boot, _ = self.generate(value)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(boot, "[Slice]\nCPUQuota=" + value + "%\n")

    def test_upgrade_does_not_replace_operator_configuration(self):
        result, boot, config = self.generate("150")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CPUQuota=150%", boot)
        self.assertEqual(
            config, '{"fallback_cpu_percent":150,"preserve":"operator-setting"}'
        )

    def test_unrecognized_cli_output_cannot_write_a_broken_unit(self):
        for value in ("", "0", "150%", "150\nCPUQuota=", "secret-token"):
            result, boot, _ = self.generate(value)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(boot, "[Slice]\nCPUQuota=20%\n")
            self.assertNotIn(value or "not-a-token", result.stderr)

    def test_failed_configuration_validation_keeps_the_previous_boot_quota(self):
        result, boot, _ = self.generate("150", success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(boot, "[Slice]\nCPUQuota=20%\n")


if __name__ == "__main__":
    unittest.main()
