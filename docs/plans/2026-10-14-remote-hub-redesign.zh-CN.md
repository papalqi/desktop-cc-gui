# 远程模式重构实施计划：Hub 只存远端会话、单一历史、执行端升级、多机器界面

> 版本：v1.0 · 2026-10-14
> 读者：接手实施的工程师或编程模型。写计划的人不参与实施，文中的结论都附了来源，标「估计」的没有实测。
> 关联文档：[DevCloud 网页与会话管理](../web-hub-architecture.zh-CN.md)（现状）、[Agent Link v1](../agent-link-v1.zh-CN.md)（专用通道设计稿，本计划第 D 阶段会修订它）、[Windows 中转客户端一键更新](../windows-relay-update.zh-CN.md)、[AI 操作与调试 API](../ai-debug-api.zh-CN.md)、[UI/UX 规范](../ui-ux-spec.zh-CN.md)。

---

## 0. 给实施者的说明

1. **先读这些文件**，再动手：
   - Hub（相邻仓库 `E:\projects\ccgui-relay`）：`ccgui-relay.mjs`（隧道、登录、网页入口）、`ccgui-hub.mjs`（浏览器命令路由、同步、推送）、`ccgui-hub-store.mjs`（SQLite 表与读写）、`ccgui-hub-history.mjs`（读取时合并历史的启发式）、`ccgui-codex-transcript.mjs`（JS 版 Codex 转录本解析）、`HUB.md`、`scripts/install-hub.py`。
   - 执行端（本仓库 `src-tauri/src`）：`history/journal.rs`（`chat_runs`/`chat_events` 事件日志）、`history/reader.rs`（`journal_page` 把事件日志叠加到原生转录本上，`load_session_page` 用它）、`web/dispatch.rs`（网页与 Hub 能调用的命令）、`relay.rs`（中转隧道客户端）、`db.rs`（`app.db` 表结构）、`engine/mod.rs`（`send_message`）。
   - 网页（本仓库 `src`）：`lib/transport.ts`（网页桥、心跳）、`lib/web-send-recovery.ts`（发送断线后查送达）、`lib/web-machine.ts`、`features/chat/relay-machines.ts`、`features/chat/machine-catalog.ts`、`features/chat/machine-run-watch.ts`、`components/application/ai-chat/pinned-machines-section.tsx`、`features/chat/store/messaging.ts`。
2. **硬约束**（来自 `AGENTS.md`，任何阶段都不能违反）：
   - 部署或迁移 Hub 不得重启执行机器，不得中止正在运行的任务。执行端只在空闲时更新，部署脚本的活动任务检查不能绕过。
   - 不自动重放提示词。任何环节无法确认是否送达时，报告「无法确认」。
   - 不截断正文或工具结果。
   - 日志与诊断不输出凭据、完整对话或工具结果。Hub 的 `RELAY_ACCESS_PASSWORD`、`RELAY_KEY` 不打印、不写进仓库。
   - 用户可见的交互变化在同一个提交里更新 `docs/ui-ux-spec.zh-CN.md`，文案走 `src/i18n`。
   - 提交与推送要有人明确下令。用户 2026-10-14 已提出「提交」需求，但按 `AGENTS.md`，实施者仍需在自己的对话里得到明确的提交指令；推送、开 PR、部署共享环境各自另行确认。
3. **一次只做一个阶段**，每个阶段都能单独上线、单独回滚。阶段之间的依赖见第 4 节开头的表。
4. **会删除数据的步骤**（第 C 阶段的数据迁移）必须先给用户看试运行报告，得到同意后才执行。
5. 遇到文档没写清的地方，先按第 6 节的默认决策做，并在提交说明里写明。

---

## 1. 需求与可行性结论

用户 2026-10-14 提出的七条需求：

| # | 需求 | 结论 | 阶段 |
|---|---|---|---|
| 1 | 网页发起的会话存进 Hub 数据库；不是网页发起的不存，从执行机取 | 可行，有三个前提，见下 | B、C |
| 2 | 不要三份数据，远端发起的只留一份 | 可行。「一份」指 Hub 只持久保存一份、合并只在执行机做一次；引擎自己的原生转录本删不掉 | B、C、D |
| 3 | 提交 | 可行，先清理两个仓库的未提交改动 | A |
| 4 | 网页发起的保留，归档的从 Hub 清空，需要时从执行机取 | 可行。迁移前必须核对执行机上是否还留着这些会话 | C |
| 5 | 提供只看远端工作的模式，不和本地工作混 | 可行，依赖第 1 条的来源标记 | E |
| 6 | 解决还没做的界面问题 | 可行，清单见第 E 阶段 | E |
| 7 | 升级执行机，做阶段 1、2、3 | 可行。第一次升级仍要人工安装，同时带上自更新，以后的版本自动下发 | B、D |

### 1.1 第 1、4 条的三个前提

