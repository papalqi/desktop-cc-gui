# AI 操作与调试 API

Hub 提供供 AI 调用的 HTTP 查询、会话操作、回复读取和运行诊断接口。操作复用既有执行命令；执行端另外提供本机快照、性能采样与持久化日志。远程基础地址为 `https://arashishader.devcloud.woa.com/CCGUI`；以下路径相对此地址。源码位于相邻的 `ccgui-relay` 仓库和本项目的 `src-tauri/src/web/debug.rs`。

## Hub 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/_relay/api` | 接口发现、鉴权方式、容量与错误码 |
| GET | `/_relay/api/commands` | 23 个操作的参数 JSON Schema、默认值、执行位置、读写性质与调用说明 |
| POST | `/_relay/api/machines/{machine}/invoke` | JSON `{command,args}`：查询内容、开始/继续会话、回答提问或中断回合 |
| GET | `/_relay/api/machines/{machine}/runs/{runId}` | 投递状态、会话绑定、结束状态、持久化回复事件与有界等待 |
| GET | `/_relay/api/status` | Hub 启动时间、运行时内存、存储数量、机器总览 |
| GET | `/_relay/api/machines` | 在线与已缓存的离线机器 |
| GET | `/_relay/api/machines/{machine}` | 中转连接时间、开放流数量、观察连接、待处理 RPC、浏览器数量与同步状态 |
| GET | `/_relay/api/machines/{machine}/sessions` | 会话 ID、引擎、归档、导入状态与历史版本 |
| GET | `/_relay/api/machines/{machine}/history?engine=...&sessionId=...` | 原生消息数量、事件序列缺口、转录本覆盖、历史完整性 |
| GET | `/_relay/api/machines/{machine}/executor` | 通过 RPC 读取执行端快照 |
| GET | `/_relay/api/machines/{machine}/performance` | 执行端现有性能采样 |
| GET | `/_relay/api/machines/{machine}/probe` | 实际执行 `list_active_runs`，返回 RPC 往返时间与运行任务 |
| GET | `/_relay/api/activity` | 近期连接、同步错误、RPC 结果与耗时 |
| POST | `/_relay/api/machines/{machine}/sync` | 同步机器目录，或强制同步指定会话历史 |
| GET | `/_relay/api/logs` | Hub 日志与已同步的执行端日志 |
| GET | `/_relay/api/logs/export` | 按筛选条件分页导出 NDJSON |
| GET | `/_relay/api/machines/{machine}/logs` | 指定机器的日志，离线仍可查询已缓存记录 |
| GET | `/_relay/api/machines/{machine}/logs/export` | 指定机器的 NDJSON 导出 |
| POST | `/_relay/api/machines/{machine}/logs/sync` | JSON `{}` 等待执行端保留日志补拉完成 |

机器由路径明确指定，不受另一个网页标签修改机器 cookie 的影响。会话列表和历史中的回合列表支持 `limit=1..100`（默认 50）、`offset>=0`，返回 `nextOffset`；历史汇总统计涵盖全部回合。

鉴权复用网页登录：向 `/_relay/login` 提交表单 `password`，后续携带返回的 `ccgui_relay_auth` cookie。API 无有效登录票时返回 JSON 401。执行端密钥 `RELAY_KEY` 用于机器连接和执行端更新请求，不用于网页登录。

公网地址还经过 OA 登录网关。浏览器使用已有 OA 登录状态；普通 HTTP 脚本只携带 Hub cookie 会先收到 OA 登录 HTML，不能把 HTTP 200 当作 API 成功，需核对 JSON 的 `ok` 和 `schemaVersion`。脚本可在 DevCloud 通过 SSH 调用 `http://127.0.0.1:8787/_relay/api`，或把该回环端口经 SSH 转发到本机，再沿用 Hub 登录；该路径不经过公网 OA 网关。

JSON 成功响应为 `{schemaVersion:1, generatedAt:<毫秒>, ok:true, data:...}`；失败为 `{schemaVersion:1, generatedAt:<毫秒>, ok:false, error:{code,message,...}}`，均禁用 HTTP 缓存。常见错误包括 400 参数错误、404 机器/会话/回合/命令不存在、405 方法错误、409 重复 runId、413 请求体超过容量、415 非 JSON 请求体、501 执行端不支持命令、503 离线、504 RPC 超时及 502 执行端拒绝或操作失败。同步请求最多 8 KiB，`invoke` 最多 1 MiB。普通 API 错误和 `activity` 不返回上游原始异常或完整参数；发送失败会附带必要的 runId、投递状态和查询路径，详细日志提供脱敏后的错误正文和可用堆栈。

