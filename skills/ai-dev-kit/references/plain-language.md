# Plain Language

Use this for anything a person will read that you write: replies and status
reports to the user, final summaries, questions, commit messages, PR
descriptions, docs, and — most important — product copy that ships to users
(button text, labels, titles, dialogs, empty states, errors, toasts, tooltips,
onboarding, notifications, settings descriptions, release notes). Source
comments follow `implementation-discipline.md`.

The standard is simple: write the way a capable person on a professional team
would write it for another person. If a sentence would sound odd said out loud
to a colleague, or a piece of UI text would look out of place in a mature
commercial app, rewrite it.

## Part 1 — Talking to people (replies, reports, docs, commits)

### Say the whole thing, in order

- Lead with the result: what happened, what it means for the reader, and what
  they need to do (if anything).
- Give cause and effect, not just the outcome: why it happened, what you did,
  what changed, and what is still open or unverified. Do not make the reader
  guess the reason or the consequence.
- Say plainly what you did not do, could not verify, or are unsure about.
  Never imply something was tested or checked when it was not.
- Keep the length matched to the content. Simple things get a sentence or two;
  a decision with trade-offs gets the reasoning it needs. Short is not the goal;
  clear and complete is.

### Use words people already use

- Do not coin terms, labels, or abbreviations. Use the words the reader and the
  project already use. If a project term is unavoidable and the reader may not
  know it, explain it in one plain clause the first time.
- Do not use internal identifiers (function names, flags, task ids, file
  paths) as if they were ordinary words. Describe the thing in plain words; add
  the identifier in code font only when the reader needs it to act.
- Avoid buzzwords and empty intensifiers. In Chinese: 赋能、抓手、闭环、打通、
  沉淀、对齐、颗粒度、全链路、底层逻辑、兜底、收口、收敛. In English: robust,
  seamless, comprehensive, leverage, ensure, streamline, holistic. Name the
  concrete thing instead.
- Prefer concrete facts over abstract claims: numbers, file names, commands,
  the actual error text. "Optimized performance" says nothing; "startup went
  from 4.2s to 1.1s because the plugin list now loads on demand" does.

### Write normal sentences

- Subject, verb, object. Avoid noun stacks and nominalizations
  (完成了对 X 能力的统一收口 → 把 X 合并成了一个入口).
- Chinese: avoid translated-from-English grammar — 进行 + 动词、对……进行……、
  基于……、通过……来……、被-heavy passives, and long 的的的 chains.
- Do not use metaphors in place of facts.
- Do not over-format. A bullet list of fragments loses the "because" and "so";
  use sentences when cause and effect matter. Use headings only in long docs.
  Do not bold everything or decorate with emoji.
- No filler openers or closers (好的！、希望对你有帮助、总结一下、Great question),
  no self-praise (完美解决、全面优化), no restating the request.
- Reply in the user's language.

### Examples

```text
Bad:  已完成登录模块的全链路优化，打通了鉴权闭环，确保系统稳定性。
Good: 登录偶尔失败是因为 token 过期后没有刷新，请求直接返回 401。现在过期前
      5 分钟会自动刷新。我手动测了过期和断网两种情况都正常；多标签页同时刷新
      的情况还没测。
```

```text
Bad:  Implemented robust handling to ensure seamless lane hygiene.
Good: Two workers could pick the same task when they started within the same
      second. The claim now happens inside the lock, so the second worker sees
      the task as taken and picks another. Covered by a new test.
```

## Part 2 — Product copy (UI text)

UI text is part of the product. It should read like a shipped commercial app
written by a professional team — not like a design doc, a feature description,
or an AI explaining itself. When unsure, look at how mature apps in the same
category word the same thing, and at the project's existing copy.

### First decide whether the text should exist

- Most screens need less text, not better text. Before polishing a string, ask
  whether a user could act correctly without it. If yes, delete it.
- Do not add a paragraph under a heading that restates the heading, an intro
  line like "此页面用于……", placeholder or helper text on obvious fields, or a
  tooltip that repeats its label.
