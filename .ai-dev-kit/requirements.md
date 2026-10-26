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

## center-identity-client

- [x] Package the CascadeCenter-web `7b7d4d1` client: `cascade-node-client.cjs`, `cascade-portal/store.cjs` and `cascade-portal/admission.cjs` byte-identical; the other six files unchanged and identical; `cascade-node-join.cjs` merged so it accepts `PROJECT_ID@CENTER_ORIGIN`, rejects a conflicting `--origin`, validates and reports `--harness`, prints the owner confirmation code, and still has no built-in center.
- [x] `SKILL.md`, references, the slash template and README describe the copied address, the self-reported harness and owner confirmation (10-minute code entered under 我的项目 → 执行 agent → 确认我的 agent; `owner-code` for a new one).
- [x] Join tests cover ID@origin over `CASCADE_CENTER_ORIGIN`, a conflicting `--origin`, a bare ID without a center, harness validation and resume; a real-SSH run against the Center fixtures passes with the packaged scripts.
- [x] Version 0.18.0 in all three manifests with a CHANGELOG entry; `npm run build`, skill validation, gitleaks and an internal-address grep pass.

## center-ssh-reuse

- [x] Package the CascadeCenter-web `33b9ec0` client: `cascade-node-client.cjs` and `cascade-process.cjs` byte-identical; `cascade-node-join.cjs` three-way merged so it gains SSH connection reuse and the agent-directory length check while keeping the kit's no-built-in-center rule; the other seven files unchanged and identical.
- [x] `SKILL.md` describes connection reuse, the directory length limit and how an existing agent re-runs join to get the new config; source records name `33b9ec0`.
- [x] Version 0.18.1 in all three manifests with a CHANGELOG entry; `npm run build`, skill validation, the Center client tests, gitleaks and an internal-address grep pass.

## center-nodecollab3

- [x] Package the CascadeCenter-web `b0895ee` client: `cascade-node-native.py`, `cascade-portal-publish.py`, `cascade-process.cjs` and `cascade-portal/admission.cjs` byte-identical; `cascade-node-join.cjs` three-way merged so it gains only the `0.8.2+nodecollab.3` pin while keeping the kit's no-built-in-center rule; the other five files unchanged and identical.
- [x] `deploy/cascade-runtime/` carries the .3 wheel (SHA256 `4f6b1dbe…e041`), both patches, `NODE_PROVENANCE.json` and the vendored dependencies byte-identical to the source; the .1 wheel and its `NODE_SHA256SUMS` line are dropped because no skill test needs them.
- [x] `SKILL.md` and `references/task-cycle.md` describe heartbeat renewal, how a joined agent upgrades (update the plugin, re-run join with the original inputs in the same directory, active tasks included) and the new errors; source records name `b0895ee` and .3.
- [x] `tests/cascade-center-config.test.cjs` installs the .3 wheel and checks that join installs the packaged runtime itself; `npm run build`, skill validation, gitleaks and an internal-address grep pass.
- [x] Version bump in all three manifests and the release, done by the kit maintainer after review (0.25.0).

## center-nodecollab5

- [x] Package the CascadeCenter-web `110ffe2` client: `cascade-portal-publish.py` byte-identical with the .5 pin; `cascade-node-join.cjs` three-way merged so it gains only the `0.8.2+nodecollab.5` pin while keeping the kit's no-built-in-center rule; the other eight files unchanged and identical.
- [x] `deploy/cascade-runtime/` carries only the .5 wheel (SHA256 `bb6ff0ed…d1ec9d6`), `node-collaboration.patch`, `node-storage-concurrency-nc5.patch`, `NODE_PROVENANCE.json` and the vendored dependencies byte-identical to the source; the .3 and .1 wheels and the .3 patch are dropped with their `NODE_SHA256SUMS` lines, which match the shipped files and pass `shasum -c`.
- [x] `SKILL.md` and `references/task-cycle.md` say .3 and .5 run side by side, how a .3 or .1 agent upgrades (update the plugin, re-run join in the same directory) and how to roll back (0.25.0); source records name `110ffe2` and .5.
- [x] `tests/cascade-center-config.test.cjs` uses the .5 wheel; `npm run build`, skill validation, gitleaks and an internal-address grep pass.
- [x] Version bump in all three manifests and the release, done by the kit maintainer after review (0.26.0).

## workstation-pool

- [x] `templates/workstation/` provides the generic Linux workstation image (Xvfb, `ws-run` batch/session entry with process-group timeout and `ws-run.json`, `ws-shot`, `ws-input`) and a Godot .NET example layer with official SHA512-checked downloads; `tests/workstation.test.cjs` covers the entry with real containers.
- [x] `scripts/resource-lock.cjs` adds workstation pools declared in `.ai-dev-kit/workstations.json` (image or Dockerfile, slots, CPUs, memory, screen, env, mounts, start argv, timeouts) with `claim`, `run`, `renew`, `release` and `status --pool`; the existing `--name` commands, data format and tests are unchanged, and a pool coexists with the same-named exclusive lock.
- [x] A slot is never held twice: only the first waiter in line assigns (claim-then-recheck marker) and slot files are created with an exclusive link; every claim starts a new container and release or reclaim removes it; only the claim token releases or renews; dead owners, orphaned `run` groups after they end and unrenewed leases are reclaimed with a printed, logged and status-visible reason; config errors and pools needing more memory or CPUs than Docker has exit 2; defaults fit three workstations in an 8 GB Docker VM.
- [x] `status --pool`, `status` and `skill-first-gate.sh --phase status` show holders, hold times, leases, waiters with wait times and a configurable long-hold reminder, locally only.
- [x] Disk: workstations bind-mount the agent's checkout (assets and import cache are never copied into Docker); measured three 4K workstations at +12 MiB of Docker disk; claims check `min_free_disk` on Docker's and the host disk and exit 75 before any state; `status --pool` reports actual use (df, allocated blocks); `prune` removes only unheld workstation containers, superseded images the pool built and, opt-in, old unheld evidence. Godot import caches were measured identical across macOS and Linux, shareable between checkouts by copy-on-write clone, and unharmed by a concurrent host and container import.
- [x] `tests/workstation-pool.test.cjs` (real processes, `tests/fake-docker.cjs` for the Docker CLI) runs in `test:team`; Docker-backed pool cases run in `test:workstation`; `loop-workflow.md`, the preflight skill, gate migration doc, template README and tests README describe pools; CHANGELOG has an Unreleased entry and no version bump (left to the maintainer); `npm run build` and skill validation pass.