`sync` 要求 `Content-Type: application/json`：

- `{}` 等待目录同步完成，返回 `catalogSynchronized:true`；历史迁移可能继续在后台运行，查看 `machine.sync.migration`。
- `{"engine":"codex","sessionId":"..."}` 等待该会话同步完成，返回更新后的历史诊断；复用正在同步的同一会话。不会发送提示词、重放任务或中断 AI 进程。

## AI 查询与会话操作

签名自更新的管理入口 `GET /_relay/updates` 使用相同网页登录，返回 `{machines:[{machine,enabled,capable,result}]}`，可查询逐机开关及最后的安装/失败回执。POST `{machine,enabled}` 修改指定机器的开关，启用需要 `self_update` 能力；该入口只决定是否提供更新，空闲条件、自检和回滚仍由执行端判断。此入口返回上述独立 JSON，不使用 `/_relay/api` 的 schemaVersion 包装。

AI 首先读取 `/commands` 和 `/machines`，取得参数契约与机器名，然后向机器路径发送 `{"command":"...","args":{...}}`。接口校验必填项、类型、取值范围及未知字段，并应用发现接口中的默认值。`location=hub` 由 Hub 提供目录/历史/搜索，`cached-executor` 在线从执行端读取、离线使用已有缓存，`executor` 必须在线；`effect=read|execute` 描述该操作是否执行任务或改变运行状态。

| 能力 | command | 主要参数 |
| --- | --- | --- |
| 引擎与模型 | `list_engines`、`list_engine_models` | 模型查询需要 `engine`，可选 `workspace` |
| 工作区与完整会话目录 | `list_workspaces`、`list_sessions`、`list_archived_sessions` | `limit`、`offset`；会话另可按 `engine`、`workspacePath` 精确筛选，以及 `scope=remote|all` |
| 消息搜索 | `search_messages` | `query`、`limit`、`offset`、`scope=remote|all` |
| 对话内容与工具结果 | `load_session_page`、`load_remote_session_page` | `engine`、`sessionId`、`limit`、`beforeSeq`；远程记录还需要 `workspacePath`、`remotePath` |
| 会话增量 | `load_session_events` | `engine`、`sessionId`、`afterCursor`，可选 `untilCursor`、`historyEpoch`、`historySource=hub|executor` |
| 运行任务 | `list_active_runs` | `{}` |
| 持久运行台账 | `run_status` | `runIds`，最多 256 个；执行端须声明 `run_status` |
| Hub 发送送达核对 | `get_run_delivery` | `runId`，可选 `waitMs=0..5000`，可选 `closeIfMissing`（默认 true，与已打开的旧网页相同，没收到就作废）。`closeIfMissing:false` 只查询，不关闭 ID |
| 关闭未收到的发送 ID | `close_unreceived_run` | `runId`。仅当没有记录时记为作废；已有记录原样返回 |
| 会话管理 | `pin_session`、`rename_session`、`archive_session`、`delete_session` | 置顶要 `pinned`；改名要 `title`（null 清除）；归档传 `{session}` 或 `{engine,sessionId}`；删除要执行端在线 |
| 记住会话选择 | `remember_session_model`、`remember_session_effort`、`remember_session_provider` | 分别传 `model`、`effort`、`providerId` |
| 会话来源 | `set_session_origin` | `engine`、`sessionId`、`origin=hub|local`；执行端须声明 `session_origin` |
| 开始或继续对话 | `send_message` | `runId`、`engine`、`workspacePath`、`prompt`，继续对话另传 `sessionId` |
| 恢复归档会话 | `restore_session` | `engine`、`sessionId`；复用已有恢复命令，不发送提示词 |
| 回答执行中的提问 | `answer_question` | `sessionId` 或 `runId` 至少其一、`requestId`、`answers`。`answers` 的键是 `questions[].question` 提问原文，不是标题或问题 id |
| 中断指定回合 | `interrupt_session` | `sessionId` 或 `runId` 至少其一。只传 `runId` 时 Hub 写入执行端已有的 `sessionId` 字段 |
| 文件查询 | `list_dir`、`read_file`、`search_text` | `path`；文本搜索还需要 `query` |
| Git 查询 | `git_status`、`git_diff`、`git_branches` | `path`；diff 还需要 `file`、`staged` |

