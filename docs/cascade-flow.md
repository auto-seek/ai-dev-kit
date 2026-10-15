# Cascade task flow

For the maintained standalone Center viewer and existing team webpages, use the
plugin's [cascade-flow skill](../skills/cascade-flow/SKILL.md). It carries its own
viewer assets, with ordinary-wheel zoom and canvas dragging. This document
describes the historical kit-root `npm run flow` entrypoint.

A read-only, left-to-right dependency DAG for a Git-backed task center. Ongoing
tasks and all their prerequisites appear in the current view. Cards initially
show only the task name and native state. Click a title to expand that card and
its dependency links; click again to collapse it. Technical details and delivery
records open inside the card when needed. There is no permanent side panel.

## Start

Requires Node.js 22 or newer and Git. Use the same Git credentials you already
use for the coordination repository; repository read permission is sufficient.
The viewer does not require the Cascade Python CLI, Redis, or a model runtime.

From the AI Dev Kit checkout:

```bash
npm run flow -- --remote <coordination-git-url> --namespace <project> --title <display-name>
```

With the npm package installed, the equivalent command is:

```bash
ai-dev-kit-flow --remote <coordination-git-url> --namespace <project>
```

Open the printed `http://127.0.0.1:4317` address. `--port 4318` selects another
port; `--port 0` chooses an available one. Ctrl+C stops the server and removes its
private temporary cache. `--timeout 30` is the per-Git-command budget in seconds
(greater than zero, at most 180). Git/SSH authentication must work without an
interactive terminal prompt; configure your SSH agent or Git credential helper.

Use the coordination repository, not the product repository. The remote must
contain `refs/heads/cascade-state/<project>` in Cascade 0.7's persisted format.
No profile, source checkout, shared worker cache or center loop is changed.

## What the page means

- **待领取**: READY, not evidence that the assigned employee is online.
- **等待前置任务**: PENDING, not an execution failure. A PENDING task without
  dependencies is labelled “等待就绪”.
- **执行中**: ACTIVE in the snapshot. An elapsed lease is marked “待确认”; the
  viewer neither declares the worker dead nor reclaims its task.
- **已报完成**: COMPLETED, not proof of independent acceptance or merged code.
  Setup/enrollment reports are also tasks, not product-delivery counts.
- **失败 / 已取消**: the native FAILED / CANCELLED state, never hidden by a
  successful refresh or a fallback empty list.

Arrows point from prerequisites on the left to their dependents on the right.
Parallel branches appear above/below one another. Merges and direct cross-layer
contracts are retained; spacing is not elapsed time. Current view includes
required completed/cancelled ancestors. All-task view adds other history to the
same graph, preserving links across the groups. History deep links automatically
open all tasks and expand the target. Dependency buttons navigate to that task.
Connectors follow rounded horizontal/vertical routes around cards. Selecting a
task emphasizes its direct incoming and outgoing dependencies; other real edges
remain visible at lower contrast so a dense graph is easier to follow.

Completed reports are visually quieter, while ACTIVE work is emphasized. An
expanded card shows its summary and direct prerequisites/dependents. Open
“技术详情与交付记录” for native ID/state, owner versus reservation, tier, lease,
contracts, retained events, refs and snapshot revision. At most one card expands;
its measured size participates in layout so other tasks and edges stay clear.
Remote labels, summaries and contract text are always rendered as plain text.

Large diagrams scroll at readable text size, including on narrow screens. Drag
an empty part of the canvas with a mouse or pen to move the view. Touch scrolling
and keyboard arrows work in the viewport; dragging does not change dependencies.
The minus/plus buttons zoom the graph from 25% to 200% around the viewport center.
The percentage button restores 100%. Ctrl/Command plus wheel zooms around the
pointer; an ordinary wheel continues to scroll. Zoom changes only the view, and
the controls remain outside the scaled graph. Ordinary refresh preserves zoom,
the expanded task, technical disclosure, focus and reading position; lease labels
still update when the Git revision is unchanged. Window resizing recomputes the
expanded width and retains the current focus. Keyboard buttons and native
summary controls provide the same navigation and expansion as pointer input.

HTML cards and SVG arrows use the bundled, pinned Dagre 3.1.1 layout. Collapsed
cards have fixed dimensions; expanded content is measured before rendering.
The bundle and MIT notices are under `scripts/cascade-flow/vendor/`; both existing
servers serve same-origin modules without a CDN or weaker CSP. The portal protects
these assets through its existing sessions. Layout errors remain explicit rather
than silently dropping edges or replacing the view with a fabricated empty queue. A task's native
ID is its default name. An optional text `context.critical.title` is a display
hint, not a required Cascade field or a replacement for the ID.

“读到快照” records a successful remote read. “最近任务事件” records the last
retained event in logical order; successful polling is not task progress. The
page polls every 15 seconds (every second while a refresh is running), with a
single background refresh per server. During
refresh it labels the previous snapshot. On a read failure it shows the error
and labels any retained view as old, including its original successful-read time.

The event detail shows up to five of the last twenty retained events per task.
Only events retained in the fetched snapshot are shown; absent events cannot
prove a task was never claimed. Cascade 0.7 Git compaction rewrites Git ancestry
without deleting the retained event file. Renewal resets the current lease
start and is not the start of work.
Execution identity is read from an active claim or a retained claim preceding
completion, never inferred from a reservation.

## Read and security boundaries

Each refresh fetches one state ref into a dedicated temporary bare Git repository
and reads graph and retained events at the same captured commit OID. It never
pushes or enters a Cascade lease transaction. Invalid JSON, missing files/refs,
unsupported format, unknown states and inconsistent dependencies are errors.
Git object consistency does not certify the Cascade event hash chain, task
evidence, artifact contents or an acceptance decision.

The server is deliberately **loopback-only**. It exposes fixed static assets and
a GET-only snapshot route, checks Host/Origin and uses a restrictive CSP. Remote
task text is rendered as text, with no automatic links or commands. It does not
serve full critical payloads, fencing tokens or artifact contents.

Each teammate can run the viewer locally against the same cloud Git center.
This is not an authenticated public dashboard: do not reverse-proxy it onto the
Internet. Shared web hosting needs a separate access-control/deployment design.
The cloud remains the Git center; local agents still publish and execute work.

## Verification

```bash
npm run test:flow
npm run build
```

Tests use real temporary Git repositories and real HTTP requests. They cover
remote ref advancement between blob reads, zero remote writes, inherited Git
environment isolation, source corruption, missing history/ref, previous-snapshot
error labeling, and loopback/same-origin/read-only request boundaries. Geometry
checks exercise the production layout with branching, merging, direct cross-layer
contracts, disconnected tasks and history edges, including endpoints and card
intersections. The real browser fixture can be started with
`node tests/fixtures/portal-ui.cjs --dag` for representative local graph data.
