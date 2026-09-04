# Self-hosted Paseo relay on the Portainer stack

Status: plan, not yet applied. Written 2026-09-03 against Paseo v0.7.2 and
getpaseo/paseo-relay main (3fc41c9, 2026-08-22).

Goal: the phone app reaches the daemon with nothing installed on the phone and
nothing routed through Paseo's own relay, while the web UI keeps its Cloudflare
Access gate. Long term, restore custom direct-connection headers upstream so
the relay becomes optional (see part 2).

## 1. What the relay actually is

- The production relay is **getpaseo/paseo-relay**, an Elixir/OTP release. The
  Cloudflare Worker under `packages/relay` in the monorepo is legacy and not
  deployed (docs/architecture.md line 173). Do not try to run the Worker.
- It listens on plain HTTP/WebSocket on `PASEO_RELAY_PORT` (default 4000). TLS
  is expected to be terminated in front of it. The daemon dials it with the
  `ws` library, so a plaintext hop inside Docker is supported.
- Endpoints: `/ws` (the relay protocol, v1 and v2), `GET /health` (liveness),
  `GET /ready` (readiness, 503 while draining), `GET /metrics` (Prometheus).
  Only `/ws` should be reachable from the internet.
- Upstream publishes **no container image**. Its CI builds one from the repo's
  Dockerfile but never pushes it. The community image
  `ghcr.io/mtaku3/paseo-relay:7e52c8c...` is pinned to 2026-08-05, which is
  before the 2026-08-22 "improve handshake input handling" fix. Build your own.
- Single node is a supported configuration. `PASEO_RELAY_MIN_CLUSTER_SIZE`
  defaults to 1 and `RELEASE_COOKIE` may stay unset.
- Security facts that matter here, all verified in v0.7.2 source:
  - Relay sessions bypass `PASEO_PASSWORD` and `PASEO_HOSTNAMES`
    (`websocket-server.ts` line 971, `attachExternalSocket` calls
    `attachSocket` directly). The pairing link is the credential.
  - The all-zero shared-key bypass from the 0.2.1 analysis is closed
    (`packages/relay/src/crypto.ts` line 143 rejects it), and the relay itself
    rejects non-canonical X25519 keys in `hello` / `e2ee_hello` frames.
  - Revocation is all-or-nothing: delete `$PASEO_HOME/daemon-keypair.json`
    and `$PASEO_HOME/server-id`, restart, re-pair every device.

## 2. Target topology

```
phone app  --wss--> Cloudflare edge --tunnel--> cloudflared --http--> host:4000 (paseo-relay)
                                                                            ^
paseo daemon --ws (docker network, plaintext)-------------------------------+

browser --https--> Cloudflare Access --tunnel--> cloudflared --http--> host:6767 (paseo)  [unchanged]
```

- The daemon uses the **private** endpoint `paseo-relay:4000`, no TLS.
- The pairing QR advertises the **public** endpoint `<label>.thepharmer.dev:443`
  with TLS. Paseo separates these on purpose (`PASEO_RELAY_PUBLIC_ENDPOINT`,
  `PASEO_RELAY_PUBLIC_USE_TLS`, config.ts lines 300-318).
- No Access application on the relay hostname. The phone cannot pass Access,
  and the relay's own protocol is the gate.

Assumption to confirm (question 1 in the chat): cloudflared is the existing
central tunnel in its own stack and reaches services by host IP and published
port, as README step 5 describes for `:6767`. If it instead joins a shared
Docker network, drop the published port and attach the relay to that network.

## 3. Repo changes

### 3a. Image: `docker/paseo-relay/Dockerfile`

A thin wrapper that mirrors upstream's Dockerfile but fetches a pinned commit,
so the existing content-tag scheme in `.github/workflows/docker-image.yml`
works unchanged (the tag is the tree hash of `docker/paseo-relay`). Bump the
pin to upgrade.

