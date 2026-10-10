#!/usr/bin/env python3
"""Read-only Telegram rich-message dashboard. Requires Python 3.10+, governor and sysstat."""

import argparse
import html
import json
import math
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

GIB = 1024**3
BARS = "▁▂▃▄▅▆▇█"


def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=2, check=True).stdout


def parse_sadf(text, start, end):
    header, rows = [], []
    for line in text.splitlines():
        if line.startswith("# hostname;"):
            header = line[2:].split(";")
            continue
        cells = line.split(";")
        if not header or len(cells) != len(header):
            continue
        try:
            at = (
                datetime.strptime(cells[2], "%Y-%m-%d %H:%M:%S UTC")
                .replace(tzinfo=timezone.utc)
                .timestamp()
            )
            values = {key: float(value) for key, value in zip(header[3:], cells[3:])}
            if start <= at <= end and all(math.isfinite(v) for v in values.values()):
                rows.append({"at": at, **values})
        except ValueError:
            continue
    return rows


def history(flag, start, end):
    day = datetime.fromtimestamp(start, timezone.utc).date()
    last = datetime.fromtimestamp(end, timezone.utc).date()
    rows = []
    while day <= last:
        try:
            rows.extend(
                parse_sadf(
                    command(["sadf", "-d", f"/var/log/sysstat/sa{day.day:02}", "--", flag]),
                    start,
                    end,
                )
            )
        except (OSError, subprocess.SubprocessError):
            pass
        day += timedelta(days=1)
    return sorted(rows, key=lambda row: row["at"])


def sparkline(points, start, end, maximum=100, interval=600):
    columns = max(1, min(24, int((end - start) / interval)))
    width = (end - start) / columns
    out = []
    for index in range(columns):
        values = [
            value
            for at, value in points
            if start + index * width <= at < start + (index + 1) * width
        ]
        if not values:
            out.append("·")
            continue
        value = sum(values) / len(values)
        scaled = round(7 * value / maximum) if maximum > 0 else 0
        out.append(BARS[max(0, min(7, scaled))])
    return "".join(out)


def number(value, places=1):
    return f"{value:,.{places}f}".rstrip("0").rstrip(".") if places else f"{value:,.0f}"


def duration(seconds):
    if seconds <= 0:
        return "now"
    minutes = math.ceil(seconds / 60)
    return f"~{minutes} min" if minutes < 60 else f"~{minutes // 60}h {minutes % 60}m"


def table(headers, rows):
    return (
        "<table striped compact><tr>"
        + "".join(f"<th>{html.escape(str(h))}</th>" for h in headers)
        + "</tr>"
        + "".join(
            "<tr>" + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row) + "</tr>"
            for row in rows
        )
        + "</table>"
    )


def badge(value, warning, danger):
    return "🔴" if value >= danger else "🟡" if value >= warning else "🟢"


def statistics(points):
    values = [value for _, value in points]
    return (sum(values) / len(values), max(values)) if values else (None, None)


def collect(hours=12):
    now = time.time()
    start = now - hours * 3600
    try:
        state = json.loads(command(["/usr/local/bin/governor", "status", "--json"]))
        error = None
    except (OSError, ValueError, subprocess.SubprocessError):
        state, error = (
            None,
            "No fresh governor state. Credits and recovery estimates are unavailable.",
        )
    with open("/proc/meminfo", encoding="utf-8") as source:
        memory = {line.split(":")[0]: int(line.split()[1]) / 1024**2 for line in source}
    disk = os.statvfs("/")
    return {
        "now": now,
        "start": start,
        "hours": hours,
        "state": state,
        "error": error,
        "memory": memory,
        "load": os.getloadavg(),
        "disk": {
            "total": disk.f_blocks * disk.f_frsize / GIB,
            "free": disk.f_bavail * disk.f_frsize / GIB,
        },
        "cpu": history("-u", start, now),
        "ram": history("-r", start, now),
        "swap": history("-S", start, now),
        "loads": history("-q", start, now),
    }