查询成功的 `data` 为 `{machine,command,online,result}`。目录查询的 `result` 为 `{items,total,nextOffset}`，含标题、工作区和其余现有元数据；这与 `/machines/{machine}/sessions` 的身份诊断视图不同。目录、消息搜索和消息页默认 50 条、最多 100 条。消息页从最近一页开始，用 `nextBefore` 继续向前翻页；`historyEpoch` 改变时重读快照。`search_messages.pending` 表示尚未导入历史的会话数，搜索仅涵盖已导入消息。文件响应沿用原有内容类型、截断标记和执行端授权，不扩大可访问路径。

执行端同时声明 `journal` 和 `session_origin` 后，Hub 启用只保存远端会话的路径。`scope` 默认 `remote`；`all` 在在线时加入执行端本地目录和搜索结果，本地正文不保存到 Hub。未归档远端历史由 Hub 提供，已归档和本地历史实时读执行端；后两者离线返回 `executor_history_offline`。旧执行端保持原有缓存路径。

目录查询返回的 `machine` 必须随会话身份保留；不同机器上的相同引擎、会话 ID 与工作区路径不能合并。搜索结果的 `machineOffline` 表示该次查询缺少离线执行端的本地结果；结果分页前过滤来源，不应把缺少的本地结果当作没有匹配。

支持 `session_metadata` 的执行端以字段时间仲裁网页管理修改。目录中的 `metadataSyncPending=true` 表示远端修改仍在 Hub 的持久队列，`metadataSyncError` 为上次失败的通用码；重连后保留原时间戳重试，较新的执行端字段可否决旧修改。归档排队时正文尚未清理，执行端确认后才清理。该队列只保存管理字段，不重放对话发送；内部 `write_session_field` 未加入公开 HTTP 命令目录。

消息页与事件页的 `source=hub|executor` 标识游标来源，实时事件使用同名含义的 `historySource`。请求增量时传上次来源；来源变化会返回 `reset:true`，必须丢弃旧游标、重读快照再接续。两个来源的游标与 epoch 不能互相比较大小。Hub 保存新版执行端规范页的原文，不再二次归并；被完整快照覆盖的已结束回合事件会清理，运行投递台账继续保留。

发送前生成并保存唯一 runId（1..128 个 ASCII 字母、数字、`-` 或 `_`）。`send_message` 省略或传 null 的 `sessionId` 开始新会话，传已有 ID 则继续；可选 `model`、`effort`、`permission`、`providerId` 和执行端本机路径 `imagePaths`，具体参数见发现接口。成功返回 **HTTP 202**，`data.result={runId,sessionId}` 和 `data.runPath` 确认启动命令已响应。默认不等待回复；可选 `waitMs=0..25000`（默认 0）由 Hub 消费，不传给执行端。正数表示启动确认后最多等待该时长，遇到终态、未答提问、离线、请求取消或运行状态不再活跃时提前返回；响应仍为 202，并在 `data` 内附与回合 GET 相同的页面字段。`waitReason` 说明返回原因，等待超时不会停止或重发任务。会话 ID 可能暂时为 null，随后从回合查询中的 `run.sessionId` 获取。`runPath` 是相对于站点域名的路径，已包含 `/CCGUI` 前缀。

归档会话先调用 `restore_session`，再用同一 `sessionId` 和新 runId 继续。支持管理字段同步的执行端可能返回 `result.queued=true`，须等待目录中的 `metadataSyncPending` 清除并核对归档状态；恢复和提示词发送不会组合重放。此入口复用 Hub/执行端已有的生命周期能力，无需增加执行端命令。

