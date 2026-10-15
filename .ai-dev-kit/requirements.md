# Reviewed task requirements

## many-agent-loop

- [x] Integrate `feature/gate-task-queue` (blocked exit codes, task args, task-files requirements, status phase and environment self-check, merge-base binding with integrate phase), `feature/test-review-branch` (per-branch test-review receipts with one-release legacy acceptance) and `feature/resource-lock` (queued resource lock, workflow gitignore, subtraction and loop guidance) without dropping any branch's tests.
- [x] Defaults stay compatible except the documented environment self-check; unknown contract keys are still rejected; the gate surfaces test-review notices as warnings.
- [x] Kit version 0.14.0 in all four manifest fields with a CHANGELOG entry.
- [x] `npm run build`, full `npm test`, skill validation and an independent source/test review (plus re-review of the fixes) pass on the integrated tree.

## resource-lock

- [x] `scripts/resource-lock.cjs` queues exclusive access to a named scarce resource in the main checkout's `.ai-dev-kit/locks/<name>/` (FIFO bakery tickets, pure Node, macOS/Linux): `run` supervises its command's process group and propagates its exit code, `--wait` expiry exits 75 without running or leaving a ticket, `acquire`/`release` give shell scripts a max-hold lease, `status` reports holder and queue; dead-owner and expired tickets are reclaimed while an orphaned command group keeps holding. `tests/resource-lock.test.cjs` covers these with real processes and runs in `test:team`.
- [x] `bootstrap/init-skill.sh` adds `.ai-dev-kit/workflow/` to the project `.gitignore` exactly once (creating the file when absent), never untracks existing files and prints the `git rm -r --cached` hint when workflow files are already tracked; a shell-suite bootstrap case covers repeat runs, a tracked file and a fresh project.
- [x] Subtraction guidance (reference, clean/preflight skills, clean slash template, subtraction-log template, loop cadence) runs the cadence pass on the current task branch against its own diff, defines the quick no-candidate pass recorded as `scope: <base>..HEAD (none) | mode: propose`, and stops when candidates are exhausted; the current gate was verified (code reading and a real snapshot) to accept that record and to reject `mode: propose (none)` as malformed, with no gate code change.
- [x] `loop-workflow.md` has an "Exclusive Resources And Retryable Blocks" section (wrapping project verification in `resource-lock.cjs`, token mode, reclaim rules, limits, and exit 75 as BLOCKED/retryable with a pointer to `preflight.blocked_exit_codes` in `docs/team-gate-migration.md`) and a "Scaling To Many Agents" checklist; `npm run build`, full `npm test` and skill validation pass.

## cascade-081-pin

- [x] Installation guidance pins the published Cascade 0.8.1 release commit and expected version in the coordination reference, the team Git center guide and the README, and states that environments verified from the 0.8.0 commit stay approved.
- [x] The portal publisher accepts exactly the approved 0.8.0 and 0.8.1 releases and their local builds; a real-runtime regression shows 0.8.1 was rejected before and that 0.8.2, prereleases, post-releases and malformed labels are still rejected.
- [x] Kit version 0.13.2 in all four manifest fields with a CHANGELOG entry; build, portal integration with a real Cascade environment, skill validation and an independent test review pass.

## gate-branch-prefix-docs

- [x] `docs/coordination-0.7-migration.md` states the current branch-shape rule instead of the superseded three-prefix list, and the gate behavior table in the Cascade coordination reference lists the explicit failure for a further branch segment.
- [x] The bound design document `docs/working/gate-branch-prefix.md` attributes each old failure message to the component that emitted it and records this follow-up.
- [x] No code or test bytes change relative to the reviewed 5b4ff0c (`git diff 5b4ff0c -- scripts tests bootstrap` is empty).

## gate-branch-prefix

