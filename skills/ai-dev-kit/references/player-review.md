# Player Review

A player review is an independent acceptance of a player-visible change, done
the way a player meets it: a different session plays the exact candidate build
on a workstation, without reading code, and reports what it saw. The session
that wrote the change does not judge its own screenshots.

It works in any harness (Claude Code, Codex, Gemini CLI, ...): the role is a
prompt plus a few commands, and the evidence is plain files.

## When A Review Is Required

The project lists its player-visible paths in the tracked
`.ai-dev-kit/gate-contract.json`:

```json
"player_review": {
  "paths": ["Game/Scenes", "Game/Scripts/Ui", "data/ui"],
  "exclude": ["Game/Testing"],
  "pool": "godot",
  "lock": "data/objects.lock.yaml",
  "rubric": "docs/qa/player-rubric.md",
  "specs": ["docs/art/art-bible.md", "docs/design/ui.md"],
  "keep_days": 30
}
```

- `paths` and `exclude` are literal repository-relative roots (a file, or a
  directory and everything under it), like `test-scope.json`. A branch whose
  diff against the merge base with `base_ref` touches a path under `paths` and
  not under `exclude` needs a player review.
- `pool` is the workstation pool reviewers claim (see "Workstation Pools" in
  `loop-workflow.md`). `lock` is the asset lock file whose hash names the asset
  version. `rubric` and `specs` are the only project documents a reviewer reads.
  `keep_days` (default 30) is how long filed evidence is kept.

The gate (`skill-first-gate.sh`):

- `--phase preflight` reports a missing or invalid review as a warning, so
  authors see it early without blocking their loop.
- `--phase merge` and `--phase integrate` fail unless the latest review filed
  for the current commit passes every check below; `--phase status` shows the
  state and counts it against merge readiness.
