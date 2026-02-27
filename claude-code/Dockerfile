FROM alpine:3.20

ARG CLAUDE_CODE_VERSION=""

RUN apk add --no-cache \
      git su-exec openssh-server bash mosh sudo curl \
      libgcc libstdc++ ripgrep \
    && ssh-keygen -A

# Create 'claude' user (replaces 'node' from old base image)
RUN addgroup -g 1000 claude \
    && adduser -u 1000 -G claude -h /home/claude -s /bin/bash -D claude \
    && mkdir -p /home/claude/.ssh \
    && chown claude:claude /home/claude/.ssh \
    && passwd -u claude 2>/dev/null || passwd -d claude \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config \
    && echo 'export CLAUDE_CONFIG_DIR=/claude' >> /etc/profile \
    && echo 'export PATH="/home/claude/.local/bin:$PATH"' >> /etc/profile \
    && echo "claude ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/claude

# Install native binary as claude user
USER claude
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION"; \
    else \
      curl -fsSL https://claude.ai/install.sh | bash; \
    fi
USER root

# Symlink so 'claude' works from any context (not just login shells)
RUN ln -s /home/claude/.local/bin/claude /usr/local/bin/claude

# Symlink ~/.claude -> /claude so native installer's default config path
# matches the volume mount point (workaround for CLAUDE_CONFIG_DIR bug #2986)
RUN ln -s /claude /home/claude/.claude

# Disable auto-updater by default (update via rebuild or manual 'claude update')
ENV DISABLE_AUTOUPDATER=1

RUN mkdir -p /claude /srv
WORKDIR /srv

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 60000-61000/udp
ENTRYPOINT ["/entrypoint.sh"]
