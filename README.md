# AI Dev Kit

> Skill-first AI development workflow kit for agent harnesses.

AI Dev Kit v2 installs a reusable local skill, project profile, workflow ledgers,
review prompts, and lightweight harness adapters. The kit no longer generates
large `AGENTS.md` / `CLAUDE.md` rule files or language-wide regex gates as the
main quality mechanism.

Test review is language-neutral: each project declares literal test files and
directories in tracked `.ai-dev-kit/test-scope.json`. The gate binds that scope
and changed content to an actual review, without a language or filename allowlist.
New and existing projects must [configure test scope](docs/test-scope-migration.md)
before preflight; bootstrap does not guess it.

Project validation is explicit too: commit a
[gate contract](docs/team-gate-migration.md) naming the approved base ref,
requirements scope and actual verification command. Preflight executes that
command and binds its result to the final commit and working inputs. For team
setup, task publishing and worker startup, use the [Git center runbook](docs/team-git-center.md).

GUI evidence (screenshots, scripted play) runs on Linux workstation containers
with private screens, so agents never take the host screen. The
[workstation onboarding guide](skills/ai-dev-kit/references/workstation-onboarding.md)
covers the pool, host preparation, evidence capture and player review in order,
with a [runnable example project](templates/workstation/examples/starter/).
Evidence code follows the [no focus stealing rule](skills/ai-dev-kit/references/no-focus-stealing.md),
which `scripts/focus-steal-scan.cjs` checks.

## Quick Start

Daily use should start from installed skills, not shell scripts.

Claude Code:

```text
/plugin marketplace add https://github.com/auto-seek/ai-dev-kit.git
/plugin install ai-dev-kit@ai-dev-kit-marketplace
/reload-plugins
```

If the installed Claude Code version only accepts GitHub marketplace slugs,
mirror this repository to GitHub and use `owner/repo`; the repository already
contains `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`.

Codex:

```text
Use the Codex skill installer to install these repo paths:

skills/ai-dev-kit
skills/ai-dev-kit-loop
skills/ai-dev-kit-preflight
skills/ai-dev-kit-test-review
skills/ai-dev-kit-doc-review
skills/ai-dev-kit-merge-guardian
skills/ai-dev-kit-player-review
skills/ai-dev-kit-clean
skills/ai-dev-kit-cascade-init
skills/cascade-center-agent
skills/cascade-flow
```

After installation, invoke the workflow skills directly:

```text
/ai-dev-kit-loop
/ai-dev-kit-preflight
/ai-dev-kit-test-review
/ai-dev-kit-doc-review
/ai-dev-kit-merge-guardian
/ai-dev-kit-player-review
/ai-dev-kit-clean
/ai-dev-kit-cascade-init
/cascade-center-agent
/cascade-flow
```

The local/offline fallback installer is:

```bash
bash bootstrap/install-skill.sh --target both
```

It only copies the packages declared by `marketplace/index.json` into the harness skill
directories and writes legacy project command files for harnesses that still
need them.

## Git 瀑布流：搭建、加入、查看

安装或更新同一个 ai-dev-kit plugin 后，可使用三个入口：

| 需求 | Skill | 做什么 |
| --- | --- | --- |
| 搭建项目中心 | `ai-dev-kit-cascade-init` | 复用公司 Git，搭建独立任务仓库；需要项目 ID 和网页时使用完整 Center 发行物 |
| Agent 加入 | `cascade-center-agent` | 使用网页复制的 `项目ID@中心地址`（或项目 ID 加配置的中心地址）和 lite/pro/max，自动取得瀑布流 Git 凭据，给出归属确认码，再自查项目源码 Git |
| 查看任务图 | `cascade-flow` | 打开已有团队网页，或用随包 viewer 启动本地只读任务图 |

三个入口都不绑定具体业务项目或中心域名。网页复制的 `项目ID@中心地址` 自带中心
地址；单独的项目 ID 通过 `--origin` 或 `CASCADE_CENTER_ORIGIN` 配置中心地址，
没有配置时才询问。原实例重试可复用
同一目录的注册配置，后续操作和网页查看使用 `client.json`。

例如：让 agent 使用 `cascade-center-agent`，填写私下提供的 `项目ID@中心地址` 和实际
模型 level，加入后把归属确认码交给你（在网页“我的项目 → 执行 agent → 确认我的 agent”
输入，10 分钟内有效），检查项目 Git 权限，再按你的要求领取任务。项目 ID 不放进
插件或源码；每个并发实例使用自己的身份。项目 Git 缺权单独报告，不阻止完成
瀑布流加入。接入和本地查看的客户端均随 skill 携带，无需 Center 源码权限；
搭建服务器仍需取得并部署获准的完整发行物。

