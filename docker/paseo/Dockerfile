# Paseo daemon + web UI, run as its own standalone stack alongside claude-dev.
#
# Paseo ships NO agent of its own - it orchestrates whatever agent CLIs are on PATH,
# so this child image adds Claude Code, Codex and Pi to the official base.
#
# Base image facts below are read from the published image config of
# ghcr.io/getpaseo/paseo:0.12.0 (not assumed):
#   Entrypoint  ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
#   User        (unset -> root; the stock entrypoint drops to uid/gid 1000 'paseo' itself)
#   WorkingDir  /workspace          Volume  /home/paseo          Port  6767/tcp
#   Node        22.23.3  - satisfies claude >=22.0.0, pi >=22.19.0, codex >=16
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

FROM ghcr.io/getpaseo/paseo:0.12.0

# Agent CLI pins - identical to the pins in claude-code/Dockerfile so both surfaces run
# the same agent builds. Because this stack keeps its credentials ISOLATED from the
# claude-config volume, these can be bumped independently without risking shared state:
# unlike a full-share setup, drift here cannot corrupt claude-dev.
ARG CLAUDE_CODE_VERSION="2.1.299"
ARG CODEX_VERSION="0.163.0"
ARG PI_VERSION="1.3.0"

# Python pin. 3.13 rather than 3.14 for the wider wheel coverage; bump when the packages
# agents actually reach for have caught up. (UV_VERSION is declared above the first FROM,
# because that is the only scope where the uvbin stage can see it.)
ARG PYTHON_VERSION="3.13"

# The base leaves User unset and drops privileges in its own entrypoint, so install as
# root and deliberately do NOT set USER - overriding it would break that drop.
USER root

# bubblewrap backs Codex's Linux sandbox. Installing it supplies the executable;
# Docker must also permit its nested user namespaces and mount setup. The paired
# seccomp/AppArmor profiles in security/ provide those exceptions at container creation.
# Keep bwrap non-setuid and the container without added SYS_ADMIN or unconfined profiles.
# Install the host policy and run security/verify-host.sh before deploying the stack.
# The version check below verifies packaging only, not runtime sandbox compatibility.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && bwrap --version

# Nothing here needs a compiler. Pi has no optional dependencies and no install scripts
# (checked in npm metadata for 0.87.1, 1.1.0 and 1.3.0), so nothing in this block builds native code.
# The root-run Codex version probe creates tmp/arg0-linux (tmp/arg0 before 0.163) with
# mode 0700. Return that scratch tree to paseo so runtime helper aliases can be created
# (required by bwrap 0.8).
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && claude --version \
    && codex --version \
    && chown -hR paseo:paseo /home/paseo/.codex/tmp \
    && pi --version \
    && npm cache clean --force

# Guard against a base-image regression: Pi needs Node >=22.19.0 and the base currently
# ships 22.23.3, so a future upstream downgrade inside the 22.x line would break Pi at
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
# tunnel; Paseo already has web terminals), NodeSource nodejs (the base ships 22.23.3 and
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
# Debian's ffmpeg is deliberately NOT here: it pulls 189 packages / 449MB even with
# --no-install-recommends, and bookworm's is 5.1. ffmpeg/ffprobe come from a pinned upstream
# build in their own block further down instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ripgrep jq sqlite3 unzip zip less gnupg \
         vim nano tree rsync wget file htop \
         build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && rg --version && jq --version && sqlite3 --version \
    && cc --version >/dev/null && make --version >/dev/null \
    && echo "CLI tooling OK"