1. **历史会话的来源只能识别一部分。** Hub 从 2026-10-13 14:30（UTC+8）起才在 `runs.delivery` 里记录「这次发送经过 Hub」。在那之前从网页发起的会话，Hub 和执行端（1.1.3 不记录来源）都分辨不出来。迁移时这部分怎么处理需要用户决定（第 6 节 D1）。
2. **本地会话只在执行机在线时可见。** 不存进 Hub，就意味着机器离线时网页看不到本地会话、也搜不到。远端会话不受影响。
3. **执行机上可能已经没有某些归档会话。** 引擎或用户可能删过原生转录本，这时 Hub 是唯一副本。迁移试运行必须逐个核对，把「只有 Hub 有」的会话单独列出来给用户决定（第 C5 步）。

### 1.2 第 2 条：「一份」具体是什么

现在一个远端会话的内容散在这几处，Hub 读取时再用启发式拼起来：

| 位置 | 现在 | 目标 |
|---|---|---|
| 执行机：原生转录本 | 引擎写入 | 保留。引擎续聊靠它，桌面也读它，删不掉 |
| 执行机：`chat_events` 事件日志 | 工作区已写，线上执行机没有 | 保留，作为进行中回合的发件箱，桌面也用它补全 |
| Hub：`events` 表 | 永久保存所有回合的逐条事件 | 只保存进行中的回合，回合内容入库后删除 |
| Hub：`messages` 表与搜索索引 | 本地会话和远端会话都存 | 只存远端会话，是 Hub 上唯一的持久副本 |
| 合并逻辑 | 执行端 Rust（`journal_page`）一次，Hub JS（`mergeHistory`、`repairNativeHistory`、Codex 解析器）再一次 | 只在执行端 Rust 一处 |
| 浏览器 | `ccgui.machineCatalog.v1` 等本地目录缓存 | 只按修订号缓存，随时可以丢弃重取 |

关键事实：工作区里的执行端代码已经让 `load_session_page` 经过 `journal_page`（`src-tauri/src/history/reader.rs`），输出的就是合并好的历史。执行端升级到 1.2.0 后，Hub 直接复制这个结果即可，不用再自己合并。这一步不依赖 Agent Link，第 B、C 阶段就能完成；第 D 阶段的修订号日志只是让复制变成增量。

---

## 2. 现状（2026-10-14 实测）

**拓扑**：浏览器 → DevCloud Hub（Bun 1.3.14，`/data/workspace/ccgui-relay`，端口 8787，入口 https://arashishader.devcloud.woa.com/CCGUI）→ 执行机 PC0、PC5、PC6（Windows）与 MC2（macOS），全部是 1.1.3，经 `/m/<名字>/agent?key=` 接入，共用一个 `RELAY_KEY`。

**Hub 数据**（21:25 只读查询 `data/hub.db`）：

- 文件 4.24 GB，WAL 249 MB；空闲页约 20 MB，体积是真实内容，不是碎片。
- 消息原始数据 2.9 GB（主要是完整工具输出），正文 119 MB，事件 57 MB。
- 按来源分类（来源依据：会话里有 `delivery` 为 `in-flight`/`acknowledged`/`indeterminate` 的回合即视为网页发起）：

| 分类 | 会话 | 消息 | 原始数据 |
|---|---|---|---|
| 网页发起、未归档 | 5 | 2,095 | 35 MB |
| 网页发起、已归档 | 1 | 228 | 不到 1 MB |
| 本地发起、未归档 | 153 | 70,152 | 394 MB |
| 本地发起、已归档 | 1,856 | 677,483 | 2,544 MB |

  另有事件：网页发起 46 MB，本地发起 11 MB；112 个目录条目没有消息。`runs` 表：已确认 29、Hub 事后观察到 19、墓碑 1。
- Hub 重启后约 2 分钟 RSS 160 MB（10-13 曾测到约 1.3 GB）。

**已上线但未提交**（2026-10-14 20:58 部署，回执在 `ccgui-relay/releases/phase0-relay-20261014-133aebfa/`）：同名执行机重连探测替换、WebSocket 空闲超时与 ping、`machines://status` 推送、浏览器 ping/pong、回合结束尾部增量同步与差异写入、`get_run_delivery` 送达查询与 `abandoned` 墓碑；网页的心跳与重连横幅、按 Hub 推送显示置顶会话状态、发送断线后查送达。同时上线的还有之前会话留下的调试 API、运行日志和历史修复。

**未提交改动**：

- 本仓库在 `main` 上有约 108 项改动，混着多次会话的工作：执行端事件日志、诊断日志、调试 API、Grok 首轮修复、Windows 部署脚本、网页远程模式、阶段 0 网页部分和文档。
- `ccgui-relay` 在 `master` 上有 11 个修改、5 个新文件。

**已知测试失败**：`tool-batching.test.ts` 3 个用例失败，起因是 `src/features/chat/store/engine-events.ts` 与 `stream.ts` 里正在进行的 `historyLoaded` 改动（修改于 10-13，来源未确认）；`RunStatusStrip.test.tsx` 在全量运行时有一个卸载后的未处理拒绝，单独运行不复现。

