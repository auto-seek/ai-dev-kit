---
type: runbook
status: active
owner: ai-dev-kit maintainers
created_at: 2026-09-07
last_verified_at: 2026-09-15
related_paths:
  - docs/team-git-center.md
  - docs/team-gate-migration.md
  - scripts/cascade-lane.cjs
  - scripts/cascade-process.cjs
  - scripts/cascade-doctor.py
truth_sources:
  - docs/team-git-center.md
  - docs/team-gate-migration.md
  - scripts/cascade-lane.cjs
  - scripts/cascade-process.cjs
  - Cascade 0.8 native retry and WorkerConfig.from_dict
  - Cascade c65e2fdec0eb53410bf9ef12787c34cf9ed32afd src/cascade/cli.py
  - Cascade c65e2fdec0eb53410bf9ef12787c34cf9ed32afd src/cascade/client/execution.py
  - Cascade c65e2fdec0eb53410bf9ef12787c34cf9ed32afd src/cascade/client/query.py
  - Cascade c65e2fdec0eb53410bf9ef12787c34cf9ed32afd src/cascade/worker/runner.py
---

# 团队 worker 停止与协调中心恢复

本指南用于员工 worker 停止、失联、命令超时及中心会话重启后的恢复。
如果中心已迁移，以新批准入口为准，先按[迁移与接入恢复](../skills/ai-dev-kit/references/center-access.md)
核验本人公钥、实际启动绑定与迁移状态；下文“原中心”指当前权威中心，不是已封住的旧地址。
认证失败时保留候选及测试证据，不能暂缓协调门禁或先合本地 dev；修复后重新取得最终内容绑定回执。
接入配置以[多人接入 Git 协调中心](team-git-center.md)为准，验收与合并以
[项目门禁合同](team-gate-migration.md)为准。已批准任务内的实现、测试和复审纠错
直接继续，不因正常返工重复请示。异常恢复先保存现场、读回事实，再在已有授权
范围内处理；超出范围或授权不明时才请求决策。本文中的写命令只供获授权的执行者
按条件执行，不是整篇执行脚本，也不赋予 worker 业务建图或重试 FAILED 的权限。
supervised worker 内的实现 agent 只交付批准路径的修改；租约、提交、验证、发布和
finish 由 supervisor 管理，实现 agent 不接管这些操作。

## 先停止扩散并保存现场

以下停止针对受影响的 worker/任务及依赖其未决结果的步骤。本机解释器、认证或
dispatch 配置故障不让其他健康 worker 停工。真实共享状态异常或未隔离的协议
不兼容则按实际影响处理；不能把本机 doctor 成功当作全体入口兼容的证明。

1. 员工停止本轮认领和发布，保留工作目录、未提交改动、本地及远端结果分支。
   记录任务 ID、agent、claim 返回的 fencing token、最后确认续租时间及租约长度，
   以及运行 ID、进程信息、命令起止时间、退出码和日志位置。
2. supervisor 核对本次拥有的 harness、续租和 Git/SSH 进程是否仍运行；只通过获授权
   的进程管理方式停止本次执行。终端关闭或员工失联不能证明远端机器已经停止。
   无法确认旧执行已停止时，暂停重新派发并联系原执行者或管理员。
3. 保存批准的产品 remote、base SHA、发布 remote、实际结果分支和候选完整 SHA，
   以及验证 argv、日志、preflight receipt 和下游 promises。supervised worker 优先
   查看该次运行目录的 `report.json`、`steps` 对应日志及 dispatch 配置；报告可能在
   进程被强行终止时缺失，不能把缺失当成未发布。
4. 对外报告只包含必要的非敏感定位信息。原始日志和 dispatch 留在受控位置；不复制
   个人 token、模型登录文件、云管理员凭据，也不把含凭据的 URL 写进文档或工单。

## 使用原中心重建观察

中心会话重启后，先恢复同一 Git remote、确切 namespace 和原本机专用 cache 路径，
再读取远端。核对主 checkout 的 profile、`profile.local.yml` 和环境覆盖项，特别是
`AI_DEV_KIT_CASCADE_GIT_REMOTE`。同一 namespace 仍由一位约定的规划负责人协调，
中心重启不撤销员工 claim，也不授予新会话抢占权。

下面沿用中心指南的变量，从已有批准配置和记录恢复，不必逐会话请管理员再确认；
有缺失或冲突才核对。`CACHE` 不重新推导为别人的路径。
`CASCADE_BIN` 必须指向已核验版本，示例通过 PATH 供现有命令监督器调用。

