#!/usr/bin/env python3
"""Optional, read-only /resource bot. Python 3.10+, no third-party dependencies.

For an existing bot, reuse handle_update instead of starting a second getUpdates consumer.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USAGE = "<p>Use <b>/resource</b> or <b>/resource 24</b>. History: 1 to 72 hours.</p>"


def validate_config(config):
    def integer(value):
        return type(value) is int and 0 < abs(value) < 2**52

    if not isinstance(config, dict) or not integer(config.get("chat_id")):
        raise ValueError("chat_id must be a nonzero numeric Telegram chat ID")
    users = config.get("allowed_user_ids")
    if not isinstance(users, list) or not users or any(not integer(u) or u < 0 for u in users):
        raise ValueError("allowed_user_ids must contain at least one positive numeric user ID")
    topic = config.get("topic_id")
    if topic is not None and (not integer(topic) or topic < 0):
        raise ValueError("topic_id must be null or a positive integer")
    hours = config.get("hours", 12)
    if type(hours) is not int or not 1 <= hours <= 72:
        raise ValueError("hours must be an integer from 1 to 72")
    for key in ("token_file", "reporter"):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise ValueError(f"{key} must be an absolute file path")
    return config


def resource_report(reporter, hours):
    try:
        return subprocess.run(
            [reporter, "--hours", str(hours)],
            capture_output=True,
            text=True,
            timeout=45,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        # Do not forward stderr, paths, credentials or tracebacks into a chat.
        return "<p>Resource report unavailable. Check the reporter and its read permissions.</p>"


def handle_update(update, config, bot_username, send, report=resource_report, now=None):
    """Authorize an incoming message, render it, and send a rich response. Returns whether handled.

    send(method, payload) must raise on delivery failure. The caller must not acknowledge that update
    until delivery succeeds. Reports execute a fixed argv, never message text through a shell.
    """
    message = update.get("message", {})
    user = message.get("from", {})
    if (
        message.get("chat", {}).get("id") != config["chat_id"]
        or user.get("id") not in config["allowed_user_ids"]
        or user.get("is_bot")
        or message.get("sender_chat")
        or (
            config.get("topic_id") is not None
            and message.get("message_thread_id") != config["topic_id"]
        )
    ):
        return False
    timestamp = message.get("date", 0)
    if (
        not isinstance(timestamp, (int, float))
        or (time.time() if now is None else now) - timestamp > 300
    ):
        return False
    text = message.get("text", "")
    if not isinstance(text, str):
        return False
    words = text.split()
    if not words:
        return False
    command, _, addressed = words[0].partition("@")
    if command not in ("/resource", "/resources") or (
        addressed and addressed.casefold() != bot_username.casefold()
    ):
        return False
    valid = len(words) == 1 or (
        len(words) == 2 and re.fullmatch(r"[0-9]{1,2}", words[1]) and 1 <= int(words[1]) <= 72
    )
    body = (
        report(config["reporter"], int(words[1]) if len(words) == 2 else config.get("hours", 12))
        if valid
        else USAGE
    )
    payload = {
        "chat_id": config["chat_id"],
        "rich_message": {"html": body, "skip_entity_detection": True},
        "disable_notification": True,
    }
    if message.get("message_thread_id") is not None:
        payload["message_thread_id"] = message["message_thread_id"]
    send("sendRichMessage", payload)
    return True


class Telegram:
    def __init__(self, token):
        if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
            raise ValueError("invalid Telegram token file")
        self.token = token

    def call(self, method, payload=None):
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{self.token}/{method}",
            data=json.dumps(payload or {}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            # HTTPError/URLError strings include the URL, which includes the bot token.
            raise RuntimeError(f"Telegram {method} HTTP {error.code}") from None
        except (OSError, ValueError, urllib.error.URLError):
            raise RuntimeError(f"Telegram {method} connection or response error") from None
        if not result.get("ok"):
            raise RuntimeError(f"Telegram {method} request refused")
        return result["result"]


def load_offset(path):
    try:
        value = int(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return 0
    if value < 0:
        raise ValueError("invalid saved Telegram offset")
    return value


def save_offset(path, offset):
    temp = path.with_suffix(".tmp")
    temp.write_text(str(offset), encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(path)


def process_updates(updates, offset, handle, checkpoint):
    """Persist progress after each delivered or ignored update, never after a failed delivery."""
    for update in updates:
        ident = update.get("update_id")
        if type(ident) is not int or ident < 0:
            raise ValueError("invalid Telegram update ID")
        if ident < offset:
            continue
        handle(update)
        offset = ident + 1
        checkpoint(offset)
    return offset


def run(config, state_dir):
    telegram = Telegram(Path(config["token_file"]).read_text(encoding="utf-8").strip())
    username = telegram.call("getMe")["username"]
    if telegram.call("getWebhookInfo").get("url"):
        raise ValueError("bot already has a webhook; use the existing-bot adapter instead")
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state_dir / "offset"
    offset, backoff = load_offset(path), 1
    while True:
        try:
            updates = telegram.call(
                "getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": ["message"]}
            )
            # Read progress again if a later delivery failed after earlier updates succeeded.
            offset = process_updates(
                updates,
                load_offset(path),
                lambda update: handle_update(update, config, username, telegram.call),
                lambda value: save_offset(path, value),
            )
            backoff = 1
        except (RuntimeError, OSError, ValueError):
            # Never print raw network errors or config, either of which can contain credentials.
            print(
                "Telegram update failed; retrying. Check bot access, permissions and connectivity.",
                file=sys.stderr,
                flush=True,
            )
            offset = load_offset(path)
            time.sleep(backoff)
            backoff = min(30, backoff * 2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/governor-resource/config.json")
    parser.add_argument("--state-dir", default="/var/lib/governor-resource")
    parser.add_argument(
        "--check", action="store_true", help="validate locally without contacting Telegram"
    )
    args = parser.parse_args()
    try:
        config = validate_config(json.loads(Path(args.config).read_text(encoding="utf-8")))
        if args.check:
            Telegram(Path(config["token_file"]).read_text(encoding="utf-8").strip())
            if not os.access(config["reporter"], os.X_OK):
                raise ValueError("reporter is not executable")
            print("Resource bot configuration valid; no Telegram requests made.")
        else:
            run(config, Path(args.state_dir))
    except (OSError, ValueError, RuntimeError):
        print(
            "Resource bot could not start. Check configuration, token file, reporter and webhook ownership.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
