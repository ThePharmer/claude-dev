# Codex bubblewrap inside the Paseo container

These profiles permit nested user namespaces and filesystem setup while retaining
Docker's other seccomp and AppArmor restrictions. They do not add `SYS_ADMIN`, make
bwrap setuid, disable the inner Codex sandbox, or change approval settings.

The operator ran `verify-host.sh` successfully on `docker-host` on 2026-09-11
with Codex 0.154.0 and bubblewrap 0.8.0. The disposable container confirmed active
seccomp and AppArmor, no outer `SYS_ADMIN`, allowed workspace writes, and denied
direct and symlink writes outside the workspace. Its final output was:

```text
PASS: Codex ran and enforced workspace writes without outer SYS_ADMIN.
```

After the Portainer stack was recreated on 2026-09-11, normal shell tool calls in
the live Paseo Codex session succeeded without escalation. Workspace writes passed;
direct and directory-symlink writes into `/home/paseo` failed with `EROFS`. A separate
outer-container check confirmed that the same parent directory was writable without
the inner sandbox and that Codex startup produced no helper-alias warning.

The live container reported `paseo-codex-bwrap (enforce)`, one outer seccomp filter,
and a capability bounding set without `SYS_ADMIN`. Sandboxed tool commands reported
two seccomp filters, `NoNewPrivs: 1`, and an empty capability bounding set. Temporary
boundary-test files were cleaned up.

Repeat the host test when changing the profiles, image, or host runtime. A running
container's inherited seccomp filter cannot be relaxed without recreating it.

## Install and test on the Docker host

From the checkout shared at `/srv/projects/claude-dev`, run:

```bash
sudo bash /srv/projects/claude-dev/docker/paseo/security/install-host.sh
sudo bash /srv/projects/claude-dev/docker/paseo/security/verify-host.sh
```

The installer requires AppArmor enabled, `apparmor_parser`, and Python 3. On Ubuntu,
`apparmor_parser` is supplied by the `apparmor` package. It validates both files,
backs up previous copies, installs seccomp under `/etc/docker/seccomp/`, and loads
`/etc/apparmor.d/paseo-codex-bwrap`. Installing under `/etc/apparmor.d/` also makes the
profile available to the host's AppArmor service on reboot. Docker is not restarted.
Reloading an existing named AppArmor profile affects containers already using it.

The test uses the exact image ID of the existing `paseo` container. An optional first
argument selects another locally available image. It starts a disposable container
with no project or login-volume mounts, overrides the service entrypoint, and makes
no model/API calls. It checks outer seccomp/AppArmor, absence of outer `SYS_ADMIN`,
workspace writes, and denial of direct and symlink writes outside the workspace.
For older images, the test repairs ownership of `/home/paseo/.codex/tmp` inside
that disposable container before invoking Codex. The root-run build-time version
probe left `tmp/arg0` owned by root with mode 0700, preventing helper alias creation.
The Dockerfile now corrects that ownership for future images. Existing persistent
home volumes may still need the one-time repair described below.
The test uses Codex 0.154.0's `codex sandbox -P :workspace -C DIR -- COMMAND`
syntax to select the built-in workspace-write profile explicitly. This version
has no `sandbox linux` subcommand or `--full-auto` option. Passing `linux` would
instead attempt to execute a program with that name inside the sandbox.
The temporary container has no network; this test does not validate Codex's network
policy independently. Do not update the stack if the test fails.

## Apply in Portainer after the test passes

Copy the installed seccomp profile into the Portainer container, then update the
existing Portainer stack using `docker/compose.yaml`. Preserve the stack name `paseo`
and its existing volumes and environment variables. Recreating Paseo interrupts
active sessions. No image rebuild is required for these profiles.

```bash
sudo docker cp /etc/docker/seccomp/paseo-codex-bwrap.json portainer:/data/paseo-codex-bwrap.json
```

The Compose file adds:

```yaml
security_opt:
  - seccomp=/data/paseo-codex-bwrap.json
  - apparmor=paseo-codex-bwrap
```