```bash
set -euo pipefail
: "${KIT_ROOT:?设置已核验的 kit 源码绝对路径}"
: "${CASCADE_BIN:?设置已核验的 Cascade 可执行文件绝对路径}"
: "${REMOTE:?确认原协调 Git remote，不是产品 remote}"
: "${NAMESPACE:?确认原 namespace}"
: "${CACHE:?确认原本机专用 Git cache 绝对路径}"
: "${TASK:?指定待观察的单个任务 ID}"
export PATH="$(dirname "$CASCADE_BIN"):$PATH"
c() {
  node "$KIT_ROOT/scripts/cascade-process.cjs" --storage-kind git -- \
    --git-remote "$REMOTE" --git-cache "$CACHE" \
    --namespace "$NAMESPACE" "$@"
}
cascade --version
git ls-remote --exit-code "$REMOTE" "refs/heads/cascade-state/$NAMESPACE"
c list-nodes
c inspect --task "$TASK"
c history --node "$TASK"
c check-task --task "$TASK"
c verify-chain
```

这些 Cascade 查询不认领或完成任务，但 Git 后端仍会申请、释放远端事务锁，需要
协调 refs 写权限；`git ls-remote` 成功只证明读权限。任何查询失败、事件链异常、
预期 ref 缺失或图不符都停止受影响的操作并查明，不能换 namespace、切 file 存储、
创建同名空图或从旧本地副本覆盖远端。`verify-chain` 检查事件链完整性，不证明
产品测试、发布或复审通过。

缓存是本机观察副本，不是第二个中心。不要放在 NFS/同步盘或供多机共享；原缓存
损坏或换机时，保留故障证据；已有本机配置授权涵盖重建缓存时，直接新建专用 cache，
再从**同一 remote 和 namespace**读回核验，否则先请求该项授权。不要复制缓存里的
凭据，也不要据旧缓存直接派发。入口或有效配置变化时可用中心指南的 `lane doctor
--python <实际解释器> [--dispatch <配置>]` 检查；未变入口的既有结果跨会话复用。
dispatch 错误与 protocol 结果分别处理，不重做全员环境报到。

## 确认当前 owner、token 与租约

对照 `list-nodes` 的当前状态和 `agent_id`、原 claim 记录及
`history --node "$TASK"` 的事件顺序。最新 `TASK_CLAIMED` 中的 `claim_token`、
`agent_id`、`claimed_at`、`timeout` 以及后续 `TASK_RENEWED` 的 `renewed_at`、
`timeout` 用于核对归属和期限；同时排查后续回收、释放、完成、失败或重新认领事件。
不能从旧日志取一个 token 就当作当前 token，也不能只取最后几条事件而漏掉 claim。
查询是分次快照；并发变化、时钟不明或记录不完整时，保持停止并交中心查明。

截至 Cascade `c65e2fd`，renew/finish 的归属校验是节点处于 `ACTIVE`、传入 token
匹配节点 `claim_token`，以及传入 agent 时匹配 owner；**这两个入口不自行检查 TTL**。
团队命令必须同时提供 agent 和 token。租约到期表示该 claim 可被协议回收，不等于
token 自动撤销。不能声称引擎自动拒绝所有过期 finish。

`list-nodes` 的 `stale` 只是提示：它也会标记无 timeout 且活动超过 600 秒的任务。
出现或未出现该提示都不能替代精确租约核对。`check-task` 的 `valid` 是取消 token
状态，不检查 TTL，也不返回 fencing token，不能证明租约尚未到期；其中
`claimed_at` 也不能当作最近续租时间。必须结合最新 claim/renew 事件和可信时间。

**到期、续租失败或续租结果未知即停止执行和发布，是团队操作规则。** 不利用引擎
未校验 TTL 的行为补续租或过期 finish，不借用其他执行者的新 token。

| 读回情况 | 处理 |
|---|---|
| 原 owner/token 一致，确认租约仍有效 | 不抢占；确认只有一个执行实例后，由原 supervisor 决定恢复或按协议结束 |
| owner/token 已改变，或任务已离开 ACTIVE | 旧执行停止所有写入，保留产物交中心裁决 |
| 已到期、续租未知、旧执行或发布结果未查清 | 保持停止并读回；仅无法在现有授权内查明或处理时请求中心决策，不直接续租、finish 或再次认领 |
| 无有限 timeout 或证据不足 | 不自行补一个超时值宣布任务可抢；交中心处理 |

