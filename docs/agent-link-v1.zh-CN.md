# Agent Link v1：执行端与 Hub 的专用通道（设计稿）

状态：v1 尚未上线。Hub 与执行端的身份、双通道、心跳、规范日志复制及管理字段仲裁已接入源码。真实 Rust↔Bun 回环测试覆盖大结果、工具事件、HTTP、重连和吊销；四台设备升级、故障矩阵与实际链路测量仍待完成。源码版本为 1.3.0，尚未发布。现状架构见 [DevCloud 网页与会话管理](web-hub-architecture.zh-CN.md)。

## 要解决的问题

阶段 0 在不升级执行端的前提下止血。下面几类问题的根因在执行端协议，只改 Hub 无法根治：

1. **身份**：机器名就是主键，四台机器共用一个 `RELAY_KEY`。任何持有密钥的进程都能用任意名字接入；名字冲突只能靠「旧连接是否回 ping」来判断（阶段 0 的同名重连探测）。
2. **双层隧道**：Hub 的观察/RPC 连接是执行端 `/ws` 经 relay `open/data` 帧再封装一层 base64。单帧上限迫使导入每页 20 条、失败后逐次缩小页、单条大工具结果改走文件接口，并在 Hub 用 JS 再实现一遍 Codex 转录本解析（`ccgui-codex-transcript.mjs`）。大块数据与控制帧在同一条有序流里，大页传输会推迟心跳和停止命令。
3. **历史归并做了两遍**：执行端 Rust 的 `journal_page` 叠加日志与原生转录本，Hub 再用 JS 合并、修复（`repairNativeHistory`、`mergeHistory`）。两处规则会漂移，Grok 重复回合的修复就是例子。执行端每读一页都重建整段叠加，整段同步的代价随会话长度平方增长。
4. **投递**：Hub 与执行端的连接在 `send_message` 确认前断开时，Hub 只能记为 `indeterminate`，之后无法消解。执行端其实已有持久台账：`chat_runs` 以 run_id 为主键，在启动进程前写入，重复 run_id 直接失败。缺的只是查询接口。
5. **更新**：`pnpm deploy:win` 经 SSH 推送，需要人工触发；执行端长期停在旧协议上，新能力只能在 Hub 上绕着做。

## 原则

- **执行端为准**：会话历史、运行状态和投递结果以执行端为唯一来源；Hub 只复制，不再归并或修复。
- **本地能力不变**：桌面窗口、局域网直连、本地数据库与引擎的行为不受影响。
- **升级 Hub 不重启执行端**，不中断运行中的任务；执行端只在空闲时自行更新。
- **不重放提示词**：任何环节不确定时报告「无法确认」，不自动重发。
- **渐进兼容**：Hub 同时支持 v0（现协议）与 v1，按 hello 选择路径；只有明确不支持 v1 时执行端才回落到 v0。批准、令牌失效或吊销不能触发降级绕过身份校验。

## 1. 连接与身份

端点 `wss://<hub>/agent/v1`，与现有 `/m/<名字>/agent?key=` 并存。执行端第一帧：

```json
{ "t": "hello", "protocol": 1, "machineId": "8f3c…", "name": "PC6", "version": "1.3.0", "platform": "windows",
  "capabilities": ["session_log", "run_status", "bulk", "self_update"], "token": "…" }
```