同一机器重复提交已有 runId 返回 **409 already_submitted**，附带已有投递状态和查询路径，不再发送提示词。超时或断连可能已经送达，返回的 `delivery=indeterminate` 必须通过回合查询核对，不能换一个 runId 自动重试。在线前置检查失败为 `delivery=not_sent`，不会创建回合；执行端明确拒绝为 `failed`，HTTP 502 的 `executor_rejected` 另附去掉凭据样式片段后的简短 `reason`。`in-flight` 表示 RPC 尚未响应，`acknowledged` 表示收到启动响应，null 表示该回合来自执行端观察而非 Hub 发起。`get_run_delivery` 对从未见过的 runId 返回 `not-received`。省略 `closeIfMissing` 或传 true 时把该 ID 作废，已打开的旧网页依赖这一点。`closeIfMissing:false` 不写库。新网页确认未送达后调用 `close_unreceived_run`，才把没有记录的 ID 记为 `abandoned`（查询时显示为 `not-received`）并阻止迟到启动；已有的 in-flight、acknowledged 或 failed 不会被降级。这些值描述命令投递，真实执行结果以事件为依据。参数校验失败时，`message` 在 `Invalid`、`Missing` 或 `Unknown argument` 之后写明期望的类型、枚举、模式或范围。Hub 已保存待答提问时，对不上的回答键返回 400，`unmatched` 是用错的文本，`expected` 是提问原文。

回合查询支持 `afterCursor>=0`、`limit=1..100`（默认 100）、`waitMs=0..25000` 和 `waitFor=events|terminal|question`（默认 events）。返回 `{machine,online,run,events,head,hasMore,nextCursor,pendingQuestions,waitReason}`；从 0 读取，后续传 `nextCursor`，有 `hasMore` 时继续取页。默认等待新事件或状态重新核对；terminal 等待终态，question 等待未答提问或终态。后两者会忽略普通增量，所有唤醒共用同一个截止时间。`pendingQuestions` 合并快照中仍待答的提问及未落定的提问事件，独立于本次事件游标；终态不再返回待答提问。`waitReason=events|state|terminal|question|timeout|offline|inactive|aborted|stopped`；state 表示投递、目录或快照重新核对唤醒，可能没有新事件。离线、非活跃、取消请求和 Hub 停止均提前返回。非活跃或离线不等于任务成功；读取/等待/取消 HTTP 请求均不发送或中断任务。

事件信封字段为 `{runId,engine,seq,kind,data,ts,startedAt,cursor,sessionId,workspacePath}`，类型字段名是 `kind` 而不是 `type`。常见 kind：`message`（完整消息，`data.role` 为 user/assistant/tool）、`delta`/`text`（回复增量，拼接 `data` 即正文）、`thinking`（思考片段）、`session`（会话身份）、`question`/`question_settled`（提问与落定）、`usage`（token 用量）、`done`、`error`。`/_relay/api` 发现响应的 `events` 字段包含同样的说明，供 AI 自查。

终态页面附 `replyText`（该 run 最后一条 assistant 正文的原文摘录，最多 4096 个 UTF-8 字节）、`replyTruncated` 和 `readVia`（指向 `load_session_page` 的 engine/sessionId 参数）。截断保留完整 Unicode 字符，不生成模型摘要。优先使用覆盖该回合的完整快照，否则只从连续完整事件投影正文；存在缺口、部分前缀已清理或没有可确认正文时为 `replyText:null`，使用 `readVia` 读取消息页。结束事件可能先于完整快照到达，此时已缓存消息页也可能仍旧；需要完整回复时，先 `POST /machines/{machine}/sync`，传相同 engine/sessionId，等待同步后再读回合或消息页，不将缓存页视为同步已完成。指针从会话最新页开始，旧回合需按 `nextBefore` 翻页并匹配消息的 runId；后续回合不会覆盖旧 run 的摘录。

已结束回合被完整快照覆盖且没有保留事件时附 `eventsCleared:true`；仅仅将游标读到末尾不会标成已清理。`send_message` 的 `engine` 会在 Hub 端按缓存的引擎目录校验，未知或不可用的引擎直接返回 400 并附 `engines` 列表，不会消耗 runId。`load_session_events` 的 `afterCursor` 可省略，默认 0。事件包含增量、思考、工具、提问与结束信息，正文保留 Unicode 和完整工具结果；单页按事件条数限制，大工具结果仍可能很大。