**Compose reads the seccomp file on the client side**, which here is Portainer's
Compose process, so the path refers to Portainer's `/data` volume, not the Docker
host. Installing `/etc/docker/seccomp/...` on the host alone does not expose it to
Portainer. Re-run the installer and repeat the `docker cp` after changing
`seccomp.json`. The named AppArmor profile is always
loaded on the Docker host. See [Compose's file handling](https://github.com/docker/compose/blob/main/pkg/compose/create.go).

After recreation, repeat `verify-host.sh`, then try a normal workspace-write Codex
session in Paseo. The disposable test does not exercise the persistent user config
or Paseo's complete app-server integration.

## Policy changes and provenance

`seccomp.json` uses the unmodified Moby seccomp/v0.2.3 baseline plus five rules:

| Syscall | Added allowance |
|---|---|
| `clone` | Flags contain `CLONE_NEWUSER` (0x10000000), excluding s390 argument ordering |
| `unshare` | Flags equal `CLONE_NEWNS` (0x20000) |
| `unshare` | Flags equal `CLONE_NEWUSER` (0x10000000) |
| `mount`, `pivot_root` | Allowed |
| `umount2` | Flags equal `MNT_DETACH` (2) |

The existing `clone3` ENOSYS fallback and capability-gated `setns` rule remain.
The added clone rule supports the image's amd64/arm64 targets; this is not a tested
profile for s390. AppArmor removes Docker's `deny mount` and permits `userns`,
`mount`, `umount`, and `pivot_root`. Its sensitive `/proc` and `/sys` denials remain.
The default `capability,` AppArmor rule permits capability checks; it does not grant
Linux capabilities removed from the outer container.

These mount and namespace permissions apply throughout the container. The mount
rules are broad, so this is a compatibility baseline, not a claim of minimal policy.

Sources:

- [Moby seccomp/v0.2.3](https://github.com/moby/profiles/tree/seccomp/v0.2.3), tree
  `f1a0fd6b5a369fca061b041539129661ed337ef5`; upstream `seccomp/default.json` SHA-256
  `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.
- [codex-broker profiles](https://github.com/jonasjancarik/codex-broker/tree/0517227a874ec410c75b2eb5577ed3711dff7231/examples)
  at commit `0517227a874ec410c75b2eb5577ed3711dff7231`. The five seccomp exceptions
  follow this example. The AppArmor file is adapted from its Apache-2.0 profile,
  itself derived from Moby apparmor/v0.2.1. Its name and self-peer references are
  changed to `paseo-codex-bwrap`; its unrelated AF_ALG denial is omitted. The example's
  additional socket restrictions are not copied into our Moby seccomp baseline.
- [Passing upstream CI](https://github.com/jonasjancarik/codex-broker/actions/runs/34598334520)
  loads the example profiles and runs a sandbox canary with Codex 0.153.4. It is
  evidence for the approach, not validation of this adapted pair on our host.
- [Codex 0.154.0 bwrap arguments](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/linux-sandbox/src/bwrap.rs).

Moby-derived profile material is Apache-2.0; see `LICENSE.Apache-2.0` and the source
attribution above. Preserve provenance when updating the baseline and rerun the
host test before deployment.

## Root-owned Codex helper directory

If Codex warns `could not create PATH aliases: Operation not permitted`, inspect
`/home/paseo/.codex/tmp/arg0`. Codex creates helper aliases under this directory and
sets its mode to 0700. When root owns it, the `paseo` user cannot initialize helpers.
With bubblewrap 0.8, the later error can be `execvp codex-linux-sandbox: No such file
or directory` because this version requires the helper alias compatibility path.

For an existing persistent home volume, repair just the scratch tree once:

```bash
sudo docker exec --user root paseo chown -hR paseo:paseo /home/paseo/.codex/tmp
```

The `-h` option changes symlink ownership without following helper links to the
installed executables. Restart affected Codex sessions after the repair so they
create fresh helper aliases. Changing the image alone does not repair an existing
home volume. This ownership repair does not change either security profile.

## Failure and rollback

If installation or the test fails, keep the running stack unchanged. Check the host
kernel log for AppArmor denials and retain the test output. Do not replace either
profile with `unconfined` to make the test pass.

To roll back an initial deployment, remove these two `security_opt` entries from the
stack and recreate it, preserving all volumes. This restores Docker's default
profiles and the original bwrap failure. Installed but unused profiles can remain.
For a later policy update, the installer prints the backup directory; restore its
previous files and reload the previous AppArmor profile before recreating containers
with the previous seccomp JSON. Never remove the `paseo-home` volume for this change.