## workstation-pool-followup

- [x] Every slot-file change (assigning, freeing orphans, `release`, cleanup after a failed claim or finished run) holds a per-pool slot mutex (mark-then-list markers, dead holders' markers removed); a test with a release slowed in `docker rm` while the next claim reclaims its ticket fails on 0.20.0 (the next holder's slot file is deleted) and passes now.
- [x] Pools can declare `requires` and `prepare`; an unprepared checkout is refused with exit 1 before any state. Docs say to fill assets and import caches on the host (clone, not copy) because copies made in a workstation through the bind mount are real host data (measured), and that Docker Desktop can hold deleted files open.
- [x] Memory of a workstation that builds C# and runs a 4K Godot capture is measured at several limits and the docs give the limit and how many fit in an 8 GB Docker VM.
- [x] `npm run build`, skill validation and the real-Docker workstation suite pass; CHANGELOG has an Unreleased entry and no version bump.
- [x] Slot-mutex markers record their process's start time (`LC_ALL=C ps -o lstart=`); markers older than 5 s whose pid has another start time, and any marker not refreshed for 30 minutes, are removed; holders refresh their marker after every docker call inside the mutex so the backstop stays far above the longest step; a claim whose `--wait` ends on a held mutex exits 75. A planted-marker test covers live, young, reused and expired markers and fails on 0.21.0.

## player-review

- [x] `references/player-review.md` defines the cross-harness player reviewer: a new session, the role prompt, allowed inputs (playtest, ws-play screenshots and summaries, the contract's rubric and specs) and forbidden ones (code, diffs, commits, tests, author notes), playing through a claimed workstation and `ws-play`, stuck and crash handling, report contents and verdicts, filing, and evidence retention; `/ai-dev-kit-player-review` and its slash command point at it.
- [x] `templates/player-review/` has the playtest sheet (goal, start, focus in player words, step and time limits, build commit/tree/asset lock, pool) and the report (`report.md` for people, `report.json` for the gate: steps, stuck, confusing, spec mismatches, feelings, rubric scores, verdict pass/fail/incomplete).
- [x] `scripts/player-review.cjs` writes requests bound to commit, tree and asset lock, files reports from a different session with a hashed manifest of the claim's evidence (`claim.json` from the workstation claim, steps, screenshots, report), and checks the gate; `prune --evidence-days` keeps filed evidence until `keep_until`.
- [x] The gate contract's `player_review` makes preflight warn and merge/integrate fail, with one stated reason per case (uncommitted, missing, stale, other tree, fail/incomplete, same session, evidence gone/changed/without claim); `--phase status` and merge-guardian report it.
- [x] `tests/player-review.test.cjs` covers the pass and every block case with real Git fixtures and the real gate; Docker tests cover `ws-play` and `claim.json`; `npm run build` and skill validation pass; CHANGELOG has an Unreleased entry and no version change.
- [x] Owner waiver: `player-review.cjs waive --owner --reason` writes a tracked `.ai-dev-kit/player-review-waivers/<commit>.json` bound to the candidate's full commit SHA and tree, with owner, reason, time, signing session, author session and request. Only owners in `player_review.owners` of `base_ref` count; the signing session must differ from the request's author session; the waiver lapses when any non-waiver file changes after its candidate. Invalid waivers (owner not listed, other commit or tree, empty reason, author-signed) block merge with `invalid waiver <file>: <why>`; a valid one passes and shows `WAIVED by owner <owner> — <reason>` in merge, status and merge-guardian. Preflight stays warn-only; session ids are documented as not identity authentication.

## workstation-onboarding

- [x] `references/workstation-onboarding.md` walks a project from nothing to player review in order: image, pool (every `workstations.json` key with its default; memory sizing from Docker's memory with the measured run-only 2.5g and build-and-run 3g, three or two per 8 GB VM), host preparation (assets, `cp -c` clone of the import cache from a checkout with the same lock, `requires`/`prepare`, why not in a workstation), evidence capture (claim, `ws-run`, `ws-play`, evidence directory, release, status, prune, disk checks, delayed release on Docker Desktop), player review (contract fields with owners, rubric and specs; request, file, waive; preflight and merge behavior; when to turn it on), and common failures.
- [x] `templates/workstation/examples/starter/` is a generic example project that the tests run: `tests/starter-example.test.cjs` with the fake Docker CLI in the default suite, `tests/starter-workstation.test.cjs` on real Docker in `test:workstation`.
- [x] `references/no-focus-stealing.md` states the rule and lists forbidden calls for macOS, Windows, X11 and engines; `scripts/focus-steal-scan.cjs` scans configured paths with an allowlist that needs reasons and fails on unused entries, reporting file, line, column, rule and reason; `tests/focus-steal-scan.test.cjs` covers every rule and the allowlist.
- [x] README, the `ai-dev-kit` and player-review skills, the workstation README and `loop-workflow.md` link the guide; `npm run build` and skill validation pass; CHANGELOG has an Unreleased entry and no version change.
