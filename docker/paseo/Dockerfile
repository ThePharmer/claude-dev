# Paseo daemon image for the claude-dev stack: the official Paseo image plus the agent
# CLIs we orchestrate (Claude Code, Codex, Pi). Versions are pinned to match the agents
# baked into the claude-dev image so both surfaces run the same releases; upgrade by
# bumping these ARGs and rebuilding (matches claude-dev's rebuild-to-upgrade model).
#
# Base pinned to a released tag. TODO(reproducibility): pin by digest once verifiable from a
# host with Docker/registry access:  FROM ghcr.io/getpaseo/paseo:0.1.110@sha256:<digest>
FROM ghcr.io/getpaseo/paseo:0.1.110

ARG CLAUDE_CODE_VERSION="2.1.209"
ARG CODEX_VERSION="0.145.0"
ARG PI_VERSION="0.81.1"

# The base image's entrypoint uses root only for first-run volume setup, then drops the
# daemon and launched agents to the non-root 'paseo' user - so install as root and leave
# the image user as root (per Paseo's docker docs).
USER root
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
    && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && claude --version \
    && codex --version \
    && pi --version \
    && npm cache clean --force

# Password-secret bridge: reads PASEO_PASSWORD_FILE -> exports PASEO_PASSWORD -> execs the
# stock Paseo entrypoint. Required because Paseo reads only PASEO_PASSWORD, not the _FILE
# form; without this a mounted Compose secret is ignored and the public daemon starts
# unauthenticated. tini stays PID 1; the wrapper sits between tini and the base entrypoint.
COPY rootfs/ /
RUN chmod +x /usr/local/bin/paseo-password-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-password-entrypoint"]

# Lock Claude Code to the pin (no in-container self-update), same as claude-dev.
# Agent config/creds + transcripts are shared from claude-dev via CLAUDE_CONFIG_DIR=/claude
# etc. set in compose (full-share model); Paseo's OWN daemon state stays under /home/paseo.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1