`run` 提供引擎、工作区、会话 ID、启动时间、投递状态、最近观察的 `active`、`terminal=done|error|null` 和 `outcome=completed|interrupted|error|null`。outcome 使用明确的结束事件或执行端台账：正常结束为 completed，`done.data.cancelled=true` 或台账 cancelled 为 interrupted，error/spawn_failed 为 error。仅有结束快照、缺少结果证据的旧记录为 null；中断请求收到确认也不会提前标为 interrupted。结果字段独立持久保存，清理事件和重启后保留。completed 表示引擎正常结束，不是对任务目标的独立验收。done 本身仍兼容正常结束和中断；无终止事件不能因为 `active=false` 就认定回复完整。离线时 `online=false`，`active` 仅为最后保存的状态；已保存回复继续可读。`journalContinuous` 和 `missingEventCount` 表示从 seq 0 到已观察到最大 seq 的连续性；缺口或历史版本失效时用消息页与显式同步恢复。事件的 `seq` 是回合内顺序，`cursor` 是 Hub 到达顺序，迟到事件仍会得到新游标，合并时以 runId/seq 去重并按 seq 排序。

`question` 事件的 `data.requestId` 用于回答提问；`data.input.questions` 提供问题正文与选项。`answers` 为问题正文到选项标签的映射，多选值为标签数组，null 表示跳过。继续已完成会话时使用同一个 `sessionId`，为新回合生成新的 runId。

最小跟进循环（`get`、`invoke` 返回解包后的 `data`）：

```js
let afterCursor = 0;
for (;;) {
  const page = await get(`${runPath}?afterCursor=${afterCursor}&waitMs=25000`);
  for (const event of page.events) handle(event.kind, event.data); // 按 runId/seq 去重与排序
  afterCursor = page.nextCursor;
  if (page.hasMore) continue;
  if (page.run.terminal) { consume(page.replyText, page.run.outcome, page.readVia); break; }
  if (page.pendingQuestions.length) { answerOrPause(page.pendingQuestions); break; }
  if (!page.online || !page.run.active) await backoff(); // 不将断线/非活跃当作完成
}
```

会话增量的游标还要保留 `source` 和 `historyEpoch`。遇到 `reset:true`，先 `load_session_page` 重读快照，再用该页的 `eventCursor`、`source` 和 `historyEpoch` 初始化下一次请求；`hasMore` 为 true 时持续取页，否则由调用方退避（此命令没有长轮询参数）。`/commands` 的 notes 和发现响应中也提供跟进伪代码。

新版执行端的 `run_status` 返回 `[{runId,known,state,sessionId,startedAt,error,origin}]`，状态为 `reserved|spawned|done|error|cancelled|spawn_failed`；未知 ID 的字段为 null。`known=false` 的明确回执会在执行端关闭这个 ID，避免旧连接上迟到的发送随后启动，用户有意重发须创建新 ID。已接收回合的 ID 持久去重；执行端重启将未收敛的台账记为 error，保留已保存历史及其完整性信息。

Hub 的发送统一附加 `origin:"hub"`。执行端记录会话来源，已有远端会话在桌面继续也保持 hub；目录与消息页带 `origin`。Hub 重启或执行端重连后，用能力支持的持久台账核对尚未确认的发送；执行端离线时 `get_run_delivery` 返回 `waiting-executor`，表示等待机器重连，不表示未送达。收到过的输出和终态优先于迟到的状态查询。1.1.3 不支持新增执行端命令，Hub 仍保持现有路径。

## 判断故障位置

先读机器状态：`agentConnected=false` 表示执行端中转连接离线；`observer.state=awaiting-hello` 表示本机桥接尚未完成握手；`ready` 表示已收到执行端 hello。`observer.pendingCount` 统计已发出并等待响应的 RPC，`pending` 最多列出 50 条命令和等待时长。`relay.openStreams` 包含观察连接、文件传输和 HTTP 转发。

再用 `probe` 检查一次实时 RPC；其 `roundTripMs` 包括 Hub 到执行端的传输和命令执行，不等同于前端显示延迟。离线机器仍可读取已缓存的状态、会话和历史诊断；执行端快照、性能、探测与同步明确返回 503。

