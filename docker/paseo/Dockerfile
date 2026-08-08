# Paseo daemon + web UI, run as its own standalone stack alongside claude-dev.
#
# Paseo ships NO agent of its own - it orchestrates whatever agent CLIs are on PATH,
# so this child image adds Claude Code, Codex and Pi to the official base.
#
# Base image facts below are read from the published image config of
# ghcr.io/getpaseo/paseo:0.3.0-beta.3 (not assumed):
#   Entrypoint  ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
#   User        (unset -> root; the stock entrypoint drops to uid/gid 1000 'paseo' itself)
#   WorkingDir  /workspace          Volume  /home/paseo          Port  6767/tcp
#   Node        22.23.2  - satisfies claude >=22.0.0, pi >=22.19.0, codex >=16
#   Env         PASEO_HOME=/home/paseo/.paseo
#               CLAUDE_CONFIG_DIR=/home/paseo/.claude
#               CODEX_HOME=/home/paseo/.codex
#               XDG_{CONFIG,DATA,STATE,CACHE}_HOME=/home/paseo/...
#
# That env layout is why this setup needs no cred wiring at all: every agent's config
# path already resolves under /home/paseo, so the single paseo-home volume persists
# Paseo's state AND all three agents' logins. Pi has no dedicated env var here, but it
# inherits HOME=/home/paseo and the XDG_* dirs, so its state lands on the volume too.

# uv, pulled from Astral's distroless image rather than the install script so the version
# is a pin instead of whatever the script resolves at build time. A named stage is what
# makes the ARG usable - `COPY --from=<image>` does not expand build args reliably.
ARG UV_VERSION="0.11.32"
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin

FROM ghcr.io/getpaseo/paseo:0.3.0-beta.3

# Agent CLI pins - identical to the pins in claude-code/Dockerfile so both surfaces run
# the same agent builds. Because this stack keeps its credentials ISOLATED from the
# claude-config volume, these can be bumped independently without risking shared state:
# unlike a full-share setup, drift here cannot corrupt claude-dev.
ARG CLAUDE_CODE_VERSION="2.1.220"
ARG CODEX_VERSION="0.146.0"
ARG PI_VERSION="0.83.0"

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
# because it runs non-root, as we do). Note the sudo grant further down makes this a matter
# of defaults rather than of capability - root can set the bit at runtime - but leaving it
# unset means the sandbox is not weakened for every process by default.
# Likewise NOT adding SYS_ADMIN/seccomp=unconfined/apparmor=unconfined: those relax the
# container boundary that actually protects the host in order to build a weaker one inside
# it, and unlike sudo they are not recoverable from inside. Verify with:
#   codex sandbox linux --full-auto -- /bin/sh -lc 'echo inner-ok'
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && bwrap --version

# Nothing here needs a compiler. Pi's only optional dependency (@mariozechner/clipboard) is
# a native module, but it has no install script and ships prebuilt .node binaries as
# platform-specific optional deps - verified present in an image built with no toolchain at
# all. It is a Rust crate, so build-essential would not build it anyway. npm also treats
# optionalDependencies failures as non-fatal, so this stays safe if upstream drops a prebuild.
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && claude --version \
    && codex --version \
    && pi --version \
    && npm cache clean --force

# Guard against a base-image regression: Pi needs Node >=22.19.0 and the base currently
# ships 22.23.2, so a future upstream downgrade inside the 22.x line would break Pi at
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

