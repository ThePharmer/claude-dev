#!/bin/bash
#
# Entrypoint script for Claude Code SSH container
# Handles dynamic UID/GID mapping and SSH daemon startup
#

set -e

echo "=========================================="
echo "Claude Code Container"
echo "=========================================="

# Default to node user's UID/GID if not specified
USER_UID=${USER_UID:-1000}
USER_GID=${USER_GID:-1000}

# Remap node user/group if UID/GID differs from default
CURRENT_UID=$(id -u node)
CURRENT_GID=$(id -g node)

if [ "$USER_GID" -ne "$CURRENT_GID" ]; then
    echo "Remapping node group GID from $CURRENT_GID to $USER_GID"
    sed -i "s/node:x:$CURRENT_GID:/node:x:$USER_GID:/" /etc/group
    sed -i "s/node:x:$CURRENT_UID:$CURRENT_GID:/node:x:$CURRENT_UID:$USER_GID:/" /etc/passwd
fi

if [ "$USER_UID" -ne "$CURRENT_UID" ]; then
    echo "Remapping node user UID from $CURRENT_UID to $USER_UID"
    sed -i "s/node:x:$CURRENT_UID:/node:x:$USER_UID:/" /etc/passwd
fi

# Validate SSH setup
if [ ! -f /home/node/.ssh/authorized_keys ]; then
    echo "ERROR: No authorized_keys file mounted"
    echo "Mount your keys to /home/node/.ssh/authorized_keys"
    exit 1
fi

if [ ! -s /home/node/.ssh/authorized_keys ]; then
    echo "ERROR: authorized_keys file is empty"
    exit 1
fi

# Fix SSH directory permissions
chown "$USER_UID:$USER_GID" /home/node/.ssh
chmod 700 /home/node/.ssh
chmod 600 /home/node/.ssh/authorized_keys 2>/dev/null || true

# Fix ownership of config directory
if [ -d /claude ]; then
    chown "$USER_UID:$USER_GID" /claude 2>/dev/null || true
    chmod 755 /claude 2>/dev/null || true
fi

# Ensure workspace is accessible (don't recursive chown - host owns the files)
if [ -d /srv ]; then
    chmod 755 /srv 2>/dev/null || true
fi

KEY_COUNT=$(wc -l < /home/node/.ssh/authorized_keys)
echo "SSH authorized_keys: $KEY_COUNT key(s) loaded"
echo "User: node (UID=$USER_UID, GID=$USER_GID)"
echo "Starting SSHD on port 22..."
echo "=========================================="

export SHELL=/bin/bash
exec /usr/sbin/sshd -D -e
