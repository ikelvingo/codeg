// ACP end-to-end probe for the fork/hydration design.
//
// Answers, against the REAL harness (not codeg):
//   1. does `session/fork` replay anything?            (design assumes: no)
//   2. does `session/load` on the child replay the seed? (design assumes: yes)
//   3. which frame kinds does that replay contain?     (Advisor: verify per class)
//   4. is the child still usable afterwards (prompt)?
//   5. can the child be forked again?
import { spawn } from "node:child_process"

const PKG = "file:/home/kelvin/.local/share/codeg/agent-shims/codeg-local-agents-1.1.10.tgz"
const CWD = "/home/kelvin/workspace/s&f-free"

const child = spawn("npx", ["--yes", "--package", PKG, "codeg-dsh"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
})

let nextId = 1
const pending = new Map()
const updates = []
let phase = "boot"

const stderrTail = []
child.stderr.setEncoding("utf8")
child.stderr.on("data", (d) => {
  stderrTail.push(String(d))
  if (stderrTail.length > 60) stderrTail.shift()
})

child.stdout.setEncoding("utf8")
let buf = ""
child.stdout.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
})

function write(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n")
}

function send(method, params) {
  const id = nextId++
  write({ jsonrpc: "2.0", id, method, params })
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rej(new Error(`timeout waiting for ${method}`))
      }
    }, 120000)
  })
}

function handle(msg) {
  if (msg.method === "session/update") {
    updates.push({
      phase,
      sessionId: msg.params?.sessionId,
      kind: msg.params?.update?.sessionUpdate,
    })
    return
  }
  // agent -> client request: answer minimally so nothing hangs
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "session/request_permission") {
      const opts = msg.params?.options ?? []
      const allow = opts.find((o) => /allow/i.test(o.optionId ?? "")) ?? opts[0]
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        },
      })
    } else {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } })
    }
    return
  }
  if (msg.id !== undefined) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)))
    else p.res(msg.result)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function countByKind(from) {
  const m = {}
  for (const u of updates.slice(from)) m[u.kind] = (m[u.kind] ?? 0) + 1
  return m
}

async function main() {
  const out = {}
  await sleep(2000)
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  out.protocolVersion = init?.protocolVersion
  out.sessionCapabilities = init?.agentCapabilities?.sessionCapabilities ?? null

  const newSess = await send("session/new", { cwd: CWD, mcpServers: [] })
  const sid = newSess.sessionId
  out.parentSession = sid

  phase = "parent-prompt"
  await send("session/prompt", {
    sessionId: sid,
    prompt: [{ type: "text", text: "Reply with exactly: hi" }],
  })
  await sleep(800)
  out.parentUpdates = countByKind(0)

  // 1) tail fork — does the fork response replay the seeded history?
  const markFork = updates.length
  phase = "fork"
  const forkRes = await send("session/fork", { sessionId: sid, cwd: CWD, mcpServers: [] })
  const childId = forkRes.sessionId
  out.childSession = childId
  await sleep(1500)
  out.forkReplayedKinds = countByKind(markFork)
  out.forkReplayedTotal = updates.length - markFork

  // 2) session/load on the child — does it hand the seed back?
  const markLoad = updates.length
  phase = "load-child"
  out.loadError = null
  try {
    await send("session/load", { sessionId: childId, cwd: CWD, mcpServers: [] })
  } catch (e) {
    out.loadError = String(e.message)
  }
  await sleep(3000)
  out.loadReplayedKinds = countByKind(markLoad)
  out.loadReplayedTotal = updates.length - markLoad

  // 3) is the child still usable?
  const markPrompt = updates.length
  phase = "child-prompt"
  out.childPromptError = null
  try {
    await send("session/prompt", {
      sessionId: childId,
      prompt: [{ type: "text", text: "Reply with exactly: ok" }],
    })
  } catch (e) {
    out.childPromptError = String(e.message)
  }
  await sleep(2000)
  out.childPromptKinds = countByKind(markPrompt)

  // 4) fork the child again
  phase = "child-fork"
  out.childForkError = null
  out.grandchildSession = null
  try {
    const r = await send("session/fork", { sessionId: childId, cwd: CWD, mcpServers: [] })
    out.grandchildSession = r.sessionId
  } catch (e) {
    out.childForkError = String(e.message)
  }

  out.stderrTail = stderrTail.join("").slice(-700)
  console.log(JSON.stringify(out, null, 2))
}

main()
  .catch((e) => {
    console.log(
      JSON.stringify(
        { fatal: String(e.message), stderrTail: stderrTail.join("").slice(-1500) },
        null,
        2
      )
    )
  })
  .finally(() => {
    try {
      child.kill("SIGTERM")
    } catch {}
    setTimeout(() => process.exit(0), 800)
  })