插件不会自动注册 agent、启动模型、部署服务器或发布业务任务。草案由 agent
对话拆解；成员提出的目标由本人在网页确认，agent 提出的目标由项目所有者或该 agent
的负责人确认，或由获授权的 agent 确认。已有中心保留原有心跳和任务保护规则。

## Project Bootstrap

Use this when a repository needs ai-dev-kit profile files, workflow ledgers, and
hook adapters:

```bash
bash bootstrap/init-skill.sh /path/to/project --harness codex --profile balanced
```

Fresh installs default to Cascade file storage and require Cascade >=0.8.0,
using the [fixed 0.8.1 release source](skills/ai-dev-kit/references/cascade-coordination.md#installation).
Re-running bootstrap preserves the complete existing profile, including Git
remote, namespace, roles and custom commands. Change coordination explicitly via
`/ai-dev-kit-cascade-init`. Upgrade notes: [0.11 ownership and evidence migration](docs/coordination-0.7-migration.md).
Before the first 0.8-only event in a shared namespace, upgrade and verify every
actual CLI/worker entrypoint accessing it. Updating Kit or a profile alone does
not upgrade Cascade; already approved, source-verified 0.8 environments remain valid.

For a shared team, say “Create this project's company Git center” or “Join this
project and report once.” Cascade Init routes [new centers](skills/ai-dev-kit/references/project-center.md),
[worker enrollment](skills/ai-dev-kit/references/worker-enrollment.md), and
[migration/access repair](skills/ai-dev-kit/references/center-access.md) separately.
Projects can share a company Git host with separate repositories, access and
planners; GitHub accounts are not required. Center setup does not by itself start
a planner schedule or authorize employee devices.

Harness options:

```bash
--harness codex      # install .codex/hooks.json
--harness claude     # install .claude/settings.json
--harness both       # install both adapters
--harness none       # install only skill/profile/workflow files
```

Project layout after test-scope enrollment:

```text
.ai-dev-kit/
├── profile.yml
├── test-scope.json            # project-owned, tracked test files/directories
├── skills/
│   ├── ai-dev-kit/
│   ├── ai-dev-kit-loop/
│   ├── ai-dev-kit-preflight/
│   ├── ai-dev-kit-test-review/
│   ├── ai-dev-kit-doc-review/
│   ├── ai-dev-kit-merge-guardian/
│   ├── ai-dev-kit-player-review/
│   ├── ai-dev-kit-clean/
│   ├── ai-dev-kit-cascade-init/
│   ├── cascade-center-agent/
│   └── cascade-flow/
├── workflow/
│   ├── LEDGER.md
│   ├── feature-ledger.md
│   ├── findings.jsonl
│   ├── test-review.md
│   └── subtraction-log.md
└── docs/
    ├── registry.yml
    ├── claims.jsonl
    └── document-template.md

docs/development/feature-ledger.md
docs/working/
docs/decisions/
```

## Skill Marketplace

Skill packages live under:

```text
skills/
```

Claude marketplace metadata:

```text
.claude-plugin/marketplace.json
.claude-plugin/plugin.json
```

Harness-neutral local market index:

```text
marketplace/index.json
```

The fallback installer can list the same market:

```bash
bash bootstrap/install-skill.sh --list
```

Install both user skill sets and refresh a project-local skill set:

```bash
bash bootstrap/install-skill.sh --target all --project /path/to/project
```

Install only project-local skill packages without touching user-level skills:

```bash
bash bootstrap/install-skill.sh --target project --project /path/to/project --skill-only
```

## Installing Adapters Later

Install or refresh a harness adapter without reinstalling the skill:

```bash
bash bootstrap/install-adapter.sh /path/to/project --harness codex --overwrite
bash bootstrap/install-adapter.sh /path/to/project --harness claude --overwrite
bash bootstrap/install-adapter.sh /path/to/project --harness generic
```

The generic adapter writes a hook contract under:

```text
.ai-dev-kit/adapters/generic/
```

Any harness can consume that contract and wire its own hook format to
`scripts/skill-first-gate.sh`.

## Core Workflow

- Use the local skill at `.ai-dev-kit/skills/ai-dev-kit/SKILL.md`.
- Read `.ai-dev-kit/profile.yml` for project commands, graph provider hints, and review policy.
- New projects coordinate through Cascade >=0.8.0. The default `self-serve` role reserves canonical `<slug>` with native `reserved_for=<agent>` through `scripts/cascade-lane.cjs`; orchestrators publish shared DAG nodes and the engine atomically filters ownership and tier on claims.
- File storage is the zero-dependency single-machine default. Git storage is the recommended zero-service cross-machine mode, using remote-ref compare-and-swap; Redis remains an optional low-latency backend, with credentials in the gitignored `.ai-dev-kit/profile.local.yml` overlay.
- Git mode has passed local/container lifecycle, race, fencing, tier, crash, clock-skew, compaction, 1,000-attempt contention, GitHub SSH-over-443, and CODING HTTPS acceptance (`docs/git-coordination-backend.md`).
- Bind non-trivial work to `docs/working/<slug>.md` or `docs/decisions/<slug>.md` before implementation. Version 0.11 preserves existing deprecated `engine: ledger` configurations for explicit migration; it does not remove ledger or silently switch those projects.
- Linked worktrees use one main-checkout profile, local overlay, file store and workflow evidence directory. Test review receipts cover committed, staged, unstaged and untracked changed tests, bound to branch/base and content identities.
- Use `.ai-dev-kit/workflow/LEDGER.md` for multi-agent, high-risk, or multi-session tasks.
- Store review findings in `.ai-dev-kit/workflow/findings.jsonl`.
- Treat tests as untrusted until a test-review pass validates the contract and assertions.
- Apply `references/implementation-discipline.md` before production code: ship
  only final-architecture increments, surface errors instead of degrading,
  accept coordinated breaking changes, research existing/mature capability
  first, and avoid speculative abstraction or heavy defensive machinery. Write
  comments for the next maintainer: plain, verified reasons and constraints,
  not code narration, work reports, or jargon without substance. Preserve useful
  API docs and directives; misleading comments are review findings, while
  wording preferences are not automatic gate failures.
- Keep brainstorming, plans, and decisions synchronized through `.ai-dev-kit/docs/registry.yml`.

## Gates

For a minimal read-only task waterfall, use the
[Cascade task flow viewer](docs/cascade-flow.md):

```bash
npm run flow -- --remote <coordination-git-url> --namespace <project>
```

It opens a local view of the cloud Git center without claiming tasks or writing
remote locks. Task completion reports and data-read freshness remain distinct.

For a shared Git-backed task center and developer enrollment, see
[Team Git center: setup and task delivery](docs/team-git-center.md). The guide
distinguishes task storage from a running planner or worker and includes the
fixed Cascade 0.8.1 source-install path and shared-store upgrade order. Version 0.12 requires explicit
[test scope](docs/test-scope-migration.md) and
[project gate contracts](docs/team-gate-migration.md), with exact-HEAD evidence.
Users upgrading from 0.10 must also follow the
[coordination migration guide](docs/coordination-0.7-migration.md).
For stopped workers, uncertain Git outcomes and planner restarts, use the
[recovery runbook](docs/team-loop-recovery.md).

The repository includes a root `Jenkinsfile` for CODING CI. Enable a CODING
build plan against it so version lockstep, tests, build, and package contents
must pass on every protected-branch change.

Stop gate:

```bash
bash scripts/skill-first-gate.sh --phase stop --project /path/to/project
```

Preflight / merge gate:

```bash
bash scripts/skill-first-gate.sh --phase preflight --project /path/to/project
bash scripts/skill-first-gate.sh --phase merge --project /path/to/project
```

The stop gate blocks only explicit blocking findings. Preflight and merge gates
also enforce the gate contract's selected requirements, active Cascade reservations (or
legacy feature-ledger entries), subtraction/preflight evidence, and test-review
evidence for changed tests. Run preflight after the final commit; merge requires
that exact content-bound receipt and does not sign a replacement one.

## Migrating Older Projects

Use this only for existing projects that previously used generated V1
instructions:

```bash
bash bootstrap/init-skill.sh /path/to/project --harness both --overwrite-hooks
node scripts/upgrade-v1-to-skill.cjs /path/to/project --harness both
```

## Repository Commands

The build requires Node >=24.21.0, Python >=3.11 with venv/pip, Git and
OpenSSL. Center configuration tests install the bundled runtime offline and
use temporary local HTTPS fixtures; they do not register with a live center.

```bash
npm run build
npm run init:skill -- /path/to/project --harness codex
npm run install:adapter -- /path/to/project --harness generic
npm run install:skill -- --target both
```

## License

MIT, see [LICENSE](LICENSE). Bundled third-party material keeps its own license:
`licenses/codex-skill-creator-APACHE-2.0.txt` (Apache-2.0),
`skills/cascade-flow/scripts/cascade-flow/vendor/DAGRE-LICENSE` (MIT), and the
Cascade runtime and dependency wheels under
`skills/cascade-center-agent/deploy/cascade-runtime/`, each of which contains its
license in its `.dist-info` directory.
