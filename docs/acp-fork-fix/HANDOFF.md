# ACP fork 修复 — 交接说明

基线: b56c6a9d (origin/main, v0.41.1)   仓库: /home/kelvin/workspace/codeg
状态: **已编译并通过聚焦测试（2026-10-29 01:33）**
  - 范围收窄：用户明确"修复范围局限于 fork 失败范畴"；历史水合 / 未知 adapter 兼容性 / fork 边界精度 = 超范围已知限制
  - cargo check: EXIT=0（本地副本 ~/codeg-check，CARGO_TARGET_DIR=~/.cache/codeg-target，需 PATH 加 ~/.cargo/bin）
  - 修复过程发现并修正一处编译错误：fork.rs ClaudeCode|DeepSeek 臂 `Ok(Some(ForkPoint {..})` 少一个右括号 → `}))`
  - cargo test --lib -- fork:: : 26 passed / 0 failed
  - cargo test --lib -- parsers::acp_native : 47 passed / 0 failed（含 4 个新 message-id 测试）

## Advisor 检验状态
Advisor 的角色**禁止使用工具**，必须把完整 diff 内联进任务文本才能复核。
它要求的是相对 b56c6a9d 的**完整 diff**，特别包括：
  - manager.rs: 从解析结果到实际发起 fork 的完整控制流
  - fork.rs: _meta 的构造（ForkPoint::to_meta，约 292 行）与调用位置

## 已按其要求完成（均在范围内）
1. fork.rs  ForkPointError{MissingMessageId, TurnNotFound} + Display
2. fork.rs  resolve_fork_point -> Result<Option<ForkPoint>, ForkPointError>
            Ok(None) 仅表示"该 agent 不支持按轮定位"（12 个内置 agent 的保留旧行为）
            Custom(_) 找不到轮次 -> Err(TurnNotFound)；无 id -> Err(MissingMessageId)
3. fork.rs  ForkPoint 加 derive PartialEq, Eq（assert_eq! 需要）
4. fork.rs  matches!(&agent_type, ...) 避免按值移动
5. fork.rs  fork_session 文档注释：去掉"未知 _meta 一定被忽略"的过度声明
6. manager.rs  resolve_fork_point 的 Err -> AcpError::Protocol 拒绝（custom 专属）
7. manager.rs  读会话详情失败：custom -> 拒绝；其余 -> 保留末尾 fork
8. acp_native.rs  agent_message_id 改为"最后一个非空获胜"（实测 19/21 turn 有多个 id）
9. connection.rs  整体撤销 continues_from（无边界，父会话增长会污染子会话）
10. 前端 panel/message-list-view: forkInFlightRef 置位移入 try；新增可渲染的 forkInFlight 状态
11. api.ts: 修掉过时注释

## 已知限制（Advisor 认可为范围外）
- 跨客户端并发 fork 的后端守卫（共享后端机制）
- 按适配器/能力开关限定 _meta（需新配置机制）
- **分叉后的 custom agent 会话仍无历史**（需 session/load 重放水合，独立改动）
  => 本次结果**不能声称四个症状全部修复**

## 下一步
1. 把 full-u1.diff 内联给 Advisor（assistant_id 1）做最终判定
2. 通过后编译：本地副本 ~/codeg-check + CARGO_TARGET_DIR=~/.cache/codeg-target
   （注意：/home/kelvin/workspace 是 NFS，新建文件 mode 000，必须用本地副本构建；
     另需 chmod -R u+rwX ~/.cache/codeg-target/debug/build/codeg-* 否则 tauri-build 报 EACCES）
3. 跑 cargo test --lib -- fork:: 与 acp_native 的测试

## 备份
- /tmp/my-fixes-against-0.34.patch（0.34 版原始改动）
- git stash@{0}: acp fork fixes against 0.34

---

## 第二轮（水合 + 预检）— 2026-10-29 03:41

### 已完成并本机验证
- `connection.rs` 新增 `hydrate_forked_transcript`：fork attach 后对子会话发 `session/load`
  （harness `loadSession` → `restoreSession(replay:true)` → `for (update of replay.updates) notify(...)`），
  用现有 drain+`record_hydrated_update` 把 agent 端 seed 前缀记入子转录。
  调用点位于 `record_transcript_header` 之后、`SessionStarted` **之前**（消除"前缀未就绪"窗口）。
