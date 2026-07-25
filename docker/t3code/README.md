# T3 Code — evaluation stack

[T3 Code](https://github.com/pingdotgg/t3code) daemon + web UI, running as a **service inside
the `paseo` stack**, reached through the Cloudflare tunnel at `t3.example.com`.

This exists to answer one question: **Paseo or T3 Code?** Both are minimal web GUIs that
orchestrate agent CLIs as local subprocesses; neither ships an agent. So this stack is built
to make the comparison fair rather than to be a permanent deployment — see
[`docs/t3-vs-paseo.md`](../../docs/t3-vs-paseo.md) for the scorecard.

- **`Dockerfile`** — `ghcr.io/thepharmer/paseo-agents` plus `t3`, pinned.
- **`entrypoint.sh`** — refuses to start on an unreachable bind; see below.
- **`../compose.yaml`** — the shared stack, one level up. T3 Code is a service inside the
  `paseo` stack, not a stack of its own; this directory is only the build context.

## Why it is built on paseo-agents

T3 Code needs the same provider CLIs Paseo needs, at the same versions, with the same config
paths. Building `FROM paseo-agents` gets all three for free and makes pin drift structurally
impossible: there is exactly one place claude/codex/pi versions are declared
(`docker/paseo/Dockerfile`), and this image inherits it.

The base also already resolves every agent config path under `/home/paseo`
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_*`), which is what makes the shared-credential
model below need no wiring at all.

The one cost: CI must build this **after** `paseo-agents` on the same commit. That is why
it lives in a separate `build-derived` job rather than the build matrix.

## Shared credentials: DELIBERATE (unlike the paseo stack)

The `paseo` stack was designed to share **nothing** with `claude-config`. This stack
deliberately breaks that rule *in one direction only*: it mounts the same `paseo_paseo-home`
volume, so T3 Code and Paseo drive the **same** Claude and Codex logins, the same session
history, and the same `/srv` checkout.

That is the whole point. A head-to-head where one tool has a fresher login, a different agent
build, or a different working tree tells you nothing about the tools.

What stays isolated: **claude-dev**. Neither container can read `claude-config`, the `gh`
token, or the cloudcli auth DB. The blast-radius argument from the paseo README is unchanged.

**The caveat this buys.** Both containers write `/home/paseo/.claude/.credentials.json` and
`/home/paseo/.codex/`. When an OAuth token refreshes in both at once, it is last-write-wins.
Claude Code tolerates concurrent instances on a normal workstation, so this is not exotic —
but it is a real race, and if you see a spurious re-login prompt in one UI, this is the first
thing to suspect rather than a bug in either tool.

T3 Code's own state is kept at `/home/paseo/.t3code` (`T3CODE_HOME`), beside Paseo's
`~/.paseo`. The two never write the same files.

## Authentication

T3 Code has **no password variable**. It derives its posture from the host it binds
(`src/auth/EnvironmentAuthPolicy` in the shipped bundle):

```
isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host)
policy = isRemoteReachable ? "remote-reachable" : "loopback-browser"
```

Bound to `0.0.0.0` as this stack does, it reports `remote-reachable`, which gates access
behind one-time pairing tokens (`t3 auth pairing`) or scoped bearer sessions
(`t3 auth session`). It does **not** fail open the way an unconfigured Paseo does, so this
image needs no equivalent of Paseo's password-bridge entrypoint.

> **Trust boundary.** That policy logic is read from the shipped bundle, not verified
> end-to-end against a live server. Treat **Cloudflare Access as the load-bearing control**
> and t3's pairing as defence in depth. See "Verify on first deploy" below.

## Setup (Portainer)

T3 Code is a **service inside the `paseo` stack**, not a stack of its own — both UIs share
one volume so they drive the same agent logins, and folding them into one Compose project
is what lets them reference `paseo-home` directly instead of hardcoding an external volume
name. Deploy instructions live in `docker/paseo/README.md`; this file covers T3 Code itself.

The image is **built by CI, not by the stack**, for the same reason the paseo image is.
`.github/workflows/docker-image.yml` publishes `ghcr.io/thepharmer/t3code-agents`.

1. **Wait for CI.** Pushing to `t3-paseo-test` builds and tags the image `:t3-paseo-test`.
   Only `main` moves `:latest`, and this branch is not meant to be merged unless T3 Code wins.
2. **Deploy the `paseo` stack** (compose path `docker/compose.yaml`) — it brings up
   both `paseo` and `t3code`. Keep the stack named `paseo`: Compose namespaces volumes by
   project, so renaming it creates an empty `paseo-home` and both services come up with no
   agent logins.
3. **Set the stack environment variables:**

   | Variable | Required | Notes |
   |---|---|---|
   | `T3CODE_IMAGE_TAG` | no | Defaults to `t3-paseo-test`. |

   No password variable, by design — see Authentication above.

5. **Deploy**, then issue a pairing token and open the UI:

   ```bash
   docker exec -it t3code t3 auth pairing create    # one-time client pairing token
   docker exec -it t3code t3 auth pairing list      # active tokens, secrets not revealed
   docker exec -it t3code t3 auth pairing revoke    # revoke one token
   ```

   The subcommand is `create`, not `issue` (confirmed against t3 0.0.28 — `issue` errors
   with "Unknown subcommand"). No `-u` flag is needed: the image sets `USER paseo`, unlike
   the paseo image which starts as root and drops privileges in its entrypoint.

   For scoped bearer tokens aimed at API clients there is a parallel `t3 auth session`
   group (`list` and `revoke` are confirmed present in the bundle; the create verb is not
   — run `t3 auth session --help` to confirm before relying on it).

   Agent logins are already on the volume from the paseo stack — there is no
   `claude`/`codex` login step here. Confirm with:

   ```bash
   docker exec -it t3code claude --version
   docker exec -it t3code codex --version
   ```

6. **Add the Cloudflare public hostname** `t3.example.com` → the host's `:3773` (same origin
   host as the existing `paseo.example.com` → `:6767` route), duplicate the Access policy,
   and allow WebSockets.

## Verify on first deploy

Before trusting the tunnel route, confirm the pairing gate is real rather than assumed:

```bash
# From the host, bypassing Cloudflare Access - should NOT return a usable session.
curl -si http://127.0.0.1:3773/api/ | head -20
```

If an unauthenticated request to an API route returns data rather than 401/403, then the
policy logic does not behave as read, and Cloudflare Access is the *only* thing protecting
this container. Fix that before adding the public hostname.

## Upgrading t3 during the evaluation

T3 Code is at `0.0.x` and shipping fast. The image pins a version like every other agent
here, but you can test a new release in place without a CI round-trip:

```bash
docker exec -u root -it t3code npm i -g t3@latest
docker restart t3code
docker exec t3code t3 --version
```

This is why the build toolchain stays in the image: `node-pty` has **no Linux prebuild** and
compiles from source on every install, so an upgrade without `build-essential` + `python3`
present would fail.

The change is lost on the next stack re-pull, which is the intended behaviour — if a version
is worth keeping, bump `T3_VERSION` in the Dockerfile and let CI build it.

## Troubleshooting

**Container exits immediately with `FATAL: T3CODE_HOST is not set`.** Working as designed.
T3 Code defaults to binding `127.0.0.1`, which would make the published port and the tunnel
route both dead ends. Set `T3CODE_HOST=0.0.0.0`.

**Stack fails to deploy with a missing-volume error.** The `paseo` stack has not been
deployed, or Portainer namespaced its volume differently. Check the real name:

```bash
docker volume ls | grep -i paseo
```

and update `name:` in `compose.yaml` if it is not `paseo_paseo-home`.

**Spurious re-login prompts in Paseo or T3 Code.** Suspect the shared-credential race
described above before suspecting either tool.

**Healthcheck flapping.** The check accepts any status below 500, because a wildcard-bound
server may answer an unauthenticated probe with 401/403. If it flaps anyway, exec in and
check what `/` actually returns.

## Teardown

```bash
docker compose -f docker/compose.yaml stop t3code
```

**Never with `-v`.** The volume belongs to the paseo stack; `-v` on a shared external volume
is how you delete Paseo's agent logins by accident. Removing this stack in Portainer is safe
— external volumes are not removed with the stack.