- `machineId`：首次启动生成的 UUID，保存在私有 `app.db`，重装程序不变。名字保留既有兼容路由，当前不自动迁移以名字为键的会话数据。
- **机器令牌**：每台一个。首次接入用现有 `RELAY_KEY` 引导，Hub 记录 UUID 与名字，状态为「待批准」。登录后的 `GET /_relay/machines` 查询身份；`POST /_relay/machines/<UUID>` 的 JSON `{"action":"approve"}` 批准，`revoke` 单独吊销。Hub 只存令牌哈希；列表不返回令牌或摘要。首次 welcome 丢失时，尚未确认的令牌允许重新签发；成功 token hello 或 bulk hello 后固定，无法用共享密钥轮换。
- Hub 回复 `{ "t": "welcome", "protocol": 1, "connectionId": "…", "hubVersion": "…", "heartbeatMs": 10000, "deviceId": "…" }`，首次签发时带 `token`；不支持的版本回 `unsupported_protocol`。令牌存于执行端已有的私有 `app.db`，不进入日志。执行端继续用 `deviceId` 通过本机的设备审批和命令分派。
- 同一 `machineId` 重连直接替换旧连接，不再需要探测。名字已绑定到另一个 UUID 时拒绝 `name_in_use`；管理员核实替换设备的 UUID 后，用 `{"action":"rebind","replacementId":"…"}` 保留原名字和目录，再单独批准新 UUID。替换立即关闭旧连接，等待批准期间仍禁用 v0。重新批准现有设备时，Hub 明确返回 `reenrollment_required`，执行端清掉旧令牌并重新走 v1 引导；其他凭据拒绝不清除令牌、不降级。

Hub 新增 `machines(machine_id PK, name UNIQUE, token_hash, approved_at, last_seen, version, protocol)`。现有表仍以名字为键，本阶段不重写主键；绑定关系保证一个名字只对应一台机器。

登录后的身份列表包含 `lastAddress`，取自 Hub 接受控制连接时的 TCP 对端地址，不接受 hello 或 `X-Forwarded-For` 的声明。地址随身份持久化，替换身份时清空；位于代理之后时此值表示实际连接 Hub 的代理对端。

## 2. 帧与通道

两个独立 WebSocket：`/agent/v1` 负责控制和实时事件，`/agent/v1/bulk` 负责大块正文。welcome 下发本次连接的 `connectionId`；大块连接同时验证机器令牌和此编号，旧连接的大块数据不能交给新连接。控制连接断开时清理它拥有的流。

**控制帧**（文本 JSON，单帧不超过 1 MiB）：`req`、`res`、`event`、`hb`、`hb-ack`、`cancel`、`credit`。

```json
{ "t": "req", "id": 42, "cmd": "run_status", "args": { "runIds": ["…"] }, "deadlineMs": 10000 }
{ "t": "res", "id": 42, "ok": true, "data": {} }
{ "t": "res", "id": 42, "ok": false, "error": { "code": "unknown_command", "message": "…", "definitive": true } }
```

v1 的 `definitive` 由执行端明确给出；v0 保留原来的兼容推断。请求在分派前过期会明确拒绝；取消或断线不会中断已经分派的原生命令，也不会重放提示词。

**大块帧**（二进制）：`[u32 streamId，网络字节序][u8 flags][payload ≤ 256 KiB]`。响应过大时 `res` 带 `stream: { id: 7, bytes: N, sha256: "…" }`，单个正文上限 128 MiB；最后一块的 flags 为 1，其他为 0。接收方核对长度与校验值后才提交，不完整的流整体丢弃。

**流控**：发送方初始信用为零；接收控制帧中的描述符后才发首个 4 MiB `credit`，保证两条连接之间描述符先于正文。接收方处理分块后补充信用；不足时暂停大块发送，控制和实时事件继续收发。同一回合的后续事件、同一 HTTP 隧道的结束帧要等其前面的正文校验完成，其他回合和隧道继续处理。历史页不再限制 20 条，不再用 base64。大页传输期间心跳与停止命令小于 1 秒是验收目标，必须通过慢链路实测确认。

执行端先用 Hub 的设备身份通过本机 `/ws?events=0` 审批，并保持该连接监测授权。RPC 复用原生命令分派和更新活动计数，实时事件单独订阅现有广播器，卸载时移除；大结果解析、编码和摘要计算放到阻塞工作线程，保持控制读取独立。命令名、参数与错误不变。原生 HTTP/WS 隧道保留语义，正文改走大块流，去掉线上的 base64。

## 3. 心跳与在线状态

