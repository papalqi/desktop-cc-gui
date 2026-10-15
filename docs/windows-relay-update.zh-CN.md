# Windows 中转客户端一键更新

在 Windows 仓库根目录执行：

```powershell
pnpm build:win                   # 只构建并冻结更新包
pnpm deploy:win PC6              # 构建、传包、备份、安装、重启、验证
pnpm deploy:win PC6 --artifact artifacts/windows/<包目录>
pnpm deploy:win PC6 --rollback   # 恢复最近一次部署保存的程序和资源
pnpm test:deploy                 # 活动任务、失败恢复、成功更新的回归验证
```

`build:win` 先运行 `pnpm build`，再以 `tauri/custom-protocol` 构建 release exe，确保网页资源嵌入程序。产物在 `artifacts/windows/<时间-随机编号>/`，包含 exe、内置 `agent-catalogs` 和 `skills`、ZIP 更新包与校验清单。`--artifact` 复用这个完整目录，不重新编译。

部署构建使用独立的 Cargo 缓存 `src-tauri/target/relay-build/`，避免本机运行中的 `target/release/ccgui-next.exe` 被占用而导致打包失败。首次编译这个缓存耗时较长，后续构建增量复用。

首次使用时，把 `scripts/deploy-windows.config.example.json` 复制为 `scripts/deploy-windows.local.json`，填入当前连接信息。本机配置与 `artifacts/` 已加入忽略规则。当前工作区已配置 PC6。

`host` 使用 SSH 别名或 `user@host`；可选 `port` 与 `identityFile` 覆盖 SSH 配置。SSH 必须已配置密钥登录和已知主机，脚本不会跳过主机身份检查。每台 Windows 目标需已有 `CCGUIRelay` 计划任务，指向正式的 `ccgui-next.exe`；安装目录从任务动作读取，不写死用户名或路径。

中转主机需要 Bun 和现有多机器中转服务。`relay.directory` 指向中转目录，`relay.bun` 为 Bun 路径，`relay.wsUrl` 为主机自身可访问的 WebSocket 地址。检查复用中转主机 `sessions.json` 中尚未过期的网页登录凭据；凭据不会下载、打印或写入仓库。凭据全部过期时，先网页登录一次。

执行更新时先检查中转可访问性和活动任务，完成上传与备份后再次检查；目标机器还会在停止任务前直接查询本机 WebSocket 的活动任务。任何检查发现任务仍在运行，均退出且不停止应用。准备阶段、写文件阶段或进程启动失败均返回非零退出码；停止应用后发生安装失败会尝试恢复备份并重新启动。

上线检查包含计划任务状态、单个正式应用实例、exe 校验值，以及通过指定机器中转连接读取工作区、加载网页与 JavaScript 资源。在线检查失败会通过目标机器的本地任务检查尝试回滚；如果这时已经有人开始新任务，或本机桥接无法确认是否空闲，会保留备份并报告失败。回滚或检查失败不能视为部署成功。

远端备份保留在安装目录 `updates/<编号>/before/`，本机回执保存在 `artifacts/deploy/<机器>/<编号>.json`，`latest.json` 指向最近进入替换阶段的更新。SSH 在替换阶段断开时，可据回执检查实际状态并运行回滚；回滚会核对当前 exe 属于该次部署，防止覆盖后续更新。临时上传目录在结束时清理，备份和回执保留。

新增 Windows 机器时，在 `machines` 中添加对应机器名、SSH 连接及计划任务名即可。macOS 继续使用已有 `pnpm build:mac` / `pnpm build:mac:skip-notarize`；Windows 更新脚本不用于 MC2。

## 签名自更新

`pnpm release:win` 复用完整 Windows 包，要求源码已提交。设置 `CCGUI_RELEASE_PRIVATE_KEY` 为离线 Ed25519 私钥路径，并配置 `relay.releaseUrl` 为执行端实际连接的 Hub 地址（与 `webRelayUrl` 同源）。私钥留在发布电脑；Hub 只收到 ZIP、两个安装器和签名清单。首次初始化使用 `node scripts/relay-release-signing.mjs --create-key <私钥路径> src-tauri/resources/relay-update-public-key.txt`；公钥变化必须随应用更新，不能在 Hub 侧替换。

发布命令为 `pnpm release:win`，或 `pnpm release:win --artifact artifacts/windows/<包目录>`。版本文件先上传到 `releases/windows/<版本>/`，全部成功后才替换频道 `manifest.json`。同一版本目录不覆盖。发布不会打开任何机器的开关。

登录后的 `/_relay/updates` GET 返回机器开关、能力与结果；POST `{ machine: "PC6", enabled: true }` 打开指定机器，第一次只启用 PC6。1.1.3 或 macOS 不声明 `self_update`，不能打开此开关。执行端每 30 秒检查清单，先校验应用内公钥签名，再下载同源文件并验证签名尺寸和 SHA256。

执行端检查所有聊天、插件、任务预约和进行中的桥请求/HTTP 传输；同时要求 Windows 系统最近 10 分钟没有输入（覆盖桌面窗口，条件更保守）、没有推迟或禁止时段。桌面提示后台下载及空闲安装，提供推迟一小时和本地时间的每日禁止时段；跨午夜时段有效，两个时间均为空或相等表示不禁止。安装与运行预约共享互斥边界，安装开始后暂缓新任务，已有任务不会被停止。

独立 `install-self-update.ps1` 通过 Windows WMI 创建隐藏进程，脱离应用计划任务的进程组；应用取得进程句柄并写入带一次性令牌的启动回执后，更新器才允许停止应用。回执缺失或不匹配时不替换文件。安装器复用人工通道的 `before/` 备份和活动任务校验。新版本启动时暂缓任务，检查工作区与嵌入的 HTML/JavaScript，并向 Hub 核对 observer 已收到同版本 hello。两分钟预算预留最后一次探测和恢复旧程序的时间；本地探测所有端口共用 5 秒截止时间。自检不通过就回滚。结果保存在暂存目录 `receipt.json` 和应用数据目录 `updates/state.json`；失败版本在执行端与 Hub 都禁用自动重试，Hub 暂不可用时执行端重连后重报结果。桌面或桥接更新 API 不提供强制安装入口。

v0 更新到 1.3.0 或后续版本时，更新器先从 `/m/<机器>/update/recovery` 申请绑定机器和发布版本的独立恢复凭据。Hub 仅存哈希，未使用的凭据 10 分钟过期；准备下一次更新时保留上一次回滚仍在使用的凭据。只有确认恢复旧 exe 后，更新器才调用旧包本地 `web_relay_start` 保存凭据并重连，Web 接口未监听时最多等待 5 秒。凭据使用后可跨 Hub 重启重连，后续 v1 自检通过或身份被吊销、退役、替换时清除。已在 v1 的旧包和旧 Hub 无此步骤。源码回归覆盖这些时序，真实 PC6 两分钟回滚演练仍待部署后执行。
