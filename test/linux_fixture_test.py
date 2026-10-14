"""Check Linux smoke fixtures locally without invoking SSH, sudo or systemd."""

import importlib.util
from pathlib import Path
from types import ModuleType
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "linux_broker_smoke", ROOT / "test/broker-linux.py"
)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class LinuxFixtureTests(unittest.TestCase):
    def test_overrides_run_before_the_entrypoint_without_slicing_source(self):
        source = """
value = "original"
def entrypoint():
    global result
    result = value
# A second entrypoint-looking comment must not affect fixture construction.
# if __name__ == "__main__":
if __name__ == "__main__":
    entrypoint()
"""
        namespace = {"__name__": "__main__"}
        exec(SMOKE.offline_source(source, 'value = "fixture"\n'), namespace)
        self.assertEqual(namespace["result"], "fixture")

    def test_real_setup_and_broker_fixtures_survive_nested_bundling(self):
        broker = SMOKE.offline_source(
            (ROOT / "tools/hostinger-broker.py").read_text(),
            'def api_body(token, suffix=""):\n    return {"id":12345,"cpus":8}\n',
        )
        setup = SMOKE.offline_source(
            (ROOT / "tools/setup-hostinger-broker.py").read_text(),
            'def run(argv, **kwargs):\n    return b"fixture interface data"\n',
        )
        module = ModuleType("offline_setup")
        module.BROKER_SOURCE = broker
        module.SETUP_SOURCE = setup
        exec(setup, module.__dict__)
        nested = ModuleType("bundled_offline_setup")
        exec(module.bundle_source(), nested.__dict__)
        self.assertEqual(nested.run([]), b"fixture interface data")
        self.assertEqual(
            nested.api_get("dummy.token.for.testing"), {"id": 12345, "cpus": 8}
        )
        self.assertEqual(nested.BROKER_SOURCE, broker)
        self.assertEqual(nested.SETUP_SOURCE, setup)


if __name__ == "__main__":
    unittest.main()