# System libraries and fonts for browser QA: Playwright Chromium and the paseo desktop
# (Electron) e2e suites. Without them headless Chromium dies on libglib-2.0.so.0, and with
# no fonts at all every screenshot and sharp/librsvg render draws text as boxes.
#
# The first two lines (bar fontconfig, listed for its fc-* CLI) are exactly Playwright's own
# `install-deps chromium` list for debian12-x64 (nativeDeps: tools + chromium), identical in
# playwright-core 1.58.2 and 1.60.0 - so `npx playwright install-deps chromium` becomes a
# no-op here. Browser BINARIES are deliberately not baked: `npx playwright install` puts
# them in $XDG_CACHE_HOME/ms-playwright, which is on the paseo-home volume, so they already
# survive recreation, and each repo pins its own revision (paseo's 1.58 wants chromium 1208,
# other repos here want 1223). Baking one would cost ~640MB per revision and still drift.
#
# fonts-dejavu-core is NOT in Playwright's list but is needed: without it fontconfig resolves
# the generic sans-serif/serif/monospace to WenQuanYi Zen Hei (64-wqy-zenhei.conf prefers
# itself), so Latin text renders in a CJK face. With DejaVu present, 60-latin.conf's
# preference wins (checked with fc-match); the assert below keeps it that way.
#
# The last line is for packages/desktop: Electron links libgtk-3.so.0 (headless-shell does
# not), its e2e runs under xvfb-run (needs xauth, only a Recommends of xvfb), and the renderer
# lifecycle test drives windows with xdotool. dbus-x11 satisfies gtk's dconf -> dbus session
# bus dependency without dragging in systemd via dbus-user-session.
#
# Sizes measured against the bookworm index, --no-install-recommends, installed: Playwright
# set 308MB (~170MB of it is xvfb's Mesa/LLVM chain), dejavu + Electron line 75MB.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
         xvfb fontconfig libfontconfig1 libfreetype6 xfonts-scalable fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
         fonts-dejavu-core \
         libgtk-3-0 dbus-x11 xauth xdotool \
    && rm -rf /var/lib/apt/lists/* \
    && for t in Xvfb xvfb-run xauth xdotool fc-match; do \
         command -v "$t" >/dev/null || { echo "FATAL: $t not found"; exit 1; }; \
       done \
    && case "$(fc-match -f '%{family}' sans-serif)" in "DejaVu Sans"*) ;; \
         *) echo "FATAL: sans-serif resolves to '$(fc-match -f '%{family}' sans-serif)', expected DejaVu Sans"; exit 1 ;; esac \
    && echo "Browser QA deps OK: $(fc-list | wc -l) font faces"

# ffmpeg + ffprobe, from BtbN's FFmpeg-Builds (9.0 release branch, GPL, shared libraries).
# ffmpeg backs youtube-evaluator's opt-in --whisper tier (`yt-dlp -x --audio-format mp3`,
# then faster-whisper below). ffprobe is what yt-dlp hard-requires for SponsorBlock removal,
# --remove-chapters, --concat-playlist and its HLS AAC fixup; ffmpeg alone covers codec
# detection but not those.
#
# Why this build: Debian's is 5.1 at 449MB (see the CLI block). The imageio-ffmpeg wheel
# ships only ffmpeg, no ffprobe, and its 7.0 branch is no longer listed on ffmpeg.org.
# The SHARED variant because ffmpeg and ffprobe then share one copy of the libraries:
# ffmpeg + ffprobe + lib/ is ~194MB installed, against 329MB for the static pair, which
# embeds ~165MB in each binary. Beyond its own lib/ the build needs only glibc and
# libgcc_s, and its RPATH is $ORIGIN/../lib, so the /usr/local/bin symlinks resolve the
# libraries. Both were checked with readelf and by running ffprobe through a symlink.
# ffplay, headers and docs are not extracted.
#
# Pinned to a MONTH-END autobuild plus its sha256 from that release's checksums.sha256.
# BtbN's retention policy keeps the last 14 daily builds but the last build of each month
# for two years, so a daily pin 404s within about two weeks and a month-end pin does not.
# To bump, take the last autobuild-YYYY-MM-<last day>-* release from
# https://github.com/BtbN/FFmpeg-Builds/releases (asset *-linux64-gpl-shared-9.0.tar.xz) and
# change all three ARGs together. Declared here rather than at the top so a bump only
# rebuilds from this layer down. xz for tar -J arrives with build-essential (dpkg-dev
# depends on xz-utils).
ARG FFMPEG_BTBN_TAG="autobuild-2026-09-30-13-08"
ARG FFMPEG_BTBN_ASSET="ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-shared-9.0"
ARG FFMPEG_BTBN_SHA256="01a9764d0b5364b66cfeb4617557c64321b0e232e172ec73f0a701c5f7694326"
RUN cd /tmp \
    && curl -fsSL -o ffmpeg.tar.xz \
         "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/${FFMPEG_BTBN_ASSET}.tar.xz" \
    && echo "${FFMPEG_BTBN_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/ffmpeg \
    && tar -xJf ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
         "${FFMPEG_BTBN_ASSET}/bin/ffmpeg" "${FFMPEG_BTBN_ASSET}/bin/ffprobe" \
         "${FFMPEG_BTBN_ASSET}/lib" "${FFMPEG_BTBN_ASSET}/LICENSE.txt" \
    && rm ffmpeg.tar.xz \
    && ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg \
    && ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe \
    && ffmpeg -hide_banner -version >/dev/null \
    && ffprobe -hide_banner -version >/dev/null \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame \
    && echo "ffmpeg/ffprobe OK (libmp3lame present): $(ffprobe -hide_banner -version | head -1)"

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

# YouTube fetch/transcript tooling: yt-dlp, youtube-transcript-api and faster-whisper.
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
# yt-dlp tracks the NIGHTLY channel, which yt-dlp's own README calls the "recommended channel
# for regular users" and stable "often stale and prone to external breakage". Nightlies ship
# to PyPI as .dev releases. The .dev0 floor is what makes uv consider pre-releases for yt-dlp
# alone (uv allows them only for a package whose specifier names one), so this resolves to
# the newest nightly at build time while every dependency stays on stable. Checked with
# `uv pip compile` on uv 0.11.32: yt-dlp==2026.9.27.232945.dev0, yt-dlp-ejs==0.8.0. Raise
# the floor occasionally; it only has to be at or below the current nightly.
#
# faster-whisper backs youtube-evaluator's opt-in --whisper tier, together with ffmpeg from
# the block above. Its closure (ctranslate2, av, onnxruntime, tokenizers, huggingface-hub,
# numpy, ...) measured ~383MB as a pip install on the volume. Pinned to 1.2.1, the current
# release and the version already proven on the volume. huggingface-hub is capped below 2
# to stay on the 1.x line the volume's working install uses (1.29.0; <2 resolves to 1.33.0);
# an unconstrained resolve jumps a major version to 2.2.0, untested with faster-whisper here.
# Not because of local_dir_use_symlinks: hub's deprecation decorator drops that argument
# with a warning (called for real on 1.29.0; per review, 2.2.0 does the same).
# Model weights are NOT baked: they download to ~/.cache/huggingface on first use, on the
# volume, and persist.
# A copy pip-installed earlier into ~/.local/lib/python3.13/site-packages SHADOWS this one,
# because the user site precedes site-packages on sys.path. After deploying, remove it with
# `python3 -m pip uninstall` (no sudo, so only the user-site copy is touchable).
#
# The console scripts need symlinking for the same reason python3 did. uv installs them into
# the managed interpreter's own bin/ (/usr/local/share/uv/python/cpython-*/bin), which is NOT
# on PATH - only the python3/python symlinks above are. Without this, `import yt_dlp` works
# and `yt-dlp` is command-not-found. Same fix as the interpreter, for the same reason.
RUN uv pip install --system --break-system-packages --python /usr/local/bin/python3 --no-cache \
        "yt-dlp[default]>=2026.9.27.dev0" youtube-transcript-api \
        "faster-whisper==1.2.1" "huggingface-hub<2" \
    && python3 -c 'import yt_dlp, youtube_transcript_api, faster_whisper' \
    && PYBIN="$(dirname "$(readlink -f /usr/local/bin/python3)")" \
    && for s in yt-dlp youtube_transcript_api; do \
         test -x "$PYBIN/$s" || { echo "FATAL: console script $s not found in $PYBIN"; exit 1; }; \
         ln -sf "$PYBIN/$s" "/usr/local/bin/$s"; \
       done \
    && yt-dlp --version \
    && youtube_transcript_api --help >/dev/null \
    && python3 -c 'import os, sys, yt_dlp, faster_whisper; ps = [os.path.dirname(m.__file__) for m in (yt_dlp, faster_whisper)]; print("->", *ps); sys.exit(1 if any(p.startswith("/home/paseo") for p in ps) else 0)'

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

