# Starter project

A minimal project set up for workstations, evidence capture and player
review, following `skills/ai-dev-kit/references/workstation-onboarding.md`.
Its "game" is two `xmessage` windows: a menu (Start Game, Quit) and, after
Start Game, a playing window. Copy the files into a project and replace the
game, the pool's image and the documents.

| File | Step of the guide |
| --- | --- |
| `.ai-dev-kit/workstations.json` | 2. the pool `starter`: 2 slots, 1 CPU and 512m each, 1280x720 |
| `tools/prepare.sh`, `assets.lock` | 3. host preparation: check assets, clone or import `game/.import` |
| `tools/capture.sh` | 4. evidence: claim, start, screenshot, release |
| `tools/ws-summary.sh` | 4. the UI summary `ws-play summary` prints, run inside the workstation |
| `.ai-dev-kit/focus-steal-scan.json`, `tools/check.sh` | 4. the focus-steal scan, run as the preflight command |
| `.ai-dev-kit/gate-contract.json` | 5. player review of `game/`, owner `lead-designer` |
| `docs/qa/player-rubric.md`, `docs/design/menu.md` | 5. what a reviewer reads |

Try it from a copy that is a Git repository:

```bash
docker build -t ai-dev-kit/workstation-base:local <kit>/templates/workstation/base
tools/prepare.sh
AI_DEV_KIT=<kit> tools/capture.sh          # prints evidence=<dir> with menu.png
AI_DEV_KIT=<kit> tools/check.sh
```

The gate also needs what `bootstrap/init-skill.sh` and the project's test
policy add (`.ai-dev-kit/profile.yml`, `.ai-dev-kit/test-scope.json`, the
requirements ledger). `tests/starter-example.test.cjs` and
`tests/starter-workstation.test.cjs` in the kit run this example.
