#!/usr/bin/env bash
# Run on the Docker host. Does not restart Docker or recreate containers.
set -euo pipefail

if [[ -e /.dockerenv || -e /run/.containerenv ]]; then
  echo "Run this script on the Docker host, outside the Paseo container." >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo on the Docker host." >&2
  exit 1
fi
for required in apparmor_parser python3 install cp date; do
  command -v "$required" >/dev/null || { echo "Missing host command: $required" >&2; exit 1; }
done
if [[ ! -r /sys/module/apparmor/parameters/enabled ]] || ! [[ $(cat /sys/module/apparmor/parameters/enabled) == Y ]]; then
  echo "AppArmor must be enabled on the Docker host." >&2
  exit 1
fi

profile_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
seccomp_target=/etc/docker/seccomp/paseo-codex-bwrap.json
apparmor_target=/etc/apparmor.d/paseo-codex-bwrap

# Validate before installing or replacing either file.
python3 -m json.tool "$profile_dir/seccomp.json" >/dev/null
apparmor_parser --skip-kernel-load --skip-read-cache "$profile_dir/paseo-codex-bwrap"

backup_dir="/etc/docker/seccomp/backups/paseo-codex-bwrap-$(date -u +%Y%m%dT%H%M%S)-$$"
install -d -m 0755 /etc/docker/seccomp /etc/apparmor.d
install -d -m 0700 "$backup_dir"
if [[ -e $seccomp_target ]]; then
  cp -a -- "$seccomp_target" "$backup_dir/seccomp.json"
fi
if [[ -e $apparmor_target ]]; then
  cp -a -- "$apparmor_target" "$backup_dir/paseo-codex-bwrap"
fi
install -m 0644 "$profile_dir/seccomp.json" "$seccomp_target"
install -m 0644 "$profile_dir/paseo-codex-bwrap" "$apparmor_target"
apparmor_parser --replace "$apparmor_target"

echo "Installed seccomp: $seccomp_target"
echo "Loaded AppArmor: paseo-codex-bwrap"
echo "Previous files, if any: $backup_dir"
echo "Next: sudo bash $profile_dir/verify-host.sh"
echo "Only update the Portainer stack after the disposable-container test passes."
