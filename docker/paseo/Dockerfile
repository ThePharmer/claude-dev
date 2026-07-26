# Paseo daemon + web UI, run as its own standalone stack alongside claude-dev.
#
# Paseo ships NO agent of its own - it orchestrates whatever agent CLIs are on PATH,
# so this child image adds Claude Code, Codex and Pi to the official base.
#
# Base image facts below are read from the published image config of
# ghcr.io/getpaseo/paseo:0.2.1 (not assumed):
#   Entrypoint  ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
#   User        (unset -> root; the stock entrypoint drops to uid/gid 1000 'paseo' itself)
#   WorkingDir  /workspace          Volume  /home/paseo          Port  6767/tcp
#   Node        22.23.1  - satisfies claude >=22.0.0, pi >=22.19.0, codex >=16
#   Env         PASEO_HOME=/home/paseo/.paseo
#               CLAUDE_CONFIG_DIR=/home/paseo/.claude
#               CODEX_HOME=/home/paseo/.codex
#               XDG_{CONFIG,DATA,STATE,CACHE}_HOME=/home/paseo/...
#
# That env layout is why this setup needs no cred wiring at all: every agent's config
# path already resolves under /home/paseo, so the single paseo-home volume persists
# Paseo's state AND all three agents' logins. Pi has no dedicated env var here, but it
# inherits HOME=/home/paseo and the XDG_* dirs, so its state lands on the volume too.
#
# TODO(reproducibility): pin by digest once verifiable from a host with registry access:
#   FROM ghcr.io/getpaseo/paseo:0.2.1@sha256:<digest>

# uv, pulled from Astral's distroless image rather than the install script so the version
# is a pin instead of whatever the script resolves at build time. A named stage is what
# makes the ARG usable - `COPY --from=<image>` does not expand build args reliably.
ARG UV_VERSION="0.11.32"
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin

FROM ghcr.io/getpaseo/paseo:0.2.1

# Agent CLI pins - identical to the pins in claude-code/Dockerfile so both surfaces run
# the same agent builds. Because this stack keeps its credentials ISOLATED from the
# claude-config volume, these can be bumped independently without risking shared state:
# unlike a full-share setup, drift here cannot corrupt claude-dev.
ARG CLAUDE_CODE_VERSION="2.1.219"
ARG CODEX_VERSION="0.145.0"
ARG PI_VERSION="0.82.1"

# Python pin. 3.13 rather than 3.14 for the wider wheel coverage; bump when the packages
# agents actually reach for have caught up. (UV_VERSION is declared above the first FROM,
# because that is the only scope where the uvbin stage can see it.)
ARG PYTHON_VERSION="3.13"

# The base leaves User unset and drops privileges in its own entrypoint, so install as
# root and deliberately do NOT set USER - overriding it would break that drop.
USER root

# bubblewrap backs Codex's Linux sandbox. Without it on PATH Codex warns and falls back to
# its bundled copy - functional, but noisy and unpinned to the distro build. Installing the
# package is all that is needed; it requires NO Docker security relaxation.
#
# Deliberately NOT setuid (upstream's secure devcontainer does 'chmod u+s /usr/bin/bwrap'
# because it runs non-root, as we do). A setuid-root binary in a tunnel-reachable container
# is a worse trade than Codex's fallback, so add it only if the sandbox is proven broken.
# Likewise NOT adding SYS_ADMIN/seccomp=unconfined/apparmor=unconfined: those relax the
# container boundary that actually protects the host in order to build a weaker one inside
# it. Verify with:  codex sandbox linux --full-auto -- /bin/sh -lc 'echo inner-ok'
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && bwrap --version

# Pi's only optional dependency (@mariozechner/clipboard) is a native module that is
# useless in a headless container; npm treats optionalDependencies failures as non-fatal,
# so a build host without its toolchain still produces a working image.
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && claude --version \
    && codex --version \
    && pi --version \
    && npm cache clean --force

