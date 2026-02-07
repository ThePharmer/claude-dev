FROM node:24-alpine

RUN apk add --no-cache git su-exec openssh-server bash mosh sudo \
      && ssh-keygen -A \
      && mkdir -p /home/node/.ssh \
      && chown node:node /home/node/.ssh \
      && sed -i 's|/home/node:/sbin/nologin|/home/node:/bin/bash|' /etc/passwd \
      && passwd -u node 2>/dev/null || passwd -d node \
      && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
      && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
      && echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config \
      && echo "export CLAUDE_CONFIG_DIR=/claude" >> /etc/profile \
      && echo "node ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/node

RUN npm install -g @anthropic-ai/claude-code

RUN mkdir -p /claude /srv
WORKDIR /srv

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 60000-61000/udp
ENTRYPOINT ["/entrypoint.sh"]
