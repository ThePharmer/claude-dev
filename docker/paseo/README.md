# Paseo — standalone stack

Paseo daemon + web UI, running as its **own Compose stack** next to `claude-code`, reached
through the Cloudflare tunnel at `paseo.example.com`.

This stack briefly ran a second `t3code` service for a head-to-head evaluation. Paseo won;
the service and its image are gone. The scorecard is kept as a record of the reasoning in
`docs/t3-vs-paseo.md` — it is history, not a live comparison.

Paseo ships no agent of its own — it orchestrates whatever agent CLIs are on `PATH`, and it
runs them as **local subprocesses**. That's why this is a child image with Claude Code,
Codex and Pi baked in, rather than something that talks to the `claude-code` container.

- **`Dockerfile`** — `ghcr.io/getpaseo/paseo:0.2.5` plus the three agent CLIs, pinned to the
  same versions as `claude-code/Dockerfile`, plus `uv` and a managed Python (see below).
- **`entrypoint.sh`** — password-secret bridge; fails closed (see below).
- **`bashrc.sh`** — interactive-shell defaults for the web terminals; installed to
  `/etc/paseo-bashrc.sh` rather than a home directory (see troubleshooting).
- **`../compose.yaml`** — the stack itself, one level up, kept there from when it defined
  more than one service.

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
  that `-v` would still destroy *this* stack's own agent logins — so tear down without `-v`
  unless you mean to re-authenticate everything.

The only thing shared is the code: the `/srv` subtrees are bind-mounted at the **same
absolute paths** both containers use, so agent cwd, git worktree paths and absolute paths
stay consistent.

Note "subtrees", not `/srv` itself — `../compose.yaml` mounts a named list and nothing else,
so the rest of the host's `/srv` is not visible here. Because `/srv` itself is unmounted it is
an ephemeral overlay directory with those binds grafted underneath: **writes directly to
`/srv` are lost on container recreation**, which is why `working_dir` is `/srv/projects`.

## Setup (Portainer)

The image is **built by CI, not by the stack**. Portainer does not reliably build images from
a compose file — its docs state that "building images via docker-compose ... is not fully
implemented" — so there is deliberately no `build:` directive here.
`.github/workflows/docker-image.yml` publishes `ghcr.io/thepharmer/paseo-agents`.

1. **Wait for CI.** Pushing to `main` or `paseo` builds the image. Branch builds are tagged
   with the branch name; only `main` moves `:latest`.
2. **Create the stack** in Portainer from this repo, compose path `docker/compose.yaml`.
   **Name it `paseo`.** Compose namespaces volumes by project, so the volume resolves to
   `paseo_paseo-home` only under that name — renaming the stack silently creates an empty
   volume and the service comes up with no agent logins, no daemon keypair, and no
   downloaded speech models.
3. **Set the stack environment variables:**

   | Variable | Required | Notes |
   |---|---|---|
   | `PASEO_PASSWORD` | yes | High-entropy. Deploy fails immediately if unset. |
   | `PASEO_HOSTNAMES` | for tunnel | DNS name(s) Paseo is reached by. IPs and localhost are allowed by default. |
   | `PASEO_IMAGE_TAG` | no | Defaults to `latest`. Set to `paseo` to run the branch build. Also selects the relay image tag. |
   | `PASEO_RELAY_PUBLIC_ENDPOINT` | yes | `<label>.example.com:443`, the relay's tunnel hostname. Deploy fails if unset. Keep the label out of the repo; see "Relay" below. |

4. **Deploy**, then authenticate each agent once (persists on the `paseo-home` volume):

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

6. **Add the relay hostname** (no Access on it) and pair the phone. Steps are in the
   "Relay" section below.

To upgrade later, re-pull the stack in Portainer after CI publishes a new tag — the same
rebuild-to-upgrade model `claude-code` uses.

## Python and uv

The base image ships no interpreter, so the Dockerfile installs `uv` plus a managed CPython
(`PYTHON_VERSION`, currently 3.13) and symlinks `python3`/`python` into `/usr/local/bin`.

The thing to know before editing that block: **anything baked under `/home/paseo` is
invisible at runtime.** That path is a named volume, so a build-time write there is masked
the instant an existing volume mounts over it — the build passes, the image looks right, and
the file is simply gone on deploy. uv's defaults land squarely in that trap (interpreters
under `$XDG_DATA_HOME`, symlinks under `$XDG_BIN_HOME`, both pointed at `/home/paseo` by the
base). Hence the system install dir, and a build-time assert that fails if `python3` ever
resolves back under `/home/paseo`.

`UV_PYTHON_INSTALL_DIR` is deliberately **not** baked into the image env. Left unset at
runtime, an agent's own `uv python install` or `uv pip install` writes to `~/.local` on the
volume — no root needed, and it survives container recreation.