---

## 3. 目标架构

### 3.1 会话来源

- 每个会话有来源：`hub`（远端）或 `local`（本地）。**执行端是来源的唯一记录者**，Hub 只复制。
- 经 Hub 的 `send_message` 新建的会话是 `hub`。AI 调试 API 的发送也经过 Hub，同样算 `hub`。
- `hub` 会话之后在桌面本机继续，仍然是 `hub`，执行端照常把新回合同步给 Hub。
- 网页往一个 `local` 会话里发消息时，默认把它纳入 `hub` 并一次性导入完整历史（第 6 节 D2）。
- 直接在终端里用 CLI 续聊产生的回合只在原生转录本里；`journal_page` 已能把它们并进来，不需要特殊处理。

### 3.2 读写路径

| 场景 | 列表 | 打开 | 实时输出 | 搜索 | 执行机离线 |
|---|---|---|---|---|---|
| 远端会话（未归档） | Hub | Hub `messages`，按 seq 游标分页，不合并 | Hub 转发并暂存进行中回合的事件 | Hub 索引 | 可看可搜，不能发送 |
| 远端会话（已归档） | Hub 保留目录条目 | 实时向执行机取，不存 | — | 不在 Hub 索引里 | 提示「内容在执行机上，离线无法打开」 |
| 本地会话 | 实时向执行机取 | 实时向执行机取，不存 | Hub 转发，不存 | 转给在线执行机 | 不可见，提示机器离线 |

Hub 可以为实时读取的结果加一层**内存**缓存（有总量上限，例如 64 MB，按修订号失效），不得写进数据库。

### 3.3 两种视图

- **远端工作**（网页默认）：所有机器的远端会话放在一个列表里，每行标机器名。机器离线也能浏览。
- **全部**：在远端会话之外，按机器追加本地会话，行上标「本地」；离线机器显示「离线，本地会话不可用」。

---

## 4. 分阶段计划

| 阶段 | 内容 | 依赖 | 改动范围 | 上线方式 | 规模（估计） |
|---|---|---|---|---|---|
| A | 提交基线，之后只从已提交版本部署 | 无 | 两个仓库 | 不部署 | 小 |
| B | 执行端 1.2.0：来源标记、`run_status`、自更新，带上已写好的执行端改动 | A | 执行端 + 少量 Hub | `pnpm deploy:win` 人工安装（最后一次），MC2 手工 | 大 |
| C | Hub 只存远端会话、删除 Hub 端合并、归档清空、数据迁移 | B | Hub + 少量网页 | Hub 部署 + 一次维护窗口 | 大 |
| D | Agent Link v1：机器身份与令牌、控制与大块分道、心跳、修订号日志 | B（自更新）；可与 C 并行 | 执行端 + Hub | 执行端 1.3.0 经自更新下发 | 大 |
| E | 网页：两种视图、多机器原生界面、请求超时、动态机器列表、徽章、通知、管理字段 | E1、E3 只依赖 A；其余依赖 C | 网页 + Hub | Hub 网页资源 | 大 |
| F | 删除旧协议兼容、稳定性验收 | 四台执行机都在 v1 上稳定两周 | Hub | Hub 部署 | 中 |

### A. 提交基线（需求 3）

**目标**：两个仓库的工作区干净，线上 Hub 的每个文件都能对应到一个提交。

1. **先处理已知失败**：问用户 `engine-events.ts`、`stream.ts` 里的 `historyLoaded` 改动是否完成。完成就修好 `tool-batching.test.ts`；没完成就用 `git add -p` 把这些片段留在提交之外。
2. **本仓库**：
   - 新建分支（例如 `remote-hub-baseline`），不直接在 `main` 上提交；仓库用 PR 合并。
   - 按行为分组提交。建议的分组：
     - 执行端：事件日志、诊断日志与调试 API、Grok 首轮、HTTP 取消（`src-tauri/**`、`Cargo.*`）。
     - Windows 部署脚本：`scripts/deploy-windows*`、`scripts/install-windows*`、`scripts/check-relay.mjs`、`docs/windows-relay-update.zh-CN.md`、`.gitignore`、`package.json` 的脚本。
     - 网页远程模式：机器段、置顶、目录缓存、切换（`relay-machines*`、`machine-catalog*`、`pinned-machines-section.tsx`、`relay-machines-section*`、`web-machine.ts`、`machine-bridge.ts`、`web-public-prefix*`、`use-chat-sidebar*`、`src/features/profile/`）。
     - 阶段 0 网页部分：`transport.ts`、`transport.heartbeat.test.ts`、`BridgeStatusBanner*`、`machine-run-watch*`、`web-send-recovery*`、`web-bridge-recovery*`、`ipc.ts`、`store/messaging.ts`、`store.test.ts`。
     - 文档：`docs/web-hub-architecture.zh-CN.md`、`docs/ai-debug-api.zh-CN.md`、`docs/agent-link-v1.zh-CN.md`、`docs/ui-ux-spec.zh-CN.md`、`AGENTS.md`、`README*`、本计划。
   - `ipc.ts`、`i18n`、`ui-ux-spec` 这类跨组共享的文件，可以合进其中一组，在提交说明里列明。
   - 提交前运行 `pnpm build`、`pnpm test`、`node --test scripts/deploy-windows.test.mjs`，以及在 `src-tauri` 下运行 `cargo test history`、`cargo test journal`、`cargo test --test send_path`。如实记录失败项。
