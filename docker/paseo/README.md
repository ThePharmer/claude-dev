# Paseo — standalone stack (with T3 Code alongside for evaluation)

Paseo daemon + web UI, running as its **own Compose stack** next to `claude-code`, reached
through the Cloudflare tunnel at `paseo.example.com`.

The same stack also runs a `t3code` service for the head-to-head evaluation in
`docs/t3-vs-paseo.md` — one Compose project so both share `paseo-home` and therefore one
set of agent logins. See `docker/t3code/README.md` for T3 Code itself.

Paseo ships no agent of its own — it orchestrates whatever agent CLIs are on `PATH`, and it
runs them as **local subprocesses**. That's why this is a child image with Claude Code,
Codex and Pi baked in, rather than something that talks to the `claude-code` container.

- **`Dockerfile`** — `ghcr.io/getpaseo/paseo:0.2.1` plus the three agent CLIs, pinned to the
  same versions as `claude-code/Dockerfile`.
- **`entrypoint.sh`** — password-secret bridge; fails closed (see below).
- **`bashrc.sh`** — interactive-shell defaults for the web terminals; installed to
  `/etc/paseo-bashrc.sh` rather than a home directory (see troubleshooting).
- **`../compose.yaml`** — the stack itself, one level up: it defines both the `paseo` and
  `t3code` services, so it belongs to neither image's build context.

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
- **Teardown carries no risk to claude-dev.** Nothing here touches `claude-config`. Note
  that `-v` would still destroy *this* stack's own agent logins, and both services share
  that volume — so tear down without `-v` unless you mean to re-authenticate everything.

The only thing shared is the code: `/srv` is bind-mounted at the **same absolute path** both
containers use, so agent cwd, git worktree paths and absolute paths stay consistent.

> If you later want unified transcripts and single-login instead, that's the full-share model
> on the `paseo-pi-sidecar` branch — it mounts `claude-config` and overrides the config dirs.
> It trades the isolation properties above for convenience.

## Setup (Portainer)

The image is **built by CI, not by the stack**. Portainer does not reliably build images from
a compose file — its docs state that "building images via docker-compose ... is not fully
implemented" — so there is deliberately no `build:` directive here.
`.github/workflows/docker-image.yml` publishes `ghcr.io/thepharmer/paseo-agents`.

This stack runs **two services**: `paseo` and `t3code`, for the head-to-head evaluation in
`docs/t3-vs-paseo.md`. They share the `paseo-home` volume on purpose, so a single set of
agent logins drives both UIs and any difference you observe is a difference in the tools.
Drop the `t3code` service once the evaluation is settled.

1. **Wait for CI.** Pushing to `main` or `t3-paseo-test` builds both images. Branch builds
   are tagged with the branch name; only `main` moves `:latest`.
2. **Create the stack** in Portainer from this repo, compose path `docker/compose.yaml`.
   **Name it `paseo`.** Compose namespaces volumes by project, so the volume resolves to
   `paseo_paseo-home` only under that name — renaming the stack silently creates an empty
   volume and both services come up with no agent logins, no daemon keypair, and no
   downloaded speech models.
3. **Set the stack environment variables:**

   | Variable | Required | Notes |
   |---|---|---|
   | `PASEO_PASSWORD` | yes | High-entropy. Deploy fails immediately if unset. |
   | `PASEO_HOSTNAMES` | for tunnel | DNS name(s) Paseo is reached by. IPs and localhost are allowed by default. |
   | `PASEO_IMAGE_TAG` | no | Defaults to `latest`. Set to `t3-paseo-test` to run the branch build. |
   | `T3CODE_IMAGE_TAG` | no | Defaults to `t3-paseo-test` — there is no `:latest` until T3 Code is merged. |

4. **Deploy**, then authenticate each agent once (persists on the `paseo-home` volume,
   so it covers both services):

   ```bash
   docker exec -it --user paseo paseo claude
   docker exec -it --user paseo paseo codex
   docker exec -it --user paseo paseo pi
   docker exec -it --user paseo paseo gh auth login   # so agents can open PRs
   docker exec -u paseo paseo paseo ls      # confirm Paseo sees all three
   ```

   `gh` writes to `$XDG_CONFIG_HOME/gh` (`/home/paseo/.config/gh`), which is on the
   volume, so the login survives container recreation like the agent logins do.