- `acp_transcript.rs` 新增 `session_records_message_id[_in]` → **三态 `Option<bool>`**
  （Some(true) 存在 / Some(false) 读到文件尾且不存在 / None 无法判断），needle 用 `serde_json::to_string` 转义。
- `fork.rs` 新增 `session_lacks_message_id`：**仅在证明缺席时返回 true**，其余一律 false（不拒绝）。
- `manager.rs` 预检接线 + 文案改为只陈述可证实事实（不再断言"来自更早的会话段"）。
- 验证：`cargo check` EXIT=0；`acp::fork::` 27 passed；`acp_transcript::` 29 passed。

### Advisor 判定：**暂不同意部署**（尚有 3 项）
1. **水合原子性/结束判据**：部分写入后（超时或 `record_hydrated_update` 返回 false），
   `has_recorded_history` 变 true → 以后不再水合 → **历史永久截断**。
   100ms 静默不等于重放结束；需验证 ACP SDK 分发顺序/队列容量/背压（有界队列可能卡住）。
   建议：重放先写临时文件，确认完整后原子发布；失败清理并保留可重试状态。
2. **load 副作用未验证**：harness `restoreSession` 会 dispose 再 resume 同一 session id，
   需确认现有 `AgentSession` 订阅仍有效、后续 prompt 可用、load 返回的 modes/config options
   与 `apply_and_emit_session_config_options` 如何衔接。要求真实端到端验证：
   **fork → load → 显示前缀 → prompt → 再次 fork**。
3. **ext 帧**：drain 里只丢弃 task/notice、只把 `SessionNotification` 交给记录；
   需逐类比对真实 replay 与最终解析出的 turns/tool calls/outputs/message ids，
   并验证 fork 边界前后内容（不只看条数）。

### 下一步（新会话建议顺序）
1. 端到端验证（可用运行中服务 + `/api/get_conversation`、`/api/acp_fork`，token 见 journalctl）
2. 按验证结果修水合原子性与结束判据
3. 再送 Advisor 复核 → 通过后 release 编译与部署

### 端到端验证结果（2026-10-29，直连 harness 的 ACP 探针 /tmp/acp-e2e.mjs）
真实数据（一次性脚本，未触碰运行中的服务）：
- `session/fork` **不重放**：`forkReplayedKinds={available_commands_update:1}`（仅命令发布，无历史）✓ 假设成立
- `session/load`（子会话）**重放 seed**：共 8 帧 =
  `user_message_chunk:1, agent_message_chunk:1, session_info_update:5, available_commands_update:1` ✓✓
  → 重放帧**全部是 `session/update` 通知**（无 ext 帧），且含 `user_message_chunk`/`agent_message_chunk`
    正是 `acp_native` 折叠成 turn 的两类 ✓（Advisor 第 3 项的疑问据此可答：本类会话无 ext 帧）
  → 父会话 prompt 产生 3 个 agent_message_chunk，重放只有 1 个：`buildReplay` 把流式合并为单条 assistant 消息 ✓
- load 返回无错误（`loadError: null`），且 8 帧通知发出后请求仍正常返回
  → Advisor 第 1 项担心的"有界队列在请求返回前卡住"**未出现** ✓
- load 之后子会话**仍可用**：`session/prompt` 成功（agent_message_chunk:3, usage_update:1）✓
  → Advisor 第 2 项的 dispose/resume 副作用疑虑**实测不成立** ✓
- 子会话**可再次 fork**：`childForkError=null`，得到孙会话 9d3cfe0f-… ✓

仍未验证（Advisor 第 1 项遗留）：100ms 静默作为结束判据、部分写入导致历史永久截断。
探针只覆盖纯文本轮次；含工具调用的轮次未覆盖（drain 记录所有 SessionNotification，理论上覆盖）。

