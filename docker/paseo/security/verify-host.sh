#!/usr/bin/env bash
# Tests the existing Paseo image in a disposable container with no user-data mounts.
set -euo pipefail

if [[ -e /.dockerenv || -e /run/.containerenv ]]; then
  echo "Run this script on the Docker host, outside the Paseo container." >&2
  exit 1
fi
command -v docker >/dev/null || { echo "Docker CLI is required on the host." >&2; exit 1; }
profile_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
seccomp_target=/etc/docker/seccomp/paseo-codex-bwrap.json
cmp "$profile_dir/seccomp.json" "$seccomp_target" || {
  echo "Installed seccomp differs from this checkout; rerun install-host.sh." >&2
  exit 1
}
cmp "$profile_dir/paseo-codex-bwrap" /etc/apparmor.d/paseo-codex-bwrap || {
  echo "Installed AppArmor differs from this checkout; rerun install-host.sh." >&2
  exit 1
}

# Default to the exact image already running, not a mutable latest tag.
image_ref=${1:-}
if [[ -z $image_ref ]]; then
  image_ref=$(docker inspect --format '{{.Image}}' paseo)
fi

docker run --rm -i --pull=never \
  --network none \
  --hostname paseo-codex-canary \
  --add-host paseo-codex-canary:127.0.0.1 \
  --user paseo \
  --workdir /tmp \
  --entrypoint /bin/sh \
  --security-opt "seccomp=$seccomp_target" \
  --security-opt apparmor=paseo-codex-bwrap \
  "$image_ref" -eu <<'CANARY'
python3 - <<'PYTHON'
from pathlib import Path
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
assert not int(status['CapBnd'].strip(), 16) & (1 << 21), 'Unexpected outer CAP_SYS_ADMIN'
assert status['Seccomp'].strip() == '2', 'Outer seccomp filter is missing'
assert Path('/proc/self/attr/current').read_text().strip() == 'paseo-codex-bwrap (enforce)', 'Wrong AppArmor profile'
PYTHON
# Older images contain root-owned tmp/arg0 from the build-time version probe.
# Repair only the disposable container's scratch tree; no persistent home is mounted.
if [ -d /home/paseo/.codex/tmp ]; then
  sudo -n chown -hR paseo:paseo /home/paseo/.codex/tmp
fi
python3 - <<'PYTHON'
import os
from pathlib import Path
scratch = Path('/home/paseo/.codex/tmp/arg0')
scratch.mkdir(parents=True, exist_ok=True)
os.chmod(scratch, 0o700)
assert scratch.stat().st_uid == os.getuid(), 'Codex helper directory has wrong owner'
PYTHON
codex --version
bwrap --version
mkdir -p /tmp/paseo-codex-canary /home/paseo/paseo-codex-canary
# Prove the ordinary container user can write outside the workspace first.
printf baseline > /home/paseo/paseo-codex-canary/baseline
cd /tmp/paseo-codex-canary
ln -s /home/paseo/paseo-codex-canary outside

timeout 90 codex sandbox -P :workspace -C /tmp/paseo-codex-canary -- /bin/sh -eu -c '
  printf allowed > allowed.txt
  if (printf denied > /home/paseo/paseo-codex-canary/unexpected) 2>/dev/null; then
    echo "FAIL: sandbox allowed a write outside its workspace" >&2
    exit 1
  fi
  if (printf denied > outside/unexpected-symlink) 2>/dev/null; then
    echo "FAIL: sandbox allowed a write through an outside symlink" >&2
    exit 1
  fi
'
test "$(cat allowed.txt)" = allowed
test "$(cat /home/paseo/paseo-codex-canary/baseline)" = baseline
test ! -e /home/paseo/paseo-codex-canary/unexpected
test ! -e /home/paseo/paseo-codex-canary/unexpected-symlink
echo "PASS: Codex ran and enforced workspace writes without outer SYS_ADMIN."
CANARY
