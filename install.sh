#!/usr/bin/env bash
# install.sh: install, update or remove the governor on a Hostinger VPS (systemd, cgroup v2).
#
#   curl -fsSL https://github.com/olmezsoy/hostinger-governor/releases/latest/download/install.sh |
#     sudo bash -s -- --vm-id 1234567 --token-file /root/hostinger-token
#
# Options:
#   --version vX.Y.Z       release to install (default: the latest)
#   --binary PATH          install this binary instead of downloading one
#   --vm-id N              Hostinger VM id (hPanel, or the API's virtual-machines list)
#   --token-file PATH      copy this Hostinger API token to /etc/governor/hostinger-token
#   --timezone ZONE        timezone for reports (default UTC)
#   --consumer USER        accepted for compatibility; status is readable by every user
#   --baseline-share N     baseline fraction for a new config (default 0.6)
#   --uninstall            stop it and lift the ceiling; keeps /etc/governor (add --purge to drop it)
set -euo pipefail
trap 'echo "install failed at line $LINENO" >&2' ERR

REPO=olmezsoy/hostinger-governor
version="" binary="" vm_id="" token_file="" timezone="" baseline_share="" uninstall=0 purge=0
consumers=()
while (($#)); do
  case $1 in
    --version|--binary|--vm-id|--token-file|--timezone|--consumer|--baseline-share)
      (($# >= 2)) || { echo "$1 needs a value" >&2; exit 2; } ;;
  esac
  case $1 in
    --version) version=$2; shift ;;
    --binary) binary=$2; shift ;;
    --vm-id) vm_id=$2; shift ;;
    --token-file) token_file=$2; shift ;;
    --timezone) timezone=$2; shift ;;
    --consumer) consumers+=("$2"); shift ;;
    --baseline-share) baseline_share=$2; shift ;;
    --uninstall) uninstall=1 ;;
    --purge) purge=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -z $vm_id || $vm_id =~ ^[1-9][0-9]{0,14}$ ]] ||
  { echo "--vm-id must be a positive decimal integer (at most 15 digits)" >&2; exit 2; }
[[ -z $baseline_share || $baseline_share =~ ^(0\.[1-8][0-9]*|0\.9)$ ]] ||
  { echo "--baseline-share must be from 0.1 to 0.9" >&2; exit 2; }
if [[ -n $timezone ]]; then
  [[ $timezone =~ ^[A-Za-z][A-Za-z0-9_+/-]*$ && $timezone != *..* && -f /usr/share/zoneinfo/$timezone ]] ||
    { echo "--timezone must be an installed timezone name" >&2; exit 2; }
fi
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

if ((uninstall)); then
  systemctl disable --now governor.service 2>/dev/null || true
  systemctl set-property --runtime user.slice CPUQuota= || true
  rm -f /etc/systemd/system/governor.service /usr/local/bin/governor \
    /usr/local/libexec/governor-cap /etc/sudoers.d/governor \
    /etc/systemd/system/user.slice.d/10-governor.conf
  systemctl daemon-reload
  if ((purge)); then rm -r -f /etc/governor /var/lib/governor; fi
  echo "governor removed"
  exit 0
fi

command -v systemctl >/dev/null && [[ -f /sys/fs/cgroup/cgroup.controllers ]] ||
  { echo "needs systemd with cgroup v2" >&2; exit 1; }

case $(uname -m) in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [[ -z $binary ]]; then
  base="https://github.com/$REPO/releases/latest/download"
  [[ -n $version ]] && base="https://github.com/$REPO/releases/download/$version"
  tmp=$(mktemp -d)
  trap 'rm -r -f "$tmp"' EXIT
  curl -fsSL -o "$tmp/governor-$target" "$base/governor-$target"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
  (cd "$tmp" && grep " governor-$target\$" SHA256SUMS | sha256sum -c -) ||
    { echo "checksum mismatch" >&2; exit 1; }
  binary="$tmp/governor-$target"
fi
install -m 0755 "$binary" /usr/local/bin/governor

# sysstat keeps the 10-minute history `governor report` draws.
if ! command -v sadf >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q sysstat >/dev/null
fi
[[ -f /etc/default/sysstat ]] && sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat
systemctl enable --now sysstat >/dev/null 2>&1 || true

getent group governor >/dev/null || groupadd --system governor
id governor >/dev/null 2>&1 ||
  useradd --system --gid governor --home-dir /var/lib/governor --shell /usr/sbin/nologin governor
if ((${#consumers[@]})); then echo "--consumer no longer grants control access; all users can read status"; fi

install -d -o root -g governor -m 0750 /etc/governor
install -d -o root -g root -m 0755 /etc/governor/hooks.d
if [[ -n $token_file ]]; then
  install -o root -g governor -m 0640 "$token_file" /etc/governor/hostinger-token
fi
if [[ ! -f /etc/governor/config.json ]]; then
  cat > /etc/governor/config.json <<EOF
{
  "hostinger": { "vm_id": ${vm_id:-null}, "token_file": "/etc/governor/hostinger-token" },
  "slice": "user.slice",
  "timezone": "${timezone:-UTC}",
  "initial_balance": 0,
  "baseline_share": ${baseline_share:-0.6},
  "tick_seconds": 30
}
EOF
  chown root:governor /etc/governor/config.json
  chmod 0640 /etc/governor/config.json
fi
/usr/local/bin/governor validate-config

# The only root action the daemon needs: the ceiling on one slice.
install -d /usr/local/libexec
cat > /usr/local/libexec/governor-cap <<'EOF'
#!/usr/bin/env bash
# governor-cap <percent> [slice]: the CPU ceiling the governor sets (100 is one vCPU).
set -euo pipefail
p=${1:-} slice=${2:-user.slice}
max=$(( $(grep -c '^cpu[0-9]' /proc/stat) * 100 ))
(( $# >= 1 && $# <= 2 )) && [[ $p =~ ^[1-9][0-9]{0,5}$ ]] && (( p >= 20 && p <= max )) && [[ $slice == user.slice ]] ||
  { echo "usage: governor-cap 20..$max [user.slice]" >&2; exit 2; }
exec systemctl set-property --runtime "$slice" "CPUQuota=$p%"
EOF
chmod 0755 /usr/local/libexec/governor-cap
printf 'governor ALL=(root) NOPASSWD: /usr/local/libexec/governor-cap *\n' > /etc/sudoers.d/governor
chmod 0440 /etc/sudoers.d/governor
visudo -cf /etc/sudoers.d/governor

# A runtime quota disappears on reboot. Start logins safely before the daemon runs.
install -d /etc/systemd/system/user.slice.d
cat > /etc/systemd/system/user.slice.d/10-governor.conf <<'EOF'
[Slice]
CPUAccounting=yes
CPUQuota=20%
EOF

cat > /etc/systemd/system/governor.service <<'EOF'
[Unit]
Description=Hostinger CPU credit governor
After=network-online.target
Wants=network-online.target

[Service]
User=governor
Group=governor
RuntimeDirectory=governor
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
StateDirectory=governor
StateDirectoryMode=0755
# Only root and the daemon can access requests; the daemon checks file ownership too.
ExecStartPre=+/usr/bin/install -d -o root -g governor -m 0770 /run/governor/requests
ExecStartPre=+/usr/local/bin/governor fallback
ExecStart=/usr/local/bin/governor run
# Stopped or crashed, the machine keeps a ceiling under the credit baseline.
ExecStopPost=+/usr/local/bin/governor fallback
Restart=always
RestartSec=5
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable governor.service >/dev/null
systemctl restart governor.service
echo "governor $(/usr/local/bin/governor version) running; check with: governor status"
