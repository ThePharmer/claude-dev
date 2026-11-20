#!/usr/bin/env bash
#
# Seed the agent CLIs (Claude Code, Codex, Pi) into a paseo-owned npm prefix on the
# paseo-home volume, from the pinned copies baked into the image.
#
# WHY: the image installs the CLIs as root into /usr/local, but everything runs as the
# non-root paseo user. T3 Code's provider "update" button runs
#   npm install -g --prefix <prefix the binary lives under> <pkg>@<version>
# as that user, so against /usr/local it fails on permissions, and even a root install
# there would be lost when the container is recreated. Living in $AGENT_CLI_PREFIX on the
# volume, the CLIs are writable by paseo and their updates survive redeploys. The image
# ENV puts $AGENT_CLI_PREFIX/bin ahead of /usr/local/bin, so Paseo, T3, terminals and
# agents all run the volume copy. The image copies remain the fallback.
#
# WHAT IT DOES: for each package missing from the prefix, copy the image's copy in (local
# copy, no network, so a fresh volume starts on exactly the pinned versions), then add any
# missing bin symlinks in npm's own layout. A package that is already there is never
# touched: once seeded, versions change only when someone updates them (T3's button, or
# npm by hand). Nothing auto-updates. Then log volume vs image versions so drift is
# visible in the container logs.
#
# Runs as paseo, from the entrypoint, before Paseo and t3 start. Every failure is logged
# and skipped: the image copy stays on PATH, so seeding can never block startup.
# To reseed one CLI back to the image's version, delete its directory under
# $AGENT_CLI_PREFIX/lib/node_modules and restart the container.
# sudo does NOT see this prefix (sudo's secure_path omits it): `sudo claude` runs the image
# copy, and `sudo npm install -g` writes to /usr/local, which is lost on recreation.
set -uo pipefail

PREFIX="${AGENT_CLI_PREFIX:-/home/paseo/.local/share/agent-clis}"
IMAGE_MODULES=/usr/local/lib/node_modules
PACKAGES=(
    @anthropic-ai/claude-code
    @openai/codex
    @earendil-works/pi-coding-agent
)

log() { echo "[agent-clis] $*" >&2; }

pkg_version() {
    node -p 'require(process.argv[1] + "/package.json").version' "$1" 2>/dev/null || echo "none"
}

# Make bin/<name> point at each entry in the package's "bin" field, in the same form npm
# uses for global installs (bin/<name> -> ../lib/node_modules/<pkg>/<file>). A link that
# already points there is left alone, so this never fights npm. A symlink pointing anywhere
# else (stale after a reset, or dangling) is replaced: otherwise PATH would fall through to
# the image copy and T3 would try to update /usr/local. A non-symlink is never touched.
link_bins() {
    node -e '
        const fs = require("fs"), path = require("path");
        const [prefix, pkg] = process.argv.slice(1);
        const dir = path.join(prefix, "lib", "node_modules", pkg);
        const binDir = path.join(prefix, "bin");
        let bin = require(path.join(dir, "package.json")).bin || {};
        if (typeof bin === "string") bin = { [pkg.split("/").pop()]: bin };
        for (const [name, rel] of Object.entries(bin)) {
            const link = path.join(binDir, name);
            const want = path.relative(binDir, path.join(dir, rel));
            let st = null;
            try { st = fs.lstatSync(link); } catch {}
            if (st && !st.isSymbolicLink()) {
                console.error("[agent-clis] " + link + " is not a symlink; leaving it alone");
                continue;
            }
            if (st && fs.readlinkSync(link) === want) continue;
            if (st) fs.unlinkSync(link);
            fs.symlinkSync(want, link);
            console.error("[agent-clis] linked " + name + (st ? " (replaced a stale link)" : ""));
        }
    ' "$PREFIX" "$1"
}

if ! mkdir -p "$PREFIX/lib/node_modules" "$PREFIX/bin"; then
    log "cannot create $PREFIX; the image's CLIs stay in use"
    exit 0
fi

# Temp dirs left by an interrupted earlier run (container killed mid-copy). Their names
# carry that run's PID, so a later run would not otherwise find them.
for stale in "$PREFIX"/.seed-tmp-*; do
    [[ -e "$stale" ]] || continue
    log "removing leftover $stale from an interrupted seed"
    rm -rf "$stale"
done

for pkg in "${PACKAGES[@]}"; do
    src="$IMAGE_MODULES/$pkg"
    dst="$PREFIX/lib/node_modules/$pkg"
    image_version="$(pkg_version "$src")"

    if [[ ! -f "$dst/package.json" ]]; then
        if [[ ! -f "$src/package.json" ]]; then
            log "$pkg is not in the image; skipping"
            continue
        fi
        # A directory without package.json is not a usable install (a broken npm run, or a
        # stray copy). Remove it, or the rename below fails on every start.
        if [[ -e "$dst" ]]; then
            log "$dst has no package.json; removing the broken install"
            rm -rf "$dst"
        fi
        log "seeding $pkg $image_version from the image (first start on this volume)"
        # Copy to a temp dir on the same filesystem, then rename into place, so an
        # interrupted copy never leaves a half-populated package that looks installed.
        tmp="$PREFIX/.seed-tmp-$$"
        rm -rf "$tmp"
        if ! mkdir -p "$(dirname "$dst")" \
            || ! cp -R --preserve=mode,timestamps,links "$src" "$tmp" \
            || ! mv -T "$tmp" "$dst"; then
            rm -rf "$tmp"
            log "failed to seed $pkg; the image copy stays in use"
            continue
        fi
    fi

    link_bins "$pkg" || log "could not link bins for $pkg; the image copy may be used"

    volume_version="$(pkg_version "$dst")"
    if [[ "$volume_version" == "$image_version" ]]; then
        log "$pkg $volume_version (volume, same as image)"
    else
        log "$pkg $volume_version (volume; image has $image_version)"
    fi
done
exit 0
