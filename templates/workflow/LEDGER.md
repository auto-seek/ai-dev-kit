# Requirements Ledger

Use this file for large, multi-agent, high-risk, or multi-session work.

Add concrete task requirements when a task needs a ledger.

Preflight requires an explicit requirements scope in the tracked
`.ai-dev-kit/gate-contract.json`. With `requirements.mode: task-sections`, use
one exact `## <canonical-task-id>` heading per task; a `<prefix>/example-task`
branch (one prefix segment: `fix/`, `codex/` or an agent id) reads `## example-task`. With `global`, all items in the selected ledger
apply. With `task-files`, this ledger is not used: each task keeps its
checkboxes in its own `<dir>/<task-id>.md` (default `docs/tasks`), so parallel
branches never edit one shared file. Do not relabel abandoned historical work as complete just to pass a gate.

Completion rules:

- Mark an item `[x]` only after implementation and verification evidence exist.
- Mark an item `[~]` only when explicitly deferred with a reason and owner.
- Do not merge work with open `[ ]` items.