```dockerfile
# Builds getpaseo/paseo-relay at a pinned commit. Upstream publishes no image.
ARG PASEO_RELAY_REF=3fc41c96c8c63f3a7109e832899cc57d473c4531
FROM hexpm/elixir:1.20.2-erlang-29.0.2-debian-bookworm-20260623-slim AS build
ARG PASEO_RELAY_REF
WORKDIR /app
ENV MIX_ENV=prod
ADD https://github.com/getpaseo/paseo-relay/archive/${PASEO_RELAY_REF}.tar.gz /tmp/src.tar.gz
RUN tar -xzf /tmp/src.tar.gz --strip-components=1 -C /app \
 && mix local.hex --force && mix local.rebar --force \
 && mix deps.get --only prod && mix compile && mix release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 libsctp1 openssl ca-certificates \
 && rm -r /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/_build/prod/rel/paseo_relay ./
ENV HOME=/app PASEO_RELAY_HOST=0.0.0.0 PASEO_RELAY_PORT=4000 PASEO_RELAY_DRAIN=false
EXPOSE 4000
ENTRYPOINT ["/app/bin/paseo_relay"]
CMD ["start"]
```

Check the exact base image tag against upstream's Dockerfile when pinning; it
moves with their Elixir/Erlang upgrades.

### 3b. Workflow: third image `paseo-relay`

In `docker-image.yml`, extend `plan` with a `relay` content tag
(`git rev-parse HEAD:docker/paseo-relay`), add it to the "which images exist"
loop, and copy the `paseo-agents` job as `paseo-relay` with
`context: ./docker/paseo-relay`. Smoke test:

```bash
docker run -d --name relay-smoke -p 4000:4000 "$IMAGE"
for i in $(seq 1 30); do curl -fs http://127.0.0.1:4000/ready && break; sleep 1; done
docker stop relay-smoke && docker container prune -f --filter label=none
```

### 3c. Stack: `docker/compose.yaml`

Add a service in the same stack so the daemon reaches it by service name.

```yaml
  paseo-relay:
    image: ghcr.io/thepharmer/paseo-relay:${PASEO_IMAGE_TAG:-latest}
    container_name: paseo-relay
    restart: unless-stopped
    ports:
      - "4000:4000"           # cloudflared reaches it at <host>:4000, like :6767
    environment:
      PASEO_RELAY_HOST: 0.0.0.0
      PASEO_RELAY_PORT: "4000"
      # README: generic operators should set a watermark from the runtime limit.
      PASEO_RELAY_MEMORY_WATERMARK_BYTES: "402653184"   # 384 MiB of a 512 MiB cap
    mem_limit: 512m
    stop_grace_period: 30s
    healthcheck:
      # Runtime image has bash but no curl; /dev/tcp is enough for /ready.
      test:
        - CMD
        - bash
        - -c
        - 'exec 3<>/dev/tcp/127.0.0.1/4000; printf "GET /ready HTTP/1.0\r\n\r\n" >&3; head -n1 <&3 | grep -q " 200 "'
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

Daemon service changes:

```yaml
    environment:
      PASEO_RELAY_ENABLED: "true"
      PASEO_RELAY_ENDPOINT: paseo-relay:4000
      PASEO_RELAY_USE_TLS: "false"
      PASEO_RELAY_PUBLIC_ENDPOINT: ${PASEO_RELAY_PUBLIC_ENDPOINT:-<label>.thepharmer.dev:443}
      PASEO_RELAY_PUBLIC_USE_TLS: "true"
    depends_on:
      paseo-relay:
        condition: service_healthy
```

Keeping `PASEO_RELAY_ENABLED` as an env override is deliberate: it makes the
setting declarative in Portainer. The cost is that `paseo daemon pair` cannot
toggle relay at runtime, which does not matter because it is already on; the
pair command only prompts when relay is off (`pair.ts` line 130).

Rewrite the comment block above `PASEO_RELAY_ENABLED`. Its two load-bearing
claims (bypassable handshake, relay invisible to you) are stale on 0.7.2 with
a self-hosted relay. Keep the claims that still hold: no password or hostname
check on this path, pairing link is a non-expiring bearer credential.

### 3d. README `docker/paseo/README.md`

- Replace the "Consequence: the Android/iOS app cannot get past Cloudflare
  Access" paragraph with the relay path.
- Add a "Pairing a phone" runbook (section 5 below) and the revocation
  procedure.
- Add `PASEO_RELAY_PUBLIC_ENDPOINT` to the stack variables table.

## 4. Cloudflare changes (dashboard only)

1. DNS: `<label>.thepharmer.dev` is created by the tunnel public hostname rule;
   no manual record.
2. Zero Trust, Networks, Tunnels, your tunnel, Public Hostname:
   - `<label>.thepharmer.dev`, path `^/ws`, service `http://<host-ip>:4000`.
   - Below it a catch-all for `<label>.thepharmer.dev` with service
     `http_status:404`, so `/health`, `/ready`, `/metrics` never leave the LAN.
   - WebSockets are on by default for tunnel origins; nothing to toggle.