3. **`ccgui-relay`**：仓库习惯直接在 `master` 上提交。建议分三组：调试 API 与运行日志（`ccgui-debug-api*`、`ccgui-logs*`、`ccgui-api-commands.mjs` 及 Hub 中的对应改动）、阶段 0（`ccgui-relay.mjs`、`ccgui-hub.mjs`、`ccgui-hub-store.mjs`、测试、`HUB.md`）、`scripts/install-hub.py`。测试用显式路径运行，例如 `bun test ./ccgui-hub.test.mjs ./ccgui-relay.test.mjs`，因为不带路径的过滤会匹配到 `releases/` 里的副本。
4. **核对线上与提交一致**：对服务器上的 `ccgui-relay.mjs`、`ccgui-hub.mjs`、`ccgui-hub-store.mjs` 等文件计算 sha256，与 `git show HEAD:<文件>` 的 sha256 比较。参考值：阶段 0 回执里 `ccgui-relay.mjs` 为 `c87cd8e2…`、`ccgui-hub.mjs` 为 `133aebfa…`、`ccgui-hub-store.mjs` 为 `5305d91b…`。
5. **以后只从提交部署**：出包脚本改为从 `git archive <commit>` 取源码，`install.json` 增加 `commit` 字段；`install-hub.py` 发现暂存文件与该提交不一致时拒绝安装。在 `HUB.md` 里写明。

**验收**：两个仓库 `git status` 只剩被忽略的文件；线上 Hub 文件与提交逐个一致；测试结果如实记录在提交或 PR 说明里。

### B. 执行端 1.2.0（需求 7 的第一步）

**目标**：四台执行机装上同一个包含后续阶段所需能力的版本，并带上自更新，让这成为最后一次人工安装。

**B1. 已写好的执行端改动**：`history/journal.rs`、`diagnostics.rs`、`web/debug.rs`、Grok 首轮修复、`relay.rs` 的 HTTP 取消。用 `cargo test` 确认，必要时补用例。

**B2. 会话来源**：

- `app.db` 新增 `session_origins(engine TEXT, session_id TEXT, origin TEXT NOT NULL, adopted_at INTEGER, PRIMARY KEY(engine, session_id))`，只写 `hub` 行，没有记录即为本地。
- `chat_runs` 新增 `origin TEXT NOT NULL DEFAULT 'local'`、`state`（`reserved`、`spawned`、`done`、`error`、`cancelled`、`spawn_failed`）、`error`，与 Agent Link 设计稿第 5 节一致。
- `send_message` 增加可选参数 `origin: "hub"`（`web/dispatch.rs` 的 `SendMessageArgs` 与 `engine::send_message`）。带这个参数时写入 `chat_runs.origin`，会话 ID 确定后写入 `session_origins`。
- 新增命令 `set_session_origin { engine, sessionId, origin }`，供迁移和「纳入远端」使用。
- `list_sessions`、`list_archived_sessions` 的每一项和会话分页结果都带上 `origin`。
- Hub 同步改动：转发 `send_message` 时加上 `origin: "hub"`。已核实 `dispatch.rs` 没有 `deny_unknown_fields`，1.1.3 会忽略这个参数，所以 Hub 可以先于执行端部署。

**B3. `run_status`**：经现有 `/ws` 的 invoke 提供 `run_status { runIds }`，返回 `[{ runId, known, state, sessionId, startedAt, error, origin }]`。Hub 在执行机重连后用它消解 `in-flight` 和 `indeterminate`；`get_run_delivery` 遇到执行机离线时返回新状态 `waiting-executor`，网页显示「等待执行机器重新连接以确认」（同步更新 `web-send-recovery.ts`、i18n 与 UI 规范）。

**B4. 能力声明**：relay hello 的 `capabilities`（1.1.3 为空）填上 `journal`、`debug_logs`、`session_origin`、`run_status`、`self_update`。Hub 按机器记录，后续所有新行为都按能力开关，没有能力的机器走旧路径。

**B5. 自更新**（Windows；设计见 Agent Link 设计稿第 6 节）：

