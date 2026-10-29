#!/usr/bin/env python3
"""Operation-only Hostinger broker. Install root-owned and invoke with python3 -I.

The no-argument entry point needs root, but never reads the token. It starts an
isolated worker with just the Hostinger credential. Only the worker makes HTTPS
requests. Neither entry point accepts a URL, headers or an arbitrary command.
"""

import datetime
import fcntl
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import ssl
import stat
import subprocess
import sys
import time
import shlex
from contextlib import contextmanager
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path("/etc/key-manager/hostinger/config.json")
ENCRYPTED = "/etc/key-manager/hostinger/token.cred"
WORKER = "/usr/local/libexec/governor-hostinger.py"
WORKER_ACCOUNT = "key-manager-hostinger"
STATE = Path("/var/lib/key-manager-hostinger")
HELPER = Path("/usr/local/libexec/governor-hostinger")
SUDOERS = Path("/etc/sudoers.d/governor-hostinger")
LOCK = Path("/run/governor-hostinger-request.lock")
API = "https://developers.hostinger.com/api/vps/v1/virtual-machines"
MAX_BODY = 4 * 1024 * 1024
MAX_INTERVAL = 48 * 3_600_000
MAX_VCPUS = 128
MAX_VM_ID = 9_007_199_254_740_991
MAX_TOKEN_BYTES = 8192
COOLDOWN_SECONDS = 60
CHECK_WINDOW_MS = 12 * 3_600_000
CAPABILITY = "request_command v1 supported"
TEMPORARY_ERRORS = ("busy", "rate_limited")
# Metrics Hostinger returned but no CPU percentage can be: the daemon raises readings-invalid for
# them, as it does when it reads the API itself, instead of letting the feed merely go stale.
INVALID_METRICS = "invalid_metrics"
RESPONSE_ERRORS = TEMPORARY_ERRORS + (INVALID_METRICS,)
# Readings may carry Hostinger's clock, a little ahead of this box's, as the daemon allows.
CLOCK_SKEW_MS = 300_000
USER_AGENT = "Deno/2.9.7"
REQUEST_SECONDS = 25
# Keep these budgets ordered with commandRequest's 25-second deadline. The
# supervisor outlives systemd-run, which outlives the worker's CPU/API work.
# Startup + runtime + stop also fit inside systemd-run's budget, so its worker
# cannot outlive the caller's deadline. The shared contract tests both orderings.
WORKER_SECONDS = 18
START_SECONDS = 3
STOP_SECONDS = 1
RUN_SECONDS = 23
ALARM_SECONDS = 24
API_SECONDS = 15
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


def launcher_text(worker=WORKER):
    return (
        "#!/bin/sh\n"
        '[ "$#" -eq 0 ] || { echo "Arguments are not authorized." >&2; exit 2; }\n'
        "exec /usr/bin/env -i "
        + " ".join(shlex.quote(key + "=" + value) for key, value in ENV.items())
        + " /usr/bin/python3 -I "
        + shlex.quote(str(worker))
        + "\n"
    )


def sudo_rule(helper=HELPER):
    require(re.fullmatch(r"/[A-Za-z0-9/._-]+", str(helper)), "Unsafe helper path.")
    return "governor ALL=(root) NOPASSWD: " + str(helper) + ' ""\n'


@contextmanager
def request_lock(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as lock:
        info = os.fstat(lock.fileno())
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == 0
            and not info.st_mode & 0o077,
            "Unsafe broker lock.",
        )
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Broker is busy.", "busy") from None
        yield


def validate_token(raw):
    require(
        10 <= len(raw) <= MAX_TOKEN_BYTES
        and re.fullmatch(rb"[A-Za-z0-9._~+/=\-]+", raw),
        "Invalid Hostinger token.",
    )
    return raw.decode("ascii")