def render(data):
    state, now, start = data["state"], data["now"], data["start"]
    try:
        tz = ZoneInfo((state or {}).get("timezone", "Europe/Istanbul"))
    except ZoneInfoNotFoundError:
        tz = timezone.utc
    clock = datetime.fromtimestamp(now, tz).strftime("%H:%M")
    zone = "Turkey time" if str(tz) == "Europe/Istanbul" else str(tz)
    out = [
        "<h3>Server vitals</h3>",
        f"<p>Last {data['hours']}h · {clock} {html.escape(zone)}</p>",
    ]
    if state:
        plan, credits = state["plan"], state["credits"]
        limit, cpu = state.get("limit"), state["cpu"]
        cores, capacity = plan["vcpus"], plan["capacity"]
        balance, reserve, rate = credits["balance"], plan["recovered"], credits["rate"]
        percent = 100 * balance / capacity
        filled = max(0, min(20, round(percent / 5)))
        gate = "🟢 Accepting work" if state["accepting"] else "🔴 New work paused"
        host = "🔴 Host CPU limit detected" if limit else "Host CPU limit not detected"
        out += [
            f"<p><b>{gate}</b> · {host}</p>",
            "<p><b>Estimated CPU credit bank</b></p>",
            f"<pre>{'█' * filled}{'░' * (20 - filled)}  {percent:.1f}%</pre>",
        ]
        rebuilding = credits.get("rebuilding")
        if rebuilding:
            reasons = {
                "first-start": "first startup",
                "state-upgrade": "discarding an older, untrusted estimate",
                "plan-change": "a plan or baseline change",
                "reboot": "a VPS reboot",
                "counter-reset": "a CPU counter reset",
            }
            reason = reasons.get(rebuilding["reason"], "resetting the estimate")
            out.append(
                f"<p><b>Estimate rebuilding</b> after {html.escape(reason)}. "
                "This is a conservative local estimate, not an empty bank reported by Hostinger. "
                "The governor can still accept work below the baseline.</p>"
            )
        measuring = cpu.get("observedSeconds") == 0
        margin = credits["margin"]
        debit = cores * margin["mul"] + margin["add"] - plan["baseline"]
        headroom = max(0, balance - reserve)
        rows = [
            ("Balance", f"{number(balance, 0)} / {number(capacity, 0)} core-seconds"),
            (
                "Bank trend" if measuring else "Earning" if rate >= 0 else "Spending",
                "Waiting for the first CPU sample"
                if measuring
                else f"{number(abs(rate))} credits/s · {number(abs(rate) * 3600, 0)}/h",
            ),
            (
                "Managed ceiling",
                f"{number(state['ceiling'] / 100)} / {cores} vCPUs · {number(state['ceiling'] / cores)}% of box",
            ),
            (
                "Baseline",
                f"{number(plan['baseline'])} / {cores} vCPUs · {number(plan['baseline'] / cores * 100)}%",
            ),
            (
                "Reserve / lift point",
                f"{number(reserve, 0)} credits · {number(reserve / capacity * 100)}% of bank",
            ),
            ("Burst headroom", f"{number(headroom, 0)} credits above reserve"),
            (
                f"Runway at all {cores} vCPUs",
                duration(headroom / debit) + " until reserve"
                if headroom > 0 and debit > 0
                else "No surplus above reserve",
            ),
            (
                "Billing margin",
                f"Observed use × {number(margin['mul'], 2)} + {number(margin['add'], 2)} vCPU",
            ),
        ]
        if measuring:
            pass
        elif rate > 0:
            if balance < reserve:
                rows.append(
                    ("Build reserve", duration((reserve - balance) / rate) + " at current rate")
                )
            rows.append(
                ("Fill bank", duration(max(0, capacity - balance) / rate) + " at current rate")
            )
        elif rate < 0:
            rows.append(
                (
                    "Reach reserve",
                    duration(headroom / -rate) + " at current rate"
                    if headroom
                    else "Already at or below reserve",
                )
            )
        else:
            rows.append(("Bank trend", "Flat; no refill or spending ETA"))
        out.append(table(("Credit metric", "Current estimate"), rows))
        coverage = state["coverage"]
        recovery = [
            ("Outside the quota", f"{number(coverage['outsideCores'], 2)} vCPU"),
            (
                "Recovery blocked",
                "🔴 Outside workload alone exceeds the host limit"
                if coverage["recoveryBlocked"]
                else "No outside-load block detected",
            ),
        ]
        if limit:
            elapsed = max(0, (state["uptime"] - limit.get("startedAt", limit["heldFrom"])) / 1000)
            recovery += [
                ("Limited for", duration(elapsed).removeprefix("~")),
                ("Host limit", f"{number(plan['limit'])} vCPUs"),
                (
                    "Earliest idle recovery",
                    duration(reserve / plan["baseline"]) + " from limit start",
                ),
            ]
            if limit.get("testAt"):
                recovery.append(
                    (
                        "Lift-test backoff",
                        duration(max(0, limit["testAt"] - state["uptime"]) / 1000),
                    )
                )
            observed = limit.get("recovery", {})
            if observed.get("seconds"):
                paused = max(0, observed["seconds"] - observed["earningSeconds"])
                recovery.append(
                    (
                        "Estimated earning pauses",
                        duration(paused).removeprefix("~") if paused else "0 min",
                    )
                )
            out.append(
                "<p><b>Limit recovery</b> · A lift test must confirm recovery; timing alone cannot.</p>"
            )
        else:
            out.append("<p><b>Quota coverage</b></p>")
        out.append(table(("Recovery metric", "State"), recovery))
        live_cpu = (
            "Waiting for the first CPU sample"
            if measuring
            else f"{number(cpu['busy5'] * 100)}% busy · {number(cpu['steal5'] * 100, 2)}% steal over 5m"
        )
        out.append(
            f"<p><b>CPU</b> · {html.escape(live_cpu)}"
            + ("" if measuring else f"<br>30m busy average: {number(cpu['busy30'] * 100)}%")
            + "</p>"
        )
        users = sorted(cpu.get("users30", {}).items(), key=lambda item: item[1], reverse=True)
        if users:
            out.append(
                table(
                    ("User", "CPU share over 30m"),
                    [(name[:64], f"{number(value * 100, 2)}%") for name, value in users[:12]],
                )
            )
    else:
        cores = os.cpu_count() or 1
        out.append("<p><b>🔴 Governor unavailable</b><br>" + html.escape(data["error"]) + "</p>")
    cpu_points = [
        (row["at"], max(0, 100 - row["%idle"] - row["%iowait"] - row["%steal"]))
        for row in data["cpu"]
    ]
    steal = [(row["at"], row["%steal"]) for row in data["cpu"]]
    readings = [
        (r["at"] / 1000, r["v"])
        for r in (state or {}).get("readings", [])
        if start <= r["at"] / 1000 <= now
    ]
    cpu_rows = []
    for label, points in (("Guest CPU", cpu_points), ("Steal", steal), ("Hostinger API", readings)):
        average, peak = statistics(points)
        cpu_rows.append(
            (
                label,
                f"{number(average)}%" if average is not None else "Not available",
                f"{number(peak)}%" if peak is not None else "Not available",
            )
        )
    out += [
        table((f"CPU · last {data['hours']}h", "Average", "Peak"), cpu_rows),
        "<p><b>Guest CPU history</b></p><pre>" + sparkline(cpu_points, start, now) + "</pre>",
        "<p><b>Steal history</b></p><pre>" + sparkline(steal, start, now) + "</pre>",
    ]
    if readings:
        out += [
            "<p><b>Hostinger API history</b> · Diagnostic only</p><pre>"
            + sparkline(readings, start, now, interval=1800)
            + "</pre>"
        ]
    else:
        out.append(
            "<p>Hostinger API history is unavailable. The bank estimate uses guest CPU measurements.</p>"
        )
    anchor = state and state["credits"].get("anchor")
    if anchor:
        checked = datetime.fromtimestamp(anchor["checkedAt"] / 1000, tz).strftime("%d %b %H:%M")
        difference = anchor.get("difference")
        comparison = (
            "not comparable"
            if difference is None
            else f"guest/API difference {number(difference)} percentage points"
        )
        out.append(f"<p>API last checked {checked} · {comparison}. It does not reset the bank.</p>")
    memory, disk = data["memory"], data["disk"]
    total, available = memory["MemTotal"], memory["MemAvailable"]
    ram = [(row["at"], 100 * (1 - row["kbavail"] / 1024**2 / total)) for row in data["ram"]]
    lowest = min([available] + [row["kbavail"] / 1024**2 for row in data["ram"]])
    swap = 100 * (1 - memory["SwapFree"] / memory["SwapTotal"]) if memory["SwapTotal"] else 0
    swap_peak = max([swap] + [row["%swpused"] for row in data["swap"]])
    loads = [(row["at"], row["ldavg-1"]) for row in data["loads"]]
    load_peak = max([data["load"][0]] + [value for _, value in loads])
    disk_used = 100 * (1 - disk["free"] / disk["total"])
    out += [
        "<p><b>Memory, load and storage</b></p>",
        table(
            ("Resource", "Live", f"Last {data['hours']}h"),
            [
                (
                    badge(100 * (1 - lowest / total), 80, 90) + " Memory",
                    f"{number(available)} / {number(total)} GiB free",
                    f"Lowest free {number(lowest)} GiB",
                ),
                (
                    badge(swap, 50, 90) + " Swap",
                    f"{number(swap)}% used / {number(memory['SwapTotal'])} GiB",
                    f"Peak {number(swap_peak)}% used",
                ),
                (
                    badge(data["load"][0], cores, cores * 2) + " Load",
                    " / ".join(number(value, 2) for value in data["load"]),
                    f"Peak {number(load_peak, 2)} · {cores} vCPUs",
                ),
                (
                    badge(disk_used, 70, 85) + " Disk /",
                    f"{number(disk['free'])} / {number(disk['total'])} GiB free",
                    f"{number(disk_used)}% used now",
                ),
            ],
        ),
        "<p><b>Memory usage history</b></p><pre>" + sparkline(ram, start, now) + "</pre>",
        "<p><b>Load history</b> · Chart ceiling "
        + str(cores * 2)
        + "</p><pre>"
        + sparkline(loads, start, now, maximum=cores * 2)
        + "</pre>",
    ]
    if state:
        age = max(0, round((now * 1000 - state["updatedAt"]) / 1000))
        out.append(
            f"<footer>Governor snapshot {age}s ago. Credit figures are conservative estimates, not the hPanel balance. "
            "One credit = one vCPU-second. Runway includes the billing margin and stops at the reserve. "
            "ETAs assume the current rate continues. Charts: missing samples are ·; CPU/memory scale 0–100%. "
            "Live CPU averages build after daemon startup.</footer>"
        )
    else:
        out.append(
            "<footer>Missing chart samples are ·. No stale or assumed credit balance is displayed.</footer>"
        )
    return "".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=12, choices=range(1, 73), metavar="1..72")
    args = parser.parse_args()
    print(render(collect(args.hours)))


if __name__ == "__main__":
    main()