# Everyday CLI tooling. The base image is deliberately minimal - it ships git, curl and
# little else - so agents and web terminals hit "command not found" on the basics.
#
# This overlaps claude-code/Dockerfile's apt line but is NOT the same set: ripgrep, jq,
# sqlite3, unzip, gnupg and build-essential are shared, while zip/less/vim/nano/tree/rsync/
# wget/file/htop are additions here. Four of claude-code's are deliberately left out -
# openssh-server and mosh (each a second ingress on a container reachable over a public
# tunnel; Paseo already has web terminals), NodeSource nodejs (the base ships 22.23.1 and
# the build asserts >=22.19 for Pi) and apt python3 (would collide with the uv-managed 3.13
# below and its masking assert).
#
# ripgrep is worth calling out: it is genuinely absent here. Claude Code ships its own
# vendored copy and shims `rg` as a shell function, so the gap is invisible from inside an
# agent session and shows up only for everything else.
#
# Placement: this must precede the uv pip block below, so build-essential is available if a
# wheel ever has to be built from source. Its position relative to the npm block above does
# not matter - nothing there invokes a compiler (see that block's comment).
#
# Sizes measured against the real bookworm index, --no-install-recommends, installed:
# core tools 24MB, editors/QoL 55MB (vim is 39MB of it), build-essential 253MB.
#
# ffmpeg is deliberately NOT here. Debian's ffmpeg pulls 189 packages / 449MB even with
# --no-install-recommends, and the reason claude-code carries it - audio extraction for a
# local-transcription tier - does not apply, because faster-whisper is not installed below.
# Caption/transcript extraction needs neither. Revisit only alongside that decision.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ripgrep jq sqlite3 unzip zip less gnupg \
         vim nano tree rsync wget file htop \
         build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && rg --version && jq --version && sqlite3 --version \
    && cc --version >/dev/null && make --version >/dev/null \
    && echo "CLI tooling OK"

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

# YouTube fetch/transcript tooling, matching claude-code's set minus faster-whisper.
#
# apt is the WRONG tool for these, and not just by preference: Debian's python3-* packages
# install into /usr/lib/python3.11, and Debian's interpreter is not installed in this image
# at all. The install would succeed and the modules would be invisible to `python3`. So it
# has to be uv pip, which targets one specific interpreter's site-packages.
#
# --python is explicit rather than left to uv's discovery, because "which interpreter" is
# exactly what decides whether this survives deploy: the managed CPython lives under
# /usr/local/share/uv/python, while uv's own defaults write to $XDG_DATA_HOME - which the
# base points at /home/paseo, the named volume that masks build-time writes at runtime. The
# assert at the end is the same guard the interpreter itself gets above.
#
# --break-system-packages is REQUIRED, not cargo cult copied from claude-code. uv writes a
# PEP 668 EXTERNALLY-MANAGED marker into its own managed interpreters ("This Python
# installation is managed by uv and should not be modified"), so without the flag uv refuses
# outright and the build dies here. Verified against the pinned uv 0.11.32 and CPython
# 3.13.14: the marker is at <install-dir>/lib/python3.13/EXTERNALLY-MANAGED, and the same
# command without the flag exits with "The interpreter ... is externally managed".
#
# faster-whisper is omitted on purpose. Its closure (ctranslate2, av, onnxruntime, tokenizers)
# is ~95MB of wheels - call it 200-250MB installed; that range is ESTIMATED from PyPI wheel
# sizes, not measured, unlike the apt figures above. Either way it buys a local-transcription
# tier this container does not need. Its absence is also why ffmpeg is not installed further
# up; the two go together, so re-add them together or not at all.
#
# The console scripts need symlinking for the same reason python3 did. uv installs them into
# the managed interpreter's own bin/ (/usr/local/share/uv/python/cpython-*/bin), which is NOT
# on PATH - only the python3/python symlinks above are. Without this, `import yt_dlp` works
# and `yt-dlp` is command-not-found. Same fix as the interpreter, for the same reason.
RUN uv pip install --system --break-system-packages --python /usr/local/bin/python3 --no-cache \
        "yt-dlp[default]" youtube-transcript-api \
    && python3 -c 'import yt_dlp, youtube_transcript_api' \
    && PYBIN="$(dirname "$(readlink -f /usr/local/bin/python3)")" \
    && for s in yt-dlp youtube_transcript_api; do \
         test -x "$PYBIN/$s" || { echo "FATAL: console script $s not found in $PYBIN"; exit 1; }; \
         ln -sf "$PYBIN/$s" "/usr/local/bin/$s"; \
       done \
    && yt-dlp --version \
    && youtube_transcript_api --help >/dev/null \
    && python3 -c 'import os, sys, yt_dlp; p = os.path.dirname(yt_dlp.__file__); print("yt_dlp ->", p); sys.exit(1 if p.startswith("/home/paseo") else 0)'

