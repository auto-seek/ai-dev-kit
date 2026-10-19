"use strict";
const { DatabaseSync } = require("node:sqlite");
const { randomUUID, createHash } = require("node:crypto");
const { redact } = require("../cascade-process.cjs");
const { workflowStore } = require("./workflow-store.cjs");
const { collaborationStore } = require("./collaboration-store.cjs");

class PortalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PortalError(status, message); };
const text = (value, name, max = 20000) => {
  if (typeof value !== "string" || !value.isWellFormed() || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, `${name} 无效`);
  return value.trim();
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
// An agent reports its own harness. It is display-only and never an authorization input.
const HARNESS = /^[a-z][a-z0-9-]{1,31}$/;
const HARNESS_LABELS = { codex: "Codex", claude: "Claude", antigravity: "Antigravity", gemini: "Gemini", cursor: "Cursor", opencode: "OpenCode" };
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(400, "请求字段无效");
}
function list(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > 30) fail(400, `${name} 需要 1–30 项`);
  return value.map(item => text(item, name, 2000));
}
function validateProposal(value) {
  exact(value, ["title", "goal", "scope", "nonGoals", "acceptance", "requiredTier", "baseSha", "dependencies"]);
  if (redact(canonical(value)) !== canonical(value)) fail(400, "提案不能包含带用户名或密码的 URI；请使用无凭据的示例地址");
  if (!["lite", "pro", "max"].includes(value.requiredTier)) fail(400, "必须评估任务难度层级");
  if (typeof value.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(value.baseSha)) fail(400, "需要完整批准基线 SHA");
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 30 || value.dependencies.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) || new Set(value.dependencies).size !== value.dependencies.length) fail(400, "前置任务无效");
  return { title: text(value.title, "标题", 160), goal: text(value.goal, "目标"),
    scope: list(value.scope, "范围"), nonGoals: list(value.nonGoals, "非目标"), acceptance: list(value.acceptance, "验收"),
    requiredTier: value.requiredTier, baseSha: value.baseSha, dependencies: value.dependencies };
}
function dispatchContract(request) {
  if (!["planned", "dispatching"].includes(request.state) || !request.proposal) fail(409, "需求尚无可派发的完整提案");
  return { requestId: request.id, proposalVersion: request.version, proposalSha256: digest(request.proposal), proposal: request.proposal };
}

