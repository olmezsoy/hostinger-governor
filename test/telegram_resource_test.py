import copy
import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "examples" / "telegram-resource.py"
SPEC = importlib.util.spec_from_file_location("telegram_resource", PATH)
resource = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resource)


def sample():
    return {
        "now": 1791606600,
        "start": 1791563400,
        "hours": 12,
        "error": None,
        "state": {
            "updatedAt": 1791606590000,
            "uptime": 404500000,
            "timezone": "Europe/Istanbul",
            "plan": {
                "vcpus": 8,
                "baseline": 4.8,
                "capacity": 34560,
                "limit": 2.4,
                "recovered": 6912,
            },
            "credits": {
                "balance": 23421,
                "rate": 3.1,
                "margin": {"mul": 1.05, "add": 0.08},
                "anchor": None,
            },
            "ceiling": 800,
            "accepting": True,
            "limit": None,
            "readings": [],
            "cpu": {
                "busy5": 0.02,
                "steal5": 0,
                "busy30": 0.22,
                "users30": {"ci": 0.1, "ci2": 0.05},
            },
            "coverage": {"outsideCores": 0.05, "recoveryBlocked": False},
        },
        "memory": {"MemTotal": 31, "MemAvailable": 22.9, "SwapTotal": 8, "SwapFree": 0.88},
        "load": (0.3, 0.2, 0.1),
        "disk": {"total": 387, "free": 88},
        "cpu": [{"at": 1791606500, "%idle": 47, "%iowait": 1, "%steal": 0}],
        "ram": [{"at": 1791606500, "kbavail": 0.8 * 1024**2}],
        "swap": [{"at": 1791606500, "%swpused": 100}],
        "loads": [{"at": 1791606500, "ldavg-1": 40.4}],
    }


class ResourceTest(unittest.TestCase):
    def test_rebuilding_is_not_a_host_limit_and_warmup_is_not_a_measured_rate(self):
        data = sample()
        data["state"]["credits"]["balance"] = 0
        data["state"]["credits"]["rebuilding"] = {"reason": "state-upgrade", "since": 123}
        data["state"]["cpu"]["observedSeconds"] = 0
        message = resource.render(data)
        for text in (
            "Estimate rebuilding",
            "older, untrusted estimate",
            "not an empty bank",
            "Accepting work",
            "Waiting for the first CPU sample",
        ):
            self.assertIn(text, message)
        self.assertNotIn("credits/s", message)
        self.assertNotIn("at current rate", message)
        self.assertNotIn("30m busy average: 0%", message)

    def test_header_omits_server_names(self):
        for hostname in ("agents-vps", "quakeready-agents"):
            data = sample()
            data["hostname"] = hostname
            message = resource.render(data)
            self.assertTrue(message.startswith("<h3>Server vitals</h3>"))
            self.assertNotIn(hostname, message)

    def test_credit_dashboard_and_real_resource_values(self):
        message = resource.render(sample())
        for text in (
            "<table striped compact>",
            "23,421 / 34,560",
            "67.8%",
            "4.8 / 8",
            "3.1 credits/s",
            "8 / 8 vCPUs",
            "6,912",
            "16,509",
            "22.9 / 31",
            "Lowest free 0.8",
            "89% used",
            "Peak 100%",
            "40.4",
            "88 / 387",
            "ci2",
            "Turkey time",
            "conservative estimates",
        ):
            self.assertIn(text, message)
        self.assertLess(len(message), 32000)

    def test_runway_uses_margin_and_only_surplus_above_reserve(self):
        message = resource.render(sample())
        # (23421 - 6912) / (8 * 1.05 + .08 - 4.8) = 74.77 minutes, not the nominal 122.
        self.assertIn("~1h 15m until reserve", message)
        self.assertNotIn("122 min", message)

    def test_startup_bank_does_not_claim_burst_headroom(self):
        data = sample()
        data["state"]["credits"]["balance"] = 0
        message = resource.render(data)
        self.assertIn("No surplus above reserve", message)
        self.assertIn("Build reserve", message)
        self.assertIn("0.0%", message)

    def test_negative_and_zero_rates_do_not_claim_refill(self):
        for rate in (-3, 0):
            data = sample()
            data["state"]["credits"]["rate"] = rate
            message = resource.render(data)
            self.assertNotIn("Fill bank", message)
            self.assertNotIn("Build reserve", message)
            self.assertIn("Spending" if rate < 0 else "Flat", message)

    def test_limit_details_use_monotonic_elapsed_and_do_not_promise_lift(self):
        data = sample()
        data["state"]["accepting"] = False
        data["state"]["limit"] = {
            "heldFrom": 404000000,
            "startedAt": 403000000,
            "testAt": 404620000,
            "recovery": {"seconds": 1500, "earningSeconds": 1350},
        }
        data["state"]["coverage"]["recoveryBlocked"] = True
        message = resource.render(data)
        for text in (
            "New work paused",
            "Host CPU limit detected",
            "25 min",
            "~2 min",
            "24 min",
            "Estimated earning pauses",
            "Outside workload alone",
            "lift test must confirm",
        ):
            self.assertIn(text, message)

    def test_missing_governor_cannot_display_stale_bank(self):
        data = sample()
        data["state"] = None
        data["error"] = "No fresh governor state"
        message = resource.render(data)
        self.assertIn("Governor unavailable", message)
        self.assertIn("Memory", message)
        self.assertNotIn("23,421", message)
        self.assertNotIn("Estimated CPU credit bank", message)

    def test_missing_history_is_not_reported_as_zero_usage(self):
        data = sample()
        for field in ("cpu", "ram", "swap", "loads"):
            data[field] = []
        message = resource.render(data)
        self.assertIn("Not available", message)
        self.assertIn("························", message)
        self.assertIn("API history is unavailable", message)

    def test_api_history_is_diagnostic_not_billing_truth(self):
        data = sample()
        data["state"]["readings"] = [{"at": 1791606500000, "v": 52}]
        data["state"]["credits"]["anchor"] = {"checkedAt": 1791606500000, "difference": None}
        message = resource.render(data)
        self.assertIn("Diagnostic only", message)
        self.assertIn("not comparable", message)
        self.assertIn("does not reset the bank", message)
        self.assertNotIn("what its throttle acts on", message)

    def test_names_and_cells_are_escaped(self):
        data = sample()
        data["state"]["cpu"]["users30"] = {"<b>owner</b>": 0.1}
        message = resource.render(data)
        self.assertIn("&lt;b&gt;owner&lt;/b&gt;", message)
        self.assertNotIn("<b>owner</b>", message)

    def test_sadf_ignores_bad_rows_and_outside_window(self):
        text = (
            "# hostname;interval;timestamp;CPU;%idle\nbox;600;2026-10-10 04:30:00 UTC;-1;98\n"
            "box;600;2026-10-10 04:30:00 UTC;-1;nan\nbox;600;invalid;-1;98\n"
        )
        rows = resource.parse_sadf(text, 1791606600, 1791606700)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["%idle"], 98)
        self.assertEqual(resource.parse_sadf(text, 1, 2), [])

    def test_sparkline_has_gaps_and_clamps_scale(self):
        self.assertEqual(resource.sparkline([(100, 0), (1300, 1000)], 0, 1800), "▁·█")
        self.assertEqual(resource.sparkline([], 0, 1800), "···")

    def test_render_does_not_change_public_state(self):
        data = sample()
        before = copy.deepcopy(data)
        resource.render(data)
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main()