- Hub 托管 `releases/<channel>/manifest.json`：`{ version, protocol, files: [{ name, url, bytes, sha256 }], signature }`。签名用离线私钥（例如 ed25519），执行端内置公钥，Hub 只托管文件，伪造不了更新。
- 执行端后台下载并校验，放进 `updates/<编号>/staged/`。
- 应用条件全部满足才替换：没有运行中的回合或预约、没有进行中的 Hub 请求或文件传输、本机窗口 10 分钟无输入、不在禁止时段。桌面窗口提示「新版本将在空闲时安装」，用户可以推迟。
- 由独立的更新器进程替换文件，备份布局沿用 `pnpm deploy:win` 的 `updates/<编号>/before/`。新版本 2 分钟内必须连上 Hub 并通过自检（读取工作区、加载网页资源），否则恢复旧版本，Hub 记录失败且不再自动重试同一版本。
- 新增发布脚本（例如 `pnpm release:win`）：复用 `node scripts/deploy-windows.mjs --package` 出包，签名，上传到 Hub。
- Hub 按机器提供开关，先只对 PC6 打开。

**B6. 版本号**：`package.json`、`src-tauri/Cargo.toml`、Tauri 配置改为 1.2.0。

**上线**：

1. 先部署 Hub 的 B2、B3 改动。执行端未升级时行为不变。
2. 按 `docs/windows-relay-update.zh-CN.md` 用 `pnpm deploy:win` 逐台安装，顺序 PC6、PC5、PC0，一次一台。用户说 10-14 21:17 时四台都空闲，但执行时以脚本的活动任务检查为准，忙的机器跳过，稍后再装。
3. MC2 用 `pnpm build:mac`（或 `build:mac:skip-notarize`）手工构建安装，1.2.0 不含 macOS 自更新。具体安装步骤要向用户确认。
4. 每台装完后，用 `/_relay/api` 的诊断接口核对版本、能力与连接，并保存回执。

**验收**：

- 四台都报告 1.2.0 和完整能力；安装过程中没有中断任何回合；桌面本机的打开会话、发送、历史浏览不变。
- 网页新建的会话在执行端 `list_sessions` 里 `origin` 为 `hub`；桌面本机新建的为 `local`。
- 测试覆盖「`send_message` 发出后 Hub 重启」：重连后 `get_run_delivery` 给出 `acknowledged` 或 `not-received`，不再停在无法确认。
- 自更新演练：给 PC6 发布一个 1.2.1 测试包。有运行中回合、有进行中请求或窗口有输入时都不应用；人为让自检失败时自动回滚；校验值或签名不符时拒绝安装。

**回滚**：用部署回执里的 `before/` 恢复。Hub 的 B2、B3 改动对 1.1.3 无影响，不需要回滚。

### C. Hub 只存远端会话（需求 1、2、4）

**前提**：目标机器已是 1.2.0。仍在 1.1.3 的机器（例如 MC2 来不及升级）按机器保持现有行为。

**C1. 数据模型**（`ccgui-hub-store.mjs`）：

- `sessions` 增加 `origin`，迁移后只剩 `hub` 行。归档的远端会话只保留目录字段（标题、预览、时间、工作区、机器、引擎）。
- `messages` 与搜索索引只保存未归档、未删除的远端会话。
- `events` 只保存进行中、内容还没入库的回合；回合入库后删除该回合的事件。
- `runs` 继续作投递台账，可以只留最近 30 天。
- `cache` 表不再保存本地会话目录，改用内存缓存。

**C2. 读取**（`ccgui-hub.mjs`）：

- `list_sessions`、`list_archived_sessions` 增加 `scope: "remote" | "all"`。`remote` 只读 Hub；`all` 再加上实时向执行机取的本地会话（过滤掉 `origin=hub` 的重复项）。机器离线时只返回 Hub 的部分，并标注 `machineOffline`。
- `load_session_page`：未归档的远端会话直接按 seq 从 `messages` 分页；其他情况转给执行机的 `load_session_page`，结果不入库。返回值增加 `source: "hub" | "executor"`。
- 本地会话的实时事件照常转发给正在看这个会话的浏览器，但不写入 `events`。判断依据：事件的 `sessionId` 在 Hub `sessions` 里且为 `hub`，或者这个回合是经 Hub 发起的。
- `search_messages` 增加 `scope`。`remote` 查 Hub 索引；`all` 同时转给在线执行机的 `search_messages`（执行端已有，基于 `session_messages` 搜索索引），合并结果并标出机器。

**C3. 写入**：

- 对 1.2.0 执行机，回合结束时 Hub 直接复制执行端 `load_session_page` 的结果（已由 `journal_page` 合并），沿用阶段 0 的尾部增量比对，第 D 阶段再换成按修订号复制。
- 对 1.2.0 执行机关闭 Hub 端的合并：`ccgui-hub-history.mjs` 的 `mergeHistory`、`nativeTurn`/`nativeCoversRun`、`repairNativeHistory`，以及 `ccgui-codex-transcript.mjs` 的回退分支。Hub 分页只读自己的 `messages`。代码先按能力开关保留，等第 F 阶段再删除。
- 执行端返回的页面显示回合已完整（`incompleteTurn` 为假）后，删除该回合在 `events` 里的行。
- 新会话：`send_message` 的 `sessionId` 为空时，拿到会话 ID 后写入 `origin=hub` 的目录行。
- 纳入远端（D2 默认方案）：网页往本地会话发消息时，先照常转发发送，不让导入拖慢发送；发送确认后调用执行端 `set_session_origin`，再在后台导入完整历史，沿用现有分页导入并显示进度。

