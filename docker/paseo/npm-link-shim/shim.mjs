#!/usr/bin/env node
// npm-link-shim: makes `npm ci` reuse a stored copy of a previous install when
// the inputs that determine node_modules are identical. OPT-IN per project: only
// projects whose root package.json "name" is listed in the allowlist file are
// cached; every other project, and every command other than a plain `npm ci`,
// goes straight to the real npm.
//
// Copy mode is detected per call with a real probe between project and store:
//   reflink  (XFS/btrfs): `cp -a --reflink=always`. Copy-on-write, so nothing is
//            shared-writable; in-place edits stay in the worktree that made them.
//   hardlink (ext4):     `cp -al`, with shared files made READ-ONLY as a tripwire:
//            an accidental in-place write (patch-package, a hand edit) fails with
//            EACCES instead of silently changing the store and every other
//            worktree. It is not a guarantee: the owner can chmod, and npm's own
//            bin-linking chmods bin targets back to 0755 when it re-links them, so
//            the tripwire is re-armed on every hit. Packages patched by
//            patch-package and every hidden lockfile are private copies.
//   neither  (e.g. separate mounts, EXDEV): pass through to real npm.
//
// Hit:  stage each node_modules next to the live one, swap only once every copy
//       succeeded, then run the root prepare script with the original flags.
// Miss: run the real `npm ci`; cache the result only if a before/after listing of
//       everything outside node_modules is identical (the git hooks path is exempt
//       when a prepare script will recreate it), prefetching Electron's first-run
//       binary first so it is stored once rather than downloaded per worktree.
//
// Env: NPM_LINK_SHIM=0            bypass entirely
//      NPM_LINK_STORE=dir         store (default ~/.cache/npm-link-store)
//      NPM_LINK_SHIM_ALLOW_FILE=f allowlist (default $XDG_CONFIG_HOME/npm-link-shim/allow,
//                                 one root package name per line, # comments)
//
// Admin: node shim.mjs --store ls | prune [days] | seed <dir> | rm <key>
//
// Listing a project means vouching that:
//   - its install is reproducible from the inputs the key covers: lockfile,
//     package.json files, patches/, npm's effective config, node/npm/platform,
//     NODE_ENV, and the root install scripts' files. Other environment variables
//     read by dependency install scripts, and effects outside the project, are not
//     detected;
//   - its prepare script is safe to run again on a tree where it already ran, and
//     does not write into node_modules (paseo's is `lefthook install`).

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHIM_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "bin");
const SHIM_MARKER = "npm-link-shim";
const STORE = process.env.NPM_LINK_STORE || path.join(os.homedir(), ".cache", "npm-link-store");
const ALLOW_FILE =
  process.env.NPM_LINK_SHIM_ALLOW_FILE ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "npm-link-shim", "allow");
const CI_COMMANDS = new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);
// Flags that don't change what gets installed.
const NEUTRAL_FLAGS = /^(--no-audit|--no-fund|--prefer-offline|--offline|--silent|--quiet|-s|-q|--no-progress|--loglevel(=.*)?|--foreground-scripts)$/;
// Flags that change what gets installed; allowed, part of the key, and passed on to prepare.
const KEYED_FLAGS = /^(--omit=.+|--include=.+|--ignore-scripts)$/;
// Effective-config keys that don't change what gets installed. The first five are the
// only keys that differ between a direct `npm ci` and one run from a lifecycle script;
// none differ between two worktrees of one project. offline/prefer-* only choose where
// tarballs come from, so the neutral flags above don't split the cache.
// node-gyp is handled separately in computeKey: neutral only when unset or npm's bundled copy.
const NEUTRAL_CONFIG = new Set([
  "loglevel", "user-agent", "local-prefix", "global-prefix", "json", "progress",
  "color", "unicode", "timing", "logs-dir", "logs-max", "update-notifier", "audit", "fund",
  "foreground-scripts", "cache", "userconfig", "globalconfig", "init-module", "init.module",
  "npm-version", "heading", "usage", "long", "parseable", "offline", "prefer-offline",
  "prefer-online",
]);
// Config keys that would make a direct `node install.js` download for a different target
// than npm's lifecycle environment would; their presence skips the Electron prefetch.
const TARGET_CONFIG = /^(arch|platform|os|cpu|libc|target_arch|target_platform|electron.*)$/i;
// Removed from snapshots: tool caches may embed absolute paths of the source worktree.
const SNAPSHOT_EXCLUDES = [".cache", ".vite"];
const PRUNE_DEFAULT_DAYS = 7;
const STALE_MS = 60 * 60 * 1000;
const SCAN_LIMIT = 300_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