只有中心查清旧执行已停止及发布结果、确认目标可回收且已有授权覆盖该恢复后，才可用
**定向** `get-task` 对该单目标原子回收并重新认领。下面是写操作，不是探针：

```bash
: "${AGENT:?设置获授权的新执行者 ID}"
: "${TIER:?设置真实模型能力 lite、pro 或 max}"
c get-task --task "$TASK" --agent "$AGENT" --agent-tier "$TIER" --timeout 1800
```

引擎在同一事务内处理目标过期回收和认领判断，仍受 reservation、tier、状态和
已有 ACTIVE 任务限制；认领可能失败，失败后仍要读回，不能假定没有任何状态变化。
成功后只使用本次返回的任务与新 token，重新核对任务范围和产物；旧 token 不得复用。
仍有效的目标不能因员工失联而强行回收。不要省略 `--task`：池式认领可能检查多个
节点的超时。更不能把全 namespace 的 `check-timeouts` 当成单任务探针；它会写入并
释放到期任务，没有单任务 `--task` 参数。

## FAILED 的已授权精确重试

FAILED 与正常任务内纠错、到期 ACTIVE 回收是不同状态。中心已有明确的同范围
重试授权时，不再为相同决策请示；没有授权、超出批准次数/范围或需要改验收标准
则停下请求决策。先读回目标 FAILED 及其确切失败事件 ID，确认旧执行已停止、
发布结果已查清、失败原因与获准修复路径明确，并解除再次执行所需的环境阻塞，
且实际共享入口已满足 0.8 协议兼容要求。内容缺陷在新的合法 claim 内修复、
复审和验证，不要求先无租约修改完代码才能重开。
`doctor` 只验证所选入口，不能代替其他旧进程已停止的事实。

由 orchestrator 使用相同已核验解释器和主 checkout 配置，保留一次操作的稳定 ID：

```bash
: "${CASCADE_PYTHON:?设置已核验的实际 Cascade Python}"
: "${FAILURE_EVENT:?从目标历史读取确切失败事件 ID}"
: "${OP_ID:?设置并保留本次已授权重试的唯一操作 ID}"
: "${REASON:?说明失败原因、获准修复路径与本次重试依据}"
node "$KIT_ROOT/scripts/cascade-lane.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.yml" --agent "$AGENT" \
  --python "$CASCADE_PYTHON" retry --slug "$TASK" \
  --failure-event "$FAILURE_EVENT" --op-id "$OP_ID" --reason "$REASON"
c inspect --task "$TASK"
c history --node "$TASK"
```

`retry` 要求 native Cascade >=0.8.0 和 orchestrator role，绑定确切失败事件，
使用原生操作 ID 去重。它不认领任务、不授予授权，也不自动循环重试。未知写结果
先读回；已成功则不再新增操作，确认允许重放时仍用原操作 ID。失败事件已变、状态
不符或归属未清不能换事件/操作 ID 强行重试。之后仍按原任务合同重新认领，取得
新的有效租约、完成独审和最终 preflight；不复用旧 token 或已失效回执。

## 空队列与故障分开处理

只有完整返回明确 `NO_READY_TASKS` 才按空闲处理，原生 CLI 此时退出码仍为 1。
这不表示所有任务完成，可能还有 ACTIVE 或依赖未满足的 PENDING。正常员工 loop
沿用中心指南：等待 60 秒后只再查一次，仍为空就退出；恢复流程不启动无限轮询。

`INSUFFICIENT_TIER` 是能力不符；`ALREADY_HAS_ACTIVE` 要先核对自己的旧执行；
`STALE_TOKEN`、`WRONG_AGENT`、任务状态冲突需要核对归属。认证、网络、锁、版本、
迁移、解析错误以及截断输出都属于故障，不能把“非零退出”统称为空队列，不能虚报
tier、偷偷切 role 或改图消除报错。

## 命令超时：写结果未知

[cascade-process.cjs](../scripts/cascade-process.cjs) 对 Git 命令默认预算 180 秒，
可通过 `AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS` 或 wrapper 的 `--timeout-seconds`
设置正数，最大 3600。超时返回 124，INT/TERM 返回 130/143，并清理其拥有的 POSIX
进程组。这不能回滚已经提交到远端的事务。该预算与 get-task/renew-task 的租约
`--timeout` 是两个参数；加长命令预算不延长租约。

遇到 claim、renew、finish 或产品 push 超时，先停止依赖该结果的步骤，保留日志，
按前述查询读回 owner/token、事件与远端产品分支。claim 可能已经成功；renew 可能
已写入新的时间；finish 可能已经完成；push 可能已经更新 ref。响应缺失、本地进程
被杀或重试报错均不能证明第一次没有写入。读回仍失败就报告“结果未知”并暂停，
不盲目重试，不通过 release/fail 写操作试探，也不切换存储绕开故障。

