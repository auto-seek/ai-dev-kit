# Cascade 协调引擎适配设计（0.11.0 current state）

status: accepted (rev7: native ownership, persistent bootstrap, review receipts, shared worktree state) · owner: Codex + jiang · created: 2026-07-06 · updated: 2026-09-06
reviewers: jiang · related: skills/ai-dev-kit/references/{loop-workflow,delegation}.md, Cascade repo (github.com/auto-seek/Cascade)

## 1. 动机

ai-dev-kit 的协作层(feature-ledger 作互斥锁)是散文式的:预约粒度靠人读
Scope、多工作者对同一 markdown 文件竞争提交、协调者被迫串行代写、loop 每次
醒来靠扫描重建状态。Cascade(动态 DAG 调度 + 原子 claim + 契约边 + 事件溯源)
恰好机械化了这一层。0.6.0/0.7.0 的门禁改造(分支圈定、证据回执)是渐进补丁;
本设计把 Cascade 作为新项目的协调引擎接入,一次解决互斥、调度、跨机协作三件事。

明确的非目标:不替换 ledger 的"人读持久记录"角色;不把 Cascade 变成 kit 的
必需依赖;不改变 reservation→design doc→gate→merge 的纪律本身——Cascade 只
接管"谁在干什么、下一个干什么"的调度层。

## 2. 三种形态与默认值

```yaml
# .ai-dev-kit/profile.yml
coordination:
  engine: ledger | cascade        # 新初始化 cascade；ledger 保留为显式存量迁移路径
  role: self-serve | orchestrator | worker  # self-serve 为 0.9.0+ 默认
  cascade:
    storage: file | git | redis   # file 单机；git 推荐跨机器；redis 可选低延迟
    git_remote: ""                # storage=git 时填 remote 名、URL 或 bare path
    git_cache: ""                 # 可选机器本地 cache
    redis_url: ""                 # storage=redis 时填,支持 rediss://
    namespace: <project-slug>     # 默认取项目目录名
    min_version: ">=0.7.0"        # 原生 reserved_for 事务契约最低版本
```

- **engine=ledger(DEPRECATED,rev3)**:0.8.0 起冻结——不进新功能,
  gate 检出此模式时输出 deprecation WARN 引导 `/ai-dev-kit-cascade-init`
  迁移。0.11 明确保留存量 ledger 配置，撤销此前在本版本删除的计划；不承诺
  未验证的删除日期。新项目初始化为 cascade；重跑 bootstrap 原样保留现有
  profile，不会把 Git 中心或已有 ledger 配置改成另一套状态。
- **engine=cascade + storage=file**(初始化向导的推荐默认,per owner):单机
  多 worktree/多 agent 场景。FileStorage 的文件锁在同一台机器上语义完整,
  零外部依赖。协调数据在 `.ai-dev-kit/cascade/`(gitignored,效力同 workflow/)。
- **engine=cascade + storage=redis**:跨机器协作。团队共用一个 Redis
  (如腾讯云 ap-nanjing 实例),按 namespace 隔离项目。
- **engine=cascade + storage=git**:推荐的 Redis-free 跨机器形态。使用专用
  私有 Git 仓库的 state/lock/archive refs 与 compare-and-swap，不把 file
  store 提交进产品分支，也不需要常驻中心服务。

## 3. 概念映射(kit ↔ Cascade)

| kit 概念 | Cascade 概念 | 说明 |
|---|---|---|
| feature-ledger 预约条目 | node(任务节点) | node_id = canonical slug；reserved_for 存储归属并在事务内校验 |
| Status: reserved/active | READY / ACTIVE(claim 后) | claim 原子化,替代"先读 ledger 再写"的竞态窗口 |
| Goal / Expected deliverable | 边上的 expectation / promise 契约 | 下游 claim 时自动看到 |
| Status: merged + 验证证据 | complete(summary, critical) | critical 自动带 produced_at/git_ref,流给下游 |
| Coordination notes(依赖) | DAG 边 | 机器可执行,不再是散文 |
| review finding 要求返工 | rework | 事件溯源留痕 |
| 他人 active 条目(不可碰) | ACTIVE 保护 | 引擎强制,不靠自觉 |
| ledger 归档 | archive.py / 事件日志 | |
| Expected docs / Expected tests 绑定 | CLI 尚无一等元数据字段 | 路径放在设计文档与 expectation 契约；preflight 直接核验文件。Cascade gate 当前机器校验节点状态，不虚构元数据能力 |