5. **Add the Cloudflare public hostname** `paseo.example.com` → the host's `:6767` (same
   origin host as the existing `cc.example.com` → `:3001` route), duplicate the Access
   policy, and allow WebSockets.

To upgrade later, re-pull the stack in Portainer after CI publishes a new tag — the same
rebuild-to-upgrade model `claude-code` uses.

## Why the custom entrypoint

Paseo reads only `PASEO_PASSWORD`, and if it is missing the daemon starts **unauthenticated**,
logging a warning while still serving. Since this daemon is reachable over a public tunnel,
`entrypoint.sh` treats that as fatal and **fails closed** instead. It also bridges
`PASEO_PASSWORD_FILE` → `PASEO_PASSWORD` for deployments that mount the password as a file
rather than passing an env var (Paseo itself does not read the `_FILE` form). It then execs
the stock entrypoint unmodified, with `tini` still PID 1.

With the Portainer env-var approach the bridge is inert and the fail-closed check is what
matters — but it means switching to a mounted secret later needs no image change.

## Relay: disabled, deliberately

`PASEO_RELAY_ENABLED: "false"` is set in `../compose.yaml`. The default is `true`, so this
has to be explicit.

The relay is a second ingress: the daemon holds an **outbound** connection to Paseo's
servers, and clients meet it there. Cloudflare never sees that path, so Access does not
gate it — and on it, the daemon checks **neither** `PASEO_PASSWORD` **nor** `PASEO_HOSTNAMES`.
`attachExternalSocket` calls `attachSocket` directly, skipping `attachAuthenticatedSocket`,
and the resulting session gets `scopes: ["*"]` — a terminal as the daemon user and any file
that user can read. The E2EE handshake is the only authenticator.

As of Paseo 0.2.1 that handshake is bypassable. `crypto.ts` validates public-key *length*
only, and `deriveSharedKey` does not reject an all-zero scalarmult result — which tweetnacl
permits and libsodium does not. An all-zero client key yields the constant shared key
`351f86fa…bd7f91e` for any daemon secret (verified locally against tweetnacl 1.0.3). Anyone
holding the daemon's `serverId` — a cleartext relay query parameter that is written to relay
logs — can open a fully privileged session without the pairing link and without the password.

**Consequence:** the Android/iOS app cannot reach this daemon. The app cannot send custom
headers (React Native's WebSocket can, but Paseo's `defaultWebSocketFactory` drops them), so
it cannot satisfy Cloudflare Access with a service token either. Browser access over the
tunnel is unaffected.

Before re-enabling, confirm upstream rejects low-order points, and note that even fixed, a
pairing link is a non-expiring, individually-unrevocable bearer credential with no IdP check
on that path. The alternative that keeps mobile access is a Cloudflare private-network route
plus WARP on the phone, which puts the app on an authenticated path instead of a public one.

## Troubleshooting

**403 through the tunnel, but `http://<host-ip>:6767` works.** `PASEO_HOSTNAMES` is matched
against the `Host` header Paseo actually *receives*. If the cloudflared connector sets
`httpHostHeader`, it rewrites that header and Paseo rejects the request even though the route
is correct. Check the connector config — this is not a password problem.

**Healthcheck flapping.** The check hits `/api/health`. That endpoint is confirmed for 0.1.110;
if 0.2.x moved it, point the check at `/` instead.

**Terminal prompt is a bare `$` with no working directory.** `SHELL` is unset in the
container env, so Paseo's `env.SHELL || "/bin/sh"` falls back to dash. The Dockerfile sets
`ENV SHELL=/bin/bash` and compose passes `SHELL: /bin/bash`; if you see this again, check
that neither was dropped. Interactive bash setup (colour prompt, aliases, history, completion)
lives in `bashrc.sh` → `/etc/paseo-bashrc.sh`, sourced from `/etc/bash.bashrc`. It is
deliberately *not* a `~/.bashrc`: `/home/paseo` is a volume, so a home-directory file would be
masked on existing volumes and invisible to fresh ones.

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