That persistence cuts both ways. The volume outlives image bumps too, so a package installed
at runtime sticks around indefinitely and no rebuild will ever reveal that the image doesn't
declare it. Only `down -v`, `docker volume rm`, or a stack rename clears it — at which point
a "working" dependency vanishes. Treat the runtime path as a scratchpad and **promote
anything load-bearing into the Dockerfile**, where the build asserts it.

## CLI tooling

The base image is minimal — `git`, `curl`, and not much else — so the Dockerfile installs the
everyday set: `ripgrep jq sqlite3 unzip zip less gnupg`, `vim nano tree rsync wget file htop`,
and `build-essential`. Sizes, measured against the bookworm index with
`--no-install-recommends`: 24 MB, 55 MB (`vim` is 39 MB of that), 253 MB.

`ripgrep` is the one people assume is already there. It isn't — Claude Code ships a vendored
copy and shims `rg` as a shell function, so the gap is invisible from inside an agent session
and only bites everything else.

On the Python side, `yt-dlp[default]` and `youtube-transcript-api` are installed with
`uv pip`, not apt. That is a correctness requirement, not a style choice: Debian's `python3-*`
packages target `/usr/lib/python3.11`, and **Debian's interpreter is not installed in this
image at all** — the packages would land where nothing can import them.

Two things that will bite whoever edits this next:

- **`--break-system-packages` is required, not copied cargo-cult from claude-code.** uv writes
  a PEP 668 `EXTERNALLY-MANAGED` marker into its *own* managed interpreters, so without the
  flag `uv pip install` refuses and the build dies. Verified against the pinned uv 0.11.32 and
  CPython 3.13.14. (This is the opposite of what you might assume — the flag reads like it
  only applies to distro Pythons.)
- **Console scripts need symlinking, exactly like `python3` did.** `uv pip` installs them into
  the managed interpreter's own `bin/`, which is not on `PATH`. Skip that and you get the
  confusing half-state where `import yt_dlp` works but `yt-dlp` is command-not-found. The
  build asserts both scripts exist rather than skipping a missing one.

The apt block must come *before* the `uv pip` block so `build-essential` is available if a
wheel ever needs building from source. Its position relative to the npm block is arbitrary —
nothing there invokes a compiler.

Deliberately **not** installed, each for a specific reason:

| | Why not |
|---|---|
| `openssh-server`, `mosh` | Each is a second ingress on a container reachable over a public tunnel. Paseo already has web terminals. |
| NodeSource `nodejs` | The base ships 22.23.1 and the Dockerfile asserts ≥22.19 for Pi. |
| apt `python3` | Would collide with the uv-managed 3.13 and its masking assert. |
| `cloudcli` | That is claude-dev's own web UI, which this stack replaces. |
| `ffmpeg` + `faster-whisper` | 449 MB / 189 packages (measured), and ~95 MB of wheels — 200-250 MB installed (estimated). ffmpeg exists in claude-code to extract audio for local transcription; with `faster-whisper` out, nothing here needs it. Caption and transcript extraction need neither. **Re-add them together or not at all.** |

## Passwordless sudo: granted, with the mounts narrowed to pay for it

The image gives `paseo` `NOPASSWD: ALL`. That is the dev-container default —
`devcontainers/features/common-utils` writes the identical line for every non-root user it
creates, so every `mcr.microsoft.com/devcontainers/*` image has it — and `claude-code` goes
further still, running as root outright via `user: root`.

What it actually buys an attacker who already has code execution as uid 1000:

| | uid 1000 (before) | root (with sudo) |
|---|---|---|
| Agent logins, `gh` token, all of `/srv/projects` | already exposed | same |
| `0600` files on rw bind mounts | blocked | **readable** (`DAC_OVERRIDE`) |
| setuid-root binaries on the host fs | blocked | **possible** via rw bind mount — the one real container→host path |
| Raw sockets on the docker bridge | blocked | **`NET_RAW`** |
| Host root directly | no | still no — no `docker.sock`, no `--privileged`, no `SYS_ADMIN`, seccomp on |

The trade is only reasonable because the mount list is narrow. A whole-tree `/srv` mount
would put every root-owned, mode-0600 file on the host within reach of that grant; the
container now sees five named subtrees instead, three of them `:ro`.

**If the mount list ever grows back toward `/srv:/srv`, revisit the sudo grant.** The two
decisions are coupled; neither is safe to change alone.

## Why the custom entrypoint

Paseo reads only `PASEO_PASSWORD`, and if it is missing the daemon starts **unauthenticated**,
logging a warning while still serving. Since this daemon is reachable over a public tunnel,
`entrypoint.sh` treats that as fatal and **fails closed** instead. It also bridges
`PASEO_PASSWORD_FILE` → `PASEO_PASSWORD` for deployments that mount the password as a file
rather than passing an env var (Paseo itself does not read the `_FILE` form). It then execs
the stock entrypoint unmodified, with `tini` still PID 1.