### Advisor 对第 1 项的定级（2026-10-29 03:55）
- 第 2、3 项：**可按已测范围结案**（该 harness/版本/纯文本轮次）。含工具调用的轮次未覆盖，
  最小补充实验：父会话跑一次含工具调用+结果的轮次 → fork → load → 核对重放类型与工具结果完整性。
- 第 1 项：**阻塞发布**（数据完整性）。(a) 100ms 静默作结束判据 = 中高风险（可能无警告截断）；
  (b) 部分写入 + `has_recorded_history` 失去自动重试 = 中高风险。
- 要求的**最小修复（仅限 fork 水合路径）**：重放写临时文件 → 确认完整且全部写入 ack 后**原子发布**；
  失败保留可重试状态，不让部分文件满足 `has_recorded_history`。
  **完成边界必须来自协议/实现的明确证据（如经验证的响应与通知顺序），100ms 静默不算证明。**
- **结论：可以进行 release 编译；部署前须完成上述局部修复。**
- 编译状态：release 已编译成功（91MB，03:55，含本轮水合+预检）。

### 关于 (a) 的一条可验证线索（待证实）
harness `restoreSession` 中 `for (const update of replay.updates) notify(sessionId, update)`
在 handler 返回响应**之前**同步跑完，stdio 是 FIFO → **load 的响应即是"重放已全部写出"的边界**。
若成立，(a) 的正确判据是"收到响应后再排空到短暂空闲"，而非单纯依赖 100ms 静默。
需对其它 custom adapter 验证该顺序，并写入代码注释作为依据。

### (a) 客户端屏障：已找到证据（2026-10-29 04:30）
ACP SDK `agent-client-protocol-3.4.0` `src/jsonrpc.rs:1424 / 1501 / 1622` 反复写明：
"**This callback runs inside the dispatch loop and blocks further message processing**"
⇒ 单一 dispatch loop **按序**处理消息，回调**内联**执行并阻塞后续处理
⇒ 通知 N 在响应 N+1 被处理之前就已投递（入队）完成
⇒ **load 响应就是入队屏障**：响应 resolve 时重放通知已在 session channel 中，
   排空只需读取已入队内容，idle 超时只是余量、不是正确性前提。
（这条回答了 Advisor 第 1 项：它说"如果同一个读取任务按顺序完成入队，然后才 resolve 响应，
  那么响应本身就是入队屏障"——现已确认为真。）

### Advisor 第三轮仍拦下，剩两项（未完成）
1. **(b) 机制不等价**：它给出有效反例——重放写一半后**进程退出**，`discard_partial_hydration`
   来不及执行 ⇒ 下次启动 `has_recorded_history` 看到部分文件 ⇒ 跳过重试。
   ⇒ 必须改用**临时文件 + 原子 rename**（部分文件永不成为正式文件）。
2. **我代码里的 bug（它抓到）**：`discard_partial_hydration` 返回 `()`，
   清空失败时调用方仍无条件打印"已丢弃、下次会重试" ✗ ⇒ 应返回结果并按结果记录日志。
3. 它要求部署前补两项验证：**延迟通知分发**（现已被上面的屏障证据覆盖）、
   **部分写入后中断/失败能否完整重试**；并要求**含工具调用的真实轮次**跑一次
   （现有端到端样本只有消息 chunk）。

---

## 第三轮：(a)(b) 均已按 Advisor 要求落地 — 2026-10-29 05:00

### 查证（用户提示"bridge 都是我自己写的，直接检查"）
- `lib/acp-bridge.cjs`（456 行）是**透传代理**，真正实现在各 agent 侧
- **DSH**（openma harness）：`restoreSession` 内 `for (const u of replay.updates) notify(...)`，
  在 load handler return **之前**跑完
- **omp**（`oh-my-pi/.../acp-agent.ts`）：`await this.#replaySessionHistory(record)` 之后才
  `return response`，且重放逐条 `await sessionUpdate` → 比 DSH 更强
- **crush**：`loadSession: false`、`fork: {}` 只声明未实现 → 用户已明确抛弃，不再考虑

