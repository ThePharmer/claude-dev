# Paseo sidecar

A separate multi-agent orchestration surface (Paseo daemon + web UI) that runs alongside
`claude-code` in the same compose stack, reached via the Cloudflare tunnel at
`paseo.example.com`.

- **`Dockerfile`** — the official `ghcr.io/getpaseo/paseo` image plus the agent CLIs we
  orchestrate (Claude Code, Codex, Pi), pinned to match the versions baked into
  `claude-code`. Build via the `paseo` service in `claude-code/compose.yml`.
- **State + creds** live on the `paseo-home` volume (`/home/paseo`), independent of
  `claude-code`'s `/claude`. This is the SEPARATE-credentials model: log in once per agent
  inside the container:
  ```bash
  docker exec -it -u paseo paseo claude
  docker exec -it -u paseo paseo codex
  docker exec -it -u paseo paseo pi
  ```
  See the comment block in `claude-code/compose.yml` for the shared-`/claude` alternative
  and its trade-offs.

## Setup checklist

1. Create the password secret on the host (not committed):
   ```bash
   install -d -m 700 /opt/claude-dev/secrets
   openssl rand -base64 32 > /opt/claude-dev/secrets/paseo_password
   chmod 600 /opt/claude-dev/secrets/paseo_password
   ```
2. `docker compose -f claude-code/compose.yml up -d --build paseo`
3. In Cloudflare Zero Trust, add a public hostname `paseo.example.com` →
   `http://paseo:6767`, and duplicate the `cc.example.com` Access policy (allow
   WebSockets). Keep `PASEO_PASSWORD` — the static UI is public; API/WS auth needs it.
4. Log in to each agent (step above), then confirm providers appear with `paseo ls`.
