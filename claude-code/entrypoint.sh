#!/bin/bash
#
# Entrypoint script for Claude Code SSH container
# Handles dynamic UID/GID mapping and SSH daemon startup
#

set -e

echo "=========================================="
echo "Claude Code Container"
echo "=========================================="

# Default to claude user's UID/GID if not specified
USER_UID=${USER_UID:-1000}
USER_GID=${USER_GID:-1000}

# Remap claude user/group if UID/GID differs from default
CURRENT_UID=$(id -u claude)
CURRENT_GID=$(id -g claude)

if [ "$USER_GID" -ne "$CURRENT_GID" ]; then
    echo "Remapping claude group GID from $CURRENT_GID to $USER_GID"
    groupmod -g "$USER_GID" claude
fi
if [ "$USER_UID" -ne "$CURRENT_UID" ]; then
    echo "Remapping claude user UID from $CURRENT_UID to $USER_UID"
    usermod -u "$USER_UID" claude
fi

# Validate SSH setup
if [ ! -f /home/claude/.ssh/authorized_keys ]; then
    echo "ERROR: No authorized_keys file mounted"
    echo "Mount your keys to /home/claude/.ssh/authorized_keys"
    exit 1
fi

if [ ! -s /home/claude/.ssh/authorized_keys ]; then
    echo "ERROR: authorized_keys file is empty"
    exit 1
fi

# Fix home directory ownership (needed after UID/GID remap so claude owns its home)
chown "$USER_UID:$USER_GID" /home/claude

# Fix SSH directory permissions
chown "$USER_UID:$USER_GID" /home/claude/.ssh
chmod 700 /home/claude/.ssh
chmod 600 /home/claude/.ssh/authorized_keys 2>/dev/null || true

# Fix ownership of config directory
if [ -d /claude ]; then
    chown "$USER_UID:$USER_GID" /claude 2>/dev/null || true
    chmod 755 /claude 2>/dev/null || true
fi

# Codex / Pi / cloudcli config volumes (targets of the ~/.codex, ~/.pi and ~/.cloudcli
# symlinks baked into the image). Own the mount points so the symlinks are never dangling
# on a fresh volume, mirroring how /claude is handled above. Non-recursive on purpose: a
# UID remap must not churn through every file these tools have written.
for d in /codex /pi /cloudcli; do
    if [ -d "$d" ]; then
        chown "$USER_UID:$USER_GID" "$d" 2>/dev/null || true
        chmod 755 "$d" 2>/dev/null || true
    fi
done

# Ensure workspace is accessible (don't recursive chown - host owns the files)
if [ -d /srv ]; then
    chmod 755 /srv 2>/dev/null || true
fi

KEY_COUNT=$(wc -l < /home/claude/.ssh/authorized_keys)
echo "SSH authorized_keys: $KEY_COUNT key(s) loaded"
echo "User: claude (UID=$USER_UID, GID=$USER_GID)"

# -----------------------------------------------------------------------------
# Start the cloudcli web UI in the background, as the claude user.
# tini (PID 1, started with -g) reaps it; sshd remains the foreground process below.
# Data (the web-UI login DB) is written under /claude so it persists with the
# mounted config volume instead of being lost on container recreate.
# -----------------------------------------------------------------------------
CLOUDCLI_PORT="${SERVER_PORT:-3001}"
CLOUDCLI_DB="${DATABASE_PATH:-/claude/cloudcli-auth.db}"
echo "Starting CloudCLI web UI on port ${CLOUDCLI_PORT} (UI login DB: ${CLOUDCLI_DB})..."
runuser -u claude -- env \
    HOME=/home/claude \
    CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/claude}" \
    SERVER_PORT="${CLOUDCLI_PORT}" \
    HOST="${HOST:-0.0.0.0}" \
    DATABASE_PATH="${CLOUDCLI_DB}" \
    PATH=/usr/local/bin:/usr/bin:/bin:/home/claude/.local/bin \
    cloudcli start --port "${CLOUDCLI_PORT}" \
    > /tmp/cloudcli.log 2>&1 &

echo "Starting SSHD on port 22..."
echo "=========================================="

export SHELL=/bin/bash
exec /usr/sbin/sshd -D -e
