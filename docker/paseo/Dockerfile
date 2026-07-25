# Paseo daemon + web UI, run as its own standalone stack alongside claude-dev.
#
# Paseo ships NO agent of its own - it orchestrates whatever agent CLIs are on PATH,
# so this child image adds Claude Code, Codex and Pi to the official base.
#
# Base image facts below are read from the published image config of
# ghcr.io/getpaseo/paseo:0.2.1 (not assumed):
#   Entrypoint  ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
#   User        (unset -> root; the stock entrypoint drops to uid/gid 1000 'paseo' itself)
#   WorkingDir  /workspace          Volume  /home/paseo          Port  6767/tcp
#   Node        22.23.1  - satisfies claude >=22.0.0, pi >=22.19.0, codex >=16
#   Env         PASEO_HOME=/home/paseo/.paseo
#               CLAUDE_CONFIG_DIR=/home/paseo/.claude
#               CODEX_HOME=/home/paseo/.codex
#               XDG_{CONFIG,DATA,STATE,CACHE}_HOME=/home/paseo/...
#
# That env layout is why this setup needs no cred wiring at all: every agent's config
# path already resolves under /home/paseo, so the single paseo-home volume persists
# Paseo's state AND all three agents' logins. Pi has no dedicated env var here, but it
# inherits HOME=/home/paseo and the XDG_* dirs, so its state lands on the volume too.
#
# TODO(reproducibility): pin by digest once verifiable from a host with registry access:
#   FROM ghcr.io/getpaseo/paseo:0.2.1@sha256:<digest>
FROM ghcr.io/getpaseo/paseo:0.2.1

# Agent CLI pins - identical to the pins in claude-code/Dockerfile so both surfaces run
# the same agent builds. Because this stack keeps its credentials ISOLATED from the
# claude-config volume, these can be bumped independently without risking shared state:
# unlike a full-share setup, drift here cannot corrupt claude-dev.
ARG CLAUDE_CODE_VERSION="2.1.219"
ARG CODEX_VERSION="0.145.0"
ARG PI_VERSION="0.82.1"

# The base leaves User unset and drops privileges in its own entrypoint, so install as
# root and deliberately do NOT set USER - overriding it would break that drop.
USER root

# bubblewrap backs Codex's Linux sandbox. Without it on PATH Codex warns and falls back to
# its bundled copy - functional, but noisy and unpinned to the distro build. Installing the
# package is all that is needed; it requires NO Docker security relaxation.
#
# Deliberately NOT setuid (upstream's secure devcontainer does 'chmod u+s /usr/bin/bwrap'
# because it runs non-root, as we do). A setuid-root binary in a tunnel-reachable container
# is a worse trade than Codex's fallback, so add it only if the sandbox is proven broken.
# Likewise NOT adding SYS_ADMIN/seccomp=unconfined/apparmor=unconfined: those relax the
# container boundary that actually protects the host in order to build a weaker one inside
# it. Verify with:  codex sandbox linux --full-auto -- /bin/sh -lc 'echo inner-ok'
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && bwrap --version

# Pi's only optional dependency (@mariozechner/clipboard) is a native module that is
# useless in a headless container; npm treats optionalDependencies failures as non-fatal,
# so a build host without its toolchain still produces a working image.
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && claude --version \
    && codex --version \
    && pi --version \
    && npm cache clean --force

# Guard against a base-image regression: Pi needs Node >=22.19.0 and the base currently
# ships 22.23.1, so a future upstream downgrade inside the 22.x line would break Pi at
# runtime with no build-time signal. Fail the build instead.
RUN node -e 'const v=process.versions.node.split(".").map(Number); if (v[0]<22 || (v[0]===22 && v[1]<19)) { console.error("FATAL: base Node "+process.versions.node+" is below pi >=22.19.0"); process.exit(1); } console.log("Node "+process.versions.node+" OK for claude/codex/pi")'

# Password-secret bridge. Paseo reads only PASEO_PASSWORD; a Compose secret arrives as a
# FILE, so without this the secret is silently ignored and a tunnel-reachable daemon comes
# up UNAUTHENTICATED. Sits between tini and the stock entrypoint, which is left untouched.
COPY entrypoint.sh /usr/local/bin/paseo-password-entrypoint
RUN chmod +x /usr/local/bin/paseo-password-entrypoint

# Keep tini as PID 1 exactly as the base image does - only the child process changes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-password-entrypoint"]

# Match claude-dev's rebuild-to-upgrade model: no in-container self-update.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1

EXPOSE 6767