历史诊断中的 `historyEpoch` 是 Hub 历史版本；`hubEventCursor` 与 `nativeJournalCursor` 属于不同日志，后者是最近成功导入时记录的原生日志游标，不能直接比较大小。每个回合的 `journalContinuous` 表示已观察到的事件从 seq 0 连续且包含用户事件，不代表回合已经结束；`missingEventCount` 只计算到已观察到的最大 seq，无事件时为 null。`coveredByTranscript` 表示完整原生转录本已覆盖结束回合。`blocksHistory` 和 `blockingRunCount` 用于判断缺口是否仍影响展示；`incompleteTurn` 还考虑原生快照和离线运行状态。

`sync.failedTranscriptCount` 给出失败总数，`failedTranscripts` 最多列出 50 个会话的错误码和重试时间。`hasRecordedSyncError` 表示 Hub 仍保存上次同步错误，后续目录同步成功会重新核对并清除；它不是执行端进程存活判断。

存储统计的 `pendingMetadataFields` 为待确认管理字段数，按字段计数；同一会话可有多项。结合目录的同步状态判断离线排队或失败，不能把队列存在解释为 AI 回合仍在运行。

`activity` 支持 `machine`、`afterId`、`limit=1..100`，按 ID 升序分页，返回 `nextId`、`hasMore`、`oldestId`、`truncated`。只保留内存中的最近 200 条操作，不替代完整服务日志。Hub 重启后 ID 重置；`startedAt` 改变时从 `afterId=0` 重新读取。记录包含机器、命令、必要的引擎/会话 ID、结果码和耗时，不保留其余命令参数与返回数据。

## 持久化日志

Hub 保存到数据目录的 `logs.db`，执行端保存到应用数据目录的 `diagnostics/logs.db`。独立于会话数据库，重启保留 ID 和 `epoch`。每个库最多保留 7 天、50,000 条、64 MiB 序列化正文，先达到的限制生效；单条正文最多 16 KiB，长消息/堆栈按 UTF-8 边界截断。年龄清理在日志写入/读取时最多每分钟执行一次。64 MiB 是正文预算，SQLite 索引、页、WAL 占用另计，清理后数据库复用页，不保证文件立即缩小。

| category | 内容 |
| --- | --- |
| `performance` | Hub 每 5 秒记录进程内存、CPU 与定时器延迟；执行端沿用每 5 秒的采样器记录主进程/系统 CPU、内存、swap 与采样耗时；两端记录远程 RPC 耗时 |
| `error` | Hub 同步、RPC、HTTP 转发失败与 stderr；执行端现有运行错误/警告、引擎 error/warn/retry/permission_denied 事件及 RPC 失败 |
| `exception` | Hub 未捕获异常、未处理 Promise 拒绝和 HTTP 处理异常的 JS 堆栈；执行端 Rust panic 的位置和回溯 |
| `lifecycle` | Hub 观察连接建立/断开；执行端启动/退出、引擎结束及已有安装/迁移提示 |

进程 CPU 百分比采用单核 100% 的口径，可大于 100%；系统 CPU 沿用采集器的全核平均百分比。Hub 的 `eventLoopLagMs` 是 5 秒采样定时器的实际间隔减去 5 秒，不代表网页渲染延迟。Hub RPC 耗时包括传输与执行端处理，执行端 RPC 耗时仅统计命令分派、不包含其日志写入。执行端关闭原有性能诊断开关后，不再生成周期性能样本；RPC 耗时和错误仍记录。Rust panic 可能由现有 `catch_unwind` 恢复，看到 exception 不一定表示整个进程退出。

记录包含 `id`、`epoch`、`at`（毫秒）、`origin=hub|executor`、`category`、`level=info|warn|error`、`source`，以及可用的 `machine`、`operation`、`engine`、`sessionId`、`runId`、`durationMs`、`message`、`stack`、`metrics`。Hub 导入执行端记录时保留源机器的 `at`，附带 `receivedAt`（首次接收时间）、`originEpoch`、`originId`，跨机器比较需考虑时钟偏差；Hub 的 `id` 与执行端原始 `id` 属于不同游标，不能直接比较。

