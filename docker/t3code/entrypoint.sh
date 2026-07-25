#!/usr/bin/env bash
#
# Startup wrapper for the T3 Code server.
#
# WHY THIS EXISTS: T3 Code derives its authentication posture from the HOST IT BINDS,
# not from a password variable. Reading the shipped bundle (src/auth/EnvironmentAuthPolicy):
#
#     isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host)
#     policy = isRemoteReachable ? "remote-reachable" : "loopback-browser"
#
# ...and the server defaults to `config.host ?? "127.0.0.1"`. Two failure modes follow,
# and this wrapper turns both into a refusal to start rather than a silent misconfiguration:
#
#   1. T3CODE_HOST unset -> binds loopback INSIDE the container. The published port and the
#      tunnel route both go nowhere, and you debug Cloudflare for an hour for no reason.
#   2. T3CODE_HOST loopback while the port is published -> same dead end.
#
# NOTE ON TRUST BOUNDARY: binding a non-loopback host flips T3 Code to "remote-reachable",
# which gates the API behind pairing tokens / bearer sessions rather than serving openly.
# That is read from the bundle, NOT verified end-to-end against a live server. Treat
# Cloudflare Access as the load-bearing control here and t3's own pairing as defence in
# depth - not the other way round. See README.md "Verify on first deploy".
set -euo pipefail

log() { echo "[t3code-entrypoint] $*" >&2; }

is_loopback_host() {
    case "${1}" in
        localhost|127.*|::1|"[::1]") return 0 ;;
        *) return 1 ;;
    esac
}

if [[ -z "${T3CODE_HOST:-}" ]]; then
    log "FATAL: T3CODE_HOST is not set."
    log "T3 Code would bind 127.0.0.1 inside the container and be unreachable through the"
    log "published port. Set T3CODE_HOST=0.0.0.0 in the stack environment."
    exit 1
fi

if is_loopback_host "${T3CODE_HOST}"; then
    log "FATAL: T3CODE_HOST=${T3CODE_HOST} is a loopback address."
    log "Nothing outside this container can reach the server. Set T3CODE_HOST=0.0.0.0,"
    log "or run the server ad hoc with 'docker exec' if a loopback test is what you want."
    exit 1
fi

# Persist T3 Code's own state on the shared volume, in a directory of its own. Paseo keeps
# its state in /home/paseo/.paseo, so the two never write the same files - only the agent
# credential dirs are genuinely shared, which is the point of this comparison.
export T3CODE_HOME="${T3CODE_HOME:-/home/paseo/.t3code}"
mkdir -p "${T3CODE_HOME}"

# Belt and braces: the image already sets these, but a stack env block could drop them.
export T3CODE_TELEMETRY_ENABLED="${T3CODE_TELEMETRY_ENABLED:-false}"
export T3CODE_NO_BROWSER=true

log "host=${T3CODE_HOST} port=${T3CODE_PORT:-3773} home=${T3CODE_HOME}"
log "telemetry=${T3CODE_TELEMETRY_ENABLED}; agent credentials shared with the paseo stack"
log "if this is a first deploy, issue a pairing token with:"
log "  docker exec -it t3code t3 auth pairing issue"

# 'serve' is the headless variant: runs the server without opening a browser and prints
# headless pairing details. 'start' would try to launch a browser.
exec t3 serve "$@"
