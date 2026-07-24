# Paseo — standalone stack

Paseo daemon + web UI, running as its **own Compose stack** next to `claude-code`, reached
through the Cloudflare tunnel at `paseo.example.com`.

Paseo ships no agent of its own — it orchestrates whatever agent CLIs are on `PATH`, and it
runs them as **local subprocesses**. That's why this is a child image with Claude Code,
Codex and Pi baked in, rather than something that talks to the `claude-code` container.

- **`Dockerfile`** — `ghcr.io/getpaseo/paseo:0.2.1` plus the three agent CLIs, pinned to the
  same versions as `claude-code/Dockerfile`.
- **`entrypoint.sh`** — password-secret bridge; fails closed (see below).
- **`compose.yaml`** — the stack itself.

## Credentials: ISOLATED (no share with claude-dev)

This stack deliberately shares **nothing** with the `claude-config` volume. The base image
already points every agent config path under `/home/paseo`:

```
PASEO_HOME=/home/paseo/.paseo
CLAUDE_CONFIG_DIR=/home/paseo/.claude
CODEX_HOME=/home/paseo/.codex
XDG_{CONFIG,DATA,STATE,CACHE}_HOME=/home/paseo/...
```

So the single `paseo-home` volume is the whole persistence story — Paseo's state *and* all
three agents' logins. Pi has no dedicated env var but inherits `HOME` and the `XDG_*` dirs,
so its state lands there too. No symlinks or config-dir overrides are needed.

Consequences:

- **You log in once per agent, inside this container.** Separate from claude-dev's logins.
- **Separate transcript history.** Paseo's Claude does not see claude-dev's `/claude/projects`.
- **Blast radius is contained.** This container is reachable over a public tunnel and cannot
  read claude-dev's `gh` token, cloudcli auth DB, or Claude credentials.
- **Teardown is cheap.** `docker compose down -v` removes the whole thing with no risk to
  the dev container.

The only thing shared is the code: `/srv` is bind-mounted at the **same absolute path** both
containers use, so agent cwd, git worktree paths and absolute paths stay consistent.

> If you later want unified transcripts and single-login instead, that's the full-share model
> on the `paseo-pi-sidecar` branch — it mounts `claude-config` and overrides the config dirs.
> It trades the isolation properties above for convenience.

## Setup

```bash
# 1. Password secret (not committed)
install -d -m 700 /opt/claude-dev/secrets
openssl rand -base64 32 > /opt/claude-dev/secrets/paseo_password
chmod 600 /opt/claude-dev/secrets/paseo_password

# 2. Build + start
docker compose -f docker/paseo/compose.yaml up -d --build

# 3. Authenticate each agent (once; persists on paseo-home)
docker exec -it --user paseo paseo claude
docker exec -it --user paseo paseo codex
docker exec -it --user paseo paseo pi

# 4. Confirm Paseo sees them
docker exec -u paseo paseo paseo ls
```

Then add a Cloudflare public hostname `paseo.example.com` → the host's `:6767` (same origin
host as the existing `cc.example.com` → `:3001` route), duplicate the Access policy, and
allow WebSockets.

## Why the custom entrypoint

Paseo reads only `PASEO_PASSWORD` — **not** `PASEO_PASSWORD_FILE`. A Compose secret arrives as
a *file*, so without a bridge the secret is silently ignored and the daemon starts
**unauthenticated**, logging only a warning while still serving. `entrypoint.sh` reads the
file, exports `PASEO_PASSWORD`, unsets the pointer, and **fails closed** if no password is
available. It then execs the stock entrypoint unmodified, with `tini` still PID 1.

## Troubleshooting

**403 through the tunnel, but `http://<host-ip>:6767` works.** `PASEO_HOSTNAMES` is matched
against the `Host` header Paseo actually *receives*. If the cloudflared connector sets
`httpHostHeader`, it rewrites that header and Paseo rejects the request even though the route
is correct. Check the connector config — this is not a password problem.

**Healthcheck flapping.** The check hits `/api/health`. That endpoint is confirmed for 0.1.110;
if 0.2.x moved it, point the check at `/` instead.

**Permissions on `/srv`.** Paseo is fixed at uid/gid 1000 and `/srv` is already owned by 1000,
matching `claude-code`. Don't run `claude-code` with `USER_UID != 1000` — it would rewrite
ownership out from under this container.

## Verify on upgrade

- Re-check the base image's env layout after a `FROM` bump; this design depends on every agent
  config path resolving under `/home/paseo`.
- The Dockerfile asserts Node `>=22.19.0` at build time (Pi's floor). If upstream moves to
  Node 24, drop the assert's lower bound rather than pinning an old base.
- Keep the agent pins here in sync with `claude-code/Dockerfile` so both surfaces run the same
  builds. Drift is safe (state is isolated) but confusing.