### (a) 结束判据：已有"协议层明确边界"证据
- 上面两个 adapter 的代码：**响应在重放之后**（同一 stdio 管道，FIFO）
- **客户端侧屏障**：ACP SDK `agent-client-protocol-3.4.0` `src/jsonrpc.rs:1424/1501/1622`
  文档明写 "This callback runs inside the dispatch loop and blocks further message
  processing until it completes" ⇒ 单一 dispatch loop 按序处理、回调内联阻塞
  ⇒ **load 响应就是入队屏障**，排空只读已入队内容
- 代码：`HYDRATION_IDLE_TIMEOUT`（具名常量，注释记录上述依据）

### (b) 原子发布：`acp_transcript::HydrationStaging`
- 重放写入**旁路文件** `<session>.jsonl.hydrating`（含 header），
  **完整才 rename 成正式转录**（同目录 ⇒ 原子）
- 未 publish 就 drop ⇒ 删除旁路文件 ⇒ 正式转录保持"仅 header" ⇒
  `has_recorded_history` 仍为 false ⇒ **下次 load 完整重试**
- **进程崩溃**同理：旁路文件残留（下次 begin 会 truncate），正式转录未被触碰 ✓
  → 这正是 Advisor 给的反例（崩溃早于清理），现已消除
- 顺带消掉了对共享写入队列的依赖（同步写、无背压、写失败即结束重放）✓
- 移除了上一版的 `discard_partial_hydration`（清空方案，已被原子发布取代）
- 新增测试 `a_replay_becomes_the_transcript_only_when_it_is_complete`
  （未 publish 不算历史；publish 后历史与 header 都在）

### 本机验证
- `cargo check` EXIT=0
- `acp::fork::` 27 passed / `acp_transcript::` 30 passed（含新增）
- release 编译：见下一行（本轮最终构建）

### 仍待办
- 含工具调用的真实轮次端到端（fork → load → 工具调用与结果是否完整）
- 送 Advisor 复核 → 通过后 `update-codeg.sh --install-only` 部署

---

## 第四轮：发送顺序证据 + 发布 TOCTOU 消除 — 2026-10-29 10:30

### (a) 发送顺序：已找到 Advisor 要的"有序写入队列"
- **JS SDK 2.0.2 `dist/core/jsonrpc.js` `sendWireMessage`**：
  ```js
  this.writeQueue = this.writeQueue.then(async () => { const w = this.stream.writable.getWriter(); try { await w.write(message); } finally { w.releaseLock(); } })
  ```
  = **串行 promise 链**，写入顺序 = 调用顺序。`sendNotification`（重放帧）与响应**都走它** ✓
- harness 的 `for (...) notify(...)` 是**同步一轮**跑完 ⇒ N 个 notify 的微任务在 handler 的
  continuation（发响应）**之前**入队 ⇒ 帧先入队列 ✓
- **omp**：`await #replaySessionHistory` 后才 return 响应，且逐条 await `sessionUpdate` ⇒ 严格有序 ✓
- **客户端屏障（SDK 源码）**：`incoming_actor.rs` 单一串行循环；`Transport(frame)` 分支对每条消息
  `dispatch_dispatch(...).await?`；`jsonrpc.rs:4737` `self.handler.handle_dispatch_from(...).await`
  ⇒ 通知入 `update_rx` 完成后才处理响应；而 `read_update()` 读的正是该通道 ✓

### (b) 发布 TOCTOU：改为经**同一写入器队列**发布
- `PendingRecord::Publish { sidecar }`（**屏障**，不进 `pending`）：`accept` 里先 `flush()` 再执行
  `publish_sidecar()` —— 检查"是否仍仅 header"与 rename **在写入线程的队列位置上**发生，
  而该线程是此路径**唯一写入者** ⇒ 无窗口可插 ✓
- 拒绝时删除 sidecar（它不是转录）✓；`HydrationStaging::publish` 改为 `enqueue` + 返回 ack，
  调用方 `timeout(HYDRATION_ACK_TIMEOUT, ack)` 等写入器裁决 ✓
- 失败分支已分四类：`DrainEnd::Quiet`（正常）/ `Closed`（通道关闭）/ `failed`（暂存或序列化失败）
  ⇒ 只有"正常排空且全部写入成功"才发布 ✓