- 执行端每 `heartbeatMs`（默认 10 秒）发送 `{ "t": "hb", "seq": 1, "activeRuns": [{ "runId", "engine", "sessionId", "startedAt", "state", "updatedAt" }], "journalHead": 123 }`，其中 state 为 `running`、`awaiting-approval` 或 `awaiting-input`；Hub 回 `hb-ack`。
- 任一方 30 秒没收到任何帧即判定断开并关闭；执行端沿用现有退避重连（1、2、4 秒……封顶）。WebSocket 层 ping 保留作补充。
- `activeRuns` 让 Hub 不再轮询 `list_active_runs`，`machines://status` 直接由心跳驱动；`journalHead` 用来判断日志补拉是否落后。

## 4. 执行端为准的会话日志

目标：Hub 不再解析原生转录本、不再修复历史，只按修订号复制执行端给出的消息。

复制范围只包括 `origin=hub` 且未归档、未删除的会话。本地与归档会话仍由执行端实时读取，结果不进入 Hub 的消息表、事件表或搜索索引。

先按回合计算规范消息，复用执行端的解析、叠加与修复逻辑；暂不新增保存完整 payload 的 `session_log` 物化表。持久化头部修订号、epoch、来源签名以及每行的稳定 ID、内容摘要、最近修订号和删除标记，保证重启后修订号不会倒退。规范消息在有界内存缓存中按需保留；源转录本或该回合日志变化才重算受影响部分。

- `message_id` 稳定：日志回合用 `run:<runId>:<event seq>`，原生转录本用 `native:<叠加前解析消息的 seq>`，两种来源的命名空间不相交。
- `rev` 是会话内单调递增的修订号。追加、工具结果补齐、回合被日志替换、删除都写入新的 rev；删除留墓碑行。
- **增量更新**：按转录本来源签名与回合日志头部识别变化。追加与工具结果补齐更新对应行；变短、前缀改写或身份重排时全量重算并 `epoch + 1`。先测量约 9 MiB 会话的冷解析、热分页和序列化，再决定是否需要物化，局部回放数据不能代替原生应用或链路性能。
- **接口**：`session_log_since { engine, sessionId, afterRev, epoch, untilRev?, limit }` 返回 `{ rows: [{ messageId, rev, seq, payload, deleted }], headRev, epoch, nextRev, hasMore, reset, … }`。每页最多 500 行，正文按约 96 MiB 拆批，单条不截断，超过传输上限明确失败。后续页用首帧 headRev 作为 untilRev。进行中的纯追加不把这次复制打成 reset：`untilRev` 仍停在首帧那个修订，文件变长的部分留给下一次调用。源被改写或 epoch 不同才从头复制。数据库只保存身份、摘要、修订和删除标记，正文使用 16 会话、64 MiB 的有界缓存。子任务摘要带执行端计算的触发边界，Hub 按页裁剪；结束回合确认覆盖完整历史，避免旧事件永久残留。
- **追加前缀**：普通会话转录本（codex、grok、claude、kimi、qoder、pi、omp 的 jsonl）在压缩、改名或截断之前只追加。`session_log_since` 按签名里记下的长度读一段一致前缀，这一页的修订对应该前缀；下一次调用读后面的字节。文件长过捕获长度时，末尾没有换行的半行先不返回，补完后的下一次只出现一次。文件长度没变时，即使最后一行没有换行也算完整记录。前缀被改短、前缀字节对不上、文件消失，或者来源本来就不是追加（opencode 的 sqlite、dsh 的 zstd、agy）时，仍走整段解析：三次签名一致才提交，否则返回 `session changed while reading revision log`；稳定的改写让 epoch 加一并 `reset`。运行中预期的追加记 info（尝试次数、耗时、前缀长度），不在每次轮询打 error。真正的改写或损坏记录仍是 error。
- 插件远程工作区可同时传 `workspacePath`、`remotePath`；复用既有远程路径白名单、已登记工作区传输和 64 MiB 转录本缓存，再走相同规范消息、修订号与分页。v1 Hub 对此类远端会话也使用 `session_log_since`，每次不再限 20 条；Hub 与执行端之间走 bulk。执行端到远程工作区的既有传输方式保留。本机扫描目录里没有该会话时仍可同步，外部改写会触发 reset。
- **Hub**：只对未归档远端会话按 `(machine, engine, session, message_id)` 与 rev 写入，低修订号和重复页不能覆盖新数据，删除标记清理对应行和索引。网页的 `historyEpoch` 取执行端 epoch。本地 `session_log_since` 只供实时读取。四台执行端在 v1 上稳定两周后才删除旧转录本解析、历史修复与尾部比对。
- 实时流不变：`engine://event` 仍用于逐字显示；会话日志只负责持久历史。
- 快照只确认执行端 `eventCursor` 之前的事件；Hub 独立保存执行端与自身游标，清理被规范消息覆盖的事件。网页快照游标停在首条未覆盖事件之前，读取期间新到的输出仍可补拉；迟到的已覆盖事件不再次广播。回合最后序号独立持久化，前缀清理和重启不制造缺口。

