# ACP custom-agent fork fix

A fork-only patch, not upstream. Scope is **custom agents** (`custom:*`); built-in
agent behaviour is unchanged. Everything here is about one class of bug: forking
a conversation at a turn, for agents that keep no server-side session store.

## What was broken

| Symptom | Root cause |
|---|---|
| A forked branch opens with no history | `session/fork` seeds the child on the agent side and returns nothing; the child transcript was created with a header only (measured: 0 turns) |
| Forking again inside a branch fails with `TurnNotFound` | the fork repointed the session to an empty transcript; the next click resolved the turn against the new, empty file |
| Forking a turn from an older session segment failed with the agent's `invalid params` | codeg sent the turn's `agent_message_id` without checking the agent still holds it |
| A partially written replay could truncate history permanently | `has_recorded_history` reads the FILE, so a half-written replay looks like history and is never retried |

## The fix, in one paragraph

A custom agent has no store, so codeg's transcript **is** the branch history.
After a successful fork, codeg replays the child through `session/load` and
drains it into the child transcript. The replay is staged in a sidecar and
published with a single rename only after a clean drain, through the session's
own writer queue — so a failed or half-written replay never becomes history, and
no append can interleave with the header-only check and the rename. Fork points
for custom agents are resolved from the turn's `agent_message_id`; the request
carries `_meta.jetbrains.air.fork.messageId` only, and codeg refuses (rather than
silently falling back to the tail) when the turn is unnamed or absent. The
precheck refuses only on *proven* absence — a transcript that exists, was read to
EOF, and does not contain the id.

## Files

```
src-tauri/src/acp/connection.rs                  hydration; transcript_dir_for
src-tauri/src/acp/fork.rs                       ForkPointError, resolve_fork_point, session_lacks_message_id
src-tauri/src/acp/manager.rs                    custom-only refusals + precheck
src-tauri/src/acp_transcript.rs                 session_records_message_id*, HydrationStaging, PendingRecord::Publish
src-tauri/src/parsers/acp_native.rs             PendingTurn.agent_message_id
src/components/conversations/conversation-detail-panel.tsx   forkInFlight
src/components/message/message-list-view.tsx    forkDisabled
src/lib/api.ts                                  fork error surfacing
```

## Re-applying after an upstream release

```bash
git remote add upstream https://github.com/spacering-net/codeg.git   # once
git fetch upstream
git rebase upstream/main
cargo check --no-default-features --features server-bin --bin codeg-server
cargo test --lib --no-default-features --features server-bin -- acp_transcript::   # 32 passed
cargo test --lib --no-default-features --features server-bin -- acp::fork::        # 27 passed
```

Version scheme: a fork build carries the upstream version plus one patch digit
(upstream `0.41.3` → this branch `0.41.4`), so it sorts above the release it sits
on and the desktop updater never offers a downgrade. Bump `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the `codeg` entry in
`src-tauri/Cargo.lock` together; on the next upstream release those four lines
conflict during rebase — take upstream's version, then bump again.

## Evidence

- [`ACP-FORK-FIX.md`](ACP-FORK-FIX.md) — the fix, the ordering evidence, the
  known limitations. Start here.
- [`HANDOFF.md`](HANDOFF.md) — the chronological review log (Chinese): what each
  review round challenged and what it changed. Written against `b56c6a9d`
  (v0.41.1); the branch has since been rebased to v0.41.3, so treat its file
  positions as historical, not current.
- [`probes/`](probes) — the ACP probes used to measure the wire, rather than
  infer it. They spawn `codeg-dsh` directly over stdio and print what arrives:
  - `acp-e2e.mjs` — a text-only turn: fork, load the child, dump the frame order.
  - `acp-e2e-tools.mjs` — the same with a real tool call, which is what showed
    that the recordable frames all precede the `session/load` response while
    `available_commands_update` trails it.

  Run with `node probes/acp-e2e-tools.mjs`. Both expect the custom agent to be
  installed as `codeg-dsh`; edit the launch command at the top to match your
  own setup. They write `/tmp/acp-probe.txt` to give the parent a real file to
  read.

## Known limitations

- **Turns whose recorded id is a message UUID cannot be forked.** The DSH
  adapter builds its fork index with `assistantMessageId(data) = \`${turn}:${step}\``,
  so only `turn:step` ids resolve. Harness releases before 0.4.40 put the message
  UUID in the chunk's `messageId`; turns recorded by those are permanently
  unforkable. Measured switch in one session: 20:05 (UUID) → 20:26 (`turn:step`),
  with the 0.4.40 install at 20:07.
- **Turns from an older session segment cannot be forked.** ACP's `session/fork`
  addresses only the connection's current session, so an ancestor segment
  (`continues_from`) is out of reach; codeg now says so instead of forwarding an
  id the agent will reject.
- **The `poisoned` writer branch** has code grounds but no test coverage.
- Compatibility with unknown custom adapters' `_meta` handling is unverified;
  DSH (`@openma/deepseek-harness-acp`) and omp are the two checked.
