# claude-dev

An always-on [Claude Code](https://claude.com/claude-code) dev container you SSH into.

One long-running Docker container hosts Claude Code plus a curated toolbelt, reachable three ways: **SSH** for terminal sessions, **mosh** for flaky connections, and the **CloudCLI web UI** for the browser. Config and credentials live on a named volume, so the container itself is disposable — rebuild or recreate it and everything important survives.

Forked from [nezhar/claude-container](https://github.com/nezhar/claude-container), then rebuilt around a persistent SSH-server workflow instead of one-off `docker run` sessions.

## What's in the image

`ghcr.io/thepharmer/claude-dev` — Debian 12 (bookworm-slim).

| Tool | Why it's baked in |
|------|-------------------|
| Claude Code (pinned via `CLAUDE_CODE_VERSION`) | The point. Auto-updates disabled — version changes happen by rebuild, so the image tag tells the truth |
| Node.js 24 (NodeSource) | Runtime for claude-code and CloudCLI; also serves as yt-dlp's JS runtime |
| [CloudCLI](https://www.npmjs.com/package/@cloudcli-ai/cloudcli) | Web UI for Claude Code on port 3001, started by the entrypoint |
| GitHub CLI (`gh`, official apt repo) | PRs/issues from inside the container; auth persists on the config volume via `GH_CONFIG_DIR=/claude/gh` |
| `yt-dlp`, `youtube-transcript-api`, `faster-whisper`, `ffmpeg` | The youtube-evaluator skill works with zero runtime installs — including its Whisper fallback for caption-less videos (CTranslate2-based, no PyTorch) |
| `uv` | Fast Python package installs; skills use it to bootstrap anything not baked in |
| mosh + openssh-server | Terminal access; mosh keeps sessions alive across roaming/sleep |
| `ripgrep`, `jq`, `sqlite3`, `build-essential`, `python3` | Day-to-day CLI work, plus compiling CloudCLI's native modules (node-pty, better-sqlite3) |

## Quick start

1. Put your SSH public key(s) somewhere the container can mount, e.g. `/srv/docker/claude-dev/authorized_keys`. The entrypoint **refuses to start without it**.

2. Use `example/compose.yml` as a starting point:

```yaml
services:
  claude-code:
    image: ghcr.io/thepharmer/claude-dev:latest
    ports:
      - "2222:22"                        # SSH
      - "3001:3001"                      # CloudCLI web UI
      - "60000-61000:60000-61000/udp"    # mosh
    volumes:
      - /srv:/workspace
      - claude-config:/claude
      - /srv/docker/claude-dev/authorized_keys:/home/claude/.ssh/authorized_keys:ro
    environment:
      CLAUDE_CONFIG_DIR: /claude
    restart: unless-stopped

volumes:
  claude-config:
```

3. Start it and connect:

```bash
docker compose up -d
ssh -p 2222 claude@your-host        # or: mosh --ssh="ssh -p 2222" claude@your-host
claude                              # first run walks you through login
```

The CloudCLI web UI is at `http://your-host:3001` (it has its own login, stored in `/claude/cloudcli-auth.db`).

### First-time authentication

On first `claude` run you'll pick a color scheme, choose Subscription or Console login, and paste a token from your browser:

![Color Schema Selection](docs/auth1.png)
![Login Method Selection](docs/auth2.png)
![Token Generation](docs/auth3.png)
![Authentication Success](docs/auth4.png)

Credentials land on the `claude-config` volume and survive container recreation.

## Persistence model

Three tiers — know which one a file lives in:

| Location | What | Survives |
|----------|------|----------|
| `claude-config` volume at `/claude` | Claude Code config + credentials, skills, hooks, memory, gh auth (`gh/`), Hugging Face model cache (`hf-cache/`), CloudCLI login DB | Everything — rebuilds, recreation, image upgrades |
| Host bind mount (e.g. `/srv`) | Your projects | Everything (it's the host's filesystem) |
| Container rootfs | Anything else — apt packages installed live, `/tmp`, `/home/claude` outside the symlinks | Restarts only. Gone on recreation — bake it into the Dockerfile instead |

`~/.claude` is a symlink to `/claude`, so tools that hardcode the default config path still hit the volume.

## How the container runs

`tini` is PID 1. The entrypoint (`claude-code/entrypoint.sh`):

1. Remaps the `claude` user to `USER_UID`/`USER_GID` if they differ from 1000 (match your host user to keep bind-mount ownership sane)
2. Validates the `authorized_keys` mount and fixes SSH permissions
3. Starts CloudCLI in the background as `claude` (logs: `/tmp/cloudcli.log`)
4. Runs `sshd` in the foreground

Password auth is disabled; pubkey only. `sudo` inside the container is passwordless for `claude`.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `USER_UID` / `USER_GID` | `1000` | Remap the container user to match host file ownership |
| `CLAUDE_CONFIG_DIR` | `/claude` | Claude Code config location |
| `SERVER_PORT` / `HOST` | `3001` / `0.0.0.0` | CloudCLI bind |
| `DATABASE_PATH` | `/claude/cloudcli-auth.db` | CloudCLI login DB |
| `GH_CONFIG_DIR` | `/claude/gh` | gh auth on the volume |
| `HF_HOME` | `/claude/hf-cache` | Whisper model cache on the volume |

## Updating Claude Code

The pinned version is a build arg, and both the auto-updater and manual `claude update` are disabled inside the container (`DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`) — the image is the single source of truth for what's running.

```bash
# check what's current
npm view @anthropic-ai/claude-code version

# rebuild against it
docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.209 claude-code
docker compose up -d claude-code
```

Or bump the `ARG CLAUDE_CODE_VERSION` default in `claude-code/Dockerfile` and let CI build it.

## CI

Pushes to `main` build the image, push `latest` + commit-SHA tags to ghcr, and smoke-test that `claude --version` runs (`.github/workflows/docker-image.yml`).

## Repo layout

```
claude-code/     Dockerfile + entrypoint for the dev container image
example/         Reference compose.yml
bin/             claude-container: standalone launcher for one-off local runs
completions/     Bash completions for the launcher
docs/            Auth walkthrough screenshots
```

The `bin/claude-container` launcher predates the SSH-server workflow and still targets the upstream `nezhar/claude-container` image by default (override with `CLAUDE_IMAGE=ghcr.io/thepharmer/claude-dev:latest`). It's kept for quick throwaway sessions on machines without the compose setup.