function createStore(filename) {
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (![0, 1, 2, 3, 4, 5].includes(version)) { db.close(); throw new Error("Unsupported portal database version"); }
  if (!version) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE requests (id TEXT PRIMARY KEY, author TEXT NOT NULL, description TEXT NOT NULL,
      state TEXT NOT NULL, version INTEGER NOT NULL, proposal TEXT, dispatch TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dedupe TEXT NOT NULL,
      UNIQUE(author, dedupe));
    CREATE TABLE messages (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE candidates (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, sha TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, manifest_sha256 TEXT,
      UNIQUE(task_id, sha));
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
      name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(candidate_id, name));
    CREATE TABLE reviews (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
      author TEXT NOT NULL, verdict TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      processed_at TEXT, response TEXT, dedupe TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, UNIQUE(author, dedupe));
    CREATE TABLE audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
      subject TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE processor (id INTEGER PRIMARY KEY CHECK(id=1), checked_at TEXT NOT NULL);
    PRAGMA user_version=1; COMMIT;`);
  const now = () => new Date().toISOString();
  const audit = (actor, action, subject, detail) => db.prepare("INSERT INTO audit(actor,action,subject,detail,created_at) VALUES(?,?,?,?,?)").run(actor, action, subject, canonical(detail), now());
  const tx = work => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const requestView = row => row ? { id: row.id, author: row.author, description: row.description, state: row.state,
    version: row.version, proposal: row.proposal ? JSON.parse(row.proposal) : null, dispatch: row.dispatch ? JSON.parse(row.dispatch) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    messages: db.prepare("SELECT author,body,created_at AS createdAt FROM messages WHERE request_id=? ORDER BY id").all(row.id) } : fail(404, "需求不存在");
  const getRequest = id => requestView(db.prepare("SELECT * FROM requests WHERE id=? AND kind='legacy'").get(id));
  const checkVersion = (request, version) => { if (!Number.isSafeInteger(version) || request.version !== version) fail(409, "需求已更新，请重新读取后再操作"); };
  const getCandidate = id => {
    const row = db.prepare("SELECT id,task_id AS taskId,sha,title,summary,author,created_at AS createdAt,manifest_sha256 AS manifestSha256 FROM candidates WHERE id=?").get(id);
    if (!row) fail(404, "候选版本不存在");
    return { ...row, artifacts: db.prepare("SELECT id,name,mime,bytes,sha256 FROM artifacts WHERE candidate_id=? ORDER BY created_at,id").all(id),
      reviews: db.prepare("SELECT id,author,verdict,body,created_at AS createdAt,processed_at AS processedAt,response,manifest_sha256 AS manifestSha256 FROM reviews WHERE candidate_id=? ORDER BY created_at,id").all(id) };
  };
  const collaboration = collaborationStore(db, { fail, text, exact, canonical, digest });
  const workflows = workflowStore(db, { fail, text, exact, canonical, digest }, collaboration);
  if (db.prepare("PRAGMA user_version").get().user_version === 4) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE agent_reports(agent_id TEXT PRIMARY KEY, harness TEXT NOT NULL, reported_at TEXT NOT NULL);
    PRAGMA user_version=5; COMMIT;`);
  const agents = {
    report(agentId, input) {
      exact(input, ["harness"]);
      if (typeof input.harness !== "string" || !HARNESS.test(input.harness)) fail(400, "harness 须为小写名称，例如 codex、claude 或 antigravity");
      db.prepare("INSERT INTO agent_reports VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET harness=excluded.harness,reported_at=excluded.reported_at").run(agentId, input.harness, now());
      return { harness: input.harness };
    },
    // Adds the self-reported harness beside the registry's owner; agents that never reported keep null.
    describe(list) {
      const reports = new Map(db.prepare("SELECT agent_id,harness FROM agent_reports").all().map(r => [r.agent_id, r.harness]));
      return list.map(a => {
        const harness = reports.get(a.id);
        return { id: a.id, tier: a.tier, owner: a.owner ?? null, harness: harness ? { id: harness, label: HARNESS_LABELS[harness] ?? harness } : null };
      });
    },
  };
  return {
    collaboration, workflows, agents,
    close() { db.close(); },
    getRequest, getCandidate,
    taskGroups() {
      return db.prepare("SELECT id,proposal,dispatch FROM requests WHERE kind='legacy' AND state='published' AND dispatch IS NOT NULL ORDER BY id").all().map(row => ({ id: row.id, proposal: { title: JSON.parse(row.proposal).title }, dispatch: { taskIds: JSON.parse(row.dispatch).taskIds } }));
    },
    overview() {
      return { requests: db.prepare("SELECT * FROM requests WHERE kind='legacy' ORDER BY updated_at DESC LIMIT 200").all().map(requestView),
        candidates: db.prepare("SELECT id FROM candidates ORDER BY created_at DESC LIMIT 100").all().map(row => getCandidate(row.id)),
        processorCheckedAt: db.prepare("SELECT checked_at FROM processor WHERE id=1").get()?.checked_at ?? null };
    },
    createRequest(actor, input) {
      exact(input, ["description", "idempotencyKey"]);
      const description = text(input.description, "需求描述"), key = text(input.idempotencyKey, "幂等键", 100);
      return tx(() => {
        const old = db.prepare("SELECT * FROM requests WHERE author=? AND dedupe=?").get(actor, key);
        if (old) { if (old.description !== description) fail(409, "重复提交键对应其他内容"); return requestView(old); }
        const id = randomUUID(), at = now();
        db.prepare("INSERT INTO requests(id,author,description,state,version,proposal,dispatch,created_at,updated_at,dedupe) VALUES(?,?,?,'received',1,NULL,NULL,?,?,?)").run(id, actor, description, at, at, key);
        audit(actor, "request.created", id, { description });
        return getRequest(id);
      });
    },
    reply(actor, id, input) {
      exact(input, ["version", "body"]);
      const body = text(input.body, "补充说明");
      return tx(() => {
        const request = getRequest(id); checkVersion(request, input.version);
        if (request.author !== actor) fail(403, "只能补充自己提交的需求");
        if (["dispatching", "published", "rejected"].includes(request.state)) fail(409, "派单中的合同已冻结；请另建变更请求");
        db.prepare("INSERT INTO messages(request_id,author,body,created_at) VALUES(?,?,?,?)").run(id, actor, body, now());
        db.prepare("UPDATE requests SET state='received',version=version+1,proposal=NULL,updated_at=? WHERE id=?").run(now(), id);
        audit(actor, "request.replied", id, { body });
        return getRequest(id);
      });
    },
    updateRequest(id, input, verifiedDispatch = null) {
      exact(input, ["version", "action", "body", "proposal"]);
      const proposal = input.action === "plan" ? validateProposal(input.proposal) : null;
      const body = ["question", "reject"].includes(input.action) ? text(input.body, "中心说明") : null;
      if (!["question", "plan", "reject", "prepare", "publish"].includes(input.action)) fail(400, "中心操作无效");
      return tx(() => {
        const request = getRequest(id); checkVersion(request, input.version);
        if (["published", "rejected"].includes(request.state)) fail(409, "需求已经派发或关闭");
        if (request.state === "dispatching" && input.action !== "publish") fail(409, "派单中的合同已冻结；核对正式图后完成读回");
        if (input.action === "prepare" && request.state !== "planned") fail(409, "只有完整提案可冻结派单");
        if (input.action === "publish" && (!verifiedDispatch || request.state !== "dispatching" ||
            verifiedDispatch.proposalVersion !== request.version || verifiedDispatch.proposalSha256 !== digest(request.proposal))) fail(409, "缺少精确合同的正式派单读回");
        const state = { question: "clarification", plan: "planned", reject: "rejected", prepare: "dispatching", publish: "published" }[input.action];
        if (body) db.prepare("INSERT INTO messages(request_id,author,body,created_at) VALUES(?,?,?,?)").run(id, "center", body, now());
        db.prepare("UPDATE requests SET state=?,version=version+1,proposal=?,dispatch=?,updated_at=? WHERE id=?")
          .run(state, proposal ? canonical(proposal) : request.proposal ? canonical(request.proposal) : null,
            verifiedDispatch ? canonical(verifiedDispatch) : null, now(), id);
        audit("center", `request.${input.action}`, id, { proposal, body, dispatch: verifiedDispatch });
        return getRequest(id);
      });
    },
    centerQueue() {
      db.prepare("INSERT INTO processor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at").run(now());
      return { requests: db.prepare("SELECT * FROM requests WHERE kind='legacy' AND state NOT IN ('published','rejected') ORDER BY updated_at LIMIT 200").all().map(requestView),
        reviews: db.prepare("SELECT r.id,r.candidate_id AS candidateId,c.task_id AS taskId,c.sha,r.author,r.verdict,r.body,r.created_at AS createdAt FROM reviews r JOIN candidates c ON c.id=r.candidate_id WHERE r.processed_at IS NULL ORDER BY r.created_at LIMIT 200").all() };
    },
    addCandidate(input) {
      exact(input, ["taskId", "sha", "title", "summary"]);
      if (typeof input.taskId !== "string" || typeof input.sha !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.taskId) || !/^[a-f0-9]{40}$/.test(input.sha)) fail(400, "任务或候选 SHA 无效");
      const title = text(input.title, "标题", 160), summary = text(input.summary, "候选说明");
      return tx(() => {
        const old = db.prepare("SELECT * FROM candidates WHERE task_id=? AND sha=?").get(input.taskId, input.sha);
        if (old) {
          if (old.title !== title || old.summary !== summary) fail(409, "已登记候选不可改写");
          return getCandidate(old.id);
        }
        const id = randomUUID();
        db.prepare("INSERT INTO candidates VALUES(?,?,?,?,?,'center',?,NULL)").run(id, input.taskId, input.sha, title, summary, now());
        audit("center", "candidate.registered", id, input);
        return getCandidate(id);
      });
    },
    addArtifact(candidateId, metadata) {
      return tx(() => {
        if (getCandidate(candidateId).manifestSha256) fail(409, "候选产物清单已封存，不能追加或替换");
        const existing = db.prepare("SELECT id FROM artifacts WHERE candidate_id=? AND name=?").get(candidateId, metadata.name);
        if (existing) fail(409, "该候选的同名产物已存在，不可覆盖");
        db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)").run(metadata.id, candidateId, metadata.name, metadata.mime, metadata.bytes, metadata.sha256, now());
        audit("center", "artifact.uploaded", metadata.id, { candidateId, ...metadata });
        return metadata;
      });
    },
    getArtifact(id) {
      const row = db.prepare("SELECT id,candidate_id AS candidateId,name,mime,bytes,sha256 FROM artifacts WHERE id=?").get(id);
      if (!row) fail(404, "产物不存在");
      return row;
    },
    artifactBytes() { return db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM artifacts").get().total; },
    listArtifacts() { return db.prepare("SELECT id,bytes,sha256 FROM artifacts ORDER BY id").all(); },
    sealCandidate(id, expectedManifest) {
      return tx(() => {
        const candidate = getCandidate(id);
        if (!candidate.artifacts.length || digest(candidate.artifacts) !== expectedManifest) fail(409, "产物清单为空或核验期间发生变化");
        if (candidate.manifestSha256) {
          if (candidate.manifestSha256 !== expectedManifest) fail(409, "已封存清单与当前记录不符");
          return candidate;
        }
        db.prepare("UPDATE candidates SET manifest_sha256=? WHERE id=?").run(expectedManifest, id);
        audit("center", "candidate.sealed", id, { sha: candidate.sha, manifestSha256: expectedManifest });
        return getCandidate(id);
      });
    },
    addReview(actor, id, input) {
      exact(input, ["verdict", "body", "idempotencyKey"]);
      if (!["accepted", "rework"].includes(input.verdict)) fail(400, "验收意见无效");
      const body = text(input.body, "验收说明"), key = text(input.idempotencyKey, "幂等键", 100);
      return tx(() => {
        const candidate = getCandidate(id);
        if (!candidate.manifestSha256) fail(409, "产物清单尚未核验封存，不能登记验收意见");
        const old = db.prepare("SELECT * FROM reviews WHERE author=? AND dedupe=?").get(actor, key);
        if (old) {
          if (old.candidate_id !== id || old.body !== body || old.verdict !== input.verdict) fail(409, "重复验收键对应其他内容");
          return getCandidate(id);
        }
        const reviewId = randomUUID();
        db.prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,NULL,NULL,?,?)").run(reviewId, id, actor, input.verdict, body, now(), key, candidate.manifestSha256);
        audit(actor, "candidate.reviewed", id, { reviewId, sha: candidate.sha, manifestSha256: candidate.manifestSha256, verdict: input.verdict, body });
        return getCandidate(id);
      });
    },
    processReview(id, input) {
      exact(input, ["response"]);
      const response = text(input.response, "处理说明");
      return tx(() => {
        const old = db.prepare("SELECT * FROM reviews WHERE id=?").get(id);
        if (!old) fail(404, "验收记录不存在");
        if (old.processed_at) { if (old.response !== response) fail(409, "该意见已处理"); return; }
        db.prepare("UPDATE reviews SET processed_at=?,response=? WHERE id=?").run(now(), response, id);
        audit("center", "review.processed", id, { response });
      });
    },
  };
}

module.exports = { createStore, PortalError, fail, text, exact, canonical, digest, validateProposal, dispatchContract, HARNESS };
