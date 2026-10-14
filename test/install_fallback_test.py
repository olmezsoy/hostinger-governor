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
