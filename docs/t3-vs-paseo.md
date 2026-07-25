# Paseo vs T3 Code — evaluation scorecard

Both stacks are deployed and share the same agent logins and the same `/srv` checkout, so
differences you observe are differences in the **tools**, not in their setup.

- Paseo — `paseo.example.com` → `:6767` — `docker/paseo/`
- T3 Code — `t3.example.com` → `:3773` — `docker/t3code/`

Fill in the **Verdict** column as you use them. The "Known from setup" rows are already
settled — they were established while building the stacks, so don't re-litigate them.

## Settled before you start

| Dimension | Paseo 0.2.1 | T3 Code 0.0.28 |
|---|---|---|
| Maturity | Stable enough to pin and deploy | `0.0.x`, published the day of this eval; README says "expect bugs", not accepting contributions |
| Auth model | Single shared password (`PASEO_PASSWORD`) | Per-client pairing tokens + scoped bearer sessions, derived from bind host |
| Fails open? | **Yes** — starts unauthenticated if the password is missing; needed a custom fail-closed entrypoint | No — non-loopback bind flips it to `remote-reachable` (read from bundle, not verified live) |
| Host header allowlist | `PASEO_HOSTNAMES`, and it broke on `httpHostHeader` rewriting | None observed |
| Provider coverage | claude, codex, pi (anything on `PATH`) | claude, codex, cursor-agent, opencode, grok — **no pi** |
| Built-in remote access | None; you bring the tunnel | T3 Connect relay (Clerk account + runtime cloudflared download) and Tailscale serve — both disabled here |
| Telemetry | None observed | PostHog — disabled here |
| Native deps | None added | `node-pty`, compiled from source on Linux (no prebuild) |

The provider row is the one that may decide this on its own: **T3 Code cannot drive Pi.**
If Pi is load-bearing for you, T3 Code is a replacement for part of your workflow, not all
of it.

## To judge by using them

Drive the *same* real task through both — ideally something multi-step in a repo under
`/srv`, not a toy prompt.

| Dimension | What to look for | Paseo | T3 Code |
|---|---|---|---|
| Session persistence | Close the tab mid-run and come back. Does the session survive? Does output replay? | | |
| Container restart | `docker restart` mid-session. What is recoverable? | | |
| Multi-repo / multi-project | Switching between projects under `/srv`; does it handle worktrees? | | |
| Concurrent sessions | Two agents running at once — does the UI stay usable? | | |
| Mobile browser | The actual reason for a web GUI. Usable on a phone over the tunnel? | | |
| Diff / review UX | Reading and approving changes without dropping to a terminal | | |
| Permission prompts | How agent approval requests surface, and whether they block | | |
| Terminal fidelity | TUI rendering, colours, resize, copy/paste | | |
| Latency over tunnel | Typing lag, streaming smoothness through Cloudflare | | |
| Failure modes | What happens when an agent crashes or a token expires | | |
| Git integration | Branch/commit/PR affordances, if any | | |

## Decision

Record the outcome here so the branch history explains itself:

- **Winner:**
- **Why:**
- **Deal-breaker found (if any):**
- **Date:**

If T3 Code wins, `t3code-test` needs work before merge: the image should stop depending on a
branch tag of `paseo-agents`, and the shared-credential model should be reconsidered — it is
right for an evaluation, but a permanent deployment probably wants the isolation the paseo
stack was designed around.

If Paseo wins, delete the stack in Portainer and the branch; nothing else references it.
