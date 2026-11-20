# pharm-dev

The container image for a self-hosted [Paseo](https://github.com/getpaseo/paseo) setup: the
Paseo daemon and web UI with Claude Code, Codex and Pi baked in.

Originally forked from [nezhar/claude-container](https://github.com/nezhar/claude-container).

## Image

`ghcr.io/thepharmer/pharm-dev`, built from `docker/paseo/`: Paseo on `ghcr.io/getpaseo/paseo`,
with pinned agent CLIs, `uv`, a managed Python and the usual dev tools. Deployed as a Portainer
stack from `docker/compose.yaml`.

The optional self-hosted relay is not built here. `docker/compose.relay.yaml` adds it on top of
the stack using upstream's published `ghcr.io/getpaseo/paseo-relay` image, pinned by digest; see
`docs/self-hosted-relay.md`.

Setup, credentials, security profiles and troubleshooting are in
[`docker/paseo/README.md`](docker/paseo/README.md).

## CI

`.github/workflows/docker-image.yml` builds the image.

- A push to `main` publishes `:latest`, the commit SHA and a `ctx-<hash>` content tag.
- Other branches build only when run manually (`gh workflow run docker-image.yml --ref <branch>`)
  and are tagged with the branch name.
- The image is rebuilt only when `docker/paseo/` changes, not counting its Markdown docs.
  Otherwise CI points the new tags at the existing image. The manual run's `rebuild` input forces a full build.

## Repo layout

```
docker/compose.yaml         The Paseo stack (Portainer)
docker/compose.relay.yaml   Opt-in self-hosted relay, layered on top
docker/paseo/               pharm-dev image: Dockerfile, entrypoint, security profiles
docs/                       Relay runbook and design notes
```
