#!/usr/bin/env bash
# Installs into a disposable hosted runner. Never run against a developer or production machine.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $(uname -s) == Linux ]] ||
  { echo "smoke test requires a disposable GitHub-hosted Linux runner" >&2; exit 2; }
binary=${1:?pass the compiled Linux binary}
broker_smoke=${GOVERNOR_SMOKE_BROKER:-true}
[[ $broker_smoke == true || $broker_smoke == false ]] ||
  { echo "GOVERNOR_SMOKE_BROKER must be true or false" >&2; exit 2; }
version=$(sed -n 's/^export const VERSION = "\([^"]*\)";$/\1/p' src/main.ts)
[[ -n $version ]] || { echo "cannot read VERSION from src/main.ts" >&2; exit 2; }
container=""
mkdir -p test/.tmp
fixture_dir=$(mktemp -d test/.tmp/governor-smoke.XXXXXX)
jit_binary="$fixture_dir/governor-jit"
mdwe_dropin=/etc/systemd/system/governor.service.d/80-memory-deny-write-execute.conf
cleanup() {
  rm -rf -- "$fixture_dir"
  if [[ -n $container ]]; then sudo docker stop "$container" >/dev/null || true; fi
  sudo systemctl disable --now governor-smoke.service >/dev/null 2>&1 || true
  sudo systemctl stop governor-smoke@check.service >/dev/null 2>&1 || true
  sudo systemctl stop governor-hostinger-request.service >/dev/null 2>&1 || true
  sudo rm -f "$mdwe_dropin" /etc/systemd/system/governor-smoke.service \
    /etc/systemd/system/governor-smoke.service.d/50-governor.conf \
    /etc/systemd/system/governor-smoke@.service \
    /etc/systemd/system/governor-smoke@.service.d/50-governor.conf \
    /usr/local/libexec/governor-broker-smoke-hang \
    /usr/local/libexec/governor-hostinger.py /usr/local/libexec/governor-hostinger \
    /etc/sudoers.d/governor-hostinger /etc/sudoers.d/governor-setup-smoke
  sudo bash install.sh --uninstall || true
}
trap cleanup EXIT

wait_for_governor() {
  for ((attempt=0; attempt<20; attempt++)); do
    if sudo governor status --json >/dev/null 2>&1; then return; fi
    sleep 1
  done
  sudo governor status --json
}

# Require the next daemon to publish, rather than accepting its predecessor's state.
stop_and_discard_state() {
  sudo systemctl stop governor.service
  sudo rm -f /run/governor/state.json
}

assert_schema_v1() {
  python3 -c 'import json,sys; assert json.load(sys.stdin)["schemaVersion"] == 1'
}

run_under_mdwe() {
  local account=$1
  shift
  sudo systemd-run --quiet --wait --pipe --collect -p MemoryDenyWriteExecute=yes -p LimitCORE=0 \
    -p "User=$account" /usr/local/bin/governor "$@"
}

# The current source built with V8's JIT must still install and control the ceiling.
deno task compile:jit-fixture -o "$jit_binary"
sudo bash install.sh --binary "$jit_binary"
wait_for_governor
sudo governor exec --wait 5 -- /usr/bin/true
[[ $(governor version) == "$version" ]]
if run_under_mdwe root version >"$fixture_dir/mdwe-jit.log" 2>&1; then
  echo "JIT-enabled binary unexpectedly ran under MemoryDenyWriteExecute=yes" >&2
  exit 1
fi
grep -Eq 'Check failed:|Fatal process out of memory:' "$fixture_dir/mdwe-jit.log" ||
  { cat "$fixture_dir/mdwe-jit.log" >&2; echo "negative control failed for an unexpected reason" >&2; exit 1; }
echo "MDWE negative control passed: the JIT-enabled binary aborted"
stop_and_discard_state

sudo systemctl set-property user.slice CPUQuota=780%
sudo bash install.sh --binary "$binary"
[[ ! -f /etc/systemd/system.control/user.slice.d/50-CPUQuota.conf ]]
[[ ! -f /etc/systemd/system/user.slice.d/50-CPUQuota.conf ]]
[[ -f /etc/systemd/system/user.slice.d/10-governor.conf ]]
wait_for_governor
sudo governor status --json | assert_schema_v1
# One-shot readers need no sudo inside their unit, including on older systemd.
for account in root "$(id -un)"; do
  [[ $(run_under_mdwe "$account" version) == "$version" ]]
  run_under_mdwe "$account" status --json | assert_schema_v1
  run_under_mdwe "$account" report 1 |
    python3 -c 'import sys; assert "Estimated CPU credit bank" in sys.stdin.read()'
done
governor report --format html | python3 -c 'import sys; report=sys.stdin.read(); assert "<table>" in report; assert "Estimated CPU credit bank" in report; assert "Server vitals</h3>" in report'
governor report --format json | python3 -c 'import json,sys; report=json.load(sys.stdin); assert report["schema"] == 1; assert report["credits"]["balance"] >= 0; assert report["sections"]'
if governor seed 34560; then echo "consumer control unexpectedly succeeded" >&2; exit 1; fi
if sudo -u governor governor limit off; then echo "daemon control unexpectedly succeeded" >&2; exit 1; fi
if sudo -u governor sudo -n /usr/local/libexec/governor-cap 200 system.slice; then
  echo "cap helper accepted system.slice" >&2; exit 1
