"use strict";
const { randomUUID } = require("node:crypto");

// Bounds a looping or misled delegated agent; owners can still confirm more by hand.
const DELEGATED_DAILY_LIMIT = 10;

// Discussion stays in requests/messages; confirmed work uses the existing publication outbox.
function workflowStore(db, { fail, text, exact, canonical, digest }, collaboration) {
  if (db.prepare("PRAGMA user_version").get().user_version === 2) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE requests ADD COLUMN center_id TEXT;
    ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE task_publications ADD COLUMN workflow_id TEXT REFERENCES requests(id);
    CREATE INDEX requests_workflow ON requests(center_id,kind,updated_at);
    CREATE INDEX publications_workflow ON task_publications(workflow_id);
    PRAGMA user_version=3; COMMIT;`);
  if (db.prepare("PRAGMA user_version").get().user_version === 3) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE workflow_delegates(center_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(center_id,agent_id));
    PRAGMA user_version=4; COMMIT;`);
  const now = () => new Date().toISOString();
  const tx = work => { db.exec("BEGIN IMMEDIATE"); try { const result = work(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const audit = (actor, action, id, value) => db.prepare("INSERT INTO audit(actor,action,subject,detail,created_at) VALUES(?,?,?,?,?)").run(actor, action, id, canonical(value), now());
  const localId = value => { if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail(400, "阶段和任务标识须使用小写字母、数字和连字符"); return value; };
  function taskBrief(plan, task, dependencies) {
    const stage = plan.stages.find(s => s.id === task.stage);
    try { return collaboration.validateBrief({ title: task.title, goal: task.goal,
      context: `整体目标：${plan.goal}\n当前阶段：${stage.title}。${stage.goal}\n${stage.existing ? `已有成果：${stage.existing}\n` : ""}\n${task.context}`,
      acceptance: task.acceptance, baseline: task.baseline, requiredTier: task.requiredTier, dependencies, group: plan.title }); }
    catch (error) { if (error.status === 400) fail(400, `任务“${task.title}”：${error.message}。请缩短整体目标、阶段说明或任务上下文。`); throw error; }
  }
  function validatePlan(input) {
    exact(input, ["title", "goal", "stages", "tasks"]);
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s"\\]+@/.test(canonical(input))) fail(400, "资料链接不能包含账号或密码");
    if (Buffer.byteLength(canonical(input)) > 80000) fail(400, "方案过大，请分成可独立交付的目标");
    const title = text(input.title, "流程名称", 160), goal = text(input.goal, "最终目标", 4000);
    if (!Array.isArray(input.stages) || !input.stages.length || input.stages.length > 12) fail(400, "请划分 1–12 个有明确产物的阶段");
    const stages = input.stages.map(s => { exact(s, ["id", "title", "goal", "existing"]); return { id: localId(s.id), title: text(s.title, "阶段名称", 160), goal: text(s.goal, "阶段要交付什么", 2000), existing: s.existing === "" || s.existing === undefined ? "" : text(s.existing, "已有成果", 4000) }; });
    if (new Set(stages.map(s => s.id)).size !== stages.length) fail(400, "阶段标识重复");
    if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 30) fail(400, "方案需要 1–30 项具体任务");
    const tasks = input.tasks.map(t => {
      exact(t, ["id", "stage", "title", "goal", "context", "acceptance", "baseline", "requiredTier", "dependencies"]);
      if (!stages.some(s => s.id === t.stage)) fail(400, "任务所属阶段不存在");
      if (!Array.isArray(t.dependencies) || t.dependencies.length > 30 || new Set(t.dependencies).size !== t.dependencies.length) fail(400, "任务前置无效");
      const dependencies = t.dependencies.map(d => {
        if (typeof d !== "string" || !/^@?[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(d)) fail(400, "前置标识无效；方案内任务请用 @任务标识");
        return d;
      });
      const brief = collaboration.validateBrief({ title: t.title, goal: t.goal, context: t.context, acceptance: t.acceptance, baseline: t.baseline, requiredTier: t.requiredTier, dependencies: dependencies.filter(d => !d.startsWith("@")), group: title });
      return { id: localId(t.id), stage: t.stage, ...Object.fromEntries(Object.entries(brief).filter(([k]) => !["group", "dependencies"].includes(k))), dependencies };
    });
    if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail(400, "任务标识重复");
    const pending = new Map(tasks.map(t => [t.id, t])), sorted = [];
    for (const t of tasks) for (const d of t.dependencies.filter(d => d.startsWith("@"))) if (!pending.has(d.slice(1))) fail(400, "方案内的前置任务不存在");
    while (pending.size) {
      const ready = [...pending.values()].filter(t => t.dependencies.every(d => !d.startsWith("@") || !pending.has(d.slice(1))));
      if (!ready.length) fail(400, "任务依赖形成了循环，请检查哪些产物真正需要先完成");
      for (const t of ready) { sorted.push(t); pending.delete(t.id); }
    }
    const plan = { title, goal, stages, tasks: sorted };
    const compiled = sorted.map(t => taskBrief(plan, t, t.dependencies.map((d, i) => d.startsWith("@") ? `portal-task-${String(i).padStart(36, "0")}` : d)));
    if (compiled.reduce((n, brief) => n + Buffer.byteLength(canonical(brief)) + 1500, 0) > 110000) fail(400, "方案输入总量过大，请减少任务数或精简重复背景");
    return plan;
  }
  const view = row => {
    if (!row) fail(404, "当前项目没有这份拆解");
    return { id: row.id, centerId: row.center_id, author: row.author, description: row.description, state: row.state, version: row.version, plan: row.proposal ? JSON.parse(row.proposal) : null,
      dispatch: row.dispatch ? JSON.parse(row.dispatch) : null, updatedAt: row.updated_at,
      messages: db.prepare("SELECT author,body,created_at AS createdAt FROM messages WHERE request_id=? ORDER BY id").all(row.id) };
  };
  const get = (center, id) => view(db.prepare("SELECT * FROM requests WHERE id=? AND center_id=? AND kind='workflow'").get(id, center));
  const version = (r, n) => { if (!Number.isSafeInteger(n) || n !== r.version) fail(409, "拆解已更新，请先读取最新版本再操作"); };
  const editable = r => { if (["dispatching", "published"].includes(r.state)) fail(409, "这份方案已确认发布，修改请另建后续需求"); };
  // Agent-authored goals have no human author; the route says which users manage that agent.
  const owner = (r, actor, manages) => {
    if (actor.startsWith("user:") && (r.author === actor || r.author.startsWith("agent:") && manages?.(r.author.slice(6)) === true)) return;
    fail(403, r.author.startsWith("agent:") ? "agent 发起的目标由项目所有者或该 agent 的负责人调整和确认" : "只有提出需求的用户可以调整或确认方案");
  };
  const grant = (center, actor) => db.prepare("SELECT granted_by AS grantedBy, granted_at AS grantedAt FROM workflow_delegates WHERE center_id=? AND agent_id=?").get(center, actor.slice(6));
  // A delegated agent replaces the human click only for goals that agents started.
  const approver = (center, r, actor, manages) => {
    if (!actor.startsWith("agent:")) { owner(r, actor, manages); return null; }
    const found = grant(center, actor);
    if (!found) fail(403, "这个 agent 尚未获授权确认目标，请项目所有者在网页授权");
    if (!r.author.startsWith("agent:")) fail(403, "用户提出的目标须由本人确认");
    return found.grantedBy;
  };
  function batch(center, id) { get(center, id); return db.prepare("SELECT id FROM task_publications WHERE center_id=? AND workflow_id=? ORDER BY rowid").all(center, id).map(p => collaboration.getPublication(center, p.id)); }
  return {
    get, validatePlan, batch,
    list(center, pending = false, cursor = null) {
      let after = null;
      if (cursor !== null) {
        try { if (typeof cursor !== "string" || cursor.length > 160) throw new Error(); after = JSON.parse(Buffer.from(cursor, "base64url").toString()); if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== "string" || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(after[0]) || !/^[a-f0-9-]{36}$/.test(after[1])) throw new Error(); }
        catch { fail(400, "拆解列表游标无效"); }
      }
      const rows = db.prepare(`SELECT * FROM requests WHERE center_id=? AND kind='workflow' ${pending ? "AND state IN ('received','clarification','planned')" : ""} ${after ? "AND (updated_at,id)<(?,?)" : ""} ORDER BY updated_at DESC,id DESC LIMIT 201`).all(center, ...(after || []));
      const shown = rows.slice(0, 200), last = shown.at(-1);
      return { workflows: shown.map(view), nextCursor: rows.length > 200 ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString("base64url") : null };
    },
    create(center, actor, input) {
      exact(input, ["description", "idempotencyKey"]);
      if (!/^(user|agent):/.test(actor)) fail(403, "目标需要已登录成员或已注册 agent 提出");
      const description = text(input.description, "想完成什么", 12000), key = text(input.idempotencyKey, "提交标识", 100);
      return tx(() => {
        const old = db.prepare("SELECT * FROM requests WHERE author=? AND dedupe=?").get(actor, `${center}:${key}`);
        if (old) { if (old.center_id !== center || old.description !== description) fail(409, "提交标识对应另一份需求"); return view(old); }
        const id = randomUUID(), at = now();
        db.prepare("INSERT INTO requests(id,author,description,state,version,created_at,updated_at,dedupe,center_id,kind) VALUES(?,?,?,'received',1,?,?,?,?,'workflow')").run(id, actor, description, at, at, `${center}:${key}`, center);
        audit(actor, "workflow.created", id, { center }); return get(center, id);
      });
    },
    update(center, id, actor, isAgent, input, manages) {
      exact(input, ["version", "action", "body", "plan"]);
      if (!["reply", "question", "plan", "edit"].includes(input.action)) fail(400, "拆解操作无效");
      if (isAgent !== ["question", "plan"].includes(input.action)) fail(403, "agent 负责提问和提案，用户负责调整与确认");
      const plan = ["plan", "edit"].includes(input.action) ? validatePlan(input.plan) : null;
      const body = ["reply", "question"].includes(input.action) ? text(input.body, "讨论内容", 12000) : null;
      return tx(() => {
        const r = get(center, id); version(r, input.version); editable(r); if (!isAgent) owner(r, actor, manages);
        if (body) db.prepare("INSERT INTO messages(request_id,author,body,created_at) VALUES(?,?,?,?)").run(id, actor, body, now());
        const state = plan ? "planned" : input.action === "question" ? "clarification" : "received";
        db.prepare("UPDATE requests SET state=?,proposal=?,version=version+1,updated_at=? WHERE id=?").run(state, plan ? canonical(plan) : r.plan ? canonical(r.plan) : null, now(), id);
        audit(actor, `workflow.${input.action}`, id, { version: input.version }); return get(center, id);
      });
    },
    confirm(center, id, actor, publisherAgent, input, manages) {
      exact(input, ["version"]);
      return tx(() => {
        const r = get(center, id), delegatedBy = approver(center, r, actor, manages);
        if (["dispatching", "published"].includes(r.state) && r.dispatch.confirmedVersion === input.version) return r;
        version(r, input.version); if (r.state !== "planned" || !r.plan) fail(409, "请先与 agent 完成拆解并保存方案");
        if (delegatedBy) {
          const since = new Date(Date.now() - 86400000).toISOString();
          const used = db.prepare("SELECT count(*) AS n FROM requests WHERE center_id=? AND kind='workflow' AND json_extract(dispatch,'$.confirmedBy')=? AND json_extract(dispatch,'$.confirmedAt')>?").get(center, actor, since).n;
          if (used >= DELEGATED_DAILY_LIMIT) fail(429, `每个 agent 24 小时内最多按授权确认 ${DELEGATED_DAILY_LIMIT} 份目标；请稍后再试，或由项目所有者在网页确认`);
        }
        const plan = validatePlan(r.plan);
        if (plan.stages.some(s => !s.existing && !plan.tasks.some(t => t.stage === s.id))) fail(409, "有阶段既没有具体任务，也没有已有成果，请先补齐拆解");
        const taskIds = Object.fromEntries(plan.tasks.map(t => [t.id, `portal-task-${randomUUID()}`]));
        const dispatch = { confirmedVersion: r.version, confirmedBy: actor, confirmedAt: now(), ...(delegatedBy ? { delegatedBy } : {}), publisherAgent, taskIds: Object.values(taskIds), tasks: taskIds };
        for (const t of plan.tasks) {
          const taskId = taskIds[t.id], publicationId = taskId.slice(12), at = now();
          const brief = taskBrief(plan, t, t.dependencies.map(d => d.startsWith("@") ? taskIds[d.slice(1)] : d));
          db.prepare("INSERT INTO task_publications(id,center_id,author,publisher_agent,brief,brief_sha256,task_id,state,created_at,updated_at,dedupe,workflow_id) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)").run(publicationId, center, actor, publisherAgent, canonical(brief), digest(brief), taskId, at, at, `workflow:${id}:${t.id}`, id);
          db.prepare("INSERT OR IGNORE INTO node_follows VALUES(?,?,?,?)").run(center, taskId, publisherAgent, at);
        }
        if (Buffer.byteLength(canonical(batch(center, id))) > 110000) fail(400, "任务输入总量过大，请拆成较小的交付目标");
        db.prepare("UPDATE requests SET state='dispatching',dispatch=?,version=version+1,updated_at=? WHERE id=?").run(canonical(dispatch), now(), id);
        audit(actor, "workflow.confirmed", id, dispatch); return get(center, id);
      });
    },
    updateBatch(center, id, input, verified = null) {
      exact(input, ["state", "error"]);
      if (!["publishing", "published", "failed"].includes(input.state)) fail(400, "发布状态无效");
      const error = input.state === "failed" ? text(input.error, "发布错误", 4000) : null;
      return tx(() => {
        const r = get(center, id), items = batch(center, id);
        if (!r.dispatch || !items.length) fail(409, "方案尚未确认");
        if (r.state === "published") { if (input.state !== "published") fail(409, "已发布方案不可回退"); return r; }
        if (input.state === "published" && (!verified || items.some(p => !verified[p.id]))) fail(409, "缺少整批原生任务的读回");
        for (const p of items) db.prepare("UPDATE task_publications SET state=?,updated_at=?,error=?,published_at=?,revision=? WHERE id=?").run(input.state, now(), error, verified?.[p.id]?.publishedAt ?? null, verified?.[p.id]?.revision ?? null, p.id);
        if (input.state === "published") db.prepare("UPDATE requests SET state='published',updated_at=? WHERE id=?").run(now(), id);
        audit("publisher", `workflow.${input.state}`, id, { error }); return get(center, id);
      });
    },
    retry(center, id, actor, manages) {
      return tx(() => {
        const r = get(center, id);
        if (!actor.startsWith("agent:")) owner(r, actor, manages);
        else if (!grant(center, actor) || r.dispatch?.confirmedBy !== actor) fail(403, "只有按授权确认此目标、且仍有授权的 agent 可以重试发布");
        const items = batch(center, id); if (!items.length || items.some(p => p.state !== "failed")) fail(409, "只能重试整批明确失败的发布"); db.prepare("UPDATE task_publications SET state='queued',error=NULL,updated_at=? WHERE workflow_id=?").run(now(), id); audit(actor, "workflow.retry", id, {}); return r; });
    },
    delegate: (center, agentId) => grant(center, `agent:${agentId}`) ?? null,
    delegates(center) { return db.prepare("SELECT agent_id AS agentId, granted_by AS grantedBy, granted_at AS grantedAt FROM workflow_delegates WHERE center_id=? ORDER BY agent_id").all(center); },
    setDelegate(center, agentId, actor, input) {
      exact(input, ["enabled"]);
      if (typeof input.enabled !== "boolean") fail(400, "授权状态无效");
      return tx(() => {
        const old = grant(center, `agent:${agentId}`);
        if (input.enabled && !old) db.prepare("INSERT INTO workflow_delegates VALUES(?,?,?,?)").run(center, agentId, actor, now());
        if (!input.enabled && old) db.prepare("DELETE FROM workflow_delegates WHERE center_id=? AND agent_id=?").run(center, agentId);
        if (Boolean(old) !== input.enabled) audit(actor, input.enabled ? "workflow.delegate.granted" : "workflow.delegate.revoked", `${center}/${agentId}`, {});
        return { agentId, delegate: grant(center, `agent:${agentId}`) ?? null };
      });
    },
    groups(center) {
      return db.prepare("SELECT id,proposal,dispatch FROM requests WHERE center_id=? AND kind='workflow' AND dispatch IS NOT NULL ORDER BY id").all(center).map(row => {
        const plan = JSON.parse(row.proposal), dispatch = JSON.parse(row.dispatch);
        return { id: row.id, proposal: { title: plan.title, goal: plan.goal, stages: plan.stages, tasks: plan.tasks.map(({ id, stage }) => ({ id, stage })) }, dispatch: { tasks: dispatch.tasks, taskIds: dispatch.taskIds } };
      });
    },
    queue(center) { const ids = db.prepare("SELECT DISTINCT workflow_id FROM task_publications WHERE center_id=? AND workflow_id IS NOT NULL AND state IN ('queued','publishing')").all(center); return ids.map(r => ({ id: r.workflow_id, publications: batch(center, r.workflow_id) })); },
  };
}
module.exports = { workflowStore, DELEGATED_DAILY_LIMIT };
