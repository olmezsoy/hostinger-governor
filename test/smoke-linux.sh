#!/usr/bin/env bash
# Installs into a disposable hosted runner. Never run against a developer or production machine.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $(uname -s) == Linux ]] ||
  { echo "smoke test requires a disposable GitHub-hosted Linux runner" >&2; exit 2; }
binary=${1:?pass the compiled Linux binary}
container=""
cleanup() {
  if [[ -n $container ]]; then sudo docker stop "$container" >/dev/null || true; fi
  sudo systemctl disable --now governor-smoke.service >/dev/null 2>&1 || true
  sudo systemctl stop governor-smoke@check.service >/dev/null 2>&1 || true
  sudo systemctl stop governor-hostinger-request.service >/dev/null 2>&1 || true
  sudo rm -f /etc/systemd/system/governor-smoke.service \
    /etc/systemd/system/governor-smoke.service.d/50-governor.conf \
    /etc/systemd/system/governor-smoke@.service \
    /etc/systemd/system/governor-smoke@.service.d/50-governor.conf \
    /usr/local/libexec/governor-broker-smoke-hang \
    /usr/local/libexec/governor-hostinger.py /usr/local/libexec/governor-hostinger \
    /etc/sudoers.d/governor-hostinger /etc/sudoers.d/governor-setup-smoke
  sudo bash install.sh --uninstall || true
}
trap cleanup EXIT

sudo systemctl set-property user.slice CPUQuota=780%
sudo bash install.sh --binary "$binary"
[[ ! -f /etc/systemd/system.control/user.slice.d/50-CPUQuota.conf ]]
[[ ! -f /etc/systemd/system/user.slice.d/50-CPUQuota.conf ]]
[[ -f /etc/systemd/system/user.slice.d/10-governor.conf ]]
for ((attempt=0; attempt<20; attempt++)); do
  if sudo governor status --json >/dev/null 2>&1; then break; fi
  sleep 1
done
sudo governor status --json | python3 -c 'import json,sys; assert json.load(sys.stdin)["schemaVersion"] == 1'
[[ $(governor version) == 0.2.3 ]]
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
if ! command -v /usr/sbin/sshd >/dev/null; then
  sudo apt-get update -q >/dev/null
  sudo apt-get install -y -q openssh-server >/dev/null
fi
sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT python3 test/broker-linux.py
echo "Linux smoke test passed: service, schema, ownership, fallback upgrade, scopes, service routing, Docker routing"
