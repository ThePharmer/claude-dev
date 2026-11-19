# pharm-dev

Container images for a self-hosted [Paseo](https://github.com/getpaseo/paseo) setup: the Paseo
daemon and web UI with Claude Code, Codex and Pi baked in, plus an optional self-hosted relay.

Originally forked from [nezhar/claude-container](https://github.com/nezhar/claude-container).

## Images

| Image | Built from | What it is |
|---|---|---|
| `ghcr.io/thepharmer/pharm-dev` | `docker/paseo/` | Paseo on `ghcr.io/getpaseo/paseo`, with pinned agent CLIs, `uv`, a managed Python and the usual dev tools. Deployed as a Portainer stack from `docker/compose.yaml`. |
| `ghcr.io/thepharmer/paseo-relay` | `docker/paseo-relay/` | [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) at a pinned commit. Upstream publishes no image. Not deployed on `main`; see the `relay` branch and `docs/self-hosted-relay.md`. |

Setup, credentials, security profiles and troubleshooting are in
[`docker/paseo/README.md`](docker/paseo/README.md).

## CI

`.github/workflows/docker-image.yml` builds both images.

- A push to `main` publishes `:latest`, the commit SHA and a `ctx-<hash>` content tag.
- Other branches build only when run manually (`gh workflow run docker-image.yml --ref <branch>`)
  and are tagged with the branch name.
- An image is rebuilt only when its build folder changes. Otherwise CI points the new tags at
  the existing image. The manual run's `rebuild` input forces a full build.

## Repo layout

```
docker/compose.yaml     The Paseo stack (Portainer)
docker/paseo/           pharm-dev image: Dockerfile, entrypoint, security profiles
docker/paseo-relay/     paseo-relay image
docs/                   Relay runbook and design notes
```
