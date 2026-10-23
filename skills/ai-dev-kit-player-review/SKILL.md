---
name: ai-dev-kit-player-review
description: "User-invoked ai-dev-kit player review workflow. Use when the user invokes /ai-dev-kit-player-review, asks for an independent player's-eye playtest of a player-visible change, asks to request or perform a player review, is given a playtest file to review, or when the gate reports a missing, stale or failing player review."
---

# AI Dev Kit Player Review

Use the `ai-dev-kit` skill first, then read `../ai-dev-kit/references/player-review.md`.

Arguments:

```text
$ARGUMENTS
```

Decide which side you are on.

Author (you changed player-visible files): commit the change, then write the
playtest request with `node <kit>/scripts/player-review.cjs request --goal ...
--focus ...`, in a player's words. Ask for a new session to review it: give that
session only the reviewer role from the reference and the printed `playtest.md`
path. Never review your own change and never edit the reviewer's report.

Reviewer (you were given a playtest file): you are a new session acting as a
player. Follow the reviewer role in the reference exactly: claim a workstation
from the playtest's pool, play only through `ws-play`, look at every
screenshot, read no source code, diffs, commit messages, tests or author notes,
and stay within the step and time limits. Write `review/report.md` and
`review/report.json` from the kit's `templates/player-review/`, release the
workstation, and file with `node <kit>/scripts/player-review.cjs file
--request <id> --evidence <out>`.

`node <kit>/scripts/player-review.cjs status --project .` shows whether the
current commit needs a review and why it does not yet pass.