With the Portainer env-var approach the bridge is inert and the fail-closed check is what
matters — but it means switching to a mounted secret later needs no image change.

## The manifest patch: why Access was bouncing `/manifest.json`

Paseo's prebuilt `index.html` emits a bare `<link rel="manifest" href="/manifest.json" />`.
The manifest is the **one subresource in the document that is fetched with credentials mode
`omit` by default** — even same-origin, and unlike the favicon, the stylesheet or any XHR.
Only `crossorigin="use-credentials"` on the link changes that.

Behind Cloudflare Access the consequence is not a single 401. The uncredentialed fetch never
sends `CF_Authorization`, so Access 302s it to the login domain; the redirect chain can
neither send the existing cookie nor store a new one, so it bounces until the browser's
redirect cap and fails. That is the redirect storm on every page load, and it is also why the
PWA never became installable — no manifest, no install prompt.

That last part matters beyond tidiness. The **installed PWA is the Android route**. Note the
blocker there is Access, not Paseo: the daemon takes its password over the WebSocket
subprotocol (`paseo.bearer.<password>`, `@getpaseo/client` daemon-client.js), so the native
app authenticates to the daemon fine — what it cannot do is send the `CF-Access-Client-Id` /
`CF-Access-Client-Secret` headers Access requires. On Android an installed PWA is a WebAPK
running in Chrome, so it shares Chrome's cookie jar and inherits the Access session instead.

The Dockerfile patches the tag in the shipped dist — the web UI is prebuilt, with no template
hook or config knob for the head. Notes for whoever touches it next:

- `use-credentials` puts the request in CORS mode, but the manifest is **same-origin**, so the
  CORS protocol does not apply and no `Access-Control-Allow-Origin` is needed. **Nothing
  changes on the Cloudflare side.**
- The build asserts the tag before and after. An upstream bump that changes that markup
  **fails the build** rather than quietly shipping without the fix.
- The `.br`/`.gz` siblings are regenerated purely for consistency. `web-ui.js` forces
  `acceptEncoding` to `undefined` for `index.html` (it injects the connection hint into the
  response body), so the precompressed variants are **never served for this file** today.
  Regenerating is free insurance if that ever changes.

## Relay: self-hosted, for the phone app

The stack runs its own copy of [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay)
as the `paseo-relay` service. The daemon holds an **outbound** connection to it over the
stack network; the phone meets it there through a second tunnel hostname. Traffic is
end-to-end encrypted between daemon and phone (NaCl box); the relay and Cloudflare forward
opaque frames.