const log = (msg) => process.stderr.write(`[npm-link-shim] ${msg}\n`);

const isShim = (file) => {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString("utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
};

// First npm on PATH that is not this shim or another copy of it.
function realNpm() {
  const shimReal = fs.realpathSync(SHIM_BIN);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    let resolved;
    try {
      resolved = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (resolved === shimReal) continue;
    const candidate = path.join(dir, "npm");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    if (isShim(candidate)) continue;
    return candidate;
  }
  throw new Error("npm-link-shim: no real npm found on PATH");
}

// Run a child, forwarding termination signals so cancelling the shim cancels it.
// Resolves to { status, signal }.
function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    const forward = (sig) => {
      try {
        child.kill(sig);
      } catch {}
    };
    for (const s of FORWARDED_SIGNALS) process.on(s, forward);
    const done = () => {
      for (const s of FORWARDED_SIGNALS) process.off(s, forward);
    };
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("exit", (status, signal) => {
      done();
      resolve({ status, signal });
    });
  });
}

// Real npm; exits the way npm did (re-raising its signal).
async function runNpm(args) {
  const { status, signal } = await runChild(realNpm(), args);
  if (signal) {
    process.kill(process.pid, signal);
    return 128 + (os.constants.signals[signal] || 1);
  }
  return status ?? 1;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  return r.stdout;
}

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const lockfileName = (root) =>
  ["npm-shrinkwrap.json", "package-lock.json"].find((f) => fs.existsSync(path.join(root, f)));

