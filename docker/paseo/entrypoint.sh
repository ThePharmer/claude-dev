#!/usr/bin/env bash
#
# Container entrypoint: password-secret bridge for the Paseo daemon, seeding of the agent
# CLIs onto the volume (seed-agent-clis.sh), plus a supervised T3 Code server running
# alongside the daemon.
#
# PASSWORD BRIDGE. Paseo reads only the PASEO_PASSWORD env var - it does NOT read a
# PASEO_PASSWORD_FILE. Docker/Compose secrets are delivered as files, so without this
# bridge a mounted secret is silently ignored and the daemon starts UNAUTHENTICATED
# (Paseo only logs a warning in that case; it still serves). Since this daemon is meant
# to be reachable over a network/tunnel, an unauthenticated start is treated as a hard
# failure here rather than a warning.
#
# T3 CODE. `t3 serve` used to be started by hand from a Paseo web terminal, so every
# container restart dropped it. `t3 service install` is no help here: it registers a
# systemd user unit, and this container has no systemd. So this script supervises it:
# a restart loop keeps `t3 serve` running, and container stop sends it SIGTERM so it
# shuts down cleanly instead of being SIGKILLed when PID 1 exits. Set T3_SERVE_ENABLED=0
# to skip all of this and exec the stock entrypoint exactly as before.
#
# This runs as root, BEFORE the stock entrypoint drops the daemon and any launched agents
# to the non-root uid/gid 1000 'paseo' user. t3 is dropped to the same user with gosu.
# The stock entrypoint itself runs unmodified.
set -euo pipefail

log() { echo "[paseo-entrypoint] $*" >&2; }

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

# Agent CLIs live on the volume so T3 can update them (see seed-agent-clis.sh). Seed any
# that are missing before anything that runs them starts. It never fails startup: on any
# problem the image's copies stay on PATH.
if [[ "$(id -u)" == "0" ]]; then
    gosu paseo env -u PASEO_PASSWORD /usr/local/bin/paseo-seed-agent-clis \
        || log "agent CLI seeding failed; the image's copies stay in use"
else
    /usr/local/bin/paseo-seed-agent-clis || log "agent CLI seeding failed; the image's copies stay in use"
fi

# Plain exec, exactly as before, when t3 is switched off or when the container was given a
# command (`docker compose run paseo bash` and the like). A one-off command must keep its
# stdin and must not start a second `t3 serve` against the same ~/.t3.
if [[ "${T3_SERVE_ENABLED:-1}" == "0" || "$#" -gt 0 ]]; then
    log "password loaded; handing off to the stock Paseo entrypoint (t3 serve not started)"
    exec /usr/local/bin/paseo-docker-entrypoint "$@"
fi

# --- T3 Code ------------------------------------------------------------------------
# t3 is installed on the paseo-home volume (npm --prefix ~/.local), not baked into the
# image, so it may be absent on a fresh volume. The loop waits for it rather than failing.
T3_BIN=/home/paseo/.local/bin/t3
# Default working directory for provider sessions; matches the old manual launch.
T3_CWD=/srv/projects
# t3's own output. Kept out of the container logs because every start prints a pairing
# token and QR code, and a crash loop would repeat that banner forever. The previous run's
# log is kept as serve.log.1, so growth is bounded to two runs.
T3_LOG=/home/paseo/.t3/serve.log

t3_log() { echo "[t3-serve] $*" >&2; }

# Runs in a background subshell. errexit is turned off there so a non-zero `wait` (t3
# crashing, or a signal interrupting the wait) cannot kill the supervisor itself.
t3_supervise() {
    set +e
    local child="" rc
    # On TERM: pass it to whatever is running (t3, or a backoff sleep), wait for it to
    # finish shutting down, then stop looping. t3's launcher forwards SIGTERM to the
    # versioned server binary it spawns.
    trap 'if [[ -n "$child" ]]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; exit 0' TERM
    while :; do
        if [[ ! -x "$T3_BIN" ]]; then
            t3_log "$T3_BIN not found; checking again in 60s"
            sleep 60 & child=$!
            wait "$child"; child=""
            continue
        fi
        # env -u: keep the Paseo password out of t3 and every agent it launches. The paseo
        # CLI those agents call still works without it (checked: `paseo ls` succeeds with the
        # variable unset).
        # ~/.bashrc is sourced so t3 gets the same PATH as the web terminal it used to be
        # started from, ~/.local/bin included. It is a PATH-only file on this volume today;
        # a stray `exit` in it would only put t3 into this restart loop.
        gosu paseo env -u PASEO_PASSWORD bash -c \
            '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
             mkdir -p "$(dirname "$3")" && { [ ! -f "$3" ] || mv -f "$3" "$3.1"; }
             cd "$1" && exec "$2" serve >"$3" 2>&1' \
            t3-serve "$T3_CWD" "$T3_BIN" "$T3_LOG" &
        child=$!
        t3_log "started t3 serve (pid $child) in $T3_CWD; output in $T3_LOG"
        wait "$child"; rc=$?
        child=""
        t3_log "t3 serve exited with status $rc; restarting in 5s"
        sleep 5 & child=$!
        wait "$child"; child=""
    done
}

t3_supervise &
t3_pid=$!

log "password loaded; starting the stock Paseo entrypoint alongside t3 serve"
/usr/local/bin/paseo-docker-entrypoint "$@" &
paseo_pid=$!

# Paseo is no longer exec'd, so this script, not tini, is its parent. Pass container stop
# (SIGTERM, or SIGINT from an interactive `docker run`) on to both children. Paseo gets
# SIGTERM either way, since an async child of a non-interactive shell ignores SIGINT.
signals=0
t3_stopped=0
stop_t3() {
    (( t3_stopped )) && return 0
    t3_stopped=1
    kill -TERM "$t3_pid" 2>/dev/null || true
}
stop_children() {
    signals=$((signals + 1))
    kill -TERM "$paseo_pid" 2>/dev/null || true
    stop_t3
}
trap stop_children TERM INT

# Paseo is the main process: when it exits, for any reason, stop t3 and exit with Paseo's
# status, so the restart policy and healthcheck behave exactly as they did before.
# A trapped signal makes `wait` return early (128+N) with Paseo possibly still running, so
# wait again whenever the trap has fired since the last wait. bash keeps an exited child's
# status and returns it from every later `wait` on that pid, so waiting again after Paseo
# has already exited is harmless and returns its real status.
seen=0
while :; do
    status=0
    wait "$paseo_pid" || status=$?
    (( signals > seen )) || break
    seen=$signals
done

# Wait for t3 to finish shutting down. Loop because a second signal would otherwise cut
# the wait short and exit with t3 still running. t3's launcher SIGKILLs its own process
# tree 5s after SIGTERM, so this is bounded in practice.
stop_t3
while kill -0 "$t3_pid" 2>/dev/null; do
    wait "$t3_pid" || true
done
exit "$status"
