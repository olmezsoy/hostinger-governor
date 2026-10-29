import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

SOURCE = Path(__file__).resolve().parents[1] / "tools/hostinger-broker.py"
SPEC = importlib.util.spec_from_file_location("hostinger_broker", SOURCE)
BROKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BROKER)
NOW = 1_800_000_000_000
TOKEN = "dummy.secret.token"
CONTRACT = json.loads(
    (SOURCE.parent.parent / "test/fixtures/hostinger-protocol.json").read_text()
)


def vm_request(**changes):
    return {"version": 1, "operation": "vm", "vm_id": 123, **changes}


def metrics_request(**changes):
    return vm_request(
        operation="metrics", **{"from": NOW - 3_600_000, "to": NOW, **changes}
    )


class RequestTest(unittest.TestCase):
    def validate(self, value):
        return BROKER.authorize_request(json.dumps(value).encode(), 123, NOW)

    def test_allows_only_vm_details_and_recent_metrics(self):
        self.assertEqual(self.validate(vm_request()), vm_request())
        self.assertEqual(self.validate(metrics_request()), metrics_request())
        self.validate(metrics_request(**{"from": NOW - BROKER.MAX_INTERVAL}))

    def test_rejects_other_vms_operations_urls_headers_and_extra_fields(self):
        for value in (
            vm_request(vm_id=124),
            vm_request(operation="reboot"),
            vm_request(url="https://evil.invalid"),
            vm_request(headers={}),
            vm_request(token=TOKEN),
            vm_request(version=True),
            [],
            None,
        ):
            with self.subTest(value=value), self.assertRaises(BROKER.Refused):
                self.validate(value)

    def test_rejects_unbounded_or_invalid_time_ranges(self):
        for changes in (
            {"from": NOW - BROKER.MAX_INTERVAL - 1},
            {"from": NOW + 1},
            {"to": NOW + 300_001},
            {"to": NOW - 300_001},
            {"from": True},
            {"to": float("nan")},
            {"from": "0"},
            {"from": -1},
            {"from": NOW},
        ):
            with self.subTest(changes=changes), self.assertRaises(BROKER.Refused):
                self.validate(metrics_request(**changes))

    def test_refuses_oversized_and_duplicate_key_requests(self):
        for raw in (
            b" " * 1025,
            b'{"version":1,"vm_id":123,"operation":"vm","operation":"reboot"}',
        ):
            with self.assertRaises(BROKER.Refused):
                BROKER.authorize_request(raw, 123, NOW)