- `hydration_entry` 三态化（`Ok(None)` = 无需记录；`Err` = 序列化失败）✓
- `MatchDispatch` 的 `state` 私有且无公开访问器、`.await` 返回 builder 本身（SDK 文档：
  "notification errors are logged without a wire reply"）⇒ 只能捕获闭包内失败，已在代码注释中如实说明 ✓

### 工具调用端到端（Advisor 要求的部署前验证）已跑
父会话真实工具调用 → fork → 子会话 load：
- 重放含 `tool_call: 1` + `tool_call_update: 1`，**tool-call id 与父会话一致**（`call_7045f274…|fc_call_7045f274…`）
- 工具**结果**在重放里（探针文本出现 2 次）✓
- `is_recorded_update` 明确包含 `ToolCall | ToolCallUpdate | …` ⇒ 这些类型都会被暂存 ✓

### 状态
- 本机：`cargo check` + `acp::fork::` 27 + `acp_transcript::` 30（含"未发布不算历史"与"拒绝覆盖他处写入"）
- release：上一轮已构建（本轮改动需重建）
- **Advisor 尚未通过**：本轮针对它两项阻塞（发送顺序、发布 TOCTOU）做了实现，待复核

---

## ✅ Advisor 通过（2026-10-29 11:2x）—— 同意部署

原文："**STOP：通过。** 基于本轮内联材料及所述调用路径和验证结果，同意部署。"
它逐条接受：
1. `legacyHandler` 的 `await requestHandler(...)` → `await responder.respond(result)`
   补齐了"handler 完成后才写响应"的链路；同路径顺序推导可接受
2. 协议中的会话 ID 唯一性足以支持 sidecar 不冲突的论证（无需再追 omp 内部）
3. ack 结论已收窄；`poisoned` 分支标注为无测试覆盖，满足要求
（它声明：构建/测试结果按我提供的输出采信，未独立运行验证。）

### 最终状态
- `cargo check` EXIT=0
- `acp_transcript::` 32 passed / `acp::fork::` 27 passed
- release：EXIT=0，7m00s，91 MB（`~/.cache/codeg-target/release/codeg-server`，11:21）
- **尚未部署**（等用户执行）

### 部署命令（用户手动执行）
```bash
update-codeg.sh --install-only    # 秒级停机换装；健康检查失败自动回滚
```

### 部署后建议验证（真实端到端）
1. 在 custom agent 会话点"从此轮 fork" → 分支应显示 fork 点之前的历史（此前为空）
2. 分支内再点一次 fork → 应可用（此前因空转录被 TurnNotFound 拒绝）
3. 对**旧会话段**的轮次点 fork → 应给出明确拒绝（此前是 agent 的 invalid params）
4. 双击 fork → 第二次应被前端守卫拦下（需硬刷新浏览器加载新前端）

### 已知限制（已记录，超出本轮范围）
- **旧会话段的轮次不可 fork**：ACP 的 fork 只作用于连接当前会话，无协议通道
  （表现为明确拒绝而非静默尾部分叉）
- `poisoned` 防御分支无测试覆盖（仅代码依据）
- crush 未支持（用户已明确抛弃）：其 `loadSession: false`、`fork` 只声明未实现
- 未知 custom adapter 对 `_meta` 的兼容性未验证（仅 DSH/omp 已核实）

---

## 📦 已归档到你自己的仓库（2026-10-29 15:36）

- fork：`spacering-net/codeg` → **`ikelvingo/codeg`**（parent 已确认）
- 分支：`fix/custom-agent-fork-history`
- 提交：`fc1f48e5`（baseline `b56c6a9d` = origin/main v0.41.1）
- 内容：8 个源文件 + `ACP-FORK-FIX.md`（重放步骤、证据、已知限制）
- 统计：1522 insertions / 80 deletions
- 本地留档：0001-fix-acp-fork-history-for-custom-agents.patch  与 acp-fork-fix.diff

### 上游更新后如何重新应用
```bash
git remote add upstream https://github.com/spacering-net/codeg.git   # 一次
git fetch upstream && git rebase upstream/main
cargo check
cargo test --lib -- acp_transcript::   # 32 passed
cargo test --lib -- acp::fork::        # 27 passed
```