## 产品 push 成功但 finish 失败

产品 push 和协调 finish 是两笔事务。即便报告失败，也先保留远端分支、worktree、
候选 SHA 和所有验证证据。结果分支必须从实际发布记录读取：中心指南的手动流程
示例是 `codex/<TASK>-<TOKEN>`；c65 supervised worker 是
`<publication.branch_prefix>/<run_id>`（默认前缀 `codex/worker`），报告字段为
`branch`，本地 `<前缀>/<TASK>`（如 `codex/<TASK>`）则是 `local_branch`。不能从任务 ID 或 token 猜分支。

从发布记录确认 remote、branch、完整 SHA 后读回产品 ref，不能假定 remote 是 origin：

```bash
: "${WORKTREE:?设置保留的产品 checkout 路径}"
: "${PUBLICATION_REMOTE:?从发布配置读取实际产品发布 remote}"
: "${RESULT_BRANCH:?从发布记录读取实际远端分支名}"
: "${EXPECTED_SHA:?从已验证候选记录读取完整 commit SHA}"
git -C "$WORKTREE" ls-remote --exit-code "$PUBLICATION_REMOTE" \
  "refs/heads/$RESULT_BRANCH"
c list-nodes
c inspect --task "$TASK"
c history --node "$TASK"
```

核对输出是否恰为 `EXPECTED_SHA` 与该完整 ref。不存在、查询失败或 SHA 不符时，
不得宣称发布成功或强推覆盖；保持产物并报告。远端 SHA 一致只是发布证据，还要
核对同一 SHA 的真实测试、preflight 和下游交付内容。

| 协调读回结果 | 中心裁决依据 |
|---|---|
| 已 COMPLETED 且交付记录吻合 | 记录响应丢失/后续报错，安排独立复审，不重复 finish |
| 仍为同一 ACTIVE claim 且确认未到期 | 查明失败原因、实际证据和 promises；原 owner/supervisor 在已有交付授权内补齐真实交付后可再次 finish，无须重复请示 |
| 已 FAILED、READY、重新认领或已到期 | 保留发布分支供人工裁决，旧执行者不得重放 finish 或替新 owner 交付 |
| 状态、owner/token 或发布结果仍未知 | 暂停后续写入，报告未决事实，不能标记通过 |

c65 supervised worker 的异常路径还会尝试以原 token 记录 fail；因此本地
`status: failed` 不代表远端一定 FAILED，也可能是 ACTIVE、已 COMPLETED 或已经
被回收。结合 `failure_recorded`、事件与实际发布 ref 判断，不仅依赖本地报告。
`UNADDRESSED_PROMISES` 需要真实交付确认；原生 `finish-task` 使用可重复的
`--deliver <下游ID> <实际交付文本>`，`--critical` 不能替代它。不要删除承诺、
编辑状态或写虚假交付使 finish 通过。

[cascade-lane.cjs](../scripts/cascade-lane.cjs) 使用 `claim/renew/finish/release`
和 `--slug`，原生 CLI 使用 `get-task/renew-task/finish-task` 和 `--task`。
lane 的 `--deliveries` JSON 映射会转为原生重复 `--deliver`；lane `release`
会转为 `finish-task --release --reason`。不要混用两层旗标；查询用上面的原生入口。

## 独立复审与人工审批边界

中心安排独立 reviewer 检查确切发布分支与 SHA、需求范围、真实验证日志和交付
证据。supervisor 按项目合同完成最终提交及 preflight；merge gate 要求匹配最终
HEAD、批准 base ref、工作区内容及配置的成功 receipt。改动任何绑定输入后重新
验证；测试或 test-scope 变更需要实际独立审查，不能伪造 approved、receipt 或
通过记录，不能降低验证 argv 来消除失败。恢复操作及本指南不代表复审已批准。

`COMPLETED` 不等于复审通过、已合并或正式发布。保留分支直到负责人完成裁决和
交付；不强推产品或协调 refs，不删除图、节点、历史或结果分支来掩盖失败，不代替
保护分支的人类审批。role、agent ID、tier 和 reservation 是协作及协议约束，
不是强身份认证或 ACL；真实权限仍由 Git 授权、产品分支保护、执行沙箱和最小凭据
控制。中心会话恢复或自报 orchestrator/max 不会改变这些权限。