- [x] The task-sections requirements gate, the Cascade node lookup and the legacy ledger own-match accept `<owner-or-type>/<canonical-task-id>` with any single prefix segment instead of the fixed codex/feature/fix list; a branch with a further segment fails with an explicit message.
- [x] Real Git/shell regressions cover an agent-id prefix, a `feat/` prefix, a multi-segment branch rejected in preflight and merge (before the project command runs), the legacy ledger own-match with a sibling WARN, and the unchanged codex/feature/fix and trunk cases; all five were red on fab98ed.
- [x] Docs, templates and skills describe the new branch shape; kit version 0.13.1 with a CHANGELOG entry.
- [x] Full shell gate suite 69/69, node contract suite 34/34, test-scope suite, skill validation and an independent test review pass.
- [x] Seconds-scale process tests settle the first exec of their freshly written fixture scripts before timing them, so macOS Gatekeeper's online ticket lookup (0.1-4.4 s on this host, measured and logged in docs/working/gate-branch-prefix.md) no longer decides the portal verifier-timeout and supervisor-deadline cases; the exact-HEAD build gate passes on this host.

## main-integration-20260916

- [x] Integrate the three completed project-center, scoped-doctor and portal/DAG candidates into current main without dropping main's Cascade 0.8 or real-startup deadline fixes.
- [x] Preserve combined package/plugin version 0.13.0, all native/portal suites, company-center guidance and existing worktrees; no game merge, registry publication or production restart.
- [x] Real patched-runtime integration verifies release-local version handling without accepting malformed labels, prereleases or unapproved public-version upgrades.
- [x] Independent source/test/doc review and full shell verification pass; the final exact-HEAD preflight and native completion/merge gates remain mandatory before publishing.

## center-flow-simplification

- [x] One supervised non-LLM self-check uses the actual runtime and existing center; protocol and local dispatch results remain separate, without claiming work or weakening errors.
- [x] Native retry is available through the project adapter with exact failure/op identity, orchestrator role and explicit runtime selection; existing ownership/history and unknown-write rules are preserved.
- [x] Skills and the existing center policy reuse environment checks, stop duplicate approvals, isolate local blockers and consume actionable updates.
- [x] Real file/Git regression tests, independent reviews, mutation checks, build and skill validation pass; final content-bound preflight is required.

## project-center-setup

- [x] 明确路由新项目建中心、加入已有中心与迁移/认证修复，保留项目权限隔离和唯一规划负责人。
- [x] 固定安装来源支持获批准公司镜像与制品，不默认依赖 GitHub，不降低项目运行时要求。
- [x] 明确员工认证失败的修复流程：补齐本人授权并重跑最终内容绑定门禁，不先合本地 dev、不伪造 ready 或豁免协调；实际员工接入另有设备证据。
- [x] 完成独立真实场景验证、文档/模板同步、构建和技能 schema；最终提交门禁另由内容绑定回执证明。

## team-center-portal

- [x] Authenticated single-project portal persists intake conversations and center proposals without giving browsers Git write authority.
- [x] Freeze and exact-contract native publication preserve requirement versions, dependency/tier routing and independent review boundaries.
- [x] Candidate evidence binds the actual delivery SHA and sealed artifact manifest; human acceptance/rework remains separate from technical gates.
- [x] Real Git/HTTP/SQLite/native tests, independent review, runtime and browser checks pass for the implementation.
- [x] Company-server deployment is isolated, authenticated, backed up and verified without changing other projects; no browser game runtime is installed.

## cascade-flow-view

- [x] A packaged loopback viewer displays actual Git-center task flow and inline details without a dashboard/sidebar.
- [x] Every successful view uses graph and retained events from one Git commit, with no remote or product-worktree writes.
- [x] Task status, completion reports, owner uncertainty, freshness and errors remain distinct and truthful.
- [x] Real Git/HTTP tests, independent review, browser checks and build validation pass.

## worker-join-report

- [x] Agent 自助读取接入配置、检查真实环境/权限并向中心报到一次，员工只处理具体阻断。
- [x] 报到复用原生 fenced task context，不伪造身份、tier、权限或开发准备状态，不扩大worker业务图权限。
- [x] 独立行为验证、技能同步与构建通过。

最终门禁仍是必要条件，由提交后的内容绑定 preflight/merge 回执证明，不能由本文件提前自证。

Historical team operations and release progress remain in the shared workflow
ledger. This tracked file is the per-branch implementation acceptance contract.

## cascade-080-release

- [x] New installations use the reviewed fixed Cascade 0.8.0 source and fresh profiles require >=0.8.0.
- [x] Operators must upgrade actual shared-store CLI/worker entrypoints before the first new event; bootstrap preserves existing profiles byte for byte and no gate/ownership fallback is introduced.
- [x] Kit package/plugin/marketplace versions are 0.12.1; current installation docs and slash guidance agree while historical 0.7 records remain intact.
- [x] Real bootstrap/profile regressions, skill validation and independent test review pass. The coordinator must still run the unchanged final exact-HEAD build/preflight gate; local review does not authorize release.