**C4. 归档、恢复、删除**：

- 归档远端会话：转发执行端 `archive_session`。成功后在 Hub 标记归档，删除该会话的 `messages`、`events` 和索引行，保留目录行，让归档列表照常显示。执行机离线时的处理见 D6。
- 打开已归档的远端会话：实时向执行机取，不入库；离线时提示「内容在执行机上，离线无法打开」。
- 恢复：转发执行端 `restore_session`，成功后在后台重新导入完整历史。
- 删除：转发执行端，然后删除 Hub 目录行。
- 本地归档会话只在「全部」视图里实时向执行机取。

**C5. 迁移现有 `hub.db`**（删除数据，必须先试运行并得到用户同意）：

1. 写 `scripts/migrate-remote-only.mjs`，`--dry-run` 只读输出各分类的会话数、消息数和体积（格式参照第 2 节的表）。
2. 识别远端会话：有 `delivery` 为 `in-flight`/`acknowledged`/`indeterminate` 的回合，再加上 D1 决定的补充名单。
3. 逐个核对执行机上是否还有这些会话（`list_sessions`/`list_archived_sessions` 及转录本文件是否存在）。列出「只有 Hub 有」的会话交给用户决定：导出到备份，或作为远端会话保留。机器离线时不能核对，迁移推迟到四台都在线。
4. 对识别出的远端会话调用执行端 `set_session_origin`，让来源记录回到执行端。
5. 维护窗口：
   - 停止 Hub（执行机不重启，会自动重连）。
   - 不在 4 GB 的库上逐行删除（索引触发器会很慢）。新建一个空库，只复制要保留的内容：设置、工作区分组与排序、置顶键、最近 30 天的 `runs`、远端会话的目录、消息与进行中事件，然后重建搜索索引。
   - 替换文件，启动 Hub。旧库移到 `backups/remote-only-<日期>/hub.db`，保留 14 天。
   - 估计新库约 0.1 GB，停机几分钟。
6. 迁移后核对：远端会话的消息条数与内容哈希和迁移前一致；四台执行机重新连上；正在运行的回合 ID 前后一致。

**回滚**：停止 Hub，恢复旧库和上一版 Hub 代码。执行端的 `session_origins` 多出几行不影响旧 Hub。

**验收**：

- Hub 测试（`ccgui-hub.test.mjs`）：模拟执行端发出本地会话的回合，库里没有任何 `messages`/`events` 行，但正在看这个会话的浏览器能收到事件。
- 远端会话的每一行与执行端 `load_session_page` 的输出一致，覆盖中文、emoji、代码块、完整工具结果和 Grok 无时间戳回合。
- 归档后库里没有该会话的内容，目录仍在；在线时能实时打开，离线时提示清楚；恢复后内容完整。
- 回合进行中重启 Hub：内容不丢、不重复。
- 记录迁移前后的库体积和 Hub RSS，注明测量时间和条件。

### D. Agent Link v1（需求 7：阶段 1、2）

按 [Agent Link v1](../agent-link-v1.zh-CN.md) 第 1、2、3、5、6、7、8 节实现，做以下修订，**动手前先改设计稿**：

- **第 4 节会话日志**：复制范围改为只复制 `origin=hub` 的会话；其他会话的 `session_log_since` 只用于实时读取，不入 Hub 库。
- 执行端的 `session_log` 物化表先不做：先按回合计算行并带上修订号。只有在实测中大会话分页太慢时才物化。现在 `journal_page` 每读一页都要重建整段叠加，要用约 9 MB 的大会话测量后再决定。
- Hub 按 `(machine, engine, session, message_id)` 和 `rev` 写入，删除阶段 0 的尾部比对。
- 大块通道去掉每页 20 条的限制和 base64，本地会话的实时读取因此变快。
- `machines` 表（`machineId`、显示名、令牌哈希）成为第 E3 步动态机器列表的数据来源。
- 心跳里的 `activeRuns` 直接驱动 `machines://status`；同时带上每个会话的状态（运行中、待审批、待输入），供第 E5 步的徽章使用。

**上线**：Hub 先同时支持 v0 与 v1；执行端 1.3.0 经自更新先发 PC6，稳定后再发 PC5、PC0；MC2 手工安装。并行期间用诊断接口比对同一会话两条路径的条数与内容哈希。

**验收**：设计稿第 8 节，加上第 5 节的稳定性矩阵。

### E. 网页界面（需求 5、6；阶段 3）

每一项都要同时更新 `docs/ui-ux-spec.zh-CN.md`（含版本表）和中英文文案，并补 Vitest 用例；涉及 React 提交与定时器交错的，按 `tests/browser/README.md` 做真实浏览器验证。

