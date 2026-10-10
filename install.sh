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
#   --consumer USER        let USER run `governor limit` and `governor seed` (repeatable)
#   --uninstall            stop it and lift the ceiling; keeps /etc/governor (add --purge to drop it)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

REPO=olmezsoy/hostinger-governor
version="" binary="" vm_id="" token_file="" timezone="" uninstall=0 purge=0
consumers=()
while (($#)); do
  case $1 in
    --version) version=$2; shift ;;
    --binary) binary=$2; shift ;;
    --vm-id) vm_id=$2; shift ;;
    --token-file) token_file=$2; shift ;;
    --timezone) timezone=$2; shift ;;
    --consumer) consumers+=("$2"); shift ;;
    --uninstall) uninstall=1 ;;
    --purge) purge=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

if ((uninstall)); then
  systemctl disable --now governor.service 2>/dev/null || true
  systemctl set-property --runtime user.slice CPUQuota= || true
  rm -f /etc/systemd/system/governor.service /usr/local/bin/governor \
    /usr/local/libexec/governor-cap /etc/sudoers.d/governor
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
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q sysstat >/dev/null
fi
[[ -f /etc/default/sysstat ]] && sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat
systemctl enable --now sysstat >/dev/null 2>&1 || true

getent group governor-ctl >/dev/null || groupadd --system governor-ctl
id governor >/dev/null 2>&1 ||
  useradd --system --home-dir /var/lib/governor --shell /usr/sbin/nologin governor
usermod -aG governor-ctl governor
for u in "${consumers[@]}"; do usermod -aG governor-ctl "$u"; done

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
  "tick_seconds": 30
}
EOF
  chown root:governor /etc/governor/config.json
  chmod 0640 /etc/governor/config.json
fi

# The only root action the daemon needs: the ceiling on one slice.
install -d /usr/local/libexec
cat > /usr/local/libexec/governor-cap <<'EOF'
#!/usr/bin/env bash
# governor-cap <percent> [slice]: the CPU ceiling the governor sets (100 is one vCPU).
set -euo pipefail
p=${1:-} slice=${2:-user.slice}
max=$(( $(grep -c '^cpu[0-9]' /proc/stat) * 100 ))
[[ $p =~ ^[0-9]+$ ]] && (( p >= 20 && p <= max )) && [[ $slice =~ ^[a-z0-9-]+\.slice$ ]] ||
  { echo "usage: governor-cap 20..$max [slice]" >&2; exit 2; }
exec systemctl set-property --runtime "$slice" "CPUQuota=$p%"
EOF
chmod 0755 /usr/local/libexec/governor-cap
printf 'governor ALL=(root) NOPASSWD: /usr/local/libexec/governor-cap *\n' > /etc/sudoers.d/governor
chmod 0440 /etc/sudoers.d/governor
visudo -cq

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
# Consumers in governor-ctl drop requests here (`governor limit`, `governor seed`).
ExecStartPre=+/usr/bin/install -d -o governor -g governor-ctl -m 3770 /run/governor/requests
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
systemctl enable governor.service >/dev/null 2>&1
systemctl restart governor.service
echo "governor $(/usr/local/bin/governor version) running; check with: governor status"