# Guard against a base-image regression: Pi needs Node >=22.19.0 and the base currently
# ships 22.23.1, so a future upstream downgrade inside the 22.x line would break Pi at
# runtime with no build-time signal. Fail the build instead.
RUN node -e 'const v=process.versions.node.split(".").map(Number); if (v[0]<22 || (v[0]===22 && v[1]<19)) { console.error("FATAL: base Node "+process.versions.node+" is below pi >=22.19.0"); process.exit(1); } console.log("Node "+process.versions.node+" OK for claude/codex/pi")'

# GitHub CLI from GitHub's official apt repo - bookworm's own gh package is years stale
# (2.23.x). Same block as claude-code/Dockerfile, so both surfaces get the same gh. The
# agents shell out to it for PR/issue work, so it belongs in the image rather than being
# hand-installed into a container that gets replaced on every image bump.
# No GH_CONFIG_DIR is needed here: the base sets XDG_CONFIG_HOME=/home/paseo/.config, so
# gh's default config path already lands on the paseo-home volume and 'gh auth login'
# survives recreation - unlike claude-dev, where /claude is the volume instead.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh bash-completion \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# ---------------------------------------------------------------------------
# Python, via uv. The base ships no interpreter at all, so agents hit "python3: not found"
# on anything from a one-off script to a repo's own tooling.
#
# EVERYTHING baked here must land OUTSIDE /home/paseo. That path is a named volume, so a
# build-time write to it is masked the moment an existing volume mounts over it: the build
# passes, the image looks correct, and python3 is missing at runtime. uv's defaults walk
# straight into that trap - it installs interpreters under $XDG_DATA_HOME and symlinks
# under $XDG_BIN_HOME, both of which the base points at /home/paseo. Verified: a plain
# `uv python install` here warns that `/home/paseo/.local/bin` is where it put the links.
# Same hazard, and same fix, as /etc/paseo-bashrc.sh further down.
COPY --from=uvbin /uv /uvx /usr/local/bin/

# UV_PYTHON_INSTALL_DIR is set INLINE, not as ENV, and deliberately so. Baking it into the
# image would point runtime uv at a root-owned path, so an agent's own `uv python install`
# would fail on permissions. Left unset at runtime, uv falls back to ~/.local/share/uv on
# the volume - which is writable, persists across recreation, and is the rootless escape
# hatch for extra interpreters. The baked one stays reachable either way via the symlinks
# below, since uv discovers interpreters on PATH.
#
# --managed-python so this cannot silently "succeed" by finding a system interpreter that
# does not exist here. --default is avoided on purpose: it creates these same symlinks but
# is still flagged experimental ("may change without warning"), and ln is not.
RUN export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    && uv python install --managed-python "${PYTHON_VERSION}" \
    && PY="$(uv python find --managed-python "${PYTHON_VERSION}")" \
    && test -x "$PY" \
    && ln -sf "$PY" /usr/local/bin/python3 \
    && ln -sf "$PY" /usr/local/bin/python \
    && case "$(python3 --version)" in "Python ${PYTHON_VERSION}."*) ;; \
         *) echo "FATAL: python3 is $(python3 --version), expected ${PYTHON_VERSION}.x"; exit 1 ;; esac \
    && python3 -c 'import sys, ssl, sqlite3, zlib; print("python OK:", sys.version.split()[0])' \
    && uv --version

