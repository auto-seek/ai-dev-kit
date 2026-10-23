# AI Dev Kit Player Review

Arguments:

```text
$ARGUMENTS
```

Use the ai-dev-kit skill and read `references/player-review.md`.

Skill path preference:

1. `{{PROJECT_SKILL_PATH}}`
2. `{{USER_SKILL_PATH}}`

Decide which side you are on.

Author (you changed player-visible files): commit the change, then write the
playtest request, in a player's words:

```bash
node "{{AI_DEV_KIT_PATH}}/scripts/player-review.cjs" request --project "{{PROJECT_PATH}}" --goal "<what a player tries>" --focus "<what should look or behave differently>"
```

Ask for a new session to review it: give that session only the reviewer role
from the reference and the printed `playtest.md` path. Never review your own
change and never edit the reviewer's report.

Reviewer (you were given a playtest file): you are a new session acting as a
player. Follow the reviewer role in the reference exactly: claim a workstation
from the playtest's pool, play only through `ws-play`, look at every
screenshot, read no source code, diffs, commit messages, tests or author notes,
and stay within the step and time limits. Write `review/report.md` and
`review/report.json` from the kit's `templates/player-review/`, release the
workstation, and file:

```bash
node "{{AI_DEV_KIT_PATH}}/scripts/player-review.cjs" file --project "{{PROJECT_PATH}}" --request <id> --evidence <claim out dir>
```

`player-review.cjs status --project "{{PROJECT_PATH}}"` shows whether the
current commit needs a review and why it does not yet pass.