查询参数：`origin`、`category`、`level`、`source`、`engine`、`sessionId`、`runId` 为精确匹配，`q` 为序列化记录中的文字子串；Hub 总览另支持 `machine`，机器路径优先于同名查询参数。`since`/`until` 为时间戳闭区间。JSON 页 `limit=1..100`（默认 50），导出 `limit=1..1000`（默认 1000）。按 ID 升序返回 `entries`、`nextId`、`head`、`hasMore`、`oldestId`、`truncated`、`epoch` 与保留策略；用 `afterId=nextId&untilId=head` 读取同一范围的后续页。`truncated` 表示初始游标之前的记录已被清理；日志库重建导致 `epoch` 改变时，从 0 重读。

导出成功为 `application/x-ndjson`，每行一条记录，通过响应头 `x-next-cursor`、`x-log-head`、`x-has-more`、`x-log-epoch`、`x-log-truncated` 继续分页。只导出当前有界页，避免一次拉取全部记录。

执行端 hello 声明 `debug_logs` 能力后，Hub 收到实时 `diagnostics://logs` 即保存；目录同步/重连和定期轮询会按持久化游标补拉，按机器、原始日志库版本与原始 ID 去重。实时投递可乱序，补拉游标独立推进。`machine.logs` 给出支持情况、同步中、上次成功时间、游标和是否发生同步错误。读取和导出只查 Hub 缓存，强制补拉使用 `POST .../logs/sync`；离线补拉返回 503，旧执行端返回 501。

日志从升级后的进程开始采集，不能恢复以前只写到控制台的内容。凭据字段、Bearer/Basic、URL 密码及已知连接密钥会脱敏，失败的 RPC 还用调用参数中的提示词/正文/凭据做精确替换。不会采集命令完整参数、返回值、对话增量或工具结果，也不订阅 CLI 的原始 stdout/stderr 流；现有引擎已归一化的错误/告警可能包含拼接的控制台尾部，这些文本连同 user/assistant/system 行及 content/result 等字段一起脱敏，再按条目大小上限保存。SIGKILL、系统强杀、断电和底层原生崩溃不能保证留下异常堆栈；任意未知格式的外部错误文本也不能保证自动识别全部敏感信息。

## 执行端直连

本机网页桥接启动后可读取：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/debug` | 执行端接口发现 |
| GET | `/api/debug/snapshot` | 版本、OS/架构、PID、桥接/中转状态、活动回合、事件队列与资源指标 |
| GET | `/api/debug/performance` | 现有原生性能采样，包含 disabled/stale/unavailable 等实际状态 |
| GET | `/api/debug/logs` | 本机保留日志，支持时间/来源/级别/会话/回合与游标筛选 |
| GET | `/api/debug/logs/export` | 本机日志分页 NDJSON 导出 |

直连沿用桥接令牌，可用 `Authorization: Bearer <已有桥接令牌>` 或原有 `?token=`。经 Hub 转发时沿用现有设备审批；未配对返回 JSON 401，令牌错误返回 JSON 403。Hub 也可以通过 `/api/debug/snapshot?machine=PC6` 等路径转发这些接口。

快照只返回中转是否运行、是否连接及是否记录错误，不返回中转 URL、连接密钥或桥接令牌。队列信息包含待发送事件数、字节数、定时刷新状态与是否持久化；读取不会主动刷新队列。资源指标和性能采样沿用现有采集器，读取不启动新采样任务。某个组件不可用时返回该组件的 `ok:false`，其余状态继续可读。`web.remoteSockets` 包含 Hub 观察连接，不代表活跃用户数。

升级后的执行端同时通过既有 WebSocket 分派支持 `debug_snapshot` 和 `debug_logs`。后者使用与本机 HTTP 日志相同的筛选参数，单页最多 1000 条；查询自身不会产生新的性能日志。旧执行端的 Hub 存储、连接诊断和既有性能接口仍可使用；读取新命令会明确返回 501，并提示升级执行端。

## PowerShell 示例

登录密码从现有环境变量读取；机器名和会话 ID 从接口列表取得。

以下示例的公网地址需要同时具备 OA 会话。纯脚本使用 SSH 转发后，将 `$relayOrigin` 改为 `http://127.0.0.1:<本地转发端口>`（无 `/CCGUI` 前缀），其余接口和 Hub 登录方式相同。

