# Playtest <request id>

<!-- `player-review.cjs request` writes this file (and playtest.json with the
same fields) from the author's --goal, --focus, --start and limits, and binds
it to the committed candidate. This copy shows the shape; do not fill it by
hand. Write goal and focus in a player's words: what to try, what should look
or behave differently. Never name files, classes or code. -->

You are the player reviewer for this build. Follow the player-review role in the
ai-dev-kit skill (`references/player-review.md`): play only through the workstation,
never read source code or diffs.

## Goal

Buy a sword in the market and equip it.

## Start from

The save in saves/market.fsav (or: a new game).

## Watch for

- The shop shows prices before you buy.
- The new inventory grid fits on a 1280x720 window.

## Limits

- At most 60 steps and 30 minutes of play.

## Build under test

- Commit <full 40-character commit> (<branch>)
- Tree <full tree hash>
- Assets <lock file> sha256 <hash of the lock file at that commit>
- Workstation pool: <pool>

## You may read

- Scoring rubric: <rubric path from the gate contract>
- Design or art specification: <each spec path from the gate contract>

## When done

Write `review/report.md` and `review/report.json` in the claim's `out` directory
from the templates, release the workstation, then file it:

```bash
node <kit>/scripts/player-review.cjs file --request <request id> --evidence <claim out dir>
```