3. Do **not** create an Access application for this hostname. Confirm no
   wildcard Access app on `*.thepharmer.dev` already covers it.
4. Optional: a WAF rate-limiting rule on `<label>.thepharmer.dev` keyed on IP.
   The relay has its own capacity ledger, so this is belt and braces.

## 5. Deploy and pair

1. Merge the repo changes to `paseo`, wait for CI to publish
   `ghcr.io/thepharmer/paseo-relay:paseo`.
2. Portainer: set `PASEO_RELAY_PUBLIC_ENDPOINT` if not using the default,
   re-pull and update the `paseo` stack. Never `-v`.
3. Verify from the host:

```bash
curl -s http://127.0.0.1:4000/ready                   # 200 with a small JSON body
curl -s -o /dev/null -w '%{http_code}\n' https://<label>.thepharmer.dev/ready   # expect 404 (catch-all)
docker logs paseo 2>&1 | grep relay_control_connected # daemon reached the relay
```

4. Pair the phone:

```bash
docker exec -it --user paseo paseo paseo daemon pair
```

   Scan the QR with the Paseo app. The offer carries
   `<label>.thepharmer.dev:443` with TLS on (`pairing-offer.ts` lines 34-37),
   and the app honours a custom endpoint (`pair-scan.tsx` line 183).
5. From the phone, on mobile data, open the host. Then check
   `curl -s http://127.0.0.1:4000/metrics | grep -i active` on the host to see
   the client and daemon sockets.

## 6. Rollback

Set `PASEO_RELAY_ENABLED=false` on the daemon and remove the relay service.
The daemon keypair and server-id stay on the volume, so re-enabling later does
not invalidate paired phones.

## 7. Residual risk, stated plainly

- Anyone holding the pairing link has owner-level access with no password and
  no IdP. Treat the QR like the daemon password.
- The relay hostname is public and unauthenticated by design. What protects the
  daemon is the E2EE handshake against its keypair, plus the fact that a
  stranger who guesses a `serverId` still cannot complete the handshake.
- `serverId` and connection metadata land in your relay's logs. Contents do
  not; the relay is zero-knowledge.
- Cloudflare still terminates TLS, but sees only NaCl-boxed frames on this path.

---

# Part 2: the upstream PR for direct-connection headers

Why it matters: with headers restored, the phone could use the existing
Access-protected hostname with a Service Auth policy and the relay becomes a
convenience rather than a requirement.

## History (verified)

- PR #2922 (merged 2026-08-06, +1190/-125, 38 files) added header rows under
  Direct connection, Advanced, plus an Electron main-process WebSocket bridge
  so Node could attach handshake headers.
- Issue #3067: that bridge broke macOS LAN connections because the main
  process hits Local Network privacy (`EHOSTUNREACH`) and sends no Origin.
- PR #3071 (merged 2026-08-09) reverted the whole feature. Open PR #3068 is an
  alternative macOS fix that was superseded.
- Issue #3151 (yours, open, p2, triaged) documents the separate Android probe
  bug. Discussion #3125 (yours) proposes the restore. **Zero comments on
  either after three weeks.** CONTRIBUTING says unsolicited PRs can be closed
  without review and discussion-approved ones are preferred.

## Two possible scopes

**A. Native-only headers (recommended first PR).** Headers apply on iOS and
Android only. Electron and browser web keep the renderer WebSocket and hide
the header rows. No main-process bridge, so #3067 cannot recur by
construction. Touch points in v0.7.2:

- `packages/protocol/src/host-connection-schema.ts`: optional
  `headers: Record<string,string>` on `DirectTcpHostConnectionSchema`.