# Guard the masking failure mode itself. If a future edit lets any of the above resolve
# back under /home/paseo, the volume hides it at runtime with no other signal - so fail
# the build here instead of shipping an image that loses python on deploy.
RUN case "$(readlink -f /usr/local/bin/python3)" in \
      /home/paseo/*) echo "FATAL: python3 resolves into /home/paseo, which the named volume masks at runtime"; exit 1 ;; \
    esac \
    && echo "python3 -> $(readlink -f /usr/local/bin/python3) (outside the volume)"

# Restore Claude thinking/reasoning in the Paseo timeline.
#
# Paseo builds the Claude thinking option as `{ type: "adaptive" }` with no `display`
# field, so it inherits the Anthropic API default `display: "omitted"` - which on Opus 5,
# Sonnet 5, Fable 5, Opus 4.8 and Opus 4.7 returns thinking blocks with an EMPTY
# `thinking` string and only an encrypted `signature`. Paseo's extractor requires
# non-empty text (dist .../providers/claude/agent.js, extractFragments), so it produces
# zero `reasoning` timeline items and no thinking is ever rendered. Verified on this
# image: `claude -p --effort high` alone yields 0 chars of thinking text, while adding
# `--thinking-display summarized` yields 780 chars over 7 non-empty deltas.
#
# This is not configurable from outside: there is no daemon-level override in
# persisted-config, the `autoExpandReasoning` UI setting is display-only, and the
# per-agent `extra.claude` escape hatch does not carry to newly created agents.
# Upstream has no issue filed and 0.2.1 is the latest release, so patch the two call
# sites in the published dist. Asserts on both sides so a base-image bump fails the
# build loudly instead of silently reverting to no-thinking.
RUN AGENT_JS=/usr/local/lib/node_modules/@getpaseo/server/dist/server/server/agent/providers/claude/agent.js \
    && test -f "$AGENT_JS" \
    && test "$(grep -c 'type: "adaptive" }' "$AGENT_JS")" = "2" \
    && sed -i 's/{ type: "adaptive" }/{ type: "adaptive", display: "summarized" }/g' "$AGENT_JS" \
    && test "$(grep -c 'display: "summarized"' "$AGENT_JS")" = "2" \
    && node --check "$AGENT_JS" \
    && echo "Patched Paseo Claude provider: thinking display=summarized"

# Password-secret bridge. Paseo reads only PASEO_PASSWORD; a Compose secret arrives as a
# FILE, so without this the secret is silently ignored and a tunnel-reachable daemon comes
# up UNAUTHENTICATED. Sits between tini and the stock entrypoint, which is left untouched.
COPY entrypoint.sh /usr/local/bin/paseo-password-entrypoint
RUN chmod +x /usr/local/bin/paseo-password-entrypoint

# Keep tini as PID 1 exactly as the base image does - only the child process changes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-password-entrypoint"]

# Match claude-dev's rebuild-to-upgrade model: no in-container self-update.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1

# Paseo's web terminals resolve their shell as `env.SHELL || "/bin/sh"`
# (@getpaseo/server dist/server/terminal/terminal.js, resolveDefaultTerminalShell).
# Docker sets no SHELL in a container's environment, so every terminal fell back to
# /bin/sh -> dash, whose built-in prompt is a bare "$ " with no cwd. dash also never
# reads /etc/bash.bashrc or ~/.bashrc, so nothing could fix the prompt from the home
# volume. Naming bash here is what makes a prompt configurable at all - it gets the stock
# Debian '\u@\h:\w\$ ' from /etc/bash.bashrc, which the next layer then builds on.
ENV SHELL=/bin/bash

# ...and give that bash a usable interactive setup: colour prompt with cwd, the cwd on the
# web UI's terminal tab, shared-safe history across concurrent terminals, and completion.
# This has to be system-wide rather than a ~/.bashrc: /home/paseo is a named volume, so
# anything written to the home directory at build time is masked on an existing volume.
COPY bashrc.sh /etc/paseo-bashrc.sh
RUN chmod 0644 /etc/paseo-bashrc.sh \
    && printf '\n# Paseo container interactive-shell defaults.\n[ -r /etc/paseo-bashrc.sh ] && . /etc/paseo-bashrc.sh\n' \
         >> /etc/bash.bashrc \
    && bash -ic 'case "$PS1" in *\\w*) echo "interactive prompt OK: $PS1" ;; *) echo "FATAL: /etc/paseo-bashrc.sh did not take effect"; exit 1 ;; esac'

EXPOSE 6767