# npm-link-shim: makes a repeat `npm ci` with identical inputs (lockfiles, package.json
# files, patches/, npm's effective config, node/npm, the root install scripts' directory)
# rebuild node_modules from a store instead of a fresh ~2.8GB install per worktree.
# OPT-IN: only projects whose root package.json "name" is listed in
# $XDG_CONFIG_HOME/npm-link-shim/allow (on the volume; currently `paseo`) are cached. Every
# other project, and anything but a plain `npm ci`, goes straight to the real npm, silently;
# NPM_LINK_SHIM=0 bypasses it entirely. See shim.mjs's header for the full behaviour.
#
# Copy mode is probed per call. On a reflink filesystem (the planned XFS on the new server)
# it uses copy-on-write copies, so nothing is shared-writable. On ext4 it uses hardlinks
# with shared files made READ-ONLY as a tripwire: an accidental in-place write fails loudly
# instead of leaking into other worktrees. It is not a guarantee (the owner can chmod, and
# npm's bin-linking chmods bin targets back to 0755), so it is re-armed on every hit. The
# packages patch-package patches, and every hidden lockfile, stay private copies. A miss is
# only cached if a before/after listing of everything outside node_modules is identical.
#
# The code is baked here so it is versioned with the image; the STORE is not, and defaults
# to ~/.cache/npm-link-store on the volume, where worktrees live. /srv/projects is a separate
# bind mount that reports the SAME st_dev yet refuses link(2) with EXDEV, so the shim proves
# a real link/clone between project and store before touching anything, and passes through
# when it fails: `npm ci` under /srv/projects behaves exactly as before.
#
# Activated by PREPENDING to PATH, here rather than in compose: worktree setup runs as a
# plain `bash -c` with the daemon's inherited PATH, and a compose `environment: PATH:` would
# replace this image's PATH wholesale, dropping the Android entries below. Placed at the end
# so the `npm install -g` layers above never see it. sudo's secure_path also skips it, so
# root npm is untouched. The check runs the shim through PATH to prove it finds the real npm
# past its own directory.
COPY npm-link-shim /usr/local/lib/npm-link-shim
RUN chmod 0755 /usr/local/lib/npm-link-shim/bin/npm \
    && chmod 0644 /usr/local/lib/npm-link-shim/shim.mjs \
    && REAL="$(npm --version)" && VIA_SHIM="$(PATH="/usr/local/lib/npm-link-shim/bin:$PATH" npm --version)" \
    && test -n "$REAL" && test "$VIA_SHIM" = "$REAL" \
    && echo "npm-link-shim OK: passes through to npm $REAL"
