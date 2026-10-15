"use strict";
const { randomUUID } = require("node:crypto");

function collaborationStore(db, { fail, text, exact, canonical, digest }) {
  if (db.prepare("PRAGMA user_version").get().user_version === 1) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE node_follows(center_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(center_id,task_id,agent_id));
    CREATE TABLE node_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      center_id TEXT NOT NULL, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
      target TEXT, created_at TEXT NOT NULL, dedupe TEXT NOT NULL,
      UNIQUE(center_id,author,dedupe));
    CREATE INDEX node_messages_task ON node_messages(center_id,task_id,seq);
    CREATE TABLE node_receipts(message_id TEXT NOT NULL REFERENCES node_messages(id), agent_id TEXT NOT NULL,
      pulled_at TEXT, read_at TEXT, PRIMARY KEY(message_id,agent_id));
    CREATE INDEX node_receipts_agent ON node_receipts(agent_id,message_id);
    CREATE TABLE task_publications(id TEXT PRIMARY KEY, center_id TEXT NOT NULL, author TEXT NOT NULL,
      publisher_agent TEXT NOT NULL, brief TEXT NOT NULL, brief_sha256 TEXT NOT NULL,
      task_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, published_at REAL, revision TEXT, error TEXT,
      dedupe TEXT NOT NULL, UNIQUE(center_id,author,dedupe));
    PRAGMA user_version=2; COMMIT;`);
  const now = () => new Date().toISOString();
  const tx = work => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const audit = (actor, action, subject, detail) => db.prepare("INSERT INTO audit(actor,action,subject,detail,created_at) VALUES(?,?,?,?,?)")
    .run(actor, action, subject, canonical(detail), now());
  const id = value => {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) fail(400, "节点或身份标识无效");
    return value;
  };
  const page = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail(400, "消息游标无效");
    return value;
  };
  const followers = (center, task) => db.prepare("SELECT agent_id AS agentId FROM node_follows WHERE center_id=? AND task_id=? ORDER BY agent_id").all(center, task).map(x => x.agentId);
  const follow = (center, task, agent, enabled) => {
    id(center); id(task); id(agent);
    if (typeof enabled !== "boolean") fail(400, "关注状态无效");
    if (enabled) db.prepare("INSERT OR IGNORE INTO node_follows VALUES(?,?,?,?)").run(center, task, agent, now());
    else db.prepare("DELETE FROM node_follows WHERE center_id=? AND task_id=? AND agent_id=?").run(center, task, agent);
  };
  const message = row => ({ id: row.id, sequence: row.seq, centerId: row.center_id, taskId: row.task_id,
    author: row.author, body: row.body, target: row.target, createdAt: row.created_at,
    receipts: db.prepare("SELECT agent_id AS agentId,pulled_at AS pulledAt,read_at AS readAt FROM node_receipts WHERE message_id=? ORDER BY agent_id").all(row.id) });
  const publication = row => row ? ({ id: row.id, centerId: row.center_id, author: row.author,
    workflowId: row.workflow_id || null, publisherAgent: row.publisher_agent, brief: JSON.parse(row.brief), briefSha256: row.brief_sha256,
    taskId: row.task_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    publishedAt: row.published_at, revision: row.revision, error: row.error }) : fail(404, "发布记录不存在");
  const getPublication = (center, publicationId) => publication(db.prepare("SELECT * FROM task_publications WHERE center_id=? AND id=?").get(center, publicationId));
  function validateBrief(input) {
    exact(input, ["title", "goal", "context", "acceptance", "baseline", "requiredTier", "dependencies", "group"]);
    if (!["lite", "pro", "max"].includes(input.requiredTier)) fail(400, "最低模型层级无效");
    if (!Array.isArray(input.dependencies) || input.dependencies.length > 30 || new Set(input.dependencies).size !== input.dependencies.length) fail(400, "前置任务须为不重复的 0–30 项");
    const brief = { title: text(input.title, "标题", 160), goal: text(input.goal, "目标与范围", 4000),
      context: text(input.context, "必要上下文", 8000), acceptance: text(input.acceptance, "验收", 4000),
      baseline: text(input.baseline, "基线或版本引用", 300), requiredTier: input.requiredTier,
      dependencies: input.dependencies.map(id), group: input.group === null ? null : text(input.group, "所属需求", 160) };
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s"\\]+@/.test(canonical(brief))) fail(400, "资料链接不能包含账号或密码；请使用授权访问地址");
    return brief;
  }
  return {
    validateBrief, getPublication,
    retryPublication(center, publicationId, publisherAgent) {
      return tx(() => {
        const old = getPublication(center, publicationId);
        if (old.workflowId) fail(409, "流程中的任务必须整批处理");
        if (old.publisherAgent !== publisherAgent) fail(403, "只能重试自己关联 agent 发布的任务");
        if (old.state !== "failed") fail(409, "只有明确失败的任务可重试；处理中请先刷新状态");
        db.prepare("UPDATE task_publications SET state='queued',updated_at=?,error=NULL WHERE id=? AND center_id=?").run(now(), publicationId, center);
        audit(`agent:${publisherAgent}`, "node.publication.retry", `${center}/${old.taskId}`, {});
        return getPublication(center, publicationId);
      });
    },
    thread(center, task, after = 0) {
      id(center); id(task); page(after);
      const messages = db.prepare("SELECT * FROM node_messages WHERE center_id=? AND task_id=? AND seq>? ORDER BY seq LIMIT 100").all(center, task, after).map(message);
      return { followers: followers(center, task), messages, nextCursor: messages.at(-1)?.sequence ?? after };
    },
    follow(center, task, agent, enabled) {
      return tx(() => { follow(center, task, agent, enabled); audit(`agent:${agent}`, "node.follow", `${center}/${task}`, { enabled }); return { followers: followers(center, task) }; });
    },
    send(center, task, author, input, owner, eligibleAgents) {
      id(center); id(task); exact(input, ["body", "target", "idempotencyKey"]);
      const body = text(input.body, "消息正文", 4000), key = text(input.idempotencyKey, "幂等键", 100);
      const target = input.target === null ? null : id(input.target);
      if (target && !eligibleAgents.includes(target)) fail(400, "指定 agent 未注册到当前中心");
      return tx(() => {
        const old = db.prepare("SELECT * FROM node_messages WHERE center_id=? AND author=? AND dedupe=?").get(center, author, key);
        if (old) {
          if (old.task_id !== task || old.body !== body || old.target !== target) fail(409, "重复消息键对应不同内容");
          return message(old);
        }
        const recipients = [...new Set([...followers(center, task), ...(target ? [target] : []), ...(owner ? [owner] : [])])];
        if (!recipients.length) fail(409, "节点没有执行者或关注者，请指定接收 agent");
        const messageId = randomUUID();
        db.prepare("INSERT INTO node_messages(id,center_id,task_id,author,body,target,created_at,dedupe) VALUES(?,?,?,?,?,?,?,?)").run(messageId, center, task, author, body, target, now(), key);
        for (const recipient of recipients) db.prepare("INSERT INTO node_receipts VALUES(?,?,NULL,NULL)").run(messageId, recipient);
        audit(author, "node.message", `${center}/${task}`, { messageId, recipients });
        return message(db.prepare("SELECT * FROM node_messages WHERE id=?").get(messageId));
      });
    },
    inbox(center, agent, after = 0, unreadOnly = false) {
      id(center); id(agent); page(after);
      const messages = db.prepare(`SELECT m.* FROM node_messages m JOIN node_receipts r ON r.message_id=m.id
        WHERE m.center_id=? AND r.agent_id=? AND m.seq>? ${unreadOnly ? "AND r.read_at IS NULL" : ""} ORDER BY m.seq LIMIT 100`).all(center, agent, after).map(message);
      const unread = db.prepare(`SELECT count(*) AS n FROM node_receipts r JOIN node_messages m ON m.id=r.message_id
        WHERE m.center_id=? AND r.agent_id=? AND r.read_at IS NULL`).get(center, agent).n;
      return { messages, unread, nextCursor: messages.at(-1)?.sequence ?? after };
    },
    receipt(center, agent, input) {
      exact(input, ["messageIds", "state"]);
      if (!Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > 100 || !["pulled", "read"].includes(input.state)) fail(400, "消息回执无效");
      return tx(() => {
        for (const messageId of input.messageIds) {
          const row = db.prepare(`SELECT r.* FROM node_receipts r JOIN node_messages m ON m.id=r.message_id
            WHERE m.center_id=? AND r.agent_id=? AND r.message_id=?`).get(center, agent, text(messageId, "消息 ID", 36));
          if (!row) fail(404, "消息不属于当前 agent 或中心");
          const at = now();
          db.prepare("UPDATE node_receipts SET pulled_at=COALESCE(pulled_at,?),read_at=COALESCE(read_at,?) WHERE message_id=? AND agent_id=?")
            .run(at, input.state === "read" ? at : null, messageId, agent);
        }
        return { acknowledged: input.messageIds.length, state: input.state };
      });
    },
    createPublication(center, author, publisherAgent, input) {
      id(center); id(publisherAgent); exact(input, ["brief", "idempotencyKey"]);
      const brief = validateBrief(input.brief), encoded = canonical(brief), key = text(input.idempotencyKey, "幂等键", 100);
      return tx(() => {
        const old = db.prepare("SELECT * FROM task_publications WHERE center_id=? AND author=? AND dedupe=?").get(center, author, key);
        if (old) {
          if (old.brief !== encoded || old.publisher_agent !== publisherAgent) fail(409, "重复发布键对应不同任务");
          return publication(old);
        }
        const publicationId = randomUUID(), at = now(), task = `portal-task-${publicationId}`;
        db.prepare("INSERT INTO task_publications(id,center_id,author,publisher_agent,brief,brief_sha256,task_id,state,created_at,updated_at,published_at,revision,error,dedupe) VALUES(?,?,?,?,?,?,?,'queued',?,?,NULL,NULL,NULL,?)")
          .run(publicationId, center, author, publisherAgent, encoded, digest(brief), task, at, at, key);
        follow(center, task, publisherAgent, true);
        audit(author, "node.publication.queued", `${center}/${task}`, { publicationId, briefSha256: digest(brief) });
        return getPublication(center, publicationId);
      });
    },
    publications(center, pendingOnly = false) {
      return db.prepare(`SELECT * FROM task_publications WHERE center_id=? ${pendingOnly ? "AND workflow_id IS NULL AND state IN ('queued','publishing')" : ""} ORDER BY created_at ${pendingOnly ? "ASC" : "DESC"} LIMIT 100`).all(center).map(publication);
    },
    updatePublication(center, publicationId, input, verified = null) {
      exact(input, ["state", "error"]);
      if (!["publishing", "published", "failed"].includes(input.state)) fail(400, "发布状态无效");
      const error = input.state === "failed" ? text(input.error, "发布错误", 4000) : null;
      return tx(() => {
        const old = getPublication(center, publicationId);
        if (old.workflowId) fail(409, "流程中的任务必须整批处理");
        if (old.state === "published") {
          if (input.state !== "published") fail(409, "已发布合同不可覆盖");
          return old;
        }
        if (input.state === "published" && !verified) fail(409, "缺少原生发布读回");
        db.prepare("UPDATE task_publications SET state=?,updated_at=?,published_at=?,revision=?,error=? WHERE id=? AND center_id=?")
          .run(input.state, now(), verified?.publishedAt ?? null, verified?.revision ?? null, error, publicationId, center);
        audit("publisher", `node.publication.${input.state}`, `${center}/${old.taskId}`, { error, verified });
        return getPublication(center, publicationId);
      });
    },
  };
}
module.exports = { collaborationStore };