- **E1. 请求超时**（只依赖 A，可以先做）：
  - `src/lib/transport.ts` 的 `WebBridge.invoke` 现在只在连接关闭时失败。改为按命令设截止时间：默认 30 秒；添加工作区、文件读取、`rescan_sessions`、Git 操作等长命令 120 秒。
  - `send_message` 不设截止时间，由 `web-send-recovery.ts` 处理。
  - 超时时抛出带命令名的错误，文案走 i18n；非幂等命令不自动重试。
- **E2. 两种视图**（依赖 C）：
  - 侧栏顶部加「远端工作 / 全部」切换。选择保存到 Hub 的网页设置：在 `ccgui-hub.mjs` 顶部的 Hub 自管设置列表里加 `sessionScope`。
  - 远端工作：所有机器的远端会话在一个列表里，按机器再按工作区分组，另提供按最近更新排序的平铺视图。
  - 全部：按第 3.3 节。搜索跟随当前视图。
  - 桌面窗口也提供「仅远端发起」筛选（D5），数据来自执行端的 `origin`。
- **E3. 动态机器列表**（基础部分只依赖 A）：
  - 删除 `src/features/chat/relay-machines.ts` 的 `RELAY_MACHINE_ORDER` 和 `ccgui-relay.mjs` 注入脚本里写死的顺序（`const order = ["PC0", "PC6", "PC5", "MC2"]`）。
  - 机器列表与顺序来自 Hub：第 D 阶段前用 `knownNames` 加 Hub 设置里的 `machineOrder`、`hiddenMachines`；之后用 `machines` 表。
  - 提供「隐藏 / 退役机器」操作。
- **E4. 多机器原生界面**（依赖 C；改动最大，放在开关 `web.multiMachine` 后面，验证通过后再去掉旧路径）：
  - 网页里的会话身份统一为 `机器/引擎/会话ID`，覆盖标签页、置顶、分屏和地址栏路由。
  - 页面连接不再绑定某台机器，每个命令带上 `machine`。`web-machine.ts` 已有按请求传机器的机制，Hub 需要提供不绑定机器的页面连接与全局 `list_sessions`。
  - 文件、Git、终端操作的机器取自会话或工作区所在行。
  - 删除 cookie 切换（`/_relay/use`）、`sidebarHold` 和 `ccgui.machineCatalog.v1` 目录缓存（`machine-catalog.ts`）。
  - 支持跨机器分屏。
- **E5. 会话徽章**：运行中、待审批、待输入、未读。状态来自扩展后的 `machines://status`（每个会话的状态和更新时间）；未读按浏览器记在本地，或记进 Hub 设置。
- **E6. 通知**（D4）：
  - 默认用企业微信群机器人：Hub 在回合完成、等待回答或审批、出错时推送。webhook 存在服务器环境变量里，不进仓库。
  - 页面打开时用浏览器 Notification API 和标题角标。
  - Web Push 依赖浏览器厂商的推送服务，内网能否连通未验证，验证通过前不做。
- **E7. 管理字段**（标题、置顶、归档、模型偏好；以执行端为准）：
  - 网页修改经 Hub 写到执行端，成功后 Hub 更新自己的副本；桌面本机的修改经目录变化同步到 Hub。
  - 执行机离线时：远端会话按 D6 处理；本地会话直接拒绝，提示机器离线。
- **E8. 手机布局**（可选）：侧栏抽屉化、两种视图的切换在窄屏可用。
- **E9. 登录后的真实浏览器验收**：在 CCGUI 入口逐项验证断网横幅、发送断线后查送达、两种视图切换、机器离线、打开已归档会话。

### F. 收尾

- 四台执行机都在 v1 上稳定两周后，删除 Hub 的 v0 兼容：`ccgui-codex-transcript.mjs`、`repairNativeHistory`、`mergeHistory`、`tailMatcher`、base64 RPC 隧道、同名探测替换。
- 第 5 节的稳定性矩阵全部自动化。
- 把 `docs/web-hub-architecture.zh-CN.md` 改写成最终架构，把 `docs/agent-link-v1.zh-CN.md` 的状态改为已实现。

---

## 5. 稳定性验收矩阵

下列数值是验收目标，不是当前实测。每项要有自动化用例：Hub 测试里用可控代理模拟断线、半开连接和慢链路，执行端用 `cargo test`。