- Add explanation only where a user would otherwise get stuck or make a costly
  mistake — and then one short sentence at the point of decision, not a block
  of text at the top of the page.

### Buttons and menu items

- A verb, or verb + object, saying what happens: 保存、新建项目、重试、删除、
  导出. In English: Save, New project, Retry.
- Keep them short (usually 2–4 Chinese characters, 1–3 English words).
- Not: 立即开始智能分析、一键优化、点击此处保存、确认提交您的更改、
  开始你的创作之旅.
- A confirm button in a destructive dialog names the action (删除, not 确定).
- No trailing punctuation, no emoji.

### Titles and labels

- Plain nouns that users say: 名称、存储位置、成员. Not 项目名称配置项.
- No parenthetical explanations inside labels (运行（执行当前任务）).
- Do not expose internal concepts (worker, lane, node, runtime, session id,
  pipeline names) unless they are product concepts users already know.

### Messages

- **Errors:** what happened and what the user can do, in their terms.
  无法连接服务器，请检查网络后重试. Not 发生了一个错误, not raw exception text,
  not an error code as the main message (a code may follow as secondary detail).
- **Empty states:** one line saying what will appear here, plus the action.
  还没有项目 + [新建项目]. Not three sentences selling the feature.
- **Success feedback:** short or none. 已保存. Not
  🎉 恭喜！您的设置已成功保存并即时生效！
- **Confirmations:** state the consequence. 删除后无法恢复。 Not
  您确定要执行此操作吗？

### Tone

- Neutral and direct. No exclamation marks except in rare, truly celebratory
  moments. No cute personas (小助手为您……) unless the product deliberately has
  one.
- Drop decorative marketing words: 智能、一键、全新、极致、无缝、轻松、强大、
  沉浸式、赋能, ✨, and slogan patterns like "X，让 Y 更 Z".
- Follow the project's existing choice of 你/您, punctuation, and spacing
  between Chinese and Latin text/numbers; keep it consistent. Chinese text uses
  full-width punctuation; buttons, labels, and short toasts take no final
  period.

### Consistency

- Before adding a term, search the existing copy and i18n resources. One thing
  gets one name everywhere (don't call it 项目 on one screen and 工程 on another).
- Reuse existing strings instead of writing near-duplicates.

### Examples

| Where | Bad | Good |
| --- | --- | --- |
| Primary button | 立即开始智能生成 | 生成 |
| Page subtitle | 在这里，您可以轻松管理您的所有项目，开启高效协作新体验。 | (delete it) |
| Input helper | 请在此处输入项目的名称 | (delete it; the label already says 名称) |
| Empty state | 暂无数据。您可以通过点击右上角的按钮来创建您的第一个项目，开启您的旅程！ | 还没有项目 [新建项目] |
| Error | 操作失败，发生未知错误（Error: ECONNREFUSED） | 连接不上服务，请检查网络后重试 |
| Toast | ✅ 保存成功！您的更改已即时生效。 | 已保存 |
| Delete dialog | 确认操作？ [确定] [取消] | 删除"设计稿 v2"？删除后无法恢复。 [删除] [取消] |

## When you change user-facing text

1. List every new or changed string with where it appears (screen and state).
2. For each one, first ask whether it needs to exist; delete what doesn't.
3. Check against existing copy and i18n resources for naming consistency.
4. Read each remaining string as a user looking at that screen, in that state.
   Would a professional app say it this way?
5. Include the string list in the review evidence so a reviewer can check copy
   without hunting through code.

## Review checklist

- Does the report lead with the result and give the cause, what was done, and
  what is still open?
- Any coined terms, internal identifiers used as words, or buzzwords?
- Any sentence that sounds unnatural when read aloud?
- Any UI text that could be deleted without hurting the user?
- Are buttons verbs, labels nouns, errors actionable, and empty states one line?
- Any marketing words, exclamation marks, emoji, or explanatory parentheses in
  the UI?
- Is the same thing named the same way everywhere?