- Block reasons, each printed as one line:
  - uncommitted player-visible changes (no commit-bound review can cover them);
  - no review filed for the current commit;
  - the latest review is bound to an earlier commit (stale);
  - the review's tree differs from HEAD's tree;
  - the verdict is `fail` or `incomplete` (with the report's summary);
  - the reviewer session is the author session, or a session is missing;
  - the evidence is gone, its manifest changed, a file in it changed or is
    missing, or it does not cite a workstation claim.

There is no waiver: a player-visible change without a passing review does not
merge. A later, failing review of the same commit replaces an earlier pass.

## Sessions

Each command identifies its session by `--session <id>`, else
`AI_DEV_KIT_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID` (set by Claude Code).
Harnesses without an exported id pass `--session` with their conversation or
thread id. The check stops a session from approving its own work by mistake;
it is not authentication.

## Author: Request A Review

1. Commit the player-visible change. A review binds to a commit and its tree.
2. Write the playtest request:

   ```bash
   node <kit>/scripts/player-review.cjs request \
     --goal "Buy a sword in the market and equip it" \
     --focus "The shop shows prices before you buy" \
     --focus "The new inventory grid fits on a 1280x720 window" \
     [--start "the save in saves/market.fsav"] [--max-steps 60] [--max-minutes 30] [--pool godot]
   ```

   Write `--goal` and `--focus` as a player would say them: what to try and
   what should look or behave differently. Never name files, classes or code.
   `request` prints the request id and `playtest.md` (both under the main
   checkout's `.ai-dev-kit/player-review/<id>/`).
3. Start a new session for the reviewer (a new conversation in Claude Code, a
   new thread in Codex, a new chat in Gemini CLI). Give it only the reviewer
   role below and the path of `playtest.md`. Do not paste your own context,
   notes or reasoning.
4. Do not edit the reviewer's report or evidence. If the verdict is `fail` or
   `incomplete`, fix the change, commit, and request a review of the new commit.

## Reviewer Role

Give a new session this prompt, then the playtest path:

```text
You are a player reviewer. You test one build the way a player would and report
what a player experiences. You did not write this build and you must not look
at how it was made.

Read the playtest file you are given; it names the goal, where to start, what
to watch for, your step and time limits, the build, and the only project
documents you may read (a scoring rubric and design or art specifications).

Play only through the workstation: claim one, start the build, and act with
ws-play (click by coordinates or by UI node, keys, typing, waiting,
screenshots, UI summaries). Look at every screenshot before your next step.
Stay within the limits.

Do not read source code, diffs, commit messages, tests, build output, or any
note or conversation from the author. Do not edit any file in the repository
and do not change game data except by playing. If you cannot tell how
something works, that is a finding: record it, do not look it up.

Report in the templates: each step you took, where you got stuck, what
confused you, what differs from the design and art specifications, how it felt
to play, the rubric scores, and a verdict: pass, fail or incomplete. Then file
the report with player-review.cjs file.
```

Allowed inputs: the playtest file; screenshots and summaries returned by
`ws-play`; the `rubric` and `specs` files the playtest lists; the report
templates; this reference.

Forbidden inputs: source code, diffs, commit messages, tests and test output,
build logs, the author's notes, conversation or chat, other reviewers' reports
of this build, and any repository file not listed above. The reviewer writes
only inside the claim's evidence directory.

## Playing

1. Claim a workstation from the playtest's pool:

   ```bash
   out=$(node <kit>/scripts/resource-lock.cjs claim --pool <pool> --label "player review <id>") || exit $?
   ```

   Keep the printed `token`, `workstation` and `out`. Renew the lease
   (`renew=` line) if the session runs long; exit 75 means all workstations are
   busy: wait and claim again.
2. Start the build in the background with the claim's `exec=` command plus any
   start arguments the playtest names, for example
   `docker exec -d <workstation> ws-run --timeout 3600 -- <start command> <args>`.
3. Play one step at a time:

   ```bash
   docker exec <workstation> ws-play focus <window class>       # once, before keys
   docker exec <workstation> ws-play --note "open the shop" click 640 360
   docker exec <workstation> ws-play node shop.buy_button        # if the project provides UI nodes
   docker exec <workstation> ws-play key Escape
   docker exec <workstation> ws-play wait 2
   docker exec <workstation> ws-play summary
   ```

   Each call prints the screenshot path relative to `out`; open
   `<out>/<path>` and look at it. `summary` prints the UI summary (the
   project's node tree when it provides one, else the window list). Every step
   is recorded with its screenshot hash in `<out>/review/steps.jsonl`; `--note`
   says what you meant to do.
4. Stuck: try at most three different things a player would try (Escape, a
   visible control, waiting a few seconds) and record each. If still stuck,
   stop and conclude `fail` when the stuck point is in a focus item, otherwise
   `incomplete`.
5. Crash or freeze (the window is gone, or nothing changes for 30 seconds): take
   `ws-play shot crash` and `ws-play summary`, copy the game's own log into
   `<out>/review/logs/` if the project writes one there, and stop. Restart at
   most once to see whether it repeats. Do not debug. A crash during the goal
   or a focus item is `fail`.
6. A workstation that will not start, or a lost claim, is not a verdict: report
   it to whoever asked for the review and do not file.
7. Release the workstation (`release=` line) before filing.

## Report

Write two files in `<out>/review/`, starting from the kit's
`templates/player-review/`:

- `report.md`: for people. Verdict first, then the steps with their
  screenshots, where you got stuck, what confused you, differences from the
  specifications, how it felt, the scores, and the environment.
- `report.json`: the same facts for the gate:

  | Field | Content |
  | --- | --- |
  | `schema_version` | `1` |
  | `request` | the request id |
  | `candidate` | `commit` and `tree`, copied from the playtest |
  | `reviewer` | `session` (this session's id), `harness`, optional `model` |
  | `verdict` | `pass`, `fail` or `incomplete` |
  | `summary` | what happened, in a few sentences |
  | `stuck`, `confusing`, `spec_mismatches` | lists of `{ "step": <n or null>, "text": "..." }`, empty when none |
  | `feelings` | the player's impression |
  | `scores` | each rubric criterion with its score (the template's criteria without a rubric) |

Verdicts:

- `pass`: the goal can be reached, every focus item looks and behaves as a
  player would expect and as the specifications say, and nothing blocks play.
- `fail`: a focus item is broken, misleading or visibly off-spec, the goal
  cannot be reached because of the build, or the build crashes.
- `incomplete`: the review ran out of steps or time, or something outside the
  build stopped it, before the goal and focus items were judged.

## File The Review

From the reviewer session:

```bash
node <kit>/scripts/player-review.cjs file --request <id> --evidence <out>
```

`file` refuses when the session is the author's, the evidence has no
`claim.json` (it was not played on a claimed workstation), the report does not
match the request, or a recorded screenshot is missing. It then writes
`<out>/review/manifest.json` (every evidence file with its size and SHA-256,
the candidate, both sessions, the workstation and its image), a receipt in
`.ai-dev-kit/player-review/<id>/receipt.json`, and `<out>/review/filed.json`.
Filing a `fail` or `incomplete` report matters as much as a pass: it blocks the
merge until a new commit passes.

## Evidence And Retention

```text
<out>/                               .ai-dev-kit/pools/<pool>/out/<claim>/, /ws/out in the workstation
  claim.json                         pool, slot, workstation, image and image id, screen, start command
  ws-run.json                        exit, time and memory of the last ws-run
  review/steps.jsonl                 one line per ws-play step
  review/shots/NNNN[-name].png       the screen after each step
  review/summaries/NNNN.txt          UI summaries
  review/logs/                       game logs the reviewer copied (optional)
  review/report.md, report.json      the report
  review/manifest.json               written by file: files, hashes, versions, sessions
  review/filed.json                  keep_until, read by prune
```

The renderer and its settings are part of the start command in `claim.json`;
the image id pins the workstation image. Requests and receipts stay in the main
checkout's `.ai-dev-kit/player-review/` (ignored by Git, a few kilobytes each).
`resource-lock.cjs prune --evidence-days <n>` never removes evidence before its
`keep_until` (`keep_days` after filing, default 30); after that the usual rule
applies. Once the evidence is gone the receipt no longer passes the gate, which
only matters for a branch that has not merged yet.