| 场景 | 期望 |
|---|---|
| `send_message` 发出后、响应前断线（浏览器↔Hub 或 Hub↔执行机） | 不重复执行；重连后显示「已开始」或「未送达，可重发」；执行机离线时显示等待确认 |
| 执行机半开连接（不发 FIN） | 45 秒内显示离线；恢复后 5 秒内重新上线，不出现 409 |
| 回合进行中传输 50 MB 历史页（第 D 阶段后） | 其他会话实时输出延迟 p95 小于 1 秒，停止命令 1 秒内送达 |
| Hub 重启 | 执行机任务不中断；网页自动恢复；远端会话无重复、无缺失 |
| 浏览器休眠 30 分钟后唤醒 | 30 秒内发现断线并重连，正在看的会话补齐 |
| 执行机在跑任务时收到更新 | 等到空闲再替换，不中止任务 |
| 新版本自检失败 | 2 分钟内自动回滚到旧版本，Hub 记录失败 |
| 本地会话在桌面运行 | Hub 库里没有它的任何内容；正在看它的网页能看到实时输出 |
| 归档远端会话 | Hub 库里内容清空、目录保留；在线时能打开，离线时提示清楚 |
| 远端会话规模 50 个、每个 5 千条消息时回合结束 | Hub 单次事件循环阻塞小于 50 ms |

---

## 6. 待决事项与默认决策

实施时先按默认决策做，但 D1 和 C5 第 3 步涉及删数据，必须先得到用户确认。

| 编号 | 问题 | 选项 | 默认 |
|---|---|---|---|
| D1 | 2026-10-13 14:30 前网页发起的会话无法识别来源 | A. 迁移时全部当本地，内容仍在执行机，「全部」视图可看<br>B. 把 153 个未归档本地会话一次性列为远端（多保留约 394 MB）<br>C. 用户手动挑选 | A，迁移前把名单给用户过目 |
| D2 | 网页往本地会话里发消息 | A. 自动纳入远端并导入完整历史<br>B. 不入库，只实时读取（离线看不到） | A |
| D3 | 未归档的远端会话是否设自动归档期限 | 不设，或设 N 天未更新自动归档 | 不设；归档即清空已控制体积 |
| D4 | 通知渠道 | 企业微信群机器人，或 Web Push | 企业微信群机器人 |
| D5 | 桌面窗口是否也提供「仅远端发起」筛选 | 提供或不提供 | 提供 |
| D6 | 执行机离线时修改远端会话的管理字段 | A. Hub 先接受，排队到重连后写回，按时间后写者胜<br>B. 直接拒绝 | A |

---

## 7. 风险

- **自更新出错导致执行机起不来**：要求自检加自动回滚、先只开 PC6、`pnpm deploy:win` 保留为人工通道。第一次自更新演练必须在用户知情时进行。
- **迁移删除约 4 GB 的 Hub 数据**：按 C5 第 3 步逐个核对执行机副本，旧库备份保留 14 天，删除前要用户确认。
- **MC2 升级滞后**：Hub 所有新行为都按能力开关，MC2 在 1.1.3 上继续走旧路径，直到手工升级。
- **本地会话离线不可见、不可搜**：这是需求 1 带来的取舍，界面上要明确提示，不能显示成空列表。
- **第 D 阶段前实时读取大型本地会话较慢**：v0 隧道每页 20 条、走 base64；第 D 阶段的大块通道解决这个问题。在此之前允许 Hub 用内存缓存。
- **跨仓库协议漂移**：两个仓库共用协议样例文件（Agent Link 设计稿第 8 节），双方测试都解析它。

---

## 8. 验证命令

- 本仓库：`pnpm build`；`pnpm exec vitest run <相关测试路径>`；`node --experimental-strip-types --test tests/*.test.ts`；在 `src-tauri` 下 `cargo test <过滤条件>`、`cargo test --test send_path`；`node --test scripts/deploy-windows.test.mjs`。
- `ccgui-relay`：`bun test ./ccgui-hub.test.mjs ./ccgui-relay.test.mjs ./ccgui-hub.integration.test.mjs ./ccgui-debug-api.test.mjs ./ccgui-logs.test.mjs`（显式路径）。
- 服务器部署：参照 `ccgui-relay/releases/phase0-relay-20261014-133aebfa/` 的 `install.json`、`scripts/install-hub.py`、`scripts/verify-deployment.mjs`：先备份源码和 `VACUUM INTO` 数据库快照，核对线上文件未被他人改过，只停止确认过的 Hub PID，部署后核对四台机器连接、HAPI 进程未受影响、网页资源哈希与功能检查。
- 报告时写清实际通过、失败、跳过和未覆盖的项目；退出码为零不等于用户问题已解决。

---

## 9. 需要同步更新的文档

- `docs/web-hub-architecture.zh-CN.md`：数据归属（第 3 节）、两种视图、归档语义、迁移结果。
- `docs/agent-link-v1.zh-CN.md`：第 4 节复制范围、物化表改为按需。
- `docs/ui-ux-spec.zh-CN.md`：E 阶段每一项和 B3 的等待确认状态。
- `docs/ai-debug-api.zh-CN.md`：`scope` 参数、`source` 字段、`waiting-executor`、`run_status`。
- `docs/windows-relay-update.zh-CN.md`：自更新发布流程与人工通道的关系。
- `ccgui-relay/HUB.md`：只从提交部署、远端会话存储规则、迁移脚本用法。