## 5. 投递台账

执行端：`chat_runs` 增加 `state`（reserved、spawned、done、error、cancelled、spawn_failed）、`origin`（local、hub）和 `error`。新增 `run_status { runIds }`，返回 `[{ runId, known, state, sessionId, startedAt, error, origin }]`。台账在首次异步等待前提交；未知 ID 的明确回执同时写入 `chat_run_tombstones`，在数据库锁内关闭迟到请求的接收窗口，重发必须使用新的 ID。

Hub：

- `send_message` 确认前断开的回合，在执行端重连后立即用 `run_status` 消解。`known=false` 且没有已观察输出时记为 `not-received`，原 ID 已在执行端关闭，迟到请求不能再启动；`reserved`、`spawned` 或已有事件记为 `acknowledged`；`spawn_failed` 记为 `failed`。已有输出不能被未知回执改成未送达；已收终态不能被迟到的运行中快照复活。
- 网页的 `get_run_delivery` 遇到 `indeterminate` 时，执行端在线就当场查询；离线则返回 `waiting-executor`，网页显示「等待执行机器重新连接以确认」，不再只说「无法确认」。
- Hub 的 `abandoned` 墓碑保留，继续覆盖「Hub 从未收到」的情况。

管理字段使用独立的 `session_metadata` 能力。内部 `write_session_field {engine,sessionId,field,value,modifiedAt,session?}` 返回 `{applied,value,modifiedAt}`，支持置顶、标题、归档和模型/思考档位/渠道；归档需要同身份的目录快照。原生数据库按字段比较修改时间，相同时间保留已有执行端值，本机操作生成递增时间。Hub 的远端离线队列合并同字段修改、持久保存原时间戳并在重连后重放；只确认对应版本，本地离线修改拒绝，提示词不进入队列。目录显示 pending/error，归档确认后才清理 Hub 正文。旧执行端继续使用兼容覆盖。

## 6. 空闲时自更新

`pnpm deploy:win`（见 [Windows 中转客户端一键更新](windows-relay-update.zh-CN.md)）已经有构建包（exe、资源、ZIP、校验清单）、活动任务检查、备份与回滚。自更新复用这些产物，只把触发方式从 SSH 推送改为执行端拉取。