class UpstreamTest(unittest.TestCase):
    def test_vm_read_returns_only_validated_ipv4_addresses_and_cpu_count(self):
        body = {
            "id": 123,
            "cpus": 8,
            "ipv4": [
                {"address": "192.0.2.1", "gateway": TOKEN},
                {"address": "198.51.100.2", "secret": TOKEN},
            ],
            "ipv6": [{"address": "2001:db8::1"}],
            "password": TOKEN,
        }
        self.assertEqual(
            BROKER.sanitize(body, vm_request()),
            {
                "cpus": 8,
                "ipv4": [{"address": "192.0.2.1"}, {"address": "198.51.100.2"}],
            },
        )

    def test_vm_read_rejects_any_non_ipv4_address_without_echoing_it(self):
        for address in CONTRACT["invalid_ipv4_addresses"]:
            with self.subTest(address=address):
                with self.assertRaises(BROKER.Refused) as raised:
                    BROKER.sanitize(
                        {
                            "id": 123,
                            "cpus": 8,
                            "ipv4": [{"address": "192.0.2.1"}, {"address": address}],
                        },
                        vm_request(),
                    )
                self.assertNotIn(TOKEN, str(raised.exception))
        for ipv4 in CONTRACT["invalid_ipv4_fields"]:
            with self.subTest(ipv4=ipv4), self.assertRaises(BROKER.Refused):
                BROKER.sanitize({"id": 123, "cpus": 8, "ipv4": ipv4}, vm_request())

    def test_vm_read_treats_null_ipv4_as_no_addresses(self):
        # Hostinger's OpenAPI schema declares VirtualMachineResource.ipv4 nullable.
        self.assertEqual(
            BROKER.sanitize({"id": 123, "cpus": 8, "ipv4": None}, vm_request()),
            {"cpus": 8, "ipv4": []},
        )

    def test_vm_data_excludes_credentials_and_unrelated_account_information(self):
        body = {
            "id": 123,
            "cpus": 8,
            "plan": TOKEN,
            "password": TOKEN,
            "ssh_keys": [TOKEN],
        }
        self.assertEqual(BROKER.sanitize(body, vm_request()), {"cpus": 8, "ipv4": []})
        for bad in (
            {"id": 124, "cpus": 8},
            {"id": 123, "cpus": True},
            {"id": 123, "cpus": 0},
        ):
            with self.assertRaises(BROKER.Refused):
                BROKER.sanitize(bad, vm_request())

    def test_metrics_are_numeric_percentages_with_no_arbitrary_text(self):
        body = {
            "cpu_usage": {"unit": "percent", "usage": {"1799998200": 20}},
            "secret": TOKEN,
        }
        with patch.object(BROKER.time, "time", return_value=NOW / 1000):
            self.assertEqual(
                BROKER.sanitize(body, metrics_request()),
                {"cpu_usage": {"unit": "%", "usage": {"1799998200": 20}}},
            )
        for unit, usage in (
            ("cores", {"1799998200": 20}),
            ("%", {TOKEN: 20}),
            ("%", {"1799998200": TOKEN}),
            ("%", {"1799998200": True}),
            ("%", {"1799998200": 101}),
            ("%", {"1799998200": float("nan")}),
            ("%", {"999999999999": 20}),
        ):
            with self.assertRaises(BROKER.Refused):
                BROKER.sanitize(
                    {"cpu_usage": {"unit": unit, "usage": usage}}, metrics_request()
                )

    def test_impossible_percentages_are_reported_as_invalid_not_failed(self):
        # The daemon raises readings-invalid for these, as on its own API path.
        # A string, null or boolean value, a timestamp that isn't Unix seconds, and a missing unit
        # count too: the daemon's parser rejects each as an invalid reading.
        for unit, usage in (
            ("cores", {"1799998200": 20}),
            (None, {"1799998200": 20}),
            ("%", {"1799998200": 101}),
            ("%", {"1799998200": -1}),
            ("%", {"1799998200": float("nan")}),
            # Too large for a float: math.isfinite would raise on it.
            ("%", {"1799998200": 10**400}),
            ("%", {"1799998200": TOKEN}),
            ("%", {"1799998200": None}),
            ("%", {"1799998200": True}),
            ("%", {TOKEN: 20}),
            ("%", {str((NOW + BROKER.CLOCK_SKEW_MS) // 1000 + 1): 20}),
            # Keys that aren't Unix seconds, which the daemon's own API path rejects too.
            *(("%", {key: 20}) for key in CONTRACT["invalid_timestamp_keys"]),
        ):
            with self.assertRaises(BROKER.Refused) as raised:
                BROKER.sanitize(
                    {"cpu_usage": {"unit": unit, "usage": usage}}, metrics_request()
                )
            self.assertEqual(raised.exception.code, BROKER.INVALID_METRICS)
        # A response without the metrics object is still an ordinary failure, on the daemon's own
        # API path too (hostinger_test.ts).
        for body in CONTRACT["failed_metrics_bodies"]:
            with self.assertRaises(BROKER.Refused) as raised:
                BROKER.sanitize(body, metrics_request())
            self.assertIsNone(raised.exception.code)
        # A reading inside the daemon's clock skew is kept, as the daemon keeps it.
        ahead = str((NOW + BROKER.CLOCK_SKEW_MS) // 1000)
        self.assertEqual(
            BROKER.sanitize({"cpu_usage": {"unit": "%", "usage": {ahead: 20}}}, metrics_request()),
            {"cpu_usage": {"unit": "%", "usage": {ahead: 20}}},
        )

    def test_worker_reports_invalid_metrics_as_a_fixed_code(self):
        output = io.StringIO()
        with patch.object(BROKER.sys, "argv", ["broker", "--worker"]), patch.object(
            BROKER.resource, "setrlimit"
        ), patch.object(BROKER.signal, "signal"), patch.object(
            BROKER.signal, "alarm"
        ), patch.object(
            BROKER.sys,
            "stdin",
            SimpleNamespace(buffer=io.BytesIO(json.dumps(metrics_request()).encode())),
        ), patch.object(BROKER, "configured_vm_id", return_value=123), patch.object(
            BROKER, "authorize_request", return_value=metrics_request()
        ), patch.object(
            BROKER, "worker", side_effect=BROKER.Refused("bad unit", BROKER.INVALID_METRICS)
        ), contextlib.redirect_stdout(output):
            BROKER.main()
        self.assertEqual(
            json.loads(output.getvalue()),
            {"version": 1, "vm_id": 123, "error": BROKER.INVALID_METRICS},
        )

    def test_redirect_never_forwards_authorization(self):
        with self.assertRaisesRegex(BROKER.Refused, "redirect refused"):
            BROKER.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://evil.invalid"
            )

    def test_requests_are_fixed_get_endpoints_with_no_environment_proxy(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = (
            b'{"id":123,"cpus":8,"ipv4":[{"address":"192.0.2.1","secret":"dummy.secret.token"}]}'
        )
        opener = SimpleNamespace(open=Mock(return_value=response))
        with patch.object(
            BROKER.urllib.request, "build_opener", return_value=opener
        ) as build:
            self.assertEqual(
                BROKER.upstream(TOKEN, vm_request()),
                {"cpus": 8, "ipv4": [{"address": "192.0.2.1"}]},
            )
            req = opener.open.call_args.args[0]
            self.assertEqual(req.full_url, BROKER.API + "/123")
            self.assertEqual(req.get_method(), "GET")
            self.assertEqual(req.get_header("Authorization"), "Bearer " + TOKEN)
            self.assertEqual(build.call_args.args[0].proxies, {})

    def test_http_errors_and_oversized_responses_do_not_expose_upstream_text(self):
        error = urllib.error.HTTPError(
            BROKER.API, 401, TOKEN, {}, io.BytesIO(TOKEN.encode())
        )
        opener = SimpleNamespace(open=Mock(side_effect=error))
        with patch.object(BROKER.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(BROKER.Refused) as raised:
                BROKER.upstream(TOKEN, vm_request())
        self.assertEqual(str(raised.exception), "Hostinger returned HTTP 401")
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"x" * (BROKER.MAX_BODY + 1)
        with patch.object(
            BROKER.urllib.request,
            "build_opener",
            return_value=SimpleNamespace(open=Mock(return_value=response)),
        ):
            with self.assertRaisesRegex(BROKER.Refused, "too large"):
                BROKER.upstream(TOKEN, vm_request())


class CacheTest(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory(prefix="hostinger-broker-test.")
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        for replacement in (
            patch.object(BROKER, "STATE", self.root),
            patch.object(BROKER.os, "geteuid", return_value=999),
            patch.object(BROKER.Path, "read_text", return_value="boot-test"),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_upgrade_refreshes_a_legacy_vm_cache_once(self):
        BROKER.write_cache(self.root / "vm.json", {
            "boot_id": "boot-test", "at": 100, "request": vm_request(),
            "data": {"cpus": 8},
        })
        data = {"cpus": 8, "ipv4": [{"address": "192.0.2.1"}]}
        with patch.object(
            BROKER, "read_token", return_value=TOKEN
        ) as token, patch.object(
            BROKER, "upstream", return_value=data
        ) as upstream, patch.object(BROKER.time, "monotonic", return_value=101):
            self.assertEqual(BROKER.worker(vm_request()), data)
            self.assertEqual(BROKER.worker(vm_request()), data)
            token.assert_called_once()
            upstream.assert_called_once_with(TOKEN, vm_request())

    def test_failed_legacy_vm_refresh_does_not_bypass_cooldown_again(self):
        BROKER.write_cache(self.root / "vm.json", {
            "boot_id": "boot-test", "at": 100, "request": vm_request(),
            "data": {"cpus": 8},
        })
        with patch.object(BROKER, "read_token", return_value=TOKEN), patch.object(
            BROKER, "upstream", side_effect=BROKER.Refused("API failed")
        ) as upstream, patch.object(BROKER.time, "monotonic", return_value=101):
            with self.assertRaisesRegex(BROKER.Refused, "API failed"):
                BROKER.worker(vm_request())
            with self.assertRaises(BROKER.Refused) as raised:
                BROKER.worker(vm_request())
            self.assertEqual(raised.exception.code, "rate_limited")
            upstream.assert_called_once()

    def test_legacy_vm_cache_for_another_vm_cannot_bypass_cooldown(self):
        BROKER.write_cache(self.root / "vm.json", {
            "boot_id": "boot-test", "at": 100, "request": vm_request(vm_id=124),
            "data": {"cpus": 8},
        })
        with patch.object(BROKER, "upstream") as upstream, patch.object(
            BROKER.time, "monotonic", return_value=101
        ):
            with self.assertRaises(BROKER.Refused) as raised:
                BROKER.worker(vm_request())
            self.assertEqual(raised.exception.code, "rate_limited")
            upstream.assert_not_called()

    def test_identical_requests_use_sanitized_cache_without_reading_token(self):
        with patch.object(
            BROKER, "read_token", return_value=TOKEN
        ) as token, patch.object(
            BROKER, "upstream", return_value={"cpus": 8, "ipv4": []}
        ) as upstream, patch.object(
            BROKER.time, "monotonic", return_value=100
        ):
            self.assertEqual(BROKER.worker(vm_request()), {"cpus": 8, "ipv4": []})
            self.assertEqual(BROKER.worker(vm_request()), {"cpus": 8, "ipv4": []})
            self.assertEqual(token.call_count, 1)
            self.assertEqual(upstream.call_count, 1)
        self.assertNotIn(TOKEN, (self.root / "vm.json").read_bytes().decode())

    def test_varying_metrics_ranges_reuse_cache_without_bypassing_upstream_rate_limit(
        self,
    ):
        with patch.object(BROKER, "read_token", return_value=TOKEN), patch.object(
            BROKER, "upstream", return_value={"cpu_usage": {"unit": "%", "usage": {}}}
        ) as upstream, patch.object(BROKER.time, "monotonic", return_value=100):
            BROKER.worker(metrics_request())
            BROKER.worker(metrics_request(to=NOW + 1))
            self.assertEqual(upstream.call_count, 1)

    def test_daemon_and_connection_checks_share_recent_metrics_without_another_attempt(
        self,
    ):
        data = {
            "cpu_usage": {
                "unit": "%",
                "usage": {
                    str((NOW - 13 * 3_600_000) // 1000): 10,
                    str((NOW - 1_800_000) // 1000): 20,
                },
            }
        }
        with patch.object(
            BROKER, "read_token", return_value=TOKEN
        ) as token, patch.object(
            BROKER, "upstream", return_value=data
        ) as upstream, patch.object(
            BROKER.time, "time", return_value=NOW / 1000
        ), patch.object(
            BROKER.time, "monotonic", return_value=100
        ):
            daemon = metrics_request(**{"from": NOW - 24 * 3_600_000})
            check = metrics_request(**{"from": NOW - 12 * 3_600_000, "to": NOW + 1})
            self.assertEqual(len(BROKER.worker(daemon)["cpu_usage"]["usage"]), 2)
            self.assertEqual(
                BROKER.worker(check)["cpu_usage"]["usage"],
                {str((NOW - 1_800_000) // 1000): 20},
            )
            self.assertEqual(len(BROKER.worker(daemon)["cpu_usage"]["usage"]), 2)
            self.assertEqual(upstream.call_count, 1)
            self.assertEqual(token.call_count, 1)
            fetched = upstream.call_args.args[1]
            self.assertEqual(fetched["to"] - fetched["from"], BROKER.MAX_INTERVAL)

    def test_failed_requests_also_consume_rate_allowance(self):
        with patch.object(BROKER, "read_token", return_value=TOKEN), patch.object(
            BROKER, "upstream", side_effect=BROKER.Refused("API failed")
        ) as upstream, patch.object(BROKER.time, "monotonic", return_value=100):
            for _ in range(2):
                with self.assertRaises(BROKER.Refused):
                    BROKER.worker(vm_request())
            self.assertEqual(upstream.call_count, 1)

    def test_reboot_invalidates_cache_and_cannot_reuse_old_rate_clock(self):
        with patch.object(BROKER, "read_token", return_value=TOKEN), patch.object(
            BROKER, "upstream", return_value={"cpus": 8}
        ) as upstream, patch.object(BROKER.time, "monotonic", return_value=100):
            BROKER.worker(vm_request())
            with patch.object(BROKER.Path, "read_text", return_value="different-boot"):
                BROKER.worker(vm_request())
            self.assertEqual(upstream.call_count, 2)

    def test_worker_cannot_run_as_root(self):
        with patch.object(BROKER.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(BROKER.Refused, "unprivileged"):
                BROKER.worker(vm_request())

    def test_interrupted_cache_write_keeps_the_previous_complete_record(self):
        path = self.root / "cache.json"
        BROKER.write_cache(path, {"at": 1})
        with patch.object(
            BROKER.os, "replace", side_effect=OSError("injected failure")
        ):
            with self.assertRaises(OSError):
                BROKER.write_cache(path, {"at": 2})
        self.assertEqual(json.loads(path.read_bytes()), {"at": 1})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class LauncherTest(unittest.TestCase):
    def test_protocol_bounds_and_timeout_order_match_the_typescript_contract(self):
        for constant, key in (
            ("MAX_BODY", "max_response_bytes"),
            ("MAX_INTERVAL", "max_interval_ms"),
            ("MAX_VM_ID", "max_vm_id"),
            ("MAX_VCPUS", "max_vcpus"),
            ("ALARM_SECONDS", "alarm_seconds"),
            ("RUN_SECONDS", "run_seconds"),
            ("WORKER_SECONDS", "worker_seconds"),
            ("API_SECONDS", "api_seconds"),
            ("MAX_TOKEN_BYTES", "max_token_bytes"),
            ("COOLDOWN_SECONDS", "cooldown_seconds"),
            ("CHECK_WINDOW_MS", "check_window_ms"),
            ("CAPABILITY", "capability"),
            ("START_SECONDS", "start_seconds"),
            ("STOP_SECONDS", "stop_seconds"),
        ):
            self.assertEqual(getattr(BROKER, constant), CONTRACT[key])
        self.assertEqual(list(BROKER.TEMPORARY_ERRORS), CONTRACT["temporary_errors"])
        self.assertEqual(BROKER.INVALID_METRICS, CONTRACT["invalid_metrics_error"])
        self.assertEqual(BROKER.CLOCK_SKEW_MS, CONTRACT["clock_skew_ms"])
        self.assertEqual(BROKER.REQUEST_SECONDS * 1000, CONTRACT["request_timeout_ms"])
        self.assertLess(
            BROKER.START_SECONDS + BROKER.WORKER_SECONDS + BROKER.STOP_SECONDS,
            BROKER.RUN_SECONDS,
        )
        self.assertLess(BROKER.API_SECONDS, BROKER.WORKER_SECONDS)
        self.assertLess(BROKER.WORKER_SECONDS, BROKER.RUN_SECONDS)
        self.assertLess(BROKER.RUN_SECONDS, BROKER.ALARM_SECONDS)
        self.assertLess(BROKER.ALARM_SECONDS * 1000, CONTRACT["request_timeout_ms"])

    def test_launcher_cannot_run_unprivileged(self):
        with patch.object(BROKER.os, "geteuid", return_value=999):
            with self.assertRaisesRegex(BROKER.Refused, "requires root"):
                BROKER.launch(b"{}")

    def test_launcher_accepts_no_caller_options_and_gives_only_worker_the_credential(
        self,
    ):
        with patch.object(
            BROKER.sys, "argv", ["broker", "--url=https://evil.invalid"]
        ), patch.object(BROKER.resource, "setrlimit"), patch.object(
            BROKER.signal, "signal"
        ), patch.object(
            BROKER.signal, "alarm"
        ):
            with self.assertRaisesRegex(BROKER.Refused, "not authorized"):
                BROKER.main()
        with patch.object(BROKER.os, "geteuid", return_value=0), patch.object(
            BROKER, "request_lock", return_value=contextlib.nullcontext()
        ), patch.object(
            BROKER.subprocess,
            "run",
            return_value=SimpleNamespace(
                returncode=0, stdout=b'{"version":1,"vm_id":123,"data":{"cpus":8}}'
            ),
        ) as launched:
            BROKER.launch(json.dumps(vm_request()).encode())
        args = launched.call_args.args[0]
        self.assertIn("User=" + BROKER.WORKER_ACCOUNT, args)
        self.assertIn(
            "LoadCredentialEncrypted=hostinger-token:" + BROKER.ENCRYPTED, args
        )
        self.assertIn("ProtectHome=yes", args)
        self.assertIn("NoNewPrivileges=yes", args)
        self.assertIn("RuntimeMaxSec=" + str(BROKER.WORKER_SECONDS), args)
        # Transient units reject job timeouts on systemd 255 (Ubuntu 24.04).
        self.assertFalse(any(arg.startswith("JobTimeout") for arg in args))
        self.assertEqual(launched.call_args.kwargs["env"], BROKER.ENV)
        self.assertNotIn("shell", launched.call_args.kwargs)


class CredentialTest(unittest.TestCase):
    def test_systemd_readonly_acl_credentials_are_accepted_but_unsafe_modes_are_not(
        self,
    ):
        for mode in (0o100400, 0o100440, 0o100644, 0o100600, 0o100444, 0o120440):
            stream = io.BytesIO(TOKEN.encode())
            stream.fileno = lambda: 42
            info = SimpleNamespace(st_mode=mode, st_uid=0)
            with patch.dict(
                BROKER.os.environ, {"CREDENTIALS_DIRECTORY": "/run/credentials/test"}
            ), patch.object(BROKER.os, "open", return_value=42) as opened, patch.object(
                BROKER.os, "fdopen", return_value=stream
            ), patch.object(
                BROKER.os, "fstat", return_value=info
            ):
                if mode in (0o100400, 0o100440):
                    self.assertEqual(BROKER.read_token(), TOKEN)
                    self.assertEqual(
                        opened.call_args.args[1], os.O_RDONLY | os.O_NOFOLLOW
                    )
                else:
                    with self.assertRaises(BROKER.Refused):
                        BROKER.read_token()

    def test_worker_will_not_read_credentials_from_an_arbitrary_path(self):
        with patch.dict(BROKER.os.environ, {"CREDENTIALS_DIRECTORY": "/home/attacker"}):
            with self.assertRaisesRegex(BROKER.Refused, "unavailable"):
                BROKER.read_token()


if __name__ == "__main__":
    unittest.main()