**单一真相(rev2 简化,per owner review)**:engine=cascade 时,
**Cascade store 是协调层的唯一真相,ledger 彻底退出**——不渲染快照、不做
同步、不做漂移仲裁。feature-ledger.md 只留一行横幅指向 cascade
(`This project coordinates via Cascade — run \`cascade list\``)。
"预约历史进 git"的诉求由既有工件覆盖:设计文档(docs/working/,含验证
证据)+ conventional commits + Cascade 事件溯源。放弃的是 markdown 里的
预约状态 blame——评估为冗余。人读现状用 `cascade list`/`history`。

## 4. 角色纪律(跨机器)

- **self-serve(默认角色)**:用唯一 `<slug>` ID 和 `reserved_for=<agent>` 预约；
  `scripts/cascade-lane.cjs` 解析共享配置，Cascade 在事务内校验唯一性与归属。
  旧 `<slug>@<agent>` 图必须显式迁移，不能继续用事务外查重模拟预约原子性。
- **worker**:只准 get_task / finish_task / check_task / rework。
  加任意台机器零冲突(claim 原子)。loop 的目标选择塌缩为"claim 下一个
  READY"——`--discovery/--ev` 的扫描式选题仅在图为空时回退使用。
- **orchestrator**:每 namespace 同时唯一。建图/split/refine/remove 都归它。
  机制兜底:Redis 模式下用 `cascade:{ns}:orchestrator-lease` TTL 键做租约
  (file 模式单机,由文件锁天然保证);租约被占时第二个 orchestrator 启动
  即报错退出。Git 模式保证每次事务 CAS 安全，但不选举长期规划者，必须由
  运维显式指定一个 orchestrator，接管前先停旧规划者。
- 多编排者 = 多 namespace 分疆,一个 epic 一个图。

## 5. 初始化向导(owner 补充需求)

新入口:`/ai-dev-kit-cascade-init`(skill)+ `bootstrap/init-skill.sh --coordination` 参数。流程:

```
1. 探测:python/pipx 环境里有没有 cascade-auto(cascade --version)
   ├─ 没有 → 问:安装(pipx install cascade-auto)/ 跳过(维持 ledger)
2. 选存储(跨机器推荐 git，单机默认 file):
   ├─ [file]  单机多agent(推荐默认,零配置)
   ├─ [git]   跨机器协作 → 填专用 remote，运行真实 CAS smoke
   ├─ [redis] 低延迟跨机器 → 交互填 redis_url(支持 rediss://,连通性
   │          smoke test:PING + SET/GET + 锁获取,失败即停止)
   └─ [none]  不用 cascade,维持 ledger 模式
3. 选角色:self-serve / orchestrator / worker(默认 self-serve)
4. 写 profile.yml coordination 块 + .gitignore 补 .ai-dev-kit/cascade/
5. smoke test:add→claim→complete→list 走一圈,输出图状态
6. 已有 ledger 的项目:提示可选的一次性导入(active/ready 条目转为节点;
   merged 条目不导入,留在 markdown 历史里)
```

向导必须幂等(重跑=改配置),且任何一步失败都停止并保留原配置；不得把错误
转换成 file/ledger fallback，也不得留下半配置状态。

## 6. 门禁矩阵与严格错误处理

生产硬化后，preflight/merge 的协调证据全程 fail-closed；stop 阶段不访问
协调存储，保持轻量。`engine=ledger` 保留为显式存量迁移路径。
测试审查覆盖目标分支差异和已提交、暂存、未暂存、未追踪测试，收据绑定
branch/base 与 HEAD/index/worktree 内容。主 checkout 的 profile、overlay、
file store、workflow evidence 为所有 linked worktree 共享。

| 条件 | 当前行为 |
|---|---|
| engine=cascade,cascade CLI/存储/JSON 有效 | 查 store(list_nodes) |
| CLI 不可用、配置错误、storage 不可达/超时/坏响应 | FAIL closed，并保留可操作错误上下文 |
| cascade 版本不满足或无法验证 min_version | FAIL |
| 分支没有对应 node | FAIL |
| merge node 非 COMPLETED | FAIL |
| stop | 不做协调 I/O，只检查显式 findings |