# Passwordless sudo, matching the devcontainers common-utils default and claude-code, which
# runs as root outright. Agents need it for system packages not worth an image rebuild.
#
# What it adds over uid 1000: DAC_OVERRIDE (0600 files on rw binds), setuid-root binaries on
# the host via a rw bind mount, and NET_RAW. Not host root - no docker.sock, no --privileged,
# no SYS_ADMIN, seccomp stays on. This is only a reasonable trade because ../compose.yaml
# mounts a few named subtrees rather than a whole tree; revisit if that list widens.
#
# visudo -c because a malformed drop-in locks sudo out entirely.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/sudoers.d \
    && echo 'paseo ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/paseo \
    && chmod 0440 /etc/sudoers.d/paseo \
    && visudo -c \
    && sudo -n -U paseo -l >/dev/null \
    && echo "sudo: paseo has passwordless root"

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
# Upstream has no issue filed and the dist is unchanged at both call sites through
# 0.2.5 (checked against the @getpaseo/server npm tarball), so patch the published dist. Asserts on both sides so a base-image bump fails the
# build loudly instead of silently reverting to no-thinking.
RUN AGENT_JS=/usr/local/lib/node_modules/@getpaseo/server/dist/server/server/agent/providers/claude/agent.js \
    && test -f "$AGENT_JS" \
    && test "$(grep -c 'type: "adaptive" }' "$AGENT_JS")" = "2" \
    && sed -i 's/{ type: "adaptive" }/{ type: "adaptive", display: "summarized" }/g' "$AGENT_JS" \
    && test "$(grep -c 'display: "summarized"' "$AGENT_JS")" = "2" \
    && node --check "$AGENT_JS" \
    && echo "Patched Paseo Claude provider: thinking display=summarized"

# Send credentials with the web app manifest request, so Cloudflare Access lets it through.
#
# Paseo emits a bare `<link rel="manifest" href="/manifest.json" />`. Per the Web App
# Manifest spec the manifest is fetched with credentials mode "omit" unless the link carries
# `crossorigin="use-credentials"` - it is the one subresource in the document that does NOT
# send cookies by default, even same-origin. Behind Access that means the CF_Authorization
# cookie is withheld, Access 302s the fetch to the login domain, and because the redirect
# chain can neither send nor store the cookie it runs to the browser's redirect cap and
# fails. That is the ~124 redirects seen per page load, and it is also why the PWA never
# becomes installable: no manifest, no install prompt, no Android route.
#
# `use-credentials` puts the request in CORS mode, but the manifest is same-origin, so the
# CORS protocol does not apply and no Access-Control-Allow-Origin header is needed. Nothing
# has to change on the Cloudflare side.
#
# Patched in the dist because the web UI ships prebuilt and there is no template hook or
# config knob for the head. Asserts on both sides so an upstream bump that changes the tag
# fails the build instead of silently dropping the fix.
#
# The .br/.gz siblings are regenerated only to keep the three copies consistent: web-ui.js
# forces acceptEncoding to undefined for index.html (it injects the connection hint into the
# response), so today the precompressed variants are never served for this file. Verified in
# dist/server/server/web-ui.js, serveWebUiFile. Regenerating costs nothing and means the fix
# still holds if upstream ever starts serving them.
RUN INDEX_HTML=/usr/local/lib/node_modules/@getpaseo/server/dist/server/web-ui/index.html \
    && test -f "$INDEX_HTML" \
    && test "$(grep -c '<link rel="manifest" href="/manifest.json" />' "$INDEX_HTML")" = "1" \
    && sed -i 's#<link rel="manifest" href="/manifest.json" />#<link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />#' "$INDEX_HTML" \
    && test "$(grep -c '<link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />' "$INDEX_HTML")" = "1" \
    && node -e 'const z=require("zlib"),f=require("fs"),p=process.argv[1],b=f.readFileSync(p); f.writeFileSync(p+".gz",z.gzipSync(b,{level:9})); f.writeFileSync(p+".br",z.brotliCompressSync(b)); if(!z.gunzipSync(f.readFileSync(p+".gz")).equals(b)||!z.brotliDecompressSync(f.readFileSync(p+".br")).equals(b)){console.error("FATAL: recompressed index.html does not round-trip");process.exit(1)}' "$INDEX_HTML" \
    && echo "Patched Paseo web UI: manifest link sends credentials"

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
