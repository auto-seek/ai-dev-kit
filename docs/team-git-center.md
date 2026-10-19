---
type: runbook
status: active
owner: ai-dev-kit maintainers
created_at: 2026-09-06
last_verified_at: 2026-09-20
feature_ledger: cascade:kit-production-fixes-v070/team-loop-ready
related_paths:
  - skills/ai-dev-kit/references/cascade-coordination.md
  - scripts/set-coordination.cjs
  - scripts/skill-first-gate.sh
  - docs/coordination-0.7-migration.md
related_commits:
  - auto-seek/Cascade@689f1f296e1350515842c08522963afd3f387db3
supersedes: []
truth_sources:
  - code
  - Cascade CLI help and docs/supervised-worker.md
  - Git remote refs verified on 2026-09-07
  - Orbweaver docs/agent-platform-production-runbook.md
---

# 多人接入 Git 协调中心

已有项目 ID 的团队直接使用 `cascade-center-agent`：输入网页复制的 `项目ID@中心地址`
和模型 level 后加入，把归属确认码交给使用者，再自查项目源码 Git；不执行下文传统准入报告。要搭建带 AutoSeek 登录、项目 ID 和
网页的中心，使用 [新版中心搭建](../skills/ai-dev-kit-cascade-init/references/project-id-center.md)；
查看现有任务使用 [cascade-flow](../skills/cascade-flow/SKILL.md)。下文保留传统 Git
配置入口的运维流程。


要为另一个项目新建中心，请先走 [创建项目中心](../skills/ai-dev-kit/references/project-center.md)；
本页的“已有 state ref”检查只用于加入已有中心，不用于新建空仓库。
迁移或 SSH 认证失败请走 [迁移与接入恢复](../skills/ai-dev-kit/references/center-access.md)：
修复员工自己的授权并重新验证，不以测试已通过为由暂缓协调门禁、先合本地 dev。

员工可以直接对 agent 说：**“接入这个项目的团队，检查环境和权限，向中心报到一次；
符合项目准入要求后开始 loop。”** Agent 使用 `ai-dev-kit-cascade-init` 的
[自助接入流程](../skills/ai-dev-kit/references/worker-enrollment.md)，从正式项目入口读取
配置，只问无法自行解决的具体缺口，不要求员工填写安装长表。首次真正加入中心仍
报到一次，复用原生 Cascade 节点；同一实际机器入口和配置的环境检查、匹配的报到
可跨会话复用。若中心要求登记新身份，只补身份差异，不重做未变的环境验证。
这不是注册服务或常驻监听；本机检查失败只阻塞该 worker，不阻塞健康同伴。
本页后续内容供 agent 和管理员按需核对，不在每次 loop 重做接入。

## 中心不是一台必须常驻的服务器

| 层 | 做什么 | 不做什么 |
|---|---|---|
| Git 状态仓库 | 保存 DAG、认领、租约及交付事件，以远端 ref 事务保护并发 | 不运行模型、不创建执行进程 |
| 规划 agent / 中心负责人 | 发布任务、依赖、tier，明确调度、验收、安排返工 | 当前没有自动选主或常驻 HA；一个 namespace 同时只有一个约定的规划负责人 |
| 执行 agent / worker | 认领、开发、测试、续租、推送独立分支并报告 | 不自行合并默认分支，不替代独立复审 |

中心地址从当前项目获批准的接入说明取得，不能从本通用指南猜测。可以使用公司
Git 托管、CODING 专用仓库或自托管 bare Git + SSH，不要求 GitHub 账号。一台公司
服务器可以承载多个独立项目中心，每个项目有自己的协调仓库、namespace、授权与
规划负责人；namespace 本身不是权限隔离。服务端必须允许所需 ref 的创建、
带 expected-OID 的更新与删除，并完成相同的并发/失败验收。Redis 不是依赖。
开发者可以在各自电脑运行 agent，服务器只是可选执行资源，不是接入前提。

本指南采用“中心发布，开发者认领”模式。要自行规划工作，可另按 self-serve
工作流申请范围；不要为了接任务而偷偷切换角色或新建一个同名图。
接入阶段仅允许自己的专用报到节点及隔离权限探针；worker 不因此获得业务建图权限。
员工失联、写操作超时或中心会话重启时，按[恢复指南](team-loop-recovery.md)
先读回事实，不能以重复认领或删除协调状态作为恢复步骤。

## 接入前由管理员提供

