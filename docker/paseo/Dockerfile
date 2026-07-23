# Paseo daemon image for the claude-dev stack: the official Paseo image plus the agent
# CLIs we orchestrate (Claude Code, Codex, Pi). Versions are pinned to match the agents
# baked into the claude-dev image so both surfaces run the same releases; upgrade by
# bumping these ARGs and rebuilding (matches claude-dev's rebuild-to-upgrade model).
#
# Base pinned to a released tag. For full reproducibility, append the multi-arch digest:
#   FROM ghcr.io/getpaseo/paseo:0.1.110@sha256:<digest>
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
    && command -v pi \
    && npm cache clean --force

# Lock Claude Code to the pin (no in-container self-update), same as claude-dev.
# HOME=/home/paseo is the persisted volume, so agent creds under .claude/.codex/.pi and
# Paseo state under .paseo all survive recreation with no extra symlinks needed here.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1
