# Player review <request id>: <pass | fail | incomplete>

<!-- Save as <claim out dir>/review/report.md. Write as a player: what you did,
saw and felt. Link screenshots by their path in the evidence directory. Keep
report.json consistent with this file. -->

## Verdict

<pass | fail | incomplete>: <one or two sentences: could a player reach the goal,
and did each focus item work as a player expects?>

## What I did

| Step | Action | What I saw | Screenshot |
| --- | --- | --- | --- |
| 1 | Opened the market from the map | The market screen with three stalls | shots/0001.png |
| 2 | Clicked the smith's stall | A price list, swords at 120 coins | shots/0002.png |

<Every ws-play step is in steps.jsonl; list the ones that matter for the goal
and the focus items.>

## Where I got stuck

- <Step n: what I wanted to do, what I tried (at most three things), what
  happened.> (or: Nowhere.)

## What confused me

- <Step n: what I did not understand, in a player's words.> (or: Nothing.)

## Differences from the design and art specifications

- <Step n: what the specification says (document and section), what the screen
  shows.> (or: None found.)

## How it felt

<The player's impression: pace, clarity, look, anything surprising or pleasing.>

## Scores

| Criterion | Score | Why |
| --- | --- | --- |
| <rubric criterion> | <score on the rubric's scale> | <one line> |

<!-- Without a project rubric, score 1 (poor) to 5 (good): clarity,
responsiveness, visual consistency, feel. -->

## Environment

- Build: commit <commit>, tree <tree>, assets <lock hash>
- Workstation: <pool> slot <n>, image <image id>, screen <WxH>
- Renderer: <from the start command in claim.json, e.g. forward_plus / vulkan>
- Reviewer: <harness> <model>, session <session id>