```powershell
$relayOrigin = "https://arashishader.devcloud.woa.com/CCGUI"
Invoke-WebRequest -Uri "$relayOrigin/_relay/login" -Method Post `
  -Body @{ password = $env:RELAY_ACCESS_PASSWORD } `
  -ContentType "application/x-www-form-urlencoded" -SessionVariable relayDebugSession | Out-Null
Invoke-RestMethod -Uri "$relayOrigin/_relay/api" -WebSession $relayDebugSession
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6" -WebSession $relayDebugSession
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6/probe" -WebSession $relayDebugSession

Invoke-RestMethod -Uri "$relayOrigin/_relay/api/commands" -WebSession $relayDebugSession
$machineApi = "$relayOrigin/_relay/api/machines/PC6"
$queryBody = @{ command = "list_sessions"; args = @{ engine = "codex"; limit = 50 } } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$machineApi/invoke" -Method Post -WebSession $relayDebugSession `
  -ContentType "application/json" -Body $queryBody

# 工作区路径从 list_workspaces 获取；此调用会启动实际 AI 回合。
$turnId = [Guid]::NewGuid().ToString()
$sendBody = @{ command = "send_message"; args = @{
  runId = $turnId; engine = "codex"; workspacePath = "<执行端工作区路径>"; prompt = "查询当前项目的运行状态并回复"
} } | ConvertTo-Json -Depth 10 -Compress
$launch = Invoke-RestMethod -Uri "$machineApi/invoke" -Method Post -WebSession $relayDebugSession `
  -ContentType "application/json" -Body $sendBody
$afterCursor = 0
do {
  $reply = Invoke-RestMethod -Uri "$machineApi/runs/${turnId}?afterCursor=$afterCursor&waitMs=25000" -WebSession $relayDebugSession
  $reply.data.events
  $afterCursor = $reply.data.nextCursor
} while ($reply.data.hasMore -or ($reply.data.online -and $reply.data.run.active -and -not $reply.data.run.terminal))
# 续接时把 $reply.data.run.sessionId 放入下一次 send_message，使用新的 runId。

$since = [DateTimeOffset]::UtcNow.AddHours(-1).ToUnixTimeMilliseconds()
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6/logs?category=error&since=$since&limit=100" -WebSession $relayDebugSession
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6/logs?category=exception&since=$since" -WebSession $relayDebugSession
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/logs?origin=hub&category=performance&source=runtime&since=$since" -WebSession $relayDebugSession
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6/logs/sync" -Method Post `
  -WebSession $relayDebugSession -ContentType "application/json" -Body '{}'
Invoke-WebRequest -Uri "$relayOrigin/_relay/api/machines/PC6/logs/export?since=$since&limit=1000" `
  -WebSession $relayDebugSession -OutFile "ccgui-logs.ndjson"

$syncBody = @{ engine = "codex"; sessionId = "<会话 ID>" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$relayOrigin/_relay/api/machines/PC6/sync" -Method Post `
  -WebSession $relayDebugSession -ContentType "application/json" -Body $syncBody
```

本地源码验证：Hub 仓库运行 `bun test`，涵盖真实 HTTP/WebSocket 查询、启动/续接/回复读取、重复 runId、超时与离线；本项目日志能力运行 `cargo test --lib -- diagnostics:: web:: event_sink:: metrics:: relay::tests`。操作接口只需更新 Hub 源码，包含新增的 `ccgui-api-commands.mjs`；已有执行端命令和网页协议保持兼容。执行端持久化日志和新快照另需升级执行程序。Hub 更新不要求重启执行机器或正在运行的 AI 任务。

Hub 的五项 HTTP 冒烟固化在 `scripts/smoke-ai-api.mjs`：发现契约、非法参数、机器目录与搜索、发送等待与摘录、续接与重复投递。默认只读，后两项明确记为 skipped；`--exercise --engine <引擎> --workspace <执行端工作区>` 创建独立的两回合测试会话，仅要求回复标记，不使用现有会话。失败时只尝试中断该脚本创建且仍运行的测试回合。通过 SSH 在服务器执行，例如 `node scripts/smoke-ai-api.mjs --url http://127.0.0.1:8787/_relay/api --sessions sessions.json --machine PC0 --exercise --engine codex --workspace <工作区> --receipt <新回执.json>`；脚本不会输出登录票或对话正文。真实 HTTP/WS 集成测试复用同一个冒烟入口。
