FROM debian:bookworm-slim

# Pin Claude Code. Default is the version you asked for; override at build with
#   docker build --build-arg CLAUDE_CODE_VERSION=2.1.258 ...
ARG CLAUDE_CODE_VERSION="2.1.258"

# Node major version for cloudcli (it requires Node 22+).
ARG NODE_MAJOR="24"

# ---------------------------------------------------------------------------
# Base system packages
#  - tini: PID 1 init so sshd AND the cloudcli web UI are both reaped cleanly
#  - build-essential / python3 / python3-setuptools: needed to compile cloudcli's
#    native modules (node-pty, better-sqlite3, bcrypt) if no prebuild matches.
#    node-pty ships as a beta with no Node 24 prebuild, so this compiles from source.
#  - jq / sqlite3: kept for interactive use inside the container (cloudcli itself
#    does not shell out to them - it uses the better-sqlite3 library)
#  Note: debian's own nodejs/npm are NOT installed here; Node comes from NodeSource
#  below so we land on Node 24 instead of bookworm's Node 18.
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      git openssh-server bash mosh sudo curl ca-certificates gnupg \
      ripgrep unzip tini build-essential python3 python3-setuptools jq sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && ssh-keygen -A

RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# bookworm-slim is PEP 668 externally-managed, so a system install needs the flag.
# yt-dlp[default] pulls certifi + curl_cffi. Node 24 already satisfies the JS runtime.
# faster-whisper (CTranslate2, ~50MB, no torch) backs the youtube-evaluator skill's
# opt-in --whisper tier, replacing the old openai-whisper runtime install (~2GB torch).
RUN uv pip install --system --break-system-packages --no-cache \
        "yt-dlp[default]" youtube-transcript-api faster-whisper

# ffmpeg is needed by the --whisper tier's audio-extraction step (yt-dlp -x).
# Caption extraction itself doesn't need it.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's official apt repo — bookworm's own gh package is
# years stale (2.23.x). Follows the documented install for Debian.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# ---------------------------------------------------------------------------
# Create 'claude' user (replaces 'node' from old base image)
# ---------------------------------------------------------------------------
RUN groupadd -g 1000 claude \
    && useradd -u 1000 -g claude -m -d /home/claude -s /bin/bash claude \
    && mkdir -p /home/claude/.ssh \
    && chown claude:claude /home/claude/.ssh \
    && passwd -d claude \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config \
    && echo 'export PATH="/home/claude/.local/bin:$PATH"' >> /etc/profile \
    && echo "claude ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/claude

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version

RUN npm install -g @cloudcli-ai/cloudcli \
    && cloudcli --version

# Codex + Pi coding agents. Pinned like Claude Code (rebuild-to-upgrade). These are for
# interactive / cloudcli use INSIDE this container; the standalone Paseo stack installs
# its own copies at the same pins (docker/paseo/Dockerfile).
# Pi has no install/postinstall hook - its only optional dep (@mariozechner/clipboard) is
# a native module that is useless headless, and npm treats optional-dep failures as
# non-fatal, so a plain install is safe here.
ARG CODEX_VERSION="0.149.1"
ARG PI_VERSION="0.84.2"
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
    && codex --version
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && pi --version

# /codex, /pi and /cloudcli are mount points for their own named volumes. Kept top-level
# (like /claude) so they stay out of usermod's recursive rechown path when USER_UID is
# remapped at runtime, and so each tool's state can be backed up or reset independently.
RUN mkdir -p /claude /srv /codex /pi /cloudcli
# /srv/projects, not /srv: compose mounts the individual subtrees of /srv rather than the
# whole tree, so /srv itself is an ephemeral overlay directory and writes to it are lost
# on container recreation. The cwd belongs on a real mount.
WORKDIR /srv/projects

# Symlink ~/.claude -> /claude so the config path matches the mounted volume.
# Both 'claude' and cloudcli read/write here, so this keeps them sharing one config.
# The symlink (rather than mounting the volume directly at ~/.claude) keeps the
# config volume out of any 'rm -rf ~/.claude' reset path and out of usermod's
# recursive rechown when USER_UID is remapped at runtime.
RUN rm -rf /home/claude/.claude && ln -s /claude /home/claude/.claude

# Same pattern for Codex, Pi and cloudcli, but onto their own volumes. The symlinks are
# required (not just the env vars): cloudcli hardcodes ~/.codex/sessions, pi defaults to
# ~/.pi, and cloudcli reads ~/.cloudcli with no relocate env var at all.
RUN rm -rf /home/claude/.codex /home/claude/.pi /home/claude/.cloudcli \
    && ln -s /codex    /home/claude/.codex \
    && ln -s /pi       /home/claude/.pi \
    && ln -s /cloudcli /home/claude/.cloudcli

# Lock the pinned version. DISABLE_AUTOUPDATER stops the background update check;
# DISABLE_UPDATES additionally blocks manual 'claude update' / 'claude install', so
# nobody can drift off the pin from inside the container - changing version means
# rebuilding the image. This is the documented setup for running your own pinned channel.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1

# cloudcli defaults (overridable via compose env)
ENV SERVER_PORT=3001 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/claude/cloudcli-auth.db

# Codex honors CODEX_HOME; point it at its own volume so 'codex login' survives container
# recreation, same as ~/.claude does. (Pi uses ~/.pi, handled by the symlink above.)
ENV CODEX_HOME=/codex

# gh stores auth/config under GH_CONFIG_DIR; pointing it at the /claude volume
# means 'gh auth login' survives container recreation, same as ~/.claude does.
ENV GH_CONFIG_DIR=/claude/gh

# Hugging Face cache on the /claude volume so faster-whisper's model download
# (~500MB for small.en, fetched on first --whisper use) survives recreation
# without bloating the image.
ENV HF_HOME=/claude/hf-cache

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 3001
EXPOSE 60000-61000/udp

# tini as PID 1, with -g so a stop signal reaches the whole process group, not just
# tini's immediate child. The entrypoint execs sshd (the foreground child) and leaves
# cloudcli backgrounded in the same process group; -g ensures SIGTERM hits both on
# shutdown instead of letting cloudcli wait for SIGKILL at the timeout.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
