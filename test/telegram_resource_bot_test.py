import copy
import importlib.util
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "resource_bot", Path(__file__).resolve().parents[1] / "examples" / "telegram-resource-bot.py"
)
bot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bot)


def config():
    return {
        "token_file": "/etc/governor-resource/token",
        "reporter": "/usr/local/libexec/governor-resource",
        "chat_id": -100123456,
        "topic_id": 42,
        "allowed_user_ids": [123],
        "hours": 12,
    }


def update(text="/resource"):
    return {
        "update_id": 9,
        "message": {
            "message_id": 10,
            "date": 1000,
            "text": text,
            "chat": {"id": -100123456},
            "message_thread_id": 42,
            "from": {"id": 123, "is_bot": False},
        },
    }


class ResourceBotTest(unittest.TestCase):
    def handle(self, item, conf=None):
        self.sent, self.reports = [], []

        def report(path, hours):
            self.reports.append((path, hours))
            return "<h3>Server vitals</h3><table><tr><td>42%</td></tr></table>"

        return bot.handle_update(
            item,
            conf or config(),
            "VitalsBot",
            lambda *args: self.sent.append(args),
            report,
            now=1000,
        )

    def test_defaults_and_native_tables_stay_in_requested_topic(self):
        self.assertTrue(self.handle(update()))
        self.assertEqual(self.reports, [(config()["reporter"], 12)])
        method, payload = self.sent[0]
        self.assertEqual(method, "sendRichMessage")
        self.assertEqual(payload["chat_id"], -100123456)
        self.assertEqual(payload["message_thread_id"], 42)
        self.assertTrue(payload["rich_message"]["skip_entity_detection"])
        self.assertIn("<table>", payload["rich_message"]["html"])
        self.assertNotIn("allow_paid_broadcast", payload)

    def test_command_alias_address_and_custom_window(self):
        for text in ("/resource 24", "/resources@vitalsbot 24"):
            self.assertTrue(self.handle(update(text)))
            self.assertEqual(self.reports[0][1], 24)
        self.assertFalse(self.handle(update("/resource@OtherBot")))

    def test_invalid_windows_and_shell_text_never_execute(self):
        for text in (
            "/resource 0",
            "/resource 73",
            "/resource -1",
            "/resource ١",
            "/resource 1;id",
            "/resource 12 extra",
            "/resource " + "9" * 5000,
        ):
            self.assertTrue(self.handle(update(text)))
            self.assertEqual(self.reports, [])
            self.assertIn("1 to 72", self.sent[0][1]["rich_message"]["html"])

    def test_wrong_chat_user_topic_and_anonymous_senders_are_ignored(self):
        for field, value in (
            ("chat", {"id": -55}),
            ("from", {"id": 456}),
            ("from", {"id": 123, "is_bot": True}),
            ("sender_chat", {"id": -100123456}),
            ("message_thread_id", 99),
            ("date", 0),
        ):
            item = update()
            item["message"][field] = value
            self.assertFalse(self.handle(item))
            self.assertEqual(self.sent, [])
            self.assertEqual(self.reports, [])
        self.assertFalse(self.handle({"channel_post": update()["message"]}))

    def test_private_chat_and_unrestricted_topic_configuration(self):
        conf = {**config(), "chat_id": 123, "topic_id": None}
        item = update()
        item["message"]["chat"]["id"] = 123
        item["message"].pop("message_thread_id")
        self.assertTrue(self.handle(item, conf))
        self.assertNotIn("message_thread_id", self.sent[0][1])

    def test_configuration_fails_closed(self):
        bot.validate_config(config())
        for field, value in (
            ("chat_id", 0),
            ("chat_id", "@public"),
            ("chat_id", True),
            ("allowed_user_ids", []),
            ("allowed_user_ids", [True]),
            ("allowed_user_ids", [-1]),
            ("topic_id", 0),
            ("hours", 73),
            ("hours", 1.5),
            ("token_file", "token"),
            ("reporter", None),
        ):
            with self.assertRaises(ValueError):
                bot.validate_config({**config(), field: value})

    def test_offsets_advance_only_after_success(self):
        checkpoints = []

        def handle(item):
            if item["update_id"] == 11:
                raise RuntimeError("delivery failed")

        with self.assertRaises(RuntimeError):
            bot.process_updates(
                [{"update_id": 9}, {"update_id": 10}, {"update_id": 11}],
                10,
                handle,
                checkpoints.append,
            )
        self.assertEqual(checkpoints, [11])
        self.assertEqual(
            bot.process_updates([{"update_id": 11}], 11, lambda _: None, checkpoints.append), 12
        )

    def test_network_errors_never_disclose_token(self):
        token = "123456:secret_token"
        for error in (
            urllib.error.HTTPError(
                f"https://api.telegram.org/bot{token}/getMe", 401, "unauthorized", {}, None
            ),
            urllib.error.URLError(f"failed {token}"),
        ):
            with patch.object(bot.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(RuntimeError) as caught:
                    bot.Telegram(token).call("getMe")
                self.assertNotIn(token, str(caught.exception))

    def test_report_failure_does_not_forward_stderr(self):
        with patch.object(bot.subprocess, "run", side_effect=OSError("secret_token")):
            result = bot.resource_report("/missing", 12)
            self.assertIn("unavailable", result)
            self.assertNotIn("secret_token", result)

    def test_input_is_not_mutated(self):
        item = update()
        before = copy.deepcopy(item)
        self.handle(item)
        self.assertEqual(item, before)

    def test_poller_uses_delivery_checkpoint_and_does_not_change_a_webhook(self):
        for webhook in ("", "https://existing.example/webhook"):
            calls = []

            class FakeTelegram:
                def call(self, method, payload=None):
                    calls.append((method, payload))
                    if method == "getMe":
                        return {"username": "VitalsBot"}
                    if method == "getWebhookInfo":
                        return {"url": webhook}
                    if method == "getUpdates":
                        if payload["offset"] == 10:
                            raise KeyboardInterrupt
                        return [update()]
                    if method == "sendRichMessage":
                        return {"message_id": 100}
                    raise AssertionError(method)

            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                token = root / "token"
                token.write_text("123:fake", encoding="utf-8")
                conf = {**config(), "token_file": str(token)}
                with (
                    patch.object(bot, "Telegram", return_value=FakeTelegram()),
                    patch.object(bot.time, "time", return_value=1000),
                    patch.object(bot.subprocess, "run") as reporter,
                ):
                    reporter.return_value.stdout = "<p>Test report</p>"
                    with self.assertRaises(ValueError if webhook else KeyboardInterrupt):
                        bot.run(conf, root / "state")
                if webhook:
                    self.assertEqual([name for name, _ in calls], ["getMe", "getWebhookInfo"])
                    self.assertFalse((root / "state").exists())
                else:
                    self.assertEqual(bot.load_offset(root / "state/offset"), 10)
                    self.assertIn("sendRichMessage", [name for name, _ in calls])


if __name__ == "__main__":
    unittest.main()
