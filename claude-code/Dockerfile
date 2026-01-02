# Use official Node.js Alpine image
FROM node:24-alpine

# Install git and su-exec (required by Claude Code and entrypoint) as well as OpenSSH
RUN apk add --no-cache git su-exec openssh-server \
    && ssh-keygen -A \
    && mkdir -p /home/node/.ssh \
    && chown node:node /home/node/.ssh

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D"]

# Create directories
RUN mkdir -p /claude /workspace

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set working directory
WORKDIR /workspace

# Set entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["sh", "-c", "echo 'Claude Code container is ready!'"]
