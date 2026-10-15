# Asking The User

Use this whenever a workflow must put a question to the user — loop kickoff clarification, deletion proposals in subtraction, merge calls, or any decision you cannot resolve yourself. A bad question wastes the user and signals you did not look; question quality matters more than question count.

## Rules

- **Research first.** Resolve what you can from code, docs, git history, and the codegraph before asking. Never ask what the repo already answers.
- **Only ask decision-changing questions.** If an answer would not change what you build, delete, or approve — or how you verify it — do not ask it.
- **Carry your own default.** Pair each question with your best guess and proceed on it unless corrected ("I plan to do X — correct me if not"). Confirming a default is faster and higher-signal than composing an answer from scratch.
- **Offer concrete options** over open-ended prompts where you can.
- **One batched round, smallest set.** Do not interrogate across many turns.
- **Separate blockers from discoverables.** Hard-block only on answers that would invalidate the work; record the rest as stated assumptions and proceed.

Workflows may layer a domain-specific question set on top of these rules — e.g. the loop kickoff template in `loop-workflow.md`.
