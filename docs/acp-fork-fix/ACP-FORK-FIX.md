# ACP fork fix for custom agents (branch: fix/custom-agent-fork-history)

Baseline: rebased onto `ddd1f09f` (= origin/main **v0.41.3**); originally written
against `b56c6a9d` (v0.41.1). Scope: **custom agents only** — built-in agent
behaviour is unchanged.

**Version scheme.** Fork builds carry the upstream version plus one patch digit,
so a build of this branch is always NEWER than the upstream release it sits on
and the desktop updater never offers a downgrade: upstream `0.41.3` →
this branch `0.41.4`. Bump `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and the `codeg` entry in `src-tauri/Cargo.lock` together.
On the next upstream release these four lines conflict during rebase — take
upstream's version, then bump again.

## 1. What was broken

| # | Symptom | Root cause |
|---|---|---|
| 1 | A forked branch opens with **no history** | `session/fork` seeds the child on the agent side and returns nothing; the child transcript was created with a header only (measured: 0 turns) |
| 2 | Forking again inside a branch fails with `TurnNotFound` | the fork repointed the session to an empty transcript; a second click resolved the turn against the new, empty file |
| 3 | Forking a turn from an **older session segment** failed with the agent's `invalid params` | codeg sent the turn's `agent_message_id` without checking the agent still holds it |
| 4 | A partially written replay could truncate history permanently | `has_recorded_history` reads the FILE, so a half-written replay looks like history and is never retried |

## 2. The fix

- **Hydration** (`src-tauri/src/acp/connection.rs`, `src-tauri/src/acp_transcript.rs`)
  After a successful custom-agent fork, send `session/load` and drain the replay
  into the child transcript. The replay is STAGED in a sidecar and published with
  one rename only when the drain ends cleanly (`DrainEnd::Quiet`) and nothing
  failed. Publishing goes through the session's own `SessionWriter` queue, so the
  header-only check and the rename cannot be interleaved by an append.
  Ordering evidence: both adapters write every replay frame before the load
  response (`legacyHandler` awaits the handler, then `responder.respond`;
  `stepKey`/`waitUntilInitialized` make each frame a plain microtask on the
  shared serial `writeQueue`).
- **Fork point** (`src-tauri/src/acp/fork.rs`, `src-tauri/src/acp/manager.rs`)
  Custom agents send `_meta.jetbrains.air.fork.messageId` only. Missing id →
  refuse; turn absent → refuse; built-ins keep the tail fallback (`Ok(None)`).
- **Conservative precheck** (`session_lacks_message_id`)
  Refuses only on PROVEN absence (transcript exists, read to EOF, id not found).
  Unknown (missing/unreadable file) never refuses.
- **Parser** (`src-tauri/src/parsers/acp_native.rs`)
  `PendingTurn.agent_message_id` records the LAST non-empty
  `AgentMessageChunk.message_id`; blank ids never erase a recorded one.
- **Frontend** (`conversation-detail-panel.tsx`, `message-list-view.tsx`, `lib/api.ts`)
  `forkInFlight` guard disables the fork button while a fork is in flight
  (the double-click that produced two POSTs ~14 ms apart).

## 3. Re-applying this after an upstream codeg update

```bash
git remote add upstream https://github.com/spacering-net/codeg.git   # once
git fetch upstream
git rebase upstream/main          # or: git cherry-pick <this commit>
cargo check
cargo test --lib -- acp_transcript::   # 32 passed
cargo test --lib -- acp::fork::        # 27 passed
```

Files this fix touches (8):

```
src-tauri/src/acp/connection.rs                  hydration, transcript_dir_for
src-tauri/src/acp/fork.rs                        ForkPointError, resolve_fork_point, session_lacks_message_id
src-tauri/src/acp/manager.rs                     custom-only refusals + precheck
src-tauri/src/acp_transcript.rs                  session_records_message_id*, HydrationStaging, PendingRecord::Publish
src-tauri/src/parsers/acp_native.rs              PendingTurn.agent_message_id
src/components/conversations/conversation-detail-panel.tsx   forkInFlight
src/components/message/message-list-view.tsx     forkDisabled
src/lib/api.ts                                   fork error surfacing
```

If upstream rewrites `acp_transcript.rs` or `connection.rs`, the two pieces to
keep are: (a) publish only after a clean drain, through the writer queue;
(b) never fork a custom agent at an id the agent may not hold.

## 4. Known limitations (not fixed here)

- **Turns whose recorded id is a message UUID cannot be forked.**
  `@openma/deepseek-harness-acp` builds its fork index with
  `assistantMessageId(data) = \`${turn}:${step}\``, so only `turn:step` ids
  resolve. Harness versions before 0.4.40 put the message UUID
  (`data.message.id`) in the chunk's `messageId`; those turns are permanently
  unforkable. Measured switch: session `5b430c78`, 2026-10-28 20:05 (UUID) →
  20:26 (`turn:step`), with the 0.4.40 install at 20:07.
- **Turns from an older session segment** (`continues_from` ancestor) cannot be
  forked: ACP's `session/fork` only addresses the connection's current session.
- **`poisoned` writer branch** has code grounds but no test coverage.
- Unknown custom adapters' `_meta` compatibility is unverified (DSH and omp are
  the two verified).
- crush is unsupported (its `loadSession: false`, `fork` declared but not
  implemented) — abandoned by the user.