ENV PATH="/usr/local/lib/npm-link-shim/bin:${PATH}"

# Android toolchain for phone QA (adb over wireless debugging, agent-device, APK builds).
# It is NOT installed by the image: ~/.local/opt/install-android.sh put a full SDK (4.6GB:
# platform-tools 37.0.1, platforms;android-36, build-tools 36, NDK 27, cmake) and a JDK 21
# on the paseo-home volume, where it survives recreation. Nothing pointed at it, so adb was
# "not found" and agent-device, which reads ANDROID_HOME, could not see the SDK either.
#
# ENV rather than /etc/paseo-bashrc.sh because the daemon and the agents' non-interactive
# shells never read bashrc. These are runtime-only paths into the volume, so the masking
# trap above does not apply: nothing is written there at build time, and on a fresh volume
# the entries simply do not resolve. Appended, not prepended, so image tools win on PATH.
# No usable USB or KVM in this container: real phones only, over `adb pair` + `adb connect`.
ENV ANDROID_HOME=/home/paseo/.local/opt/android-sdk \
    JAVA_HOME=/home/paseo/.local/opt/jdk-21
ENV PATH="${PATH}:/home/paseo/.local/opt/android-sdk/platform-tools:/home/paseo/.local/opt/jdk-21/bin"

# Login shells would otherwise lose every PATH entry above: Debian's /etc/profile assigns
# PATH outright, and Codex runs its commands through `bash -lc`. /etc/profile sources
# /etc/profile.d/*.sh AFTER that assignment, so restore the image's PATH there. It is
# generated from this layer's own PATH, so it can never drift from the ENV lines above;
# ~/.profile still runs afterwards and prepends ~/.local/bin as before. Must stay the last
# PATH change in this file.
RUN printf '# Generated at image build: restore the image PATH that /etc/profile resets.\nPATH="%s"\nexport PATH\n' "$PATH" \
         > /etc/profile.d/paseo-path.sh \
    && chmod 0644 /etc/profile.d/paseo-path.sh \
    && case "$(bash -lc 'echo "$PATH"')" in \
         *:/home/paseo/.local/opt/android-sdk/platform-tools:*) ;; \
         *) echo "FATAL: login shells do not get the image PATH: $(bash -lc 'echo "$PATH"')"; exit 1 ;; esac \
    && echo "login-shell PATH OK"

EXPOSE 6767
