FROM node:24-alpine

RUN apk add --no-cache git su-exec openssh-server bash \
    && ssh-keygen -A \
    && mkdir -p /home/node/.ssh \
    && chown node:node /home/node/.ssh \
    && sed -i 's|/home/node:/sbin/nologin|/home/node:/bin/bash|' /etc/passwd \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config

RUN npm install -g @anthropic-ai/claude-code

RUN mkdir -p /claude /workspace
WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