- 协调仓库地址、**确切 namespace**、产品仓库、目标分支和批准的 base commit。
  不猜 namespace，不复用历史 smoke namespace。
- 唯一 agent ID，任务范围、设计文档位置、验收方法与复审人。
- 协调 refs 的合法写权限和产品分支权限；开发者使用自己的获授权 Git 身份、
  模型账号或专用凭据，不需要服务器 root 权限。
- Python 3.11+、Git、Node.js、项目工具链和可工作的真实 harness。
- 管理员批准的 `CASCADE_SOURCE_REMOTE` 源码 SSH URL（GitHub 或同提交的公司源码镜像），
  它不是协调状态仓库 remote；员工使用自己的获授权只读源码身份。

新安装保留 Cascade >=0.8.0 的要求，默认的发布源码为 Cascade 0.8.1，提交
`689f1f296e1350515842c08522963afd3f387db3`（标签 `v0.8.1`）；事件与存储协议和 0.8.0 相同，
已按 `4400dee8a0e1129e6408578eab4b495168a340ea` 安装并核验的 0.8.0 环境继续有效。按
[安装说明](../skills/ai-dev-kit/references/cascade-coordination.md#installation)
使用批准的 `CASCADE_SOURCE_REMOTE` 和完整 SHA 安装，核验提交、实际入口与版本。
已有项目更高的最低版本或另一个已审固定运行时合同继续有效，不因默认值而降级。
中心提供 wheel 时同样按该安装说明核验制品哈希、来源提交和精确版本。
公司镜像与 GitHub 不是错误后的自动备选；所选来源失败就停止，保留认证与 host-key 检查。
不用未固定的 main、猜测的 tag 或
假定 PyPI 供应来替代来源核验。既有已批准、核实来源的 0.8 环境无需仅为新安装
推荐而重装。bootstrap 继续逐字节保留旧 profile，版本要求只能显式迁移。

共享 namespace 写入第一个 0.8 新事件前，核实实际访问它的机器入口：PATH 中的
CLI、绝对路径 CLI、supervisor/worker 的 Python 环境及定时进程环境；不兼容入口
须升级或停止访问。相同入口/配置的核验跨会话复用，不逐会话收集证明。某台机器
本地未配置不阻塞健康同伴；尚未隔离的不兼容客户端仍阻塞相关协议升级。
只更新 Kit 或 profile 不会升级实际 Cascade；本机自检不能证明其他进程已暂停。
遇到新事件不能降级客户端、改写历史或切换后端逃过错误。
旧 `slug@owner` 图先按 [迁移说明](coordination-0.7-migration.md) 处理，禁止混跑旧 worker。

## 1. 克隆产品并安装 / 更新 kit

下列 Bash 示例需要先设置变量；路径用绝对路径。`KIT_ROOT` 是已核验版本的 kit
源码目录，`PROJECT` 是本机产品主 checkout，`CASCADE_BIN` 是所选版本可执行文件。
所有写操作只用于管理员已批准的项目及任务；不要整篇无差别粘贴执行。

```bash
set -euo pipefail
: "${KIT_ROOT:?设置 kit 源码绝对路径}"
: "${CASCADE_BIN:?设置 Cascade 可执行文件绝对路径}"
: "${PRODUCT_REMOTE:?向管理员获取产品仓库地址}"
: "${PROJECT:?设置本机产品主 checkout 绝对路径}"
: "${REMOTE:?向管理员获取协调仓库地址}"
: "${NAMESPACE:?向管理员获取确切 namespace}"
: "${AGENT:?设置管理员认可的唯一 agent ID}"
: "${HARNESS:?设置 codex、claude 或 generic}"
export PATH="$(dirname "$CASCADE_BIN"):$PATH"
cascade --version
git clone "$PRODUCT_REMOTE" "$PROJECT"
bash "$KIT_ROOT/bootstrap/init-skill.sh" "$PROJECT" \
  --harness "$HARNESS" --profile balanced
```

已有产品 clone 时不重复 clone；在其主 checkout 运行同一 bootstrap 更新安装。
bootstrap 保留已有 profile，包括协调配置和项目命令，不会自动把 file 切为 git。
不要在新 linked worktree 里另建一套 profile；kit 从主 checkout 读取共享状态。

Kit 0.12 起还要求产品提交 `.ai-dev-kit/test-scope.json`，按实际测试文件/目录声明范围，
不能靠语言后缀猜测；见[测试范围迁移](test-scope-migration.md)。该文件属于被审分支，
linked worktree 使用自己的声明；共享的仍是主 checkout 的 profile 和复审凭证。

同样必须提交 `.ai-dev-kit/gate-contract.json`：显式填写批准的 base ref、当前任务
需求范围和真实项目验证命令，见[项目门禁迁移](team-gate-migration.md)。旧 profile
中的 `preflight.entrypoint` 不再被假定为“已经执行”。已有发布审批、签名和人审
规则继续有效；需要区分开发验收与正式发布时，应先批准项目合同变更。

## 2. 管理员配置 Git 协调并核验

以下由管理员执行或在已有接入授权内执行一次，不是 worker 每次任务的自行配置。
每个独立 clone 有自己的本地配置和缓存；绝不能把 cache 放在 NFS 或同步盘。

```bash
CACHE="$HOME/.cache/cascade/$NAMESPACE/$AGENT"
c() {
  node "$KIT_ROOT/scripts/cascade-process.cjs" --storage-kind git -- \
    --git-remote "$REMOTE" --git-cache "$CACHE" \
    --namespace "$NAMESPACE" "$@"
}
STATE_REF="$(git ls-remote "$REMOTE" "refs/heads/cascade-state/$NAMESPACE")"
test -n "$STATE_REF"
c list-nodes
c verify-chain
```

上面任一步失败都停止本机接入，保留原 profile。确认 remote/namespace 与批准值
一致、独立 smoke 已通过且配置修改在接入授权内后，才写入配置：

```bash
node "$KIT_ROOT/scripts/set-coordination.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.yml" \
  --engine cascade --role worker --storage git \
  --git-remote "$REMOTE" --git-cache "$CACHE" \
  --namespace "$NAMESPACE" --min-version "${MIN_VERSION:?项目批准的最低版本，新安装不低于>=0.8.0}"
```

复核 profile 的 remote、namespace、role、cache 与批准值一致，并检查
`profile.local.yml`、`AI_DEV_KIT_CASCADE_GIT_REMOTE` 等覆盖项没有指向另一中心。
绝对 cache 路径是本机配置，不应作为别人的共享配置发布；凭据不写入 URL/profile。
`merge_policy.target_branch` 必须是本地实际存在的批准目标分支。工作流、receipt、
缓存等运行时文件按项目规则 gitignore；不要用忽略业务代码的宽泛规则掩盖改动。

`git ls-remote` 只证明读权限。`list-nodes` 等业务只读查询也要申请/释放远端事务锁，
因此需要协调 refs 写权限。查不到预期 state ref 或图不符时停止，向管理员核对；
不要对着空图开始补建。权限与并发 smoke 在获授权的专用验收 namespace 完成；
未变的身份、入口和中心配置已有核验时复用，不因新会话再建一套探针。

完成本机配置后，用实际 Cascade 安装环境的 Python 做一次有界自检：

```bash
: "${CASCADE_PYTHON:?设置与已核验 Cascade 安装相同的 Python 绝对路径}"
node "$KIT_ROOT/scripts/cascade-lane.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.yml" --agent "$AGENT" \
  --python "$CASCADE_PYTHON" doctor
# 有 supervised dispatch 时，在 doctor 后追加 --dispatch "$DISPATCH"。
```

自检 JSON 分开报告 `runtime`、`protocol`、`center`、`dispatch`：实际 runtime 的
0.8/retry 能力、既有中心图与事件解析/hash 链，以及可选的原生
`WorkerConfig.from_dict` 配置、中心/agent 和有限续租核验；不执行配置中的命令。
protocol 兼容不等于 center 可读，中心错误仍阻塞依赖它的操作。本机 dispatch
错误返回非零但保留已成功的协议检查，不变成全员停工或重新证明。完整边界见
[实际入口自检](../skills/ai-dev-kit/references/cascade-coordination.md#actual-runtime-self-check)。
后续 lane 操作也传同一 `--python`；本页原生 `c` 示例的 `CASCADE_BIN` 则必须来自
相同已核验安装。省略 `--python` 的 lane 仍使用 PATH 中的 `cascade`。
结果记在已有本机记录中，入口/安装/有效配置改变时重查；不另建证明文件。
自检不提交报到，不等于业务 ready，也不取代真实权限、harness 与复审可用性检查。

Git 命令预算默认 180 秒；`AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS` 可显式设置正数，
最大 3600。超时返回 124，INT/TERM 返回 130/143；监督器清理其 POSIX 进程组。
这不是远端事务回滚：写操作超时后先核对状态、owner/token 和远端结果分支，
不能原样盲重试或切换 file 存储。Windows 员工使用 WSL。

## 中心发布与 idea 的归属

一个项目使用一个约定 namespace，同一时间一位规划负责人。负责人可以是你与
中心 agent：维护方向、接受员工提议、拆任务、确定 tier/依赖和验收人。员工可
在授权范围提出有仓库证据的 idea，但 worker 不自行改图、扩大任务或批准发布。

中心在自己的 orchestrator profile 下发布开放任务；默认 `add` 仍是私人预约，
不能误以为员工能认领保留给中心的节点：

```bash
node "$KIT_ROOT/scripts/cascade-lane.cjs" \
  --profile "$PROJECT/.ai-dev-kit/profile.yml" --agent "$AGENT" \
  add --slug "$TASK" --open --required-tier "$TIER"
```

任务正文放在可访问且受版本控制的设计文档中，至少给出完整 base SHA、允许路径、
验收命令和 reviewer。原生 `add-node` 不存任意 description；有依赖时填写真实的
expectation/promise 合同。用 `--reserved-for <worker-id>` 可显式定向，不与 `--open`
同时使用。仅凭 tier 自报不是安全边界，高风险任务仍需中心校准模型和独立复审。

## 3. 查看、自评并认领一个任务

任务 ID 不是完整工单。中心应给出绑定的设计文档/任务说明，或依赖边的
`expectation` / `promise` 契约，明确产品、base SHA、允许范围和验收方法。
`add-node` 没有 `--description` 参数；不要捏造参数或把没有对应边的
`--expectations` 当作任务正文存储。缺少说明先询问中心，不先认领再猜需求。

```bash
: "${TASK:?填入中心发布且自己能够完成的任务 ID}"
: "${TIER:?按真实模型能力设置 lite、pro 或 max}"
c list-nodes --state READY
c inspect --task "$TASK"
CLAIM="$(c get-task --agent "$AGENT" --agent-tier "$TIER" \
  --task "$TASK" --timeout 1800)"
printf '%s\n' "$CLAIM"
TOKEN="$(printf '%s\n' "$CLAIM" | sed -n \
  's/^[[:space:]]*fencing_token:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')"
test -n "$TOKEN"
```

共享池自由拉取可省略 `--task`，但必须以返回的 `Task` 设置实际 `TASK`，并阅读
其说明；不能接着再认领一个。`reserved_for` 非空时只允许相同声明身份认领。
低 tier 不能认领高 tier；其他 harness 需自行映射真实模型能力，不能为了清队列
虚报等级。协议不会自动选择、升级模型，也不保证模型自报能力真实。

## 4. 独立工作、续租和质量门禁

确认没有自己的旧执行进程或未处理的结果分支。从任务批准的完整 base SHA 建立
worktree；本地分支必须是 `<前缀>/<TASK>`：前缀任意单段（`codex/`、`fix/` 或 agent id），第二段等于任务 slug，不能再有第三段，也不能带 `@owner`。

```bash
: "${BASE_SHA:?填入任务批准的完整产品 commit SHA}"
: "${WORKTREE:?设置新的独立 worktree 绝对路径}"
git -C "$PROJECT" worktree add "$WORKTREE" -b "codex/$TASK" "$BASE_SHA"
# 在租约到期前定期执行；1800 秒只是本例约定，不代表自动续租。
c renew-task --task "$TASK" --agent "$AGENT" --token "$TOKEN" --timeout 1800
```

手动 CLI 不管理后台心跳。开发过程中要持续按批准周期续租（例如每 60 秒），
收到失效/续租失败应停止执行和发布，不能借用新 token。Kit lane 的 claim/renew
也支持 `--timeout`，默认有限租约 1800 秒，可用 profile 的
`coordination.cascade.lease_seconds` 显式设置。命令预算和任务租约是两个不同参数。

已批准范围内的实现纠错、测试失败修复和独审意见直接继续当前任务，不每次重新
请示；需要扩大范围、权限或改变验收标准时才补相应决策。正式 FAILED 不是普通
测试红灯，只能由中心在已有明确重试范围内按[恢复指南](team-loop-recovery.md)
处理；worker 不自行改图或领取替代任务来绕开失败。

在该分支完成实现、真实测试、必要文档并提交修改。涉及测试时由独立 reviewer
审查行为、断言和边界，将有依据的结论写入该分支的 test-review 叙述（主 checkout
中由 `test-review-evidence.cjs paths` 给出的 report 路径，按分支独立存放）；
批准后才记录 receipt，不能为了通过门禁伪写 approved。然后从工作分支执行：

```bash
# 测试内容或 test-scope 政策有变更且独立审查已批准时，记录 receipt。
node "$KIT_ROOT/scripts/test-review-evidence.cjs" record --project "$WORKTREE"
bash "$KIT_ROOT/scripts/skill-first-gate.sh" --phase preflight --project "$WORKTREE"
```

测试内容与 test-scope 政策均未变更时不必制造 test-review receipt；scope-only
迁移也需要真实复审。preflight 会真正运行 gate-contract
声明的项目 argv；它不推断遗漏的 build、lint、类型检查、测试和 E2E。所有准备
合并的代码、需求和文档都应先提交，再做最终 preflight。之后任何新提交、暂存区、
工作区、base ref 或有效配置变化都会使回执失效，必须重新验证，必要时重新审查。

## 5. 发布分支、fenced finish、中心复审

先逐条读取 claim briefing 中的下游 promises，核对真实产物后准备交付参数：

```bash
DELIVER_ARGS=()
```

有承诺时，为每个下游按 briefing 设置下面两个变量并重复追加；**仅无下游承诺时**
跳过这段、保留空数组。不能填写虚假确认，`critical` 证据不能代替 `--deliver`。

```bash
: "${DOWNSTREAM_ID:?从 briefing 读取本条承诺的下游节点 ID}"
: "${VERIFIED_DELIVERY:?填写已核验的实际交付及产物定位，不填占位确认}"
DELIVER_ARGS+=(--deliver "$DOWNSTREAM_ID" "$VERIFIED_DELIVERY")
```

先确认租约有效和门禁通过，再推送独立产品分支，不强推、不直接改默认分支：

```bash
c renew-task --task "$TASK" --agent "$AGENT" --token "$TOKEN" --timeout 1800
RESULT_BRANCH="codex/$TASK-$TOKEN"
git -C "$WORKTREE" push origin "HEAD:refs/heads/$RESULT_BRANCH"
SHA="$(git -C "$WORKTREE" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$WORKTREE" ls-remote origin "refs/heads/$RESULT_BRANCH" | awk '{print $1}')"
test "$SHA" = "$REMOTE_SHA"
: "${EVIDENCE_JSON:?提供包含已核验 git_ref、结果分支和验证结果的 JSON}"
c finish-task --task "$TASK" --agent "$AGENT" --token "$TOKEN" \
  --success --summary "交付独立分支，等待中心复审" --critical "$EVIDENCE_JSON" \
  ${DELIVER_ARGS[@]+"${DELIVER_ARGS[@]}"}
```

上述数组引用兼容 Bash 3.2 的 `set -u`，空数组不传交付参数。
`UNADDRESSED_PROMISES` 是完成失败：应补齐真实产物和对应交付确认，并核对 token
仍有效后再完成；不删除承诺或修改图来绕过报错。

开发失败时保留 `--task/--agent/--token`，将 `--success` 换成 `--fail --reason`；
明确退回 READY 则换成 `--release --reason`，提供实际原因。不要把失败改成完成。产品 push 与
finish 是两笔事务；若 push 成功而 finish 失败，保留分支、停止盲目重试并报告。
中心核对远端 SHA、证据和独立 verify 结果，获授权后通过 merge gate 再合并。
`COMPLETED` 不等于已复审、已合并；有效 claim 也不会因换了中心会话而允许抢占。

## 员工启动 loop

Kit 提供跨 harness 纪律和命令，不内置常驻模型 daemon。使用员工自己的 harness
循环机制，加载 [worker 提示](../templates/workflow/team-worker-prompt.md)，明确
任务上限、空队列等待、续租和停止条件。不要把多个员工共享一个聊天会话当成
独立 worker，也不要把认证文件复制给同事。

Codex CLI 可使用一次非交互调用执行一个有上限的 worker loop。先独立确认 CLI
版本和 `login status`，Git 权限以及项目依赖。下面示例不关闭沙箱；运行时 Git
网络、缓存和 worktree 访问必须已按团队策略获准，否则停止并配置权限：

```bash
: "${CODEX_BIN:?设置已核验的 Codex CLI 绝对路径}"
: "${WORK_ROOT:?设置员工独立 worktree 根目录}"
: "${RUN_LOG:?设置该次 loop 的外部 JSONL 日志路径}"
export KIT_ROOT PROJECT CACHE AGENT TIER WORK_ROOT
"$CODEX_BIN" --version
"$CODEX_BIN" login status
"$CODEX_BIN" exec --sandbox workspace-write -C "$PROJECT" \
  --add-dir "$WORK_ROOT" --add-dir "$CACHE" --json - \
  < "$KIT_ROOT/templates/workflow/team-worker-prompt.md" > "$RUN_LOG"
```

该提示默认最多 3 次成功认领，正式失败/释放仍占用次数且立即终止本轮，普通
实现、测试及复审纠错继续当前任务；认领前必须
确认可用的心跳和独立复审路径。仅 `NO_READY_TASKS` 按空闲处理（原生 CLI 退出码
仍为 1），`INSUFFICIENT_TIER` 应报告能力不足。空队列等待 60 秒再查一次仍为空
就退出。后续运行交给
harness 的原生调度或员工重新启动，不靠忙轮询。需要整晚循环时由负责人显式设定
结束时间、费用/任务上限和通知策略。AutoSeek/其他 harness 加载同一提示并使用
自身 loop 与 tier 映射；不要照搬 Codex 参数。Codex 非交互行为见
[官方说明](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 可选：使用 supervised worker

旧固定提交 `4d5c8ae` 的 worker 在 preflight 后提交，不能用于 Kit 0.12 的
exact-HEAD 门禁；`c65e2fd` 虽修复该顺序，完成阶段仍只等待 5 秒停止续租，
真实云 RPC 在途时会误拒绝 complete。0.8.0 发布保留 `aac3814` 对两点的修复：
形成最终提交后验证，并在停止新续租后等待在途确认；取消、超期及真实续租错误
继续阻止完成。实际启动必须使用项目入口当前批准的提交/精确版本，不能因这段
历史说明把更高版本降回 0.7。异常清理可能等到底层 I/O 自身超时后才结束，不承诺整个进程在
dispatch 成功预算内强制退出。不能只看这些提交相同的 `0.7.0` 版本输出，
更不能关闭回执或跳过续租检查。

使用所选隔离安装环境内的解释器，不使用与 pipx/uv 环境无关的系统 `python`：

```bash
: "${CASCADE_PYTHON:?设置项目批准且已核验 Cascade 0.8 来源的隔离环境 Python 绝对路径}"
: "${DISPATCH:?设置中心批准的 dispatch JSON 绝对路径}"
"$CASCADE_PYTHON" -B -c 'import cascade.worker.runner as r; print(r.__file__)'
"$CASCADE_PYTHON" -m cascade.worker --help
"$CASCADE_PYTHON" -m cascade.worker --config "$DISPATCH"
```

模块路径须属于已核验源码的同一安装环境。中心提供受控配置，
其中绑定任务、完整 base SHA、允许路径、真实 harness/auth、测试/preflight 与
发布远端。它会定向认领、自动续租、建立独立 checkout、执行门禁并发布唯一分支。
**不要先执行本指南的手动 get-task**，否则它会遇到已被认领的任务。
详情见 Cascade 仓库 `docs/supervised-worker.md`；该模式是一任务一运行，不是
自动轮询 daemon。其模型认证、执行沙箱和依赖仍须部署方实际配置和验证。

先在隔离副本核对 bootstrap 的改动：安装器可能补充 `.gitignore` 规则，这也
属于 tracked 变更，不能借初始化绕过 `allowed_paths`。把必要的项目初始化
提交到批准的 base，再下发业务任务；不要在失败后扩大允许路径换取通过。

## 权限边界与部署状态

role、agent ID、tier、reservation 是协作/协议约束，不是强身份认证或 ACL。
真实边界是 Git 权限、产品分支保护、执行沙箱与最小凭据；不互信团队不能仅靠
namespace 隔离。不要把个人广权限 token、模型登录文件或云管理员凭据复制给别人。

具体公司的服务器、安装镜像、公钥登记、备份和迁移状态放在该项目的运维记录中，
不把某次部署快照作为所有项目的当前事实。Git 中心可用、中心计划已配置、员工
已验证接入、产品已通过门禁、云端 worker 已部署是不同状态，必须分别取证。
Git 中心不需要部署模型；员工使用自己的合法身份。Kit 安装或中心可读不能证明
员工已被授权，更不授予云端模型执行、合并或生产发布权限。