Why a relay at all: the native app cannot pass **Cloudflare Access**. Access's only
non-browser mechanism is service-token headers on the WebSocket handshake, and the app has
no way to configure them (upstream issue #3151, discussion #3125). The relay path never
touches Access. Browser access over `paseo.example.com` is unchanged and still gated by Access.

### What protects the daemon on this path

Verified against Paseo 0.7.2 and paseo-relay `3fc41c9`:

- The daemon checks **neither** `PASEO_PASSWORD` **nor** `PASEO_HOSTNAMES` on relay
  sessions (`attachExternalSocket` calls `attachSocket` directly; sessions get owner
  scopes). The E2EE handshake is the only authenticator.
- The handshake needs the daemon's public key, which exists only in the pairing link
  (`serverId` + key + relay endpoint). A stranger who reaches the relay cannot derive the
  shared key; the daemon closes any connection whose first frame does not decrypt.
- The 0.2.1 all-zero-shared-key bypass is closed: `deriveSharedKey` rejects an all-zero
  scalarmult result, and the relay rejects low-order and malformed X25519 keys in `hello`
  frames before forwarding them.
- `serverId` is 9 random bytes (72 bits). Without it the relay answers `400`; with it and
  no key, the worst case is nuisance sockets bounded by the relay's capacity ledger.

**Consequence:** the pairing link is a non-expiring, owner-level bearer credential with no
IdP check. Treat the QR like the daemon password. Revocation is all-or-nothing: delete
`daemon-keypair.json` and `server-id` from the `paseo-home` volume, restart, re-pair every
phone.

### Cloudflare: add the relay hostname (dashboard)

Pick a random label so the WebSocket endpoint is not discoverable by guessing. Universal
SSL's wildcard covers it, so the label does not appear in Certificate Transparency. The
label lives only in the Portainer stack variable `PASEO_RELAY_PUBLIC_ENDPOINT`.

1. Zero Trust → Networks → Tunnels → your tunnel → **Public Hostname** → Add.
   Subdomain `<label>`, domain `example.com`, **Path** `^/ws`, service
   `HTTP` → `<host-ip>:4000` (same origin host as the `:6767` rule). Save.
2. Add a second rule for the same hostname with **no path** and service type
   `HTTP status` → `404`. Make sure the `^/ws` rule sorts **above** it. This keeps
   `/health`, `/ready` and `/metrics` LAN-only.
3. Do **not** create an Access application for this hostname. Check that no existing
   wildcard Access app (`*.example.com`) covers it; if one does, add a path-scoped
   Bypass for `<label>.example.com/ws`.
4. Optional: Security → WAF → Rate limiting rules: hostname equals `<label>.example.com`,
   10 requests per 10 seconds per IP, block. The relay has its own capacity ledger; this is
   belt and braces against scanners.

### Deploy, verify, pair

1. Set `PASEO_RELAY_PUBLIC_ENDPOINT=<label>.example.com:443` in the stack, re-pull, update.
2. From the host:

   ```bash
   curl -s http://127.0.0.1:4000/ready                                 # 200
   curl -s -o /dev/null -w '%{http_code}\n' https://<label>.example.com/ready   # 404 (catch-all)
   docker logs paseo 2>&1 | grep relay_control_connected               # daemon reached the relay
   ```

3. Pair the phone:

   ```bash
   docker exec -it --user paseo paseo paseo daemon pair
   ```

   It prints a QR and link carrying `<label>.example.com:443` with TLS on (the public
   endpoint, not the stack-internal one). Scan it with the Paseo app.
4. Open the host from the phone on mobile data, then confirm both sockets from the host:

   ```bash
   curl -s http://127.0.0.1:4000/metrics | grep -i active
   ```

### Upgrading the relay

The image is built from `../paseo-relay/Dockerfile`, which pins an upstream commit. Bump
`PASEO_RELAY_REF` (and the base image tags, copied from upstream's Dockerfile at that
commit), push, wait for CI, re-pull the stack. The pairing does not change across relay
upgrades; keypair and `server-id` live on the volume.

### Rollback

Set `PASEO_RELAY_ENABLED` to `"false"`, remove the `paseo-relay` service and the
`depends_on`, redeploy. Paired phones stay valid for a later re-enable.

## Troubleshooting

**403 through the tunnel, but `http://<host-ip>:6767` works.** `PASEO_HOSTNAMES` is matched
against the `Host` header Paseo actually *receives*. If the cloudflared connector sets
`httpHostHeader`, it rewrites that header and Paseo rejects the request even though the route
is correct. Check the connector config — this is not a password problem.

**Healthcheck flapping.** The check hits `/api/health`. Confirmed live on 0.2.1 — it returns
200 with `{"status":"ok","timestamp":…}`. If a later bump moves it, point the check at `/`.

**Terminal prompt is a bare `$` with no working directory.** `SHELL` is unset in the
container env, so Paseo's `env.SHELL || "/bin/sh"` falls back to dash. The Dockerfile sets
`ENV SHELL=/bin/bash` and compose passes `SHELL: /bin/bash`; if you see this again, check
that neither was dropped. Interactive bash setup (colour prompt, aliases, history, completion)
lives in `bashrc.sh` → `/etc/paseo-bashrc.sh`, sourced from `/etc/bash.bashrc`. It is
deliberately *not* a `~/.bashrc`: `/home/paseo` is a volume, so a home-directory file would be
masked on existing volumes and invisible to fresh ones.

**Permissions on `/srv`.** Paseo is fixed at uid/gid 1000 and the mounted `/srv` subtrees are
already owned by 1000, matching `claude-code`. Don't run `claude-code` with `USER_UID != 1000`
— it would rewrite ownership out from under this container.

**"Read-only file system" writing to documents/calibre/media.** Working as intended — those
three are mounted `:ro`. `sudo` will not help: read-only is a kernel mount flag and lifting it
needs `CAP_SYS_ADMIN`, which is not in Docker's default capability set. If you genuinely need
to write there, change the mount in `../compose.yaml`.

## Verify on upgrade

- Re-check the base image's env layout after a `FROM` bump; this design depends on every agent
  config path resolving under `/home/paseo`.
- The Dockerfile asserts Node `>=22.19.0` at build time (Pi's floor). If upstream moves to
  Node 24, drop the assert's lower bound rather than pinning an old base.
- Re-check the `XDG_*` paths specifically. If a base bump moves `XDG_DATA_HOME` off
  `/home/paseo`, the Python block's masking assert still passes but its reasoning no longer
  applies; if it moves *onto* a new volume path, the assert is what will catch it.
- Keep the agent pins here in sync with `claude-code/Dockerfile` so both surfaces run the same
  builds. Drift is safe (state is isolated) but confusing.