fi

sudo governor exec --wait 5 -- sh -c 'cgroup=$(cut -d: -f3 /proc/self/cgroup); case $cgroup in /user.slice/*) test "$(cat /sys/fs/cgroup$cgroup/cpu.weight)" = 1;; *) exit 1;; esac'
sudo install -m 0644 test/fixtures/governor-smoke.service /etc/systemd/system/governor-smoke.service
sudo systemctl daemon-reload
sudo governor enroll-service governor-smoke.service
sudo systemctl start governor-smoke.service
[[ $(systemctl show governor-smoke.service --property=ControlGroup --value) == /user.slice/* ]]
sudo install -m 0644 test/fixtures/governor-smoke.service /etc/systemd/system/governor-smoke@.service
sudo systemctl daemon-reload
sudo governor enroll-service governor-smoke@.service
sudo systemctl start governor-smoke@check.service
[[ $(systemctl show governor-smoke@check.service --property=ControlGroup --value) == /user.slice/* ]]

sudo governor configure-docker
sudo systemctl restart docker
container=$(sudo docker run --rm -d alpine:3.22 sleep 120)
container_pid=$(sudo docker inspect --format '{{.State.Pid}}' "$container")
[[ $(sudo cut -d: -f3 "/proc/$container_pid/cgroup") == /user.slice/* ]]
sudo docker stop "$container" >/dev/null
container=""

sudo systemctl stop governor.service
sudo systemctl daemon-reload
read -r quota period < /sys/fs/cgroup/user.slice/cpu.max
(( quota * 100 / period == 20 ))
# Built-in status readers reject unknown public versions and accept legacy snapshots.
sudo python3 -c 'import json,pathlib; p=pathlib.Path("/run/governor/state.json"); s=json.loads(p.read_text()); s["schemaVersion"]=99; p.write_text(json.dumps(s))'
if governor status --json; then echo "unknown public schema unexpectedly accepted" >&2; exit 1; fi
sudo python3 -c 'import json,pathlib; p=pathlib.Path("/run/governor/state.json"); s=json.loads(p.read_text()); s.pop("schemaVersion"); p.write_text(json.dumps(s))'
governor status --json >/dev/null
sudo -u governor sudo -n /usr/local/libexec/governor-cap 200 user.slice
read -r quota period < /sys/fs/cgroup/user.slice/cpu.max
(( quota * 100 / period == 200 ))

# An upgrade must keep the operator's fallback and mirror it into the boot quota.
sudo python3 -c 'import json,pathlib; p=pathlib.Path("/etc/governor/config.json"); c=json.loads(p.read_text()); c["fallback_cpu_percent"]=150; p.write_text(json.dumps(c))'
sudo bash install.sh --binary "$binary"
[[ $(sudo governor fallback --print) == 150 ]]
grep -qx 'CPUQuota=150%' /etc/systemd/system/user.slice.d/10-governor.conf
sudo systemctl stop governor.service
read -r quota period < /sys/fs/cgroup/user.slice/cpu.max
(( quota * 100 / period == 150 ))
sudo systemctl start governor.service
systemd_version=$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')
[[ $systemd_version =~ ^[0-9]+$ ]] || { echo "cannot read the systemd version" >&2; exit 1; }
if ((systemd_version >= 255)); then
  # Follow the README's opt-in and verification steps.
  sudo install -d /etc/systemd/system/governor.service.d
  printf '[Service]\nMemoryDenyWriteExecute=yes\n' | sudo tee "$mdwe_dropin" >/dev/null
  sudo systemctl daemon-reload
  stop_and_discard_state
  sudo systemctl start governor.service
  sudo governor exec --wait 60 -- /usr/bin/true
  [[ $(systemctl show governor.service --property=MemoryDenyWriteExecute --value) == yes ]]
  grep -qx $'NoNewPrivs:\t0' "/proc/$(systemctl show governor.service --property=MainPID --value)/status"
  echo "Daemon MDWE opt-in passed on systemd $systemd_version"
else
  echo "Daemon MDWE opt-in skipped: systemd $systemd_version implies NoNewPrivileges"
fi
if [[ $broker_smoke == true ]]; then
  if ! command -v /usr/sbin/sshd >/dev/null; then
    sudo apt-get update -q >/dev/null
    sudo apt-get install -y -q openssh-server >/dev/null
  fi
  sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT python3 test/broker-linux.py
else
  echo "Broker integration disabled for this runner"
fi
echo "Linux smoke test passed: JIT-enabled installation, MDWE negative control, MDWE one-shot commands, schema, ownership, fallback upgrade, scopes, service routing, Docker routing, daemon MDWE opt-in on systemd 255+"
