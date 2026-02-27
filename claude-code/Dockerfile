FROM debian:bookworm-slim

ARG CLAUDE_CODE_VERSION=""

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      git openssh-server bash mosh sudo curl ca-certificates \
      ripgrep nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && ssh-keygen -A

# Create 'claude' user (replaces 'node' from old base image)
RUN groupadd -g 1000 claude \
    && useradd -u 1000 -g claude -m -d /home/claude -s /bin/bash claude \
    && mkdir -p /home/claude/.ssh \
    && chown claude:claude /home/claude/.ssh \
    && passwd -d claude \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config \
    && echo 'export PATH="/home/claude/.local/bin:/home/claude/.bun/bin:$PATH"' >> /etc/profile
    && echo "claude ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/claude

# Install native binary as claude user
USER claude
RUN curl -fsSL https://bun.sh/install | bash
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"; \
    else \
      curl -fsSL https://claude.ai/install.sh | bash; \
    fi
USER root

# Symlink so 'claude' works from any context (not just login shells)
RUN ln -s /home/claude/.local/bin/claude /usr/local/bin/claude

RUN mkdir -p /claude /srv
WORKDIR /srv

# Symlink ~/.claude -> /claude so native installer's default config path
# matches the volume mount point (workaround for CLAUDE_CONFIG_DIR bug #2986)
RUN rm -rf /home/claude/.claude && ln -s /claude /home/claude/.claude

# Disable auto-updater by default (update via rebuild or manual 'claude update')
ENV DISABLE_AUTOUPDATER=1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 60000-60023/udp
ENTRYPOINT ["/entrypoint.sh"]
