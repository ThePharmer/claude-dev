# Claude Container

A Docker container with Claude Code pre-installed and ready to use.

This container includes all necessary dependencies and provides an easy way to run Claude Code in an isolated environment.

## Available Images

| Image | Purpose | Base |
|-------|---------|------|
| [nezhar/claude-container](https://hub.docker.com/r/nezhar/claude-container) | Main container with Claude Code CLI pre-installed | Alpine 3.20 |

## Compatibility Matrix

**Latest Release:** 2.0.0

| Container Version | Claude Code Version | Notes |
|-------------------|---------------------|-------|
| 2.0.x             | 2.x (native binary) | Alpine 3.20, native installer |
| 1.0.x–1.4.x      | 1.0.x–2.0.x (npm)   | Node.js Alpine, npm install (deprecated) |

## Migration from v1.x to v2.0

v2.0 switches from npm-based installation (`node:24-alpine`) to Anthropic's native binary installer (`alpine:3.20`). This drops the Node.js dependency, shrinks the image, and aligns with the officially supported installation path.

**Breaking change:** The container user changed from `node` to `claude`. Update your `authorized_keys` mount path:

```yaml
# Old (v1.x):
- /path/to/authorized_keys:/home/node/.ssh/authorized_keys:ro
# New (v2.0):
- /path/to/authorized_keys:/home/claude/.ssh/authorized_keys:ro
```

All other volume mounts (`/claude`, `/srv`, etc.) and environment variables remain unchanged.

**Manual in-container updates:** The auto-updater is disabled by default (`DISABLE_AUTOUPDATER=1`) to avoid a known 0-byte file bug. To update Claude Code between image rebuilds:

```bash
# SSH into the container, then:
DISABLE_AUTOUPDATER=0 claude update
```

## Quick Start

### Using the Helper Script (Recommended)

The easiest way to run Claude Container is using the provided bash script. Download and install it with:

```bash
# Download the script directly from GitHub
curl -o ~/.local/bin/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/bin/claude-container

# Make it executable
chmod +x ~/.local/bin/claude-container

# Run Claude Code
claude-container
```

Make sure `~/.local/bin` is in your PATH. Alternatively, install to `/usr/local/bin`:

```bash
# Download and install system-wide (requires sudo)
sudo curl -o /usr/local/bin/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/bin/claude-container
sudo chmod +x /usr/local/bin/claude-container
```

The script handles all Docker configuration automatically. Run with `--help` to see all available options:

```bash
claude-container --help
```

#### Optional: Enable Tab Completion

To enable bash tab completion for the `claude-container` command:

```bash
# Download and install completion script
mkdir -p ~/.local/share/bash-completion/completions
curl -o ~/.local/share/bash-completion/completions/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/completions/claude-container

# Reload your shell or start a new terminal session
source ~/.bashrc
```

Once installed, you can use tab completion with `claude-container --<TAB>` to see all available options

#### Updating to the Latest Version

To update to the latest version, simply re-download the helper script and completions:

```bash
# Update helper script (user install)
curl -o ~/.local/bin/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/bin/claude-container

# Or for system-wide install
sudo curl -o /usr/local/bin/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/bin/claude-container

# Update completions (if installed)
curl -o ~/.local/share/bash-completion/completions/claude-container https://raw.githubusercontent.com/nezhar/claude-container/main/completions/claude-container

# Verify the new version
claude-container --version
```

The helper script will automatically pull the latest Docker images when needed.

### Using Docker Compose

Create a `compose.yml` file as provided in the example folder. 
```bash
docker compose run claude-code claude
```

You will need to login for the first time, afterwards your credentials and configurations will be stored inside a bind mount volume, make sure this stays in your `.gitignore`.

### Using Docker directly


```bash
docker run --rm -it -v "$(pwd):/workspace" -v "$HOME/.config/claude-container:/claude" -e "CLAUDE_CONFIG_DIR=/claude" nezhar/claude-container:latest claude
```

This will store the credentials in `$HOME/.config/claude-container` and will be able to reuse them after the first login.

## How does the authentication work

When you run the container for the first time, you'll go through the following authentication steps:

1. **Choose Color Schema**: Select your preferred terminal color scheme

   ![Color Schema Selection](docs/auth1.png)

2. **Select Login Method**: Choose between Subscription or Console login (this example uses Subscription)

   ![Login Method Selection](docs/auth2.png)

3. **Generate Token**: Open the provided URL in your browser to generate an authentication token, then paste it into the prompt

   ![Token Generation](docs/auth3.png)

4. **Success**: You're authenticated and ready to use Claude Code

   ![Authentication Success](docs/auth4.png)

## Integration with Existing Projects

To integrate Claude Container into an existing Docker Compose project, create a `compose.override.yml` file:

```yaml
services:
  claude-code:
    image: nezhar/claude-container:latest
    volumes:
      - ./workspace:/workspace
      - ./claude-config:/claude
    environment:
      CLAUDE_CONFIG_DIR: /claude
    profiles:
      - tools
```

Then run Claude Code with:

```bash
# Using profiles to avoid starting by default
docker compose --profile tools run claude-code claude
```

This approach keeps Claude Code separate from your main application services while allowing easy access when needed.