## team-loop-ready

- [x] Cloud commands have configurable finite budgets and clean up owned process groups on timeout/cancellation, with real process tests.
- [x] Team publishing, finite claims, renewal and fenced delivery use the native Cascade protocol with tested failure handling.
- [x] Project requirements and real verification argv are explicit; stale preflight evidence cannot authorize merge.
- [x] Bootstrap, skills and team runbook describe the actual enrollment and handoff procedure without weakening product approval requirements.
- [x] Build, full shell gates, independent test review and real Cascade integration pass for the final implementation.

## team-center-ui

- [x] 保留已部署门户完整历史与安全/合同/候选封存语义，只在独立分支优化前端。
- [x] 首页状态与下一步清晰，需求、任务详情和候选之间可直接导航。
- [x] 提交、补充与验收中的草稿/焦点不会被自动刷新打断，错误和空状态有明确反馈。
- [x] 桌面与窄屏真实浏览器验证、相关测试、独立复审和文档同步完成。

## team-center-login

- [x] 已批准的侧栏、工作台、列表、独立详情与需求编辑页面接入真实数据。
- [x] 现有员工账号可登录，安全会话、退出、到期重登、同账号草稿恢复与切换账号清理完整。
- [x] 密码校验、身份隔离、Origin/CSRF、限流、机器 Bearer 与原业务合同有真实边界验证。
- [x] Linux/nginx 迁移验证、浏览器检查、独立复审和构建完成，中心审核所需交付材料齐备。

提交后的内容绑定 preflight 与中心交接由最终回执/交付包证明，不以本表替代。

## team-center-dag

- [x] 任务以真实依赖分层呈现，完整显示分支、汇合、跨层边和原生状态。
- [x] 选中任务可辨识上下游并核对详情，搜索、历史深链、刷新与窄屏操作完整。
- [x] 保留登录、旧快照错误、租约不确定性、合同和业务数据语义。
- [x] 独立源码/测试/文档复审、真实浏览器与完整验证完成，候选交中心审核。

## team-center-dag-simple

- [x] 按已确认横向设计从左到右显示真实依赖，并行任务上下排列；默认仅名称与状态。
- [x] 点击卡片展开详情，保留依赖合同与交付数据读取能力；删除常驻详情栏和复杂工具栏。
- [x] 刷新、深链、键盘、窄屏、错误与租约不确定性等现有语义保持完整。
- [x] 独立源码/测试/文档审查、变异抽查、真实浏览器、构建与技能验证完成，候选交中心审核。

## team-center-dag-interaction

- [x] 连线使用清晰的圆角直角路径，保留全部真实依赖，避开任务卡片。
- [x] 选中任务仅突出直接依赖，支持拖动空白处平移，保留触屏/键盘/详情操作。
- [x] 密集图、展开卡片、真实拖动、刷新与窄屏验证通过，完成必要审查并保留可复核证据。

## team-center-dag-zoom

- [x] 提供放大、缩小、比例显示与恢复 100%，缩放围绕当前阅读位置。
- [x] 缩放与拖动、任务展开、自动刷新、范围切换和窄屏配合正常。
- [x] 真实浏览器验证、源码复审与构建通过，候选可供用户已授权的直接发布；发布结果由线上回执证明。

## cascade-center-skills

- [x] Ship self-contained project-ID admission and read-only visualization skills inside the existing plugin, offline installation and project bootstrap.
- [x] Route setup, project-ID joining and visualization correctly; keep product Git access separate from task-state Git and retain actual authorization boundaries.
- [x] Prepare synchronized 0.16.0 package/plugin/marketplace versions together with usage and source documentation.
- [x] Prepare for final preflight with verified installed resources, isolated viewer behavior, skill metadata, package contents and a passing repository build.

## cascade-generic-config

- [x] Replace project-specific examples and live center URLs with generic configuration in setup, join and visualization instructions.
- [x] Resolve join origin from explicit input, environment or the same private enrollment directory; reject missing/invalid origins and cross-center retries.
- [x] Prepare the validated package, independent review and synchronized plugin version 0.16.1 for final release gates.
