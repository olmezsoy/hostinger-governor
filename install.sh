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
  # A recovery quota period may outlive the daemon; older systemd lacks the property.
  systemctl set-property --runtime user.slice CPUQuotaPeriodSec= 2>/dev/null || true
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

# Broker token-copy guard (isolated installer-test entry point).
# Do not reintroduce a daemon-readable credential when updating a broker setup.
if [[ -n $token_file && -f /etc/governor/config.json ]] &&
  grep -q '"request_command"[[:space:]]*:' /etc/governor/config.json; then
  echo "--token-file cannot be used with an existing request_command broker" >&2
  exit 2
fi
# End broker token-copy guard.

# Quota migration functions are also exercised with isolated files in installer tests.
quota_only_dropin() {
  local line seen=0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    case $line in
      ''|'#'*|';'*|'[Slice]') ;;
      CPUQuota=*) seen=1 ;;
      *) return 1 ;;
    esac
  done < "$1"
  ((seen))
}

find_persistent_quotas() {
  local paths path
  persistent_quotas=()
  paths=$(systemctl show user.slice --property=DropInPaths --value)
  # Include shadowed local files too, so retiring a higher-priority file cannot reveal an old cap.
  for path in $paths /etc/systemd/system/user.slice.d/*.conf /etc/systemd/system.control/user.slice.d/*.conf; do
    case $path in
      /run/*|/etc/systemd/system/user.slice.d/10-governor.conf) continue ;;
    esac
    [[ -f $path ]] || continue
    [[ " ${persistent_quotas[*]:-} " != *" $path "* ]] || continue
    if grep -Eq '^[[:space:]]*CPUQuota[[:space:]]*=' "$path"; then
      case $path in
        /etc/systemd/system/user.slice.d/*|/etc/systemd/system.control/user.slice.d/*) ;;
        *) echo "CPUQuota in $path conflicts with governor; remove that quota before installing" >&2; return 1 ;;
      esac
      quota_only_dropin "$path" || {
        echo "CPUQuota in $path shares a file with other settings; remove only CPUQuota before installing" >&2
        return 1
      }
      [[ ! -L $path ]] || { echo "refusing to migrate symlink $path" >&2; return 1; }
      persistent_quotas+=("$path")
    fi
  done
  # A quota in the main unit cannot be retired without replacing unrelated configuration.
  local fragment
  fragment=$(systemctl show user.slice --property=FragmentPath --value)
  if [[ -f $fragment ]] && grep -Eq '^[[:space:]]*CPUQuota[[:space:]]*=' "$fragment"; then
    echo "CPUQuota in $fragment conflicts with governor; remove only CPUQuota before installing" >&2
    return 1
  fi
}

retire_persistent_quotas() {
  ((${#persistent_quotas[@]})) || return 0
  local backup path
  backup=$(mktemp -d /var/backups/governor-quota.XXXXXX)
  for path in "${persistent_quotas[@]}"; do
    install -d -m 0700 "$backup$(dirname "$path")"
    mv -- "$path" "$backup$path"
    echo "Retired $path; recoverable at $backup$path"
  done
}
# End quota migration functions.

find_persistent_quotas

case $(uname -m) in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

base="https://github.com/$REPO/releases/latest/download"
[[ -n $version ]] && base="https://github.com/$REPO/releases/download/$version"
if [[ -z $binary ]]; then
  tmp=$(mktemp -d)
  trap 'rm -r -f "$tmp"' EXIT
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
fi
if [[ -z $binary ]]; then
  curl -fsSL -o "$tmp/governor-$target" "$base/governor-$target"
  (cd "$tmp" && grep " governor-$target\$" SHA256SUMS | sha256sum -c -) ||
    { echo "checksum mismatch" >&2; exit 1; }
  binary="$tmp/governor-$target"
fi
# Upgrade configuration check (isolated installer-test entry point).
# A configuration the new version rejects, such as a key it doesn't know, stops the upgrade here,
# while the running daemon still holds its ceiling.
if [[ -f /etc/governor/config.json ]]; then
  # Staged beside the binary's destination, not in /tmp: a noexec /tmp would refuse to run it and
  # stop every upgrade.
  check=$(mktemp /usr/local/bin/.governor-check.XXXXXX)
  trap 'rm -f -- "$check"; [[ -z ${tmp:-} ]] || rm -r -f -- "$tmp"' EXIT
  install -m 0755 "$binary" "$check"
  if ! "$check" validate-config; then
    echo "the new binary rejects /etc/governor/config.json or cannot run; the running governor is unchanged" >&2
    exit 1
  fi
  rm -f -- "$check"
fi
# End upgrade configuration check.
# Stop any old writer before retiring its persistent quota. Keep a safe runtime ceiling throughout.
if [[ $(systemctl show governor.service --property=LoadState --value) == loaded ]]; then
  systemctl stop governor.service
fi
systemctl set-property --runtime user.slice CPUQuota=20%
retire_persistent_quotas
install -m 0755 "$binary" /usr/local/bin/governor

getent group governor >/dev/null || groupadd --system governor
id governor >/dev/null 2>&1 ||
  useradd --system --gid governor --home-dir /var/lib/governor --shell /usr/sbin/nologin governor
# State ownership repair (isolated installer-test entry point).
# A `governor run` started by root left its state root-owned and private, which the service can't
# read. Hand back only the governor's own files: -h changes a link itself, never what it points
# to, and a file with other hard links is left alone. That includes the top snapshots under top/,
# which v0.2.5 wrote too. find never follows a link, so a top/ that is a link isn't entered.
# -execdir runs chown inside the directory find opened, on the bare name: a top/ swapped for a link
# after find chose its files can't send chown through the link to a file elsewhere. GNU find refuses
# -execdir when PATH holds a relative or empty entry, so it gets a fixed one.
if [[ -d /var/lib/governor ]]; then
  PATH=/usr/sbin:/usr/bin:/sbin:/bin find /var/lib/governor -maxdepth 1 -type f -user root -links 1 \( -name 'persist.json*' \
    -o -name 'history.json*' -o -name 'history.log*' -o -name daemon.lock \) \
    -execdir chown -h governor:governor -- {} +
  PATH=/usr/sbin:/usr/bin:/sbin:/bin find /var/lib/governor -maxdepth 2 -user root \( \( -path /var/lib/governor/top -type d \) \
    -o \( -path '/var/lib/governor/top/*.log' -type f -links 1 \) \) \
    -execdir chown -h governor:governor -- {} +
fi
# End state ownership repair.
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
  "fallback_cpu_percent": 20,
  "tick_seconds": 30
}
EOF
  chown root:governor /etc/governor/config.json
  chmod 0640 /etc/governor/config.json
fi
/usr/local/bin/governor validate-config
# Fallback quota selection (isolated installer-test entry point).
fallback_percent=$(/usr/local/bin/governor fallback --print)
[[ $fallback_percent =~ ^[1-9][0-9]{0,4}$ ]] ||
  { echo "invalid fallback CPU quota" >&2; exit 1; }
# End fallback quota selection.
# Apply the configured fallback before package installation, which may take a while.
systemctl set-property --runtime user.slice "CPUQuota=$fallback_percent%"

# sysstat keeps the 10-minute history `governor report` draws.
if ! command -v sadf >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q sysstat >/dev/null
fi
[[ -f /etc/default/sysstat ]] && sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat
systemctl enable --now sysstat >/dev/null 2>&1 || true

# The only root action the daemon needs: the ceiling on one slice.
install -d /usr/local/libexec
cat > /usr/local/libexec/governor-cap <<'EOF'
#!/usr/bin/env bash
# governor-cap <percent> [slice] [10|default]: the CPU ceiling the governor sets (100 is one vCPU).
set -euo pipefail
p=${1:-} slice=${2:-user.slice} period=${3:-}
max=$(( $(grep -c '^cpu[0-9]' /proc/stat) * 100 ))
(( $# >= 1 && $# <= 3 )) && [[ $p =~ ^[1-9][0-9]{0,5}$ ]] && (( p >= 20 && p <= max )) && [[ $slice == user.slice ]] ||
  { echo "usage: governor-cap 20..$max [user.slice] [10|default]" >&2; exit 2; }
case "$period" in
  "") exec systemctl set-property --runtime "$slice" "CPUQuota=$p%" ;;
  10) exec systemctl set-property --runtime "$slice" "CPUQuota=$p%" CPUQuotaPeriodSec=10ms ;;
  default) exec systemctl set-property --runtime "$slice" "CPUQuota=$p%" CPUQuotaPeriodSec= ;;
  *) echo "quota period must be 10 or default" >&2; exit 2 ;;
esac
EOF
chmod 0755 /usr/local/libexec/governor-cap
printf 'governor ALL=(root) NOPASSWD: /usr/local/libexec/governor-cap *\n' > /etc/sudoers.d/governor
chmod 0440 /etc/sudoers.d/governor
visudo -cf /etc/sudoers.d/governor

# Boot quota generation (isolated installer-test entry point).
# Mirror the validated configuration into the boot quota without calling the API.
# Upgrades keep the existing setting; missing configuration fields default to 20%.
# A runtime quota disappears on reboot. Start logins with the configured fallback.
install -d /etc/systemd/system/user.slice.d
cat > /etc/systemd/system/user.slice.d/10-governor.conf <<EOF
[Slice]
CPUQuota=$fallback_percent%
EOF
# End boot quota generation.

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
# Let the daemon drain a privileged broker request before systemd cleans up its children.
KillMode=mixed
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