class Refused(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def require(condition, message, code=None):
    if not condition:
        raise Refused(message, code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key.")
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def authorize_request(raw, vm_id, now=None):
    require(len(raw) <= 1024, "Request too large.")
    value = decode(raw)
    require(isinstance(value, dict), "Request must be an object.")
    require(
        type(value.get("version")) is int and value["version"] == 1,
        "Unsupported protocol version.",
    )
    require(
        type(value.get("vm_id")) is int and value["vm_id"] == vm_id,
        "VM is not authorized.",
    )
    operation = value.get("operation")
    keys = {"version", "operation", "vm_id"}
    if operation == "metrics":
        keys |= {"from", "to"}
        start, end = value.get("from"), value.get("to")
        current = int(time.time() * 1000) if now is None else now
        require(
            type(start) is int
            and type(end) is int
            and 0 <= start < end
            and end - start <= MAX_INTERVAL
            and current - MAX_INTERVAL - 300_000 <= start
            and current - 300_000 <= end <= current + 300_000,
            "Metrics interval is not authorized.",
        )
    else:
        require(operation == "vm", "Operation is not authorized.")
    require(set(value) == keys, "Unexpected request fields.")
    return value


def configured_vm_id():
    for path in (CONFIG.parent.parent, CONFIG.parent, CONFIG):
        info = path.lstat()
        require(
            info.st_uid == 0
            and not info.st_mode & 0o022
            and (
                stat.S_ISREG(info.st_mode)
                if path == CONFIG
                else stat.S_ISDIR(info.st_mode)
            ),
            "Unsafe broker configuration.",
        )
    value = decode(CONFIG.read_bytes())
    vm_id = value.get("vm_id") if isinstance(value, dict) else None
    require(type(vm_id) is int and 0 < vm_id <= MAX_VM_ID, "Invalid configured VM.")
    return vm_id


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused("Upstream redirect refused.")


def api_body(token, suffix=""):
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        NoRedirect(),
    )
    req = urllib.request.Request(
        API + suffix,
        method="GET",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            # Match the direct-token client's tested User-Agent. Hostinger's edge
            # filtering has rejected Python's default even with a valid token.
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with opener.open(req, timeout=API_SECONDS) as response:
            body = response.read(MAX_BODY + 1)
            require(len(body) <= MAX_BODY, "Upstream response too large.")
            return decode(body)
    except urllib.error.HTTPError as error:
        raise Refused("Hostinger returned HTTP " + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError):
        raise Refused("Hostinger is unavailable.") from None


def request_suffix(value):
    suffix = "/" + str(value["vm_id"])
    if value["operation"] == "metrics":

        def stamp(ms):
            return datetime.datetime.fromtimestamp(
                ms / 1000, datetime.timezone.utc
            ).isoformat()

        suffix += "/metrics?" + urllib.parse.urlencode(
            {"date_from": stamp(value["from"]), "date_to": stamp(value["to"])}
        )
    return suffix


def upstream(token, value):
    return sanitize(api_body(token, request_suffix(value)), value)


def sanitize(body, value):
    require(isinstance(body, dict), "Invalid upstream response.")
    if value["operation"] == "vm":
        cpus = body.get("cpus")
        require(
            type(body.get("id")) is int
            and body["id"] == value["vm_id"]
            and type(cpus) is int
            and 1 <= cpus <= MAX_VCPUS,
            "Invalid upstream VM.",
        )
        # Hostinger's schema makes ipv4 nullable: null means no addresses.
        addresses = body.get("ipv4")
        addresses = [] if addresses is None else addresses
        require(isinstance(addresses, list), "Invalid upstream IPv4 addresses.")
        ipv4 = []
        for item in addresses:
            require(
                isinstance(item, dict) and isinstance(item.get("address"), str),
                "Invalid upstream IPv4 addresses.",
            )
            try:
                address = str(ipaddress.IPv4Address(item["address"]))
            except ipaddress.AddressValueError:
                raise Refused("Invalid upstream IPv4 addresses.") from None
            ipv4.append({"address": address})
        # Do not forward arbitrary account data or upstream error text.
        return {"cpus": cpus, "ipv4": ipv4}
    metric = body.get("cpu_usage")
    require(
        isinstance(metric, dict) and isinstance(metric.get("usage"), dict),
        "Invalid upstream CPU metrics.",
    )
    # A unit, timestamp or value no CPU percentage can have, or a reading stamped beyond the clock
    # skew the daemon allows, condemns the whole fetch, as it does on the daemon's own API path.
    require(
        isinstance(metric.get("unit"), str)
        and metric["unit"].strip().lower() in ("%", "percent", "percentage"),
        "Unrecognized upstream CPU metric unit.",
        INVALID_METRICS,
    )
    usage = {}
    for timestamp, cpu in metric["usage"].items():
        require(
            re.fullmatch(r"[0-9]{1,12}", timestamp)
            and type(cpu) in (int, float)
            # The range check first: math.isfinite raises OverflowError on an integer too large
            # for a float, which failed the fetch as an error instead of invalid metrics.
            and 0 <= cpu <= 100
            and math.isfinite(cpu)
            and int(timestamp) * 1000 <= value["to"] + CLOCK_SKEW_MS,
            "Invalid upstream CPU reading.",
            INVALID_METRICS,
        )
        at = int(timestamp) * 1000
        if value["from"] <= at <= value["to"] + CLOCK_SKEW_MS:
            usage[timestamp] = cpu
    return {"cpu_usage": {"unit": "%", "usage": usage}}


def read_token():
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    require(
        directory.startswith("/run/credentials/"), "Worker credential is unavailable."
    )
    fd = os.open(directory + "/hostinger-token", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        # systemd may use a root-owned 0440 file with a named-user ACL. The group
        # read bit is the ACL mask, not evidence that unrelated users can read it.
        # Trust the systemd-managed private mount, but reject writable/executable
        # credentials, other-user permissions, and an unexpected owner.
        require(
            stat.S_ISREG(info.st_mode)
            and not info.st_mode & 0o337
            and info.st_uid in (0, os.geteuid()),
            "Unsafe runtime credential.",
        )
        raw = stream.read(MAX_TOKEN_BYTES + 1)
    return validate_token(raw)


def worker(value):
    require(os.geteuid() != 0, "Worker must run unprivileged.")
    # Cache contains only sanitized results. Rate limiting applies even when the
    # caller varies the interval, and unsuccessful requests consume the allowance.
    cache_path = STATE / (value["operation"] + ".json")
    cached = decode(cache_path.read_bytes()) if cache_path.exists() else {}
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    now = time.monotonic()
    age = now - cached.get("at", -1000)
    if cached.get("boot_id") == boot_id and 0 <= age < COOLDOWN_SECONDS:
        if (
            cached.get("request", {}).get("vm_id") != value["vm_id"]
            or "data" not in cached
        ):
            raise Refused("Request rate limit reached.", "rate_limited")
        if value["operation"] == "metrics":
            return sanitize(cached["data"], value)
        # A pre-addresses broker cached only cpus. Refresh once after upgrade so
        # an immediate deployment check can verify the VM's addresses. A failed
        # refresh writes a no-data record below and still consumes its allowance.
        if "ipv4" in cached["data"]:
            return cached["data"]
    fetch_request = dict(value)
    if value["operation"] == "metrics":
        # Fetch one complete authorized window. A daemon fetch and a connection
        # check may use different timestamps; both can reuse this sanitized data
        # for 60 seconds without spending each other's upstream allowance.
        fetch_request["to"] = int(time.time() * 1000)
        fetch_request["from"] = max(0, fetch_request["to"] - MAX_INTERVAL)
    cache = {"boot_id": boot_id, "at": now, "request": fetch_request}
    write_cache(cache_path, cache)
    data = upstream(read_token(), fetch_request)
    cache["data"] = data
    write_cache(cache_path, cache)
    return sanitize(data, value) if value["operation"] == "metrics" else data


def write_cache(path, value):
    staging = path.with_suffix(".tmp")
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(staging, path)


def launch(raw):
    require(os.geteuid() == 0, "Broker launcher requires root.")
    with request_lock(LOCK):
        result = subprocess.run(
            [
                "/usr/bin/systemd-run",
                "--quiet",
                "--wait",
                "--pipe",
                "--collect",
                "--unit=governor-hostinger-request",
                "--service-type=exec",
                "-p",
                "User=" + WORKER_ACCOUNT,
                "-p",
                "Group=" + WORKER_ACCOUNT,
                "-p",
                "LoadCredentialEncrypted=hostinger-token:" + ENCRYPTED,
                "-p",
                "StateDirectory=" + WORKER_ACCOUNT,
                "-p",
                "StateDirectoryMode=0700",
                "-p",
                "ProtectSystem=strict",
                "-p",
                "ProtectHome=yes",
                "-p",
                "PrivateTmp=yes",
                "-p",
                "PrivateDevices=yes",
                "-p",
                "NoNewPrivileges=yes",
                "-p",
                "CapabilityBoundingSet=",
                "-p",
                "RestrictSUIDSGID=yes",
                "-p",
                "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
                "-p",
                "InaccessiblePaths=/etc/governor /var/lib/governor",
                "-p",
                "UMask=0077",
                "-p",
                "LimitCORE=0",
                "-p",
                "MemoryMax=128M",
                "-p",
                "TasksMax=8",
                "-p",
                "RuntimeMaxSec=" + str(WORKER_SECONDS),
                "-p",
                # systemd 255 refuses JobTimeoutSec on transient units, which
                # fails every request; RUN_SECONDS bounds a queued start.
                "TimeoutStartSec=" + str(START_SECONDS),
                "-p",
                "TimeoutStopSec=" + str(STOP_SECONDS),
                "--",
                "/usr/bin/python3",
                "-I",
                WORKER,
                "--worker",
            ],
            input=raw,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=RUN_SECONDS,
            env=ENV,
        )
        require(
            result.returncode == 0 and len(result.stdout) <= MAX_BODY,
            "Hostinger worker failed.",
        )
        return decode(result.stdout)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(1))
    signal.alarm(ALARM_SECONDS)
    require(
        len(sys.argv) == 1 or sys.argv[1:] == ["--worker"],
        "Arguments are not authorized.",
    )
    raw = sys.stdin.buffer.read(1025)
    value = authorize_request(raw, configured_vm_id())
    try:
        if len(sys.argv) == 1:
            response = launch(raw)
            require(
                isinstance(response, dict)
                and response.get("version") == 1
                and response.get("vm_id") == value["vm_id"]
                and ("data" in response or response.get("error") in RESPONSE_ERRORS),
                "Invalid worker response.",
            )
        else:
            response = {"version": 1, "vm_id": value["vm_id"], "data": worker(value)}
    except Refused as error:
        if error.code not in RESPONSE_ERRORS:
            raise
        response = {"version": 1, "vm_id": value["vm_id"], "error": error.code}
    print(json.dumps(response, allow_nan=False), flush=True)


def entrypoint():
    try:
        main()
    except Refused as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except BaseException:
        # Never print exception text or a traceback. Upstream and credential
        # handling errors may contain secrets.
        print("Hostinger broker failed.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    entrypoint()