- `packages/client/src/daemon-client.ts` around line 1201: merge
  `config.headers` before the password sets `Authorization` (password wins,
  matching #2922's stated precedence).
- `packages/app/src/utils/test-daemon-connection.ts` line 166: pass headers
  and add `webSocketFactory: createAppWebSocketFactory()`. This is the
  one-line Android fix from #3151.
- `packages/app/src/runtime/host-runtime.ts` line 541: pass headers.
- `packages/app/src/components/add-host-modal.tsx`: header rows, shown only
  when `Platform.OS` is `ios` or `android`. Reuse `connection-headers.ts`
  validation from #2922 (`git show <merge sha>:packages/app/src/utils/connection-headers.ts`).
- i18n: `en.ts` plus the eight other resource files #2922 touched.
- Tests: a probe test asserting the native factory receives the headers (the
  test that would have caught #3151), a host-runtime test, a client test for
  Authorization precedence. Keep #3071's "Direct TCP must not use the desktop
  bridge" test untouched.

**B. Full restore with gated bridge.** Revert the revert, then use the
Electron bridge only when headers are configured. Larger, reintroduces the
bridge code the maintainer just removed, and needs macOS QA on both LAN and
headered paths. Only worth it if the maintainer asks for desktop parity.

## Sequence

1. Get a signal before writing code: post a two-line ping in Discord
   `#product` linking #3125, and offer scope A explicitly. A "yes" there is
   the "explicitly approved in a discussion" that CONTRIBUTING prefers.
2. Branch from `main`, keep it to scope A, open as **draft** early so the
   checks and bot review run.
3. QA evidence the maintainer requires: shell output of the curl 302/101 pair
   from #3151, the new tests' output, Android screenshots of the header rows
   and a successful connect through Access, and an explicit "iOS untested" if
   that is the case. Enable maintainer edits.
4. Point the PR at #3151 (bug) and #3125 (discussion) in the body.

Build note: an Android QA build needs the Expo toolchain from
`packages/app`; check `docs/` in the monorepo for the release build steps
before promising screenshots.

## Decisions (2026-09-03)

- cloudflared is the central tunnel in its own stack and reaches services by host IP
  and published port. The relay publishes 4000 like the daemon publishes 6767.
- The relay hostname is a random label under thepharmer.dev, held only in the Portainer
  variable `PASEO_RELAY_PUBLIC_ENDPOINT`. Repo and README use `<label>`.
- Relay lives in the `paseo` stack (same compose file).
- Image built by the existing `docker-image.yml` workflow on the `paseo` branch, as a
  third image `ghcr.io/thepharmer/paseo-relay`.
- Phone: Android, moving from the PWA to the 0.7.2 native app once the relay is up.
- Cloudflare dashboard changes are done by hand from the README runbook.
- PR scope: native-only headers (iOS/Android), no Electron bridge.
- Android QA evidence: GitHub Actions in the ThePharmer/paseo fork builds the APK
  (the fork's `ci/build-apk-on-github` branch already has a non-EAS build) and runs
  Maestro on an emulator for screenshots. The real Access connect test needs the APK
  sideloaded on the phone.

Status: sections 3a to 3d are applied in the repo (Dockerfile, workflow job, compose
service and daemon env, README runbook). Section 4 is now the README's "Relay" section.

## Outcome (2026-09-03, evening)

- Draft PR opened upstream: https://github.com/getpaseo/paseo/pull/4290
  (branch `feat/native-direct-connection-headers` on the ThePharmer fork, one commit).
- Android emulator evidence, green run: https://github.com/ThePharmer/paseo/actions/runs/33818465141
  (workflow `native-headers-qa.yml` on the fork's `qa/native-headers-android` branch).
  A stock 0.7.2 daemon behind a header-gating proxy: header-less handshake rejected,
  header-carrying handshake accepted, daemon session attached, home screen reached.
- Screenshots and gate log: fork branch `pr-assets/native-headers`.
- Tests: protocol 640, client 144, app 4933 passed; one app file
  (`use-agent-history.test.ts`) fails identically on upstream main. Typecheck, lint,
  format clean.
- Pending for a human: sideload the QA APK (artifact of run 33793518962; debug-signed,
  uninstall any store build first) and connect through the real Access service-token
  policy; then update the PR body. iOS untested.
- Relay image published as ghcr.io/thepharmer/paseo-relay:paseo; Portainer variable and
  Cloudflare hostname rule still to be applied by hand per the README.

## Decision (2026-09-04)

Relay on hold. The Android QA APK connects to paseo.thepharmer.dev through Cloudflare Access
with the two service-token headers and is rejected without them (phone screenshots on PR 4290).
The relay stack is parked on the `relay` branch of this repo; `paseo` carries the pre-relay
compose again. Next: a fork workflow that rebuilds the header-patched APK for each upstream
release until the PR merges.