- **发布**：Hub 托管 `releases/<channel>/manifest.json`，内容为 `{ version, protocol, minHubProtocol, files: [{ name, url, bytes, sha256 }], signature }`。签名用离线私钥，执行端内置公钥；Hub 只托管文件，无法伪造更新。
- **通知与下载**：复用 B5 的每 30 秒频道查询和桌面状态提示。执行端后台下载并校验，放进 `updates/<编号>/staged/`，不另增更新通知帧。
- **应用条件**（全部满足，由执行端判断，Hub 不能强制）：没有运行中的回合或预约；没有进行中的 Hub 请求或文件传输；本机窗口 10 分钟无输入；不在用户设置的禁止时段。桌面窗口提示「新版本将在空闲时安装」，用户可推迟。
- **替换与回滚**：沿用部署脚本的 `updates/<编号>/before/` 备份与替换步骤，由独立的小更新器进程完成替换和重启。新版本启动后 2 分钟内必须完成 v1 hello 并通过自检（读取工作区、加载网页资源），否则更新器恢复 `before/` 并启动旧版本；Hub 记录失败，不再自动重试同一版本。
- **恢复 v0 旧包**：从 v0 更新到 1.3.0 或后续版本前，更新器用现有更新授权向 `/m/<机器>/update/recovery` 申请独立凭据。Hub 验证当前 v0 observer、开关和发布版本，只保存绑定机器与版本的哈希；待用凭据 10 分钟过期。恢复备份成功后，通过旧包现有本地 `web_relay_start` 写入该凭据并重连。使用后保持重连能力，下一次 v1 自检成功或管理员吊销/退役/替换身份会清除；下一次更新准备不使当前凭据失效。已在 v1 的备份无需此流程。共享密钥仍不能接入已批准的 v1 机器，令牌拒绝也不触发降级。
- `pnpm deploy:win` 保留为人工通道。MC2 继续使用 macOS 构建流程，直到 macOS 更新器完成。

## 7. 上线顺序

1. Hub 支持 v1 端点与 `machines` 表，同时保留 v0。只部署 Hub，不碰执行端，网页不变。
2. 执行端构建同时带 v1 客户端与 v0 回落、`run_status`、会话日志和更新器，用 `pnpm deploy:win` 逐台在空闲时安装，先 PC6。这是最后一次人工安装。
3. Hub 对 v1 机器启用 `run_status` 消解与会话日志复制，v0 机器继续走现有路径。并行期间用诊断接口比对同一会话两条路径的消息条数与内容哈希。
4. 四台全部升级到 v1 并稳定两周后，删除 Hub 的 v0 兼容：转录本解析、历史修复、尾部比对、base64 RPC 隧道。

每一步都能单独回滚：Hub 回滚到只支持 v0 时，v1 执行端自动回落；执行端回滚使用部署回执。

## 8. 验证

- 两个仓库共用一份协议样例 `agent-link-v1.frames.json`（每种帧的合法与非法例子），双方测试都解析并回写，防止实现漂移。
- 故障注入：半开连接、帧丢失、`send_message` 期间执行端或 Hub 重启、大块传输中途断开；64 MiB 工具结果传输期间测量心跳与停止命令的延迟，目标小于 1 秒。
- 会话日志：与现有 `journal_page` 输出逐条比对，覆盖中文、emoji、代码块、工具结果和 Grok 无时间戳回合；原生转录本被外部改写时 `epoch` 递增并完整重放。
- 自更新：有运行中回合、有进行中请求、窗口有输入时都不应用；自检失败自动回滚；校验值或签名不符拒绝安装。
- Hub 规模检查：在 Hub 仓库运行 `bun test-support/hub-scale-benchmark.mjs`，预载 50 个远端会话、每个 5000 条合成规范消息，再处理 50 个回合结束及增量复制。断言最大事件循环定时器间隔小于 50 ms，同时核对 250050 条消息。该检查不包含初始导入、网络、真实原生执行端或页面渲染；生产慢链路和停止命令仍需四机矩阵。

## 不在本阶段

Hub 多实例与高可用；端到端加密；多用户命名空间；用会话日志替换桌面本地的历史读取。

## 与阶段 0 的关系

阶段 0 只改 Hub 与网页：同名重连探测替换、浏览器心跳与断线提示、`machines://status` 推送、尾部增量同步与差异写入、发送断线后的送达查询（含 `abandoned` 墓碑）。阶段 1 上线后，探测替换由 `machineId` 取代，尾部比对由会话日志取代，`indeterminate` 由 `run_status` 消解；网页侧的心跳、状态推送和送达查询保持不变。
