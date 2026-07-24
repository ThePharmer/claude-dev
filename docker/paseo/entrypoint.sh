#!/usr/bin/env bash
#
# Password-secret bridge for the Paseo daemon.
#
# WHY THIS EXISTS: Paseo reads only the PASEO_PASSWORD env var - it does NOT read a
# PASEO_PASSWORD_FILE. Docker/Compose secrets are delivered as files, so without this
# bridge a mounted secret is silently ignored and the daemon starts UNAUTHENTICATED
# (Paseo only logs a warning in that case; it still serves). Since this daemon is meant
# to be reachable over a network/tunnel, an unauthenticated start is treated as a hard
# failure here rather than a warning.
#
# This runs as root, BEFORE the stock entrypoint drops the daemon and any launched agents
# to the non-root uid/gid 1000 'paseo' user. It changes nothing else and execs the stock
# entrypoint unmodified.
set -euo pipefail

log() { echo "[paseo-password-entrypoint] $*" >&2; }

if [[ -z "${PASEO_PASSWORD:-}" && -n "${PASEO_PASSWORD_FILE:-}" ]]; then
    if [[ ! -r "${PASEO_PASSWORD_FILE}" ]]; then
        log "FATAL: PASEO_PASSWORD_FILE=${PASEO_PASSWORD_FILE} does not exist or is not readable."
        log "Create it on the host and mount it as a Compose secret. See compose.yaml."
        exit 1
    fi
    # Command substitution strips trailing newlines, so a secret written with a normal
    # 'openssl rand ... > file' does not end up with a stray \n in the password.
    PASEO_PASSWORD="$(<"${PASEO_PASSWORD_FILE}")"
    export PASEO_PASSWORD
fi

# Fail closed: never let a network-reachable daemon come up without authentication.
if [[ -z "${PASEO_PASSWORD:-}" ]]; then
    log "FATAL: no PASEO_PASSWORD (and no readable PASEO_PASSWORD_FILE)."
    log "Refusing to start a network-reachable Paseo daemon unauthenticated."
    exit 1
fi

# The password is now in the environment; drop the pointer so the daemon and every agent
# subprocess it launches don't also inherit the secret's path.
unset PASEO_PASSWORD_FILE

log "password loaded; handing off to the stock Paseo entrypoint"
exec /usr/local/bin/paseo-docker-entrypoint "$@"
