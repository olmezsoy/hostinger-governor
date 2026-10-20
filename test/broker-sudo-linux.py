#!/usr/bin/env python3
"""Exercise the production broker's sudo grant without sudo I/O logging options."""

import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile


def main():
    assert os.geteuid() == 0 and sys.platform == "linux"
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    root = Path(__file__).resolve().parents[1]
    broker = runpy.run_path(str(root / "tools/hostinger-broker.py"))
    rule = Path("/etc/sudoers.d/governor-broker-smoke")
    assert not os.path.lexists(rule)
    subprocess.run(["/usr/bin/sudo", "--version"], check=True)
    with tempfile.TemporaryDirectory(
        prefix="governor-sudo-smoke.", dir="/usr/local/libexec"
    ) as directory:
        Path(directory).chmod(0o755)
        worker = Path(directory) / "worker.py"
        worker.write_text("import os\nassert os.geteuid() == 0\nprint('broker grant ok')\n")
        helper = Path(directory) / "broker"
        helper.write_text(broker["launcher_text"](worker))
        helper.chmod(0o755)
        try:
            rule.write_text(broker["sudo_rule"](helper))
            rule.chmod(0o440)
            subprocess.run(["/usr/sbin/visudo", "-cf", str(rule)], check=True)
            command = [
                "/usr/sbin/runuser",
                "-u",
                "governor",
                "--",
                "/usr/bin/sudo",
                "-n",
                "--",
                str(helper),
            ]
            allowed = subprocess.run(command, capture_output=True, check=True)
            assert allowed.stdout == b"broker grant ok\n"
            refused = subprocess.run(command + ["--worker"], capture_output=True)
            assert refused.returncode != 0
            assert b"Arguments are not authorized" not in refused.stderr
        finally:
            rule.unlink(missing_ok=True)
    print(
        "Production broker sudo grant passed: no-argument launcher allowed, extra arguments refused"
    )


if __name__ == "__main__":
    main()