## 7. 双仓打包与发布(owner 问题)

**选型:松耦合,PyPI 为界,版本区间兼容。**(否决的方案:vendoring/submodule
——两仓 license、发布节奏、语言栈都不同,揉在一起两边都难发版。)

- **Cascade 独立发布**到 PyPI(`cascade-auto`),自己的 semver 节奏;
- **kit 不携带任何 Cascade 代码**,只声明兼容区间:profile 模板里
  `cascade.min_version`,由每次 kit release 时对着当时的 Cascade 版本实测后
  更新;gate 运行时校验并 FAIL closed，防止未验证契约进入 readiness;
- **安装动作归初始化向导**:向导调 pipx/uv tool install,kit 的 npm 包和
  Claude 插件市场包完全不变重(插件市场也没法承载 python 依赖);
- **联调测试**:kit 仓加一个可选 CI job(装最新 cascade-auto 跑向导 smoke
  test + gate cascade 分支的夹具),Cascade 仓反向加一个"kit 契约测试"
  (12 个 tools 的 dict 边界不破坏 kit 所依赖的字段)。两边各自守住接口面,
  发布互不阻塞;
- **版本沟通**:kit CHANGELOG 每次注明 "tested with cascade-auto X.Y.Z";
  Cascade 破坏性变更时 bump major,kit 收紧 min_version 并出 patch。

## 8. 实施切片(建议顺序)

1. `references/cascade-coordination.md`(用户面文档:映射表/角色/降级)+
   profile 模板 coordination 块 —— 纯文档,先行合并;
2. 初始化向导(skill + bootstrap 参数 + smoke test);
3. gate cascade 分支(查 store + 降级矩阵),夹具测试(fake cascade CLI);
4. orchestrator 租约(Redis 模式)+ **定期单向备份导出**(rev3,owner):
   `/ai-dev-kit-clean` 或 orchestrator 定期把 `cascade history` 导出为人读
   markdown 提交 git;引擎永不读回——纯备份+历史,不是同步桥;
5. 可选 CI 联调 job;届时 bump 0.8.0。

**0.11.0 实际范围**：原生预约归属、初始化保留配置、内容绑定测试审查、
worktree 共享状态。保留存量 ledger；迁移说明见
`docs/coordination-0.7-migration.md`。Cascade CLI 没有一等节点元数据前，
不宣称 gate 已机器执行不存在的 `design_doc`/`expected_tests` 字段。

切片 1-3 构成可用的最小闭环(单机 file 模式);4 之后跨机器模式完整。
(rev2:原切片 4 中的"ledger 渲染快照"已删——cascade 模式下 ledger 整体
退出,不做桥。)

## 9. 风险与开放问题

- **Cascade 成熟度**:需要确认其 FileStorage 在高频 claim 下的锁竞争表现、
  以及 tools 层 API 的稳定性承诺(→ 双仓契约测试的动机);
- **file 模式的协调数据不进 git**(.ai-dev-kit/cascade/ gitignored):
  机器丢失即任务图丢失。可接受——图是工作状态,持久记录在设计文档与
  commit 里;需要跨机器或耐机器丢失时使用 git 模式;
- **腾讯云 Redis 明文链路**(现状 password-only):协调元数据敏感度低,
  可接受;若日后传递敏感上下文,先开实例 SSL(FeatureSupport 已确认)再
  上 redis 模式,或转 Tailscale;
- 开放:worker 的 finish 是否应自动触发 gate?(倾向:否,gate 仍由人/
  协调者显式跑,finish 只带 gate 回执引用。)

## 10. Redis-free 方向（rev4）

Redis 提供的是共享原子更新，并不是任务模型的一部分。跨机器零服务方案
采用 Git remote ref CAS，而不是把 file store 提交进功能分支。状态与短租约
放在独立 ref，所有 claim/finish 通过 expected-old-OID 更新，竞争失败者重读
后重试。完整协议、安全验收和迁移切片见 `docs/git-coordination-backend.md`。

Git 后端现已通过本地 bare remote 的独立容器并发、完整生命周期、fencing、
tier、进程崩溃、时钟偏差、compaction、千次竞争、GitHub SSH-over-443 与
CODING HTTPS 验收。Redis 继续作为可选低延迟后端；file 仍是单机默认。
跨机器推荐 Git，取消“必须运营 Redis”的架构依赖。
