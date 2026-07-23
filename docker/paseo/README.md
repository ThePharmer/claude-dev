# Paseo sidecar

A separate multi-agent orchestration surface (Paseo daemon + web UI) that runs alongside
`claude-code`, reached via the Cloudflare tunnel at `paseo.example.com`.

- **`Dockerfile`** — the official `ghcr.io/getpaseo/paseo:0.1.110` image plus the agent CLIs
  we orchestrate (Claude Code, Codex, Pi), pinned to match the versions baked into
  `claude-code`. Also installs a small password-secret bridge (`rootfs/…/paseo-password-entrypoint`).
- **`rootfs/usr/local/bin/paseo-password-entrypoint`** — reads `PASEO_PASSWORD_FILE` and
  exports `PASEO_PASSWORD` before the stock entrypoint (Paseo itself reads only
  `PASEO_PASSWORD`), then fails closed if no password is present.

## Credentials + transcripts: FULL SHARE

The `paseo` service mounts the shared `claude-config` volume at `/claude` and points the
agent CLIs there via `CLAUDE_CONFIG_DIR=/claude`, `CODEX_HOME=/claude/codex`,
`PI_CODING_AGENT_DIR=/claude/pi/agent`. Consequences:

- **No second login.** Paseo's Claude and Codex reuse `claude-code`'s existing auth.
- **Unified transcripts.** Paseo's Claude reads/writes the same `/claude/projects` history
  (~3.8 GB) as cloudcli, and new Paseo sessions join it.
- **Trade-off (accepted):** this tunnel-reachable container can also read `/claude/gh` and
  the cloudcli auth DB. Mitigated by Cloudflare Access + the Paseo password + single-user use.
- **Hard requirement:** both containers must run as uid/gid **1000** (Paseo is fixed at 1000;
  `/claude` is owned by 1000). Do **not** set `USER_UID != 1000` on `claude-code` while
  sharing this volume.

Paseo's own daemon state stays on the separate `paseo-home` volume (`/home/paseo/.paseo`).

## Setup checklist

1. Create the password secret on the host (not committed):
   ```bash
   install -d -m 700 /opt/claude-dev/secrets
   openssl rand -base64 32 > /opt/claude-dev/secrets/paseo_password
   chmod 600 /opt/claude-dev/secrets/paseo_password
   ```
2. `docker compose -f claude-code/compose.yml up -d --build paseo`
3. In the Cloudflare tunnel stack (separate Portainer stack), add a public hostname
   `paseo.example.com` pointing at the host's `:6767` — same origin host as the existing
   `cc.example.com` → `:3001` route. Duplicate the Access policy; allow WebSockets.
4. Confirm agents/providers with `docker exec -u paseo paseo paseo ls` (Claude/Codex should
   already be authed via `/claude`).

## Open items to verify on first deploy

- **Pi config sharing.** `PI_CODING_AGENT_DIR=/claude/pi/agent` is what Paseo's Pi *adapter*
  reads; confirm the `pi` CLI itself honors it (vs. `~/.pi`) so Pi state is actually shared.
  Not blocking — the hard requirement (Claude transcripts) is satisfied by `CLAUDE_CONFIG_DIR`.
- **Host-header forwarding.** `PASEO_HOSTNAMES=paseo.example.com` assumes cloudflared
  forwards the external `Host`. If the connector rewrites it, requests 403 — verify the
  connector's `httpHostHeader`.
- **Version drift.** `claude-code` deploys from mutable `:latest`; keep its baked agent pins
  in sync with `docker/paseo/Dockerfile`, or you'll run mismatched CLI builds against one
  shared `/claude` state.
