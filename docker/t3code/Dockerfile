# T3 Code web UI, run as its own standalone stack alongside paseo.
#
# Like Paseo, T3 Code ships NO agent of its own - it spawns whatever provider CLIs are on
# PATH as local subprocesses. Rather than reinstall and re-pin those CLIs here, this image
# is built ON TOP of paseo-agents, which already has claude/codex/pi at known pins AND the
# env layout that puts every agent's config under /home/paseo:
#
#   CLAUDE_CONFIG_DIR=/home/paseo/.claude
#   CODEX_HOME=/home/paseo/.codex
#   XDG_{CONFIG,DATA,STATE,CACHE}_HOME=/home/paseo/...
#
# That is what makes the head-to-head comparison honest: this stack mounts the SAME
# paseo-home volume, so T3 Code and Paseo drive the same agent logins, the same session
# history and the same /srv checkout. Neither tool gets an advantage from a fresher login
# or a different agent build. See README.md for the concurrency caveat that buys.
#
# The base tag is an ARG because CI must build this AFTER paseo-agents on the same commit
# - see .github/workflows/docker-image.yml, which passes the commit SHA tag so the image
# is pinned to the exact paseo-agents build from this commit rather than a moving tag.
ARG PASEO_AGENTS_TAG=t3-paseo-test
FROM ghcr.io/thepharmer/paseo-agents:${PASEO_AGENTS_TAG}

# Pinned like every other agent in this repo. Deliberately NOT locked down further:
# T3 Code is at 0.0.x and shipping fast, so the README documents an in-container
# `npm i -g t3@<ver>` escape hatch for testing a new release without a CI round-trip.
# That escape hatch is why the build toolchain below is kept in the image.
ARG T3_VERSION="0.0.28"

# The base leaves User unset and drops privileges in its own entrypoint. This image does
# not run that entrypoint (it runs t3, not the paseo daemon), so it installs as root here
# and sets USER explicitly at the bottom instead.
USER root

# node-pty ships prebuilds for darwin-arm64, darwin-x64, win32-arm64 and win32-x64 ONLY -
# there is no linux prebuild, so it compiles from source via node-gyp on every Linux
# install. Verified by installing t3@0.0.28 and finding build/Release/pty.node freshly
# built with an empty prebuilds/linux-*. Without this toolchain the npm install below
# fails outright, and any later in-container upgrade would fail the same way.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "t3@${T3_VERSION}" \
    && t3 --version \
    && npm cache clean --force

# Assert the native PTY binding actually built. npm treats a missing allow-scripts
# approval as a WARNING, not an error (npm 11 gates install scripts behind
# `npm approve-scripts`), so a future npm could silently skip node-gyp and leave a t3 that
# installs cleanly and then fails the moment it tries to spawn a terminal. Fail the image
# build here instead of discovering it in the UI.
RUN test -f "$(npm root -g)/t3/node_modules/node-pty/build/Release/pty.node" \
    || { echo "FATAL: node-pty native binding missing - install scripts did not run"; exit 1; }

# The shared volume is owned by uid/gid 1000 from the paseo stack, so no chown is needed
# or wanted here. Assert the user exists rather than hardcoding a bare uid, so a base
# image that renames it fails the build instead of producing an unwritable container.
RUN id paseo && test "$(id -u paseo)" = "1000"

COPY entrypoint.sh /usr/local/bin/t3code-entrypoint
RUN chmod +x /usr/local/bin/t3code-entrypoint

# Telemetry off by default at the image level, not just in compose, so it stays off if
# this image is ever run without the stack's environment block.
ENV T3CODE_TELEMETRY_ENABLED=false \
    T3CODE_NO_BROWSER=true \
    HOME=/home/paseo

USER paseo

# tini stays PID 1 exactly as the base image does; only the child process changes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3code-entrypoint"]

EXPOSE 3773
