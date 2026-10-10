# Telegram `/resource`

The same dashboard template used on the project's two VPSes is included here. It shows the estimated
credit bank, earning or spending rate, reserve, burst runway, quota, recovery, outside demand,
per-user CPU, and CPU, steal, memory and load charts. Hostinger API history appears when the
governor has it. There is no hostname in the heading.

This is an optional, read-only integration. The governor does not need Telegram to run. Neither the
renderer nor the bot can seed credits, lift limits or change quotas, and neither needs a Hostinger
API token. Usernames and resource figures will be visible to everyone who can read the destination
chat, even if only selected users can request them.

## Install the template

Add `--resource` when installing or updating the governor:

```sh
curl -fsSL https://github.com/olmezsoy/hostinger-governor/releases/latest/download/install.sh |
  sudo bash -s -- --resource --timezone Europe/Istanbul
```

The installer verifies the release asset checksums, installs Python if needed, and installs:

- `/usr/local/libexec/governor-resource`, the HTML renderer;
- `/usr/local/libexec/governor-resource-bot`, the optional Telegram adapter and polling bot;
- `/etc/systemd/system/telegram-resource.service`, a disabled systemd unit.

It does not ask for a Telegram token, create a bot, or start polling. Existing governor
configuration and compatible credit estimates are kept, including your configured timezone.

To install from a checkout instead of release assets:

```sh
sudo install -m 0755 examples/telegram-resource.py /usr/local/libexec/governor-resource
sudo install -m 0755 examples/telegram-resource-bot.py /usr/local/libexec/governor-resource-bot
sudo install -m 0644 examples/telegram-resource.service /etc/systemd/system/telegram-resource.service
```

Python 3.10+ and sysstat are required. The output uses Telegram's
[native rich messages](https://core.telegram.org/bots/api#sendrichmessage), including tables.
Sending it with `sendMessage` and `parse_mode=HTML` will not work. Update old bot libraries or call
`sendRichMessage` directly.

## Connect an existing bot

Keep the bot's current webhook or polling loop. Do not start the included polling unit with that
same token. Telegram allows only one update consumer, and the standalone bot refuses an existing
webhook rather than removing it.

If your bot already handles commands, route `/resource` to this fixed command:

```sh
/usr/local/libexec/governor-resource --hours 12
```

Pass its stdout to `sendRichMessage` as
`rich_message={"html": output, "skip_entity_detection": true}`. Preserve `message_thread_id` for
forum topics. Validate any hours argument as an integer from 1 to 72, restrict who can request the
report, and acknowledge the command only after delivery succeeds. Do not interpolate message text
into a shell command.

For a Python bot, the included adapter handles those checks and command parsing. Load it once at
startup, then call it from the existing dispatcher:

```python
import runpy

resource = runpy.run_path("/usr/local/libexec/governor-resource-bot")
config = {
    "chat_id": -1001234567890,  # Replace with your group or private chat's numeric ID.
    "topic_id": 42,            # Replace with the Announcements topic ID, or None.
    "allowed_user_ids": [123456789],
    "reporter": "/usr/local/libexec/governor-resource",
    "hours": 12,
}

def on_update(update):
    # telegram_call(method, payload) is your existing sender. It must raise on failure.
    handled = resource["handle_update"](update, config, "YourBotUsername", telegram_call)
    if handled:
        return
    # Continue your existing dispatcher here.
```

`handle_update` is synchronous and can take up to 45 seconds while collecting history. Async bots
should run it in a worker thread and provide a thread-safe sender, or keep their existing async
dispatcher and execute the renderer with an async subprocess. Do not block the bot's event loop.

## Run a dedicated bot

Use this path only for a new bot token with no other polling process or webhook. Create the bot in
BotFather, add it to your group, and allow it to send messages in the desired topic. In a private
chat, start the bot first. This template handles messages from named users in private chats or
groups and forum topics. Anonymous admin messages and broadcast channel posts are deliberately
ignored because they have no allowlisted user identity.

Create a separate account with no sudo rights and no membership in the governor group:

```sh
sudo useradd --system --user-group --home-dir /var/lib/governor-resource \
  --shell /usr/sbin/nologin governor-report
sudo install -d -o root -g governor-report -m 0750 /etc/governor-resource
sudo install -o root -g governor-report -m 0640 /dev/null /etc/governor-resource/token
sudo install -o root -g governor-report -m 0640 /dev/null /etc/governor-resource/config.json
sudoedit /etc/governor-resource/token
sudoedit /etc/governor-resource/config.json
```

Put just the bot token in `token`. Keep it out of commands, Git, screenshots and logs. Paste this
into `config.json` and replace the example IDs with your own:

```json
{
  "token_file": "/etc/governor-resource/token",
  "reporter": "/usr/local/libexec/governor-resource",
  "chat_id": -1001234567890,
  "topic_id": 42,
  "allowed_user_ids": [123456789],
  "hours": 12
}
```

Use `null` for `topic_id` outside a specific forum topic. With `null`, requests from any topic in
the configured chat are allowed and replies stay in the requesting topic. Private chat IDs are
positive; group IDs are normally negative. Get numeric chat, topic and user IDs from your existing
bot's update inspector. Avoid handing your token to an unrelated ID-lookup website. Empty allowlists
are refused.

Check the configuration without contacting Telegram, then test the renderer as the bot's account:

```sh
sudo -u governor-report /usr/local/libexec/governor-resource-bot --check
sudo -u governor-report /usr/local/libexec/governor-resource --hours 12
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-resource.service
```

Send `/resource`, `/resource 24`, or `/resource@YourBotUsername` in the configured chat and topic.
`/resources` is an alias. The default history window is 12 hours. The bot ignores commands older
than five minutes so restarting it does not publish a backlog of old reports. It saves its update
offset after each successful delivery or ignored update. A crash between sending and saving can
duplicate a reply; it will not silently mark a failed delivery as done.

The systemd unit runs without root or control privileges, outside `user.slice`, so a CPU limit does
not prevent it from reporting. If sysstat files are not readable by this account, charts show gaps.
Grant read access to those history files if needed, not to the Hostinger token or the whole `adm`
group. To troubleshoot or stop it:

```sh
journalctl -u telegram-resource.service -n 50
sudo systemctl disable --now telegram-resource.service
```

## What the figures mean

The bank is a conservative guest-side estimate, not a balance fetched from hPanel. A reboot,
untrusted old state, or a changed plan can reset that estimate while the real bank still has
credits. `Estimate rebuilding` explains that state. Reaching the local reserve clears the notice;
ordinary spending below the reserve does not bring it back. Rebuilding alone does not pause new
jobs.

Full-CPU runway spends only the surplus above the reserve and includes the learned billing margin.
Refill ETAs assume the measured rate continues. The first snapshot waits for a CPU sample rather
than claiming a measured earning rate. A detected host limit and paused work are shown separately.
API history is diagnostic and never raises the estimate. Missing samples are dots, not zero CPU.

The template contains no CI queue or model-job counts. Those depend on your scheduler. Add them to
`render()` if your deployment has a source for them. Change the headings, rows, charts or timezone
to suit your setup. An installer update replaces the packaged files, so keep custom renderers at a
different path and point `reporter` there. Both Python files use only the standard library.