function allowlist() {
  try {
    return new Set(
      fs
        .readFileSync(ALLOW_FILE, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

// npm's effective configuration (all npmrc files, env in npm's own precedence, the flags),
// as npm itself resolves it.
function effectiveConfig(root, flags) {
  return JSON.parse(sh(realNpm(), ["config", "list", "--json", ...flags], { cwd: root }));
}

// Expand package.json "workspaces" entries. Supports literal paths and a single
// trailing "/*". Any other glob syntax returns null, so the caller passes through.
const GLOB_CHARS = /[*?[\]{}()!+@]/;
function workspaceDirs(root) {
  const pkg = readPkg(root);
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const dirs = new Set();
  for (const p of patterns) {
    if (typeof p !== "string") return null;
    if (p.endsWith("/*") && !GLOB_CHARS.test(p.slice(0, -2))) {
      const base = path.join(root, p.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.add(path.relative(root, path.join(base, e.name)));
      }
    } else if (GLOB_CHARS.test(p)) {
      return null;
    } else {
      dirs.add(path.normalize(p));
    }
  }
  return [...dirs];
}

// Hashes paths relative to root, so identical inputs in different worktrees
// produce the same key. Directories recurse (node_modules excluded).
function hashInto(h, root, rel) {
  const file = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    h.update(`missing:${rel}\n`);
    return;
  }
  if (st.isSymbolicLink()) {
    h.update(`link:${rel}->${fs.readlinkSync(file)}\n`);
  } else if (st.isDirectory()) {
    for (const name of fs.readdirSync(file).sort()) {
      if (name !== "node_modules") hashInto(h, root, path.join(rel, name));
    }
  } else {
    h.update(`file:${rel}:${(st.mode & 0o777).toString(8)}\n`); // mode too: an install may exec it
    h.update(fs.readFileSync(file));
  }
}

// The file a root install script runs, for `node <path> [args]` only. Anything else
// (node options before the path, shell commands, other tools) returns null: its inputs
// can't be identified, so the caller passes through.
function installScriptEntry(s) {
  const m = s.match(/^node\s+["']?([^\s"'-][^\s"']*)["']?(\s|$)/);
  return m ? m[1] : null;
}

// npm's bundled node-gyp, which is what an unset `node-gyp` config resolves to.
function bundledNodeGyp() {
  try {
    return path.join(path.dirname(fs.realpathSync(realNpm())), "..", "node_modules", "node-gyp", "bin", "node-gyp.js");
  } catch {
    return null;
  }
}

// Everything that determines the contents of node_modules.
function computeKey(root, cfg, mode) {
  const h = createHash("sha256");
  for (const f of ["npm-shrinkwrap.json", "package-lock.json", "package.json", ".npmrc", "patches"]) {
    hashInto(h, root, f);
  }
  // A root install script like `node scripts/x.mjs` decides what gets patched; hash its
  // whole directory (recursively), since it may import helpers from anywhere in it. For a
  // script at the project root, hash every root-level module file next to it instead.
  const pkg = readPkg(root);
  for (const s of [pkg.scripts?.preinstall, pkg.scripts?.install, pkg.scripts?.postinstall]) {
    if (!s) continue;
    const entryFile = installScriptEntry(s);
    if (!entryFile) throw new Error(`unsupported root install script: ${s}`); // ci() checks first
    hashInto(h, root, entryFile); // the entry itself, whatever its name (e.g. extensionless)
    const dir = path.dirname(entryFile);
    if (dir !== ".") {
      hashInto(h, root, dir);
      continue;
    }
    for (const name of fs.readdirSync(root).sort()) {
      if (/\.(mjs|cjs|js|json)$/.test(name)) hashInto(h, root, name);
    }
  }
  for (const ws of workspaceDirs(root) || []) hashInto(h, root, path.join(ws, "package.json"));
  const gyp = cfg["node-gyp"];
  const gypNeutral = gyp === undefined || gyp === null || gyp === "" || gyp === bundledNodeGyp();
  const config = Object.fromEntries(
    Object.entries(cfg)
      .filter(([k]) => !NEUTRAL_CONFIG.has(k) && !(k === "node-gyp" && gypNeutral))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  h.update(
    JSON.stringify({
      node: process.version,
      npm: cfg["npm-version"],
      platform: process.platform,
      arch: process.arch,
      NODE_ENV: process.env.NODE_ENV || "",
      mode,
      config,
    }),
  );
  return h.digest("hex").slice(0, 24);
}

function nodeModulesDirs(root) {
  const ws = workspaceDirs(root) || [];
  return ["node_modules", ...ws.map((w) => path.join(w, "node_modules"))].filter((d) =>
    fs.existsSync(path.join(root, d)),
  );
}

// Which copy primitive works between project and store. st_dev is not enough: two bind
// mounts of one filesystem report the same device but refuse link(2)/FICLONE with EXDEV.
// Every probe path is a fresh UUID name, recorded BEFORE the attempt (a failed
// `cp --reflink=always` still leaves its empty destination behind) and removed after.
function copyMode(root, store) {
  const tag = `.npm-link-probe-${randomUUID()}`;
  const src = path.join(store, tag);
  const attempted = [];
  try {
    const fd = fs.openSync(src, "wx");
    attempted.push(src); // owned from the moment the exclusive open succeeds
    try {
      fs.writeSync(fd, "probe");
    } finally {
      fs.closeSync(fd);
    }
    const reflinkDst = path.join(root, `${tag}-r`);
    attempted.push(reflinkDst);
    if (spawnSync("cp", ["--reflink=always", src, reflinkDst], { stdio: "ignore" }).status === 0) return "reflink";
    const linkDst = path.join(root, `${tag}-h`);
    attempted.push(linkDst);
    fs.linkSync(src, linkDst);
    return "hardlink";
  } catch {
    return null;
  } finally {
    for (const f of attempted) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

function copyTree(mode, src, dest) {
  sh("cp", mode === "reflink" ? ["-a", "--reflink=always", src, dest] : ["-al", src, dest]);
}

// Package names patched by patch-package. Filenames: "name+1.2.3.patch",
// "@scope+name+1.2.3.patch", nested "a++b+1.0.0.patch", sequenced
// "name+1.2.3+001+desc.patch", and ".dev.patch". The name is everything before the
// first version-looking token.
function patchedNames(root) {
  const dir = path.join(root, "patches");
  if (!fs.existsSync(dir)) return [];
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".patch")) continue;
    const tokens = f.replace(/(\.dev)?\.patch$/, "").split("++").pop().split("+");
    const vi = tokens.findIndex((t, i) => i > 0 && /^\d+\.\d+\.\d+/.test(t));
    if (vi > 0) names.add(tokens.slice(0, vi).join("/"));
  }
  return [...names];
}

// Lockfile package paths (relative to root) of patched packages that are actually
// installed: kept as private copies in hardlink mode, because patch-package writes those
// files in place.
function privatePaths(root, lock) {
  const names = patchedNames(root);
  if (!names.length) return [];
  return Object.keys(lock.packages || {}).filter(
    (k) =>
      names.some((n) => k === `node_modules/${n}` || k.endsWith(`/node_modules/${n}`)) &&
      fs.existsSync(path.join(root, k)),
  );
}

// Every hidden lockfile npm may rewrite in place (top-level and nested) gets a private file.
function unshareHiddenLockfiles(dir) {
  const out = sh("find", [dir, "-name", ".package-lock.json", "-type", "f", "-print0"]);
  for (const p of out.split("\0").filter(Boolean)) {
    const buf = fs.readFileSync(p);
    fs.unlinkSync(p);
    fs.writeFileSync(p, buf);
  }
}

// Make shared files read-only (the tripwire), skipping private package dirs and hidden
// lockfiles. Only touches files that currently have a write bit.
function armReadOnly(dir, d, privates) {
  const args = [dir];
  for (const p of privates) {
    if (p.startsWith(`${d}/`)) args.push("-path", path.join(dir, p.slice(d.length + 1)), "-prune", "-o");
  }
  args.push("-type", "f", "!", "-name", ".package-lock.json", "-perm", "/222", "-exec", "chmod", "a-w", "{}", "+");
  sh("find", args);
}

// Replace private package dirs in a freshly hardlinked tree with real copies from `src`.
function privatize(treeDir, d, src, privates) {
  for (const p of privates) {
    if (!p.startsWith(`${d}/`)) continue;
    const rel = p.slice(d.length + 1);
    if (!fs.existsSync(path.join(src, rel))) continue;
    fs.rmSync(path.join(treeDir, rel), { recursive: true, force: true });
    sh("cp", ["-a", path.join(src, rel), path.join(treeDir, rel)]);
  }
}

// Symlinks pointing at absolute paths inside the worktree would point back
// into the source worktree after copying. Refuse to snapshot those.
function nonPortableLink(root, dirs) {
  for (const d of dirs) {
    const out = sh("find", [path.join(root, d), "-type", "l", "-lname", `${root}/*`, "-print", "-quit"]);
    if (out.trim()) return out.trim();
  }
  return null;
}

// A regular, hardlinked, non-private file, for counting users in `ls` (hardlink mode).
function pickProbe(entry, dirs, privates) {
  for (const d of dirs) {
    const stack = [path.join(entry, d)];
    while (stack.length) {
      const dir = stack.shift();
      let names;
      try {
        names = fs.readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (name === ".package-lock.json" || name === ".bin") continue;
        const full = path.join(dir, name);
        const rel = path.relative(entry, full);
        if (privates.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
        let st;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isFile() && st.nlink > 1) return rel;
        if (st.isDirectory()) stack.push(full);
      }
    }
  }
  return null;
}

function gitHooksDir(root) {
  const r = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  const p = r.status === 0 ? r.stdout.trim() : "";
  return p ? path.resolve(root, p) : null;
}

// Listing of everything outside node_modules (files, dirs, symlinks, with size, times and
// mode), for a before/after comparison that sees creations, deletions (tracked or ignored,
// files or empty dirs) and modifications alike. Throws on an unreadable entry or when the
// tree is too large, so the caller fails closed.
// Only the node_modules dirs a snapshot stores (root and declared workspaces) are skipped;
// any other node_modules is listed like ordinary project content. The root's own mode is
// recorded too.
function listOutside(root, hooks) {
  const stored = new Set(
    ["node_modules", ...(workspaceDirs(root) || []).map((w) => path.join(w, "node_modules"))].map((d) =>
      path.join(root, d),
    ),
  );
  const out = new Map([[".", `d:${fs.statSync(root).mode}`]]);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true }); // throws if unreadable
    for (const e of entries) {
      if (out.size > SCAN_LIMIT) throw new Error("scan limit reached");
      const full = path.join(dir, e.name);
      if (e.name === ".git" || stored.has(full) || /\.npm-link-new-/.test(e.name)) continue;
      if (hooks && full === hooks) continue;
      const rel = path.relative(root, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out.set(rel, `l:${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) {
        out.set(rel, `d:${st.mode}`); // mode, not times: directory times churn on any entry change
        stack.push(full);
      } else out.set(rel, `f:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`);
    }
  }
  return out;
}

function firstDifference(before, after) {
  for (const [k, v] of after) if (before.get(k) !== v) return before.has(k) ? `changed ${k}` : `created ${k}`;
  for (const k of before.keys()) if (!after.has(k)) return `deleted ${k}`;
  return null;
}

// Electron downloads its binary on first run, into node_modules/electron/dist. Fetch it
// before snapshotting so it is stored once instead of downloaded by every worktree.
// Skipped when npm config could retarget the download (a direct `node install.js` would
// not see npm's lifecycle environment). Cancellable. Returns { signal } if killed and
// { failed: true } on any other failure, so the caller can refuse to store a partial dist.
async function prefetchElectron(root, dirs, cfg) {
  const retarget = Object.keys(cfg).find((k) => TARGET_CONFIG.test(k) && cfg[k] !== null && cfg[k] !== "");
  if (retarget) {
    log(`skipping Electron prefetch: npm config sets ${retarget}`);
    return {};
  }
  for (const d of dirs) {
    const pkgDir = path.join(root, d, "electron");
    if (!fs.existsSync(path.join(pkgDir, "install.js")) || fs.existsSync(path.join(pkgDir, "path.txt"))) continue;
    log(`prefetching Electron binary in ${path.join(d, "electron")}`);
    let result;
    try {
      result = await runChild(process.execPath, ["install.js"], { cwd: pkgDir });
    } catch {
      return { failed: true }; // could not even spawn (EAGAIN, ...)
    }
    if (result.signal) return { signal: result.signal };
    if (result.status !== 0) return { failed: true };
  }
  return {};
}

// Hooks in the git hooks dir as "name:x" / "name:-" (executable or not). Contents are
// not compared: lefthook embeds the worktree's absolute path, so they legitimately differ.
function hookInfo(hooks) {
  if (!hooks) return [];
  try {
    return fs
      .readdirSync(hooks)
      .sort()
      .map((n) => `${n}:${fs.statSync(path.join(hooks, n)).mode & 0o111 ? "x" : "-"}`);
  } catch {
    return [];
  }
}

// After prepare on a hit: the hooks must be exactly the recorded set (names and exec
// bits), and every one must have been (re)written since `since`, i.e. by prepare itself,
// not left over from a checkout or another tool.
function hooksReproduced(hooks, expected, since) {
  if (!expected.length) return true;
  const now = hookInfo(hooks);
  if (now.length !== expected.length || now.some((h, i) => h !== expected[i])) return false;
  return expected.every((h) => {
    try {
      return fs.statSync(path.join(hooks, h.slice(0, h.lastIndexOf(":")))).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

function snapshot(root, key, mode, privates, hooks = []) {
  const dirs = nodeModulesDirs(root);
  const bad = nonPortableLink(root, dirs);
  if (bad) {
    log(`not caching: absolute symlink into the worktree at ${bad}`);
    return false;
  }
  fs.mkdirSync(STORE, { recursive: true });
  const final = path.join(STORE, key);
  if (fs.existsSync(final)) return true;
  const tmp = fs.mkdtempSync(path.join(STORE, `.tmp-${key}-`));
  try {
    for (const d of dirs) {
      fs.mkdirSync(path.dirname(path.join(tmp, d)), { recursive: true });
      copyTree(mode, path.join(root, d), path.join(tmp, d));
      for (const ex of SNAPSHOT_EXCLUDES) {
        fs.rmSync(path.join(tmp, d, ex), { recursive: true, force: true });
      }
      if (mode === "hardlink") {
        privatize(path.join(tmp, d), d, path.join(root, d), privates);
        unshareHiddenLockfiles(path.join(tmp, d));
        armReadOnly(path.join(tmp, d), d, privates);
      }
    }
    fs.writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify(
        {
          id: randomUUID(), // identity: restore checks it is still the entry it copied
          dirs,
          mode,
          privates,
          hooks,
          probe: mode === "hardlink" ? pickProbe(tmp, dirs, privates) : null,
          source: root,
          created: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    try {
      fs.renameSync(tmp, final);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      // Only "another install with the same key won the race" counts as stored.
      if (!fs.existsSync(path.join(final, "manifest.json"))) throw e;
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return true;
}

// Stage every dir first; only touch the live install once all copies succeeded. Any
// failure removes what this call staged and rethrows, so the caller can fall back.
function restore(root, key) {
  const entry = path.join(STORE, key);
  const manifestPath = path.join(entry, "manifest.json");
  const { id, dirs, mode, privates = [] } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const now = new Date();
  fs.utimesSync(manifestPath, now, now); // last-use time, for prune
  const suffix = `.npm-link-new-${process.pid}`;
  // Leftovers from an earlier restore killed mid-way.
  for (const d of dirs) {
    const parent = path.dirname(path.join(root, d));
    const base = path.basename(d);
    try {
      for (const n of fs.readdirSync(parent)) {
        if (n.startsWith(`${base}.npm-link-new-`)) fs.rmSync(path.join(parent, n), { recursive: true, force: true });
      }
    } catch {}
  }
  const staged = dirs.map((d) => path.join(root, d) + suffix);
  try {
    dirs.forEach((d, i) => {
      fs.mkdirSync(path.dirname(staged[i]), { recursive: true });
      copyTree(mode, path.join(entry, d), staged[i]);
      if (mode === "hardlink") {
        // Re-arm the tripwire on the shared inodes (npm's bin-linking may have reopened
        // some), then give this tree its own private packages and hidden lockfiles.
        armReadOnly(path.join(entry, d), d, privates);
        privatize(staged[i], d, path.join(entry, d), privates);
        unshareHiddenLockfiles(staged[i]);
      }
    });
    // Removal renames an entry away (atomically) before deleting it, so if the SAME entry
    // (same id, not a replacement published under the key) is still here, every copy
    // above read it complete.
    let idNow = null;
    try {
      idNow = JSON.parse(fs.readFileSync(manifestPath, "utf8")).id;
    } catch {}
    if (!id || idNow !== id) throw new Error("store entry was removed or replaced during restore");
    // npm ci removes every existing node_modules first; do the same, now that it's safe.
    for (const d of nodeModulesDirs(root)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    dirs.forEach((d, i) => fs.renameSync(staged[i], path.join(root, d)));
  } catch (e) {
    for (const s of staged) fs.rmSync(s, { recursive: true, force: true });
    throw e;
  }
}

// The tail of npm ci's lifecycle, with the install's flags (so --omit=dev still sets
// NODE_ENV=production). `npm run prepare` runs preprepare/postprepare itself.
async function runPrepareScripts(pkg, flags) {
  const s = pkg.scripts || {};
  const passOn = flags.filter((f) => f !== "--ignore-scripts");
  if (s.prepare) return runNpm(["run", "prepare", ...passOn]);
  // Without prepare, run each hook alone: --ignore-scripts stops `npm run preprepare` from
  // also running a "prepreprepare" that npm ci would never run (the named script still runs).
  for (const ev of ["preprepare", "postprepare"]) {
    if (!s[ev]) continue;
    const status = await runNpm(["run", ev, ...passOn, "--ignore-scripts"]);
    if (status !== 0) return status;
  }
  return 0;
}

const hasInstallScripts = (pkg) =>
  ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare"].some((s) => pkg.scripts?.[s]);
const hasPrepare = (pkg) => ["prepare", "preprepare", "postprepare"].some((s) => pkg.scripts?.[s]);

async function ci(args) {
  const root = process.cwd();
  const flags = args.slice(1);
  const passthrough = (why) => {
    log(`pass-through (${why})`);
    return runNpm(args);
  };
  const lockName = lockfileName(root);
  if (!lockName) return runNpm(args); // not a project the shim could cache; stay quiet
  let pkg;
  try {
    pkg = readPkg(root);
  } catch {
    return runNpm(args);
  }
  if (!allowlist().has(pkg.name)) return runNpm(args); // opt-in only; stay quiet
  if (flags.some((f) => !NEUTRAL_FLAGS.test(f) && !KEYED_FLAGS.test(f))) return passthrough("unsupported flags");

  let cfg, key, mode, privates;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, lockName), "utf8"));
    if (!lock.packages) return passthrough(`${lockName} has no "packages" (lockfile v1)`);
    cfg = effectiveConfig(root, flags);
    if (cfg["dry-run"]) return passthrough("dry run");
    if (pkg.scripts?.prepublish) return passthrough("root prepublish script");
    for (const ev of ["preinstall", "install", "postinstall"]) {
      const s = pkg.scripts?.[ev];
      if (s && !installScriptEntry(s)) return passthrough(`root ${ev} is not a plain \`node <file>\``);
    }
    const ws = workspaceDirs(root);
    if (ws === null) return passthrough("unsupported workspaces glob");
    // Workspace lifecycle scripts can write anywhere and their code isn't hashed.
    const wsWithScripts = ws.find((w) => {
      try {
        return hasInstallScripts(readPkg(path.join(root, w)));
      } catch {
        return false;
      }
    });
    if (wsWithScripts) return passthrough(`workspace ${wsWithScripts} has install scripts`);
    fs.mkdirSync(STORE, { recursive: true });
    mode = copyMode(root, STORE);
    if (!mode) return passthrough("cannot reflink or hardlink between project and store");
    key = computeKey(root, cfg, mode);
  } catch (e) {
    return passthrough(`store or inputs unavailable: ${e.message}`);
  }
  const ignoreScripts = Boolean(cfg["ignore-scripts"]);

  const entry = path.join(STORE, key);
  const started = Date.now();
  // The hooks dir is exempt from the outside-change check only when a prepare script will
  // run again on a hit; the hooks present after the miss are recorded and, on a hit, must
  // come back exactly and freshly written by prepare.
  const hooks = !ignoreScripts && hasPrepare(pkg) ? gitHooksDir(root) : null;
  if (fs.existsSync(path.join(entry, "manifest.json"))) {
    let expectedHooks = [];
    try {
      expectedHooks = JSON.parse(fs.readFileSync(path.join(entry, "manifest.json"), "utf8")).hooks || [];
      restore(root, key);
    } catch (e) {
      log(`restore of ${key} failed (${e.message}); running real npm ci`);
      return runNpm(args);
    }
    log(`hit ${key} (${mode}): linked node_modules in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (ignoreScripts) return 0;
    const prepareStart = Date.now() - 50; // file times use a coarse clock that can lag a few ms
    const status = await runPrepareScripts(pkg, flags);
    if (status !== 0) return status;
    if (!hooksReproduced(hooks, expectedHooks, prepareStart)) {
      // Something other than prepare (e.g. postinstall) made or changed hooks on the miss.
      log(`prepare did not reproduce the hooks (${expectedHooks.join(" ")}); running real npm ci`);
      return runNpm(args);
    }
    return 0;
  }
  log(`miss ${key} (${mode}): running real npm ci`);
  let before = null;
  try {
    before = listOutside(root, hooks);
  } catch (e) {
    log(`will not cache: cannot list the project before installing (${e.message})`);
  }
  const status = await runNpm(args);
  if (status !== 0 || !before) return status;
  try {
    const change = firstDifference(before, listOutside(root, hooks));
    if (change) {
      log(`not caching: the install changed something outside node_modules (${change})`);
      return 0;
    }
  } catch (e) {
    log(`not cached (install itself succeeded): ${e.message}`);
    return 0;
  }
  if (!ignoreScripts) {
    const pf = await prefetchElectron(root, nodeModulesDirs(root), cfg);
    if (pf.signal) {
      // Cancelled: exit the way the prefetch did, not with npm ci's success.
      process.kill(process.pid, pf.signal);
      return 128 + (os.constants.signals[pf.signal] || 1);
    }
    if (pf.failed) {
      log("not caching: Electron prefetch failed (it will download on first run instead)");
      return 0;
    }
  }
  try {
    // Last check before publishing: inputs (files AND npm's effective config, re-read)
    // edited at any point since hashing would file this install under a key that no
    // longer describes it.
    if (computeKey(root, effectiveConfig(root, flags), mode) !== key) {
      log("not caching: install inputs changed while installing");
      return 0;
    }
    const lock = JSON.parse(fs.readFileSync(path.join(root, lockName), "utf8"));
    privates = mode === "hardlink" ? privatePaths(root, lock) : [];
    if (snapshot(root, key, mode, privates, hookInfo(hooks))) log(`stored ${key}`);
  } catch (e) {
    log(`not cached (install itself succeeded): ${e.message}`);
  }
  return 0;
}

// Every removal goes through here: rename the entry away atomically, then delete it, so a
// racing restore either copies the complete entry or sees it gone, never half-deleted.
function removeEntry(key) {
  const trash = path.join(STORE, `.trash-${key}-${randomUUID()}`);
  try {
    fs.renameSync(path.join(STORE, key), trash);
  } catch {
    return false;
  }
  fs.rmSync(trash, { recursive: true, force: true });
  return true;
}

async function store(argv) {
  const [cmd, arg] = argv;
  fs.mkdirSync(STORE, { recursive: true });
  const names = fs.readdirSync(STORE);
  const entries = names.filter((n) => !n.startsWith("."));
  const manifest = (key) => JSON.parse(fs.readFileSync(path.join(STORE, key, "manifest.json"), "utf8"));
  const lastUse = (key) => {
    try {
      return fs.statSync(path.join(STORE, key, "manifest.json")).mtimeMs;
    } catch {
      return 0;
    }
  };
  // Hardlink mode only: the probe file's link count is how many trees share it.
  const users = (m, key) => {
    if (m.mode === "reflink") return "n/a";
    const probe = path.join(STORE, key, m.probe || path.join("node_modules", ".package-lock.json"));
    return fs.existsSync(probe) ? fs.statSync(probe).nlink - 1 : 0;
  };
  if (cmd === "ls") {
    for (const k of entries) {
      let m = {};
      try {
        m = manifest(k);
      } catch {}
      const used = new Date(lastUse(k)).toISOString();
      console.log(`${k}  mode=${m.mode || "hardlink"}  in-use-by=${users(m, k)}  last-used=${used}  from=${m.source}`);
    }
  } else if (cmd === "prune") {
    // Deleting an entry never breaks a worktree (hardlinks and reflinks keep their data);
    // it only stops future sharing. So prune by last use. The entry is first renamed away
    // atomically and only then deleted, so a racing restore either copies a complete entry
    // or finds it gone (and falls back to real npm ci); it never sees a half-deleted one.
    const days = Number(arg ?? PRUNE_DEFAULT_DAYS);
    if (!Number.isFinite(days) || days < 0) {
      console.error("usage: shim.mjs --store prune [days]");
      return 2;
    }
    for (const k of entries) {
      if (Date.now() - lastUse(k) > days * 86_400_000 && removeEntry(k)) console.log(`removed ${k}`);
    }
    for (const n of names.filter((n) => /^\.(tmp-|npm-link-probe-|trash-)/.test(n))) {
      const p = path.join(STORE, n);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) {
          fs.rmSync(p, { recursive: true, force: true });
          console.log(`removed ${n}`);
        }
      } catch {}
    }
  } else if (cmd === "rm" && arg) {
    if (!removeEntry(arg)) {
      console.error(`no such entry: ${arg}`);
      return 1;
    }
  } else if (cmd === "seed" && arg) {
    // Store an existing, known-good install without reinstalling it.
    const root = path.resolve(arg);
    process.chdir(root);
    const mode = copyMode(root, STORE);
    if (!mode) {
      console.error("cannot reflink or hardlink between that directory and the store");
      return 1;
    }
    const lock = JSON.parse(fs.readFileSync(path.join(root, lockfileName(root)), "utf8"));
    const pkg = readPkg(root);
    for (const ev of ["preinstall", "install", "postinstall"]) {
      const s = pkg.scripts?.[ev];
      if (s && !installScriptEntry(s)) {
        console.error(`root ${ev} is not a plain \`node <file>\`; not seeding`);
        return 1;
      }
    }
    const cfg = effectiveConfig(root, []);
    const key = computeKey(root, cfg, mode);
    const privates = mode === "hardlink" ? privatePaths(root, lock) : [];
    // Same hooks record a miss would make, so hits from a seeded entry are checked too.
    const hooks = !cfg["ignore-scripts"] && hasPrepare(pkg) ? hookInfo(gitHooksDir(root)) : [];
    console.log(snapshot(root, key, mode, privates, hooks) ? `seeded ${key} (${mode}) from ${root}` : "not seeded");
  } else {
    console.error("usage: shim.mjs --store ls | prune [days] | rm <key> | seed <dir>");
    return 2;
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--store") return store(argv.slice(1));
  if (process.env.NPM_LINK_SHIM === "0" || !CI_COMMANDS.has(argv[0])) return runNpm(argv);
  return ci(argv);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`error: ${e.message}`);
    process.exit(1);
  },
);
