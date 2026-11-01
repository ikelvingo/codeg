// ACP probe: does a fork child's `session/load` replay TOOL CALLS, not just text?
//
// The Advisor's pre-deployment question. The first probe only exercised a
// text-only turn; this one makes the parent run a real tool call and then
// compares what the parent produced with what the child's replay carries.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const PROBE_FILE = "/tmp/acp-probe.txt"
const PROBE_TEXT = "PROBE-7391-TOOL-RESULT"
writeFileSync(PROBE_FILE, `${PROBE_TEXT}\n`)

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
// Every line as it ARRIVES, so the wire order can be asserted: the load
// response must come after every replayed session/update the agent sent.
const wire = []
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
    }, 300000)
  })
}

let permissionsAsked = 0

function handle(msg) {
  if (msg.method === "session/update") {
    const u = msg.params?.update ?? {}
    wire.push({ dir: "notif", kind: u.sessionUpdate, phase })
    updates.push({
      phase,
      sessionId: msg.params?.sessionId,
      kind: u.sessionUpdate,
      // Tool identity, so a replayed tool call can be matched to the live one.
      toolCallId: u.toolCallId ?? u.tool_call_id ?? null,
      toolTitle: u.title ?? u.kind ?? null,
      // Only the tool RESULT carries the file's text back.
      carriesProbeText: JSON.stringify(u).includes(PROBE_TEXT),
    })
    return
  }
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "session/request_permission") {
      permissionsAsked += 1
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
    wire.push({ dir: "resp", id: msg.id, phase, error: Boolean(msg.error) })
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)))
    else p.res(msg.result)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kinds = (from) => {
  const m = {}
  for (const u of updates.slice(from)) m[u.kind] = (m[u.kind] ?? 0) + 1
  return m
}
const toolCalls = (from) =>
  updates.slice(from).filter((u) => u.kind === "tool_call" || u.kind === "tool_call_update")

async function main() {
  const out = {}
  await sleep(2000)
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  const newSess = await send("session/new", { cwd: CWD, mcpServers: [] })
  const sid = newSess.sessionId
  out.parentSession = sid

  phase = "parent-prompt"
  await send("session/prompt", {
    sessionId: sid,
    prompt: [
      {
        type: "text",
        text:
          `Read the file ${PROBE_FILE} using your file-reading tool, then reply with ` +
          `exactly the line you found. Do not guess.`,
      },
    ],
  })
  await sleep(2500)
  out.parentKinds = kinds(0)
  out.parentToolCalls = toolCalls(0).map((u) => ({ kind: u.kind, id: u.toolCallId }))
  out.parentCarriedProbeText = updates.slice(0).filter((u) => u.carriesProbeText).length
  out.permissionsAsked = permissionsAsked

  const markFork = updates.length
  phase = "fork"
  const forkRes = await send("session/fork", { sessionId: sid, cwd: CWD, mcpServers: [] })
  const childId = forkRes.sessionId
  out.childSession = childId
  await sleep(1500)
  out.forkReplayedKinds = kinds(markFork)

  const markLoad = updates.length
  phase = "load-child"
  out.loadError = null
  try {
    await send("session/load", { sessionId: childId, cwd: CWD, mcpServers: [] })
  } catch (e) {
    out.loadError = String(e.message)
  }
  await sleep(3500)
  out.loadReplayedKinds = kinds(markLoad)
  out.loadToolCalls = toolCalls(markLoad).map((u) => ({ kind: u.kind, id: u.toolCallId }))
  out.loadCarriedProbeText = updates.slice(markLoad).filter((u) => u.carriesProbeText).length

  // The decisive ordering check: within the load phase, is every session/update
  // line ahead of the load response line?
  const loadWire = wire.filter((w) => w.phase === "load-child")
  const lastNotif = loadWire.map((w) => w.dir).lastIndexOf("notif")
  const firstResp = loadWire.findIndex((w) => w.dir === "resp")
  out.loadWireOrder = loadWire.map((w) => (w.dir === "notif" ? `notif:${w.kind}` : `resp:${w.id}`))
  out.loadResponseAfterAllFrames = firstResp >= 0 && firstResp > lastNotif
  out.stderrTail = stderrTail.join("").slice(-500)
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
