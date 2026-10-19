"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { fail, exact } = require("./store.cjs");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIER = new Set(["lite", "pro", "max"]);
const joinCode = () => `project_${randomBytes(24).toString("base64url")}`;
// Crockford base32 without I, L, O and U, so a code read aloud or retyped stays unambiguous.
const OWNER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OWNER_CODE_MS = 10 * 60 * 1000;

function publicKey(value) {
  if (
    typeof value !== "string" ||
    !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value)
  )
    fail(400, "需要规范的 ed25519 公钥");
  const bytes = Buffer.from(value.slice(12), "base64");
  if (
    bytes.length !== 51 ||
    bytes.readUInt32BE(0) !== 11 ||
    bytes.subarray(4, 15).toString() !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32 ||
    bytes.toString("base64") !== value.slice(12)
  )
    fail(400, "SSH 公钥编码无效");
  return value;
}

function createAdmission({
  filename,
  centers,
  projects,
  members = [],
  agents = [],
}) {
  if (!path.isAbsolute(filename || ""))
    throw new Error("An absolute admission database is required");
  if (!Array.isArray(projects) || !Array.isArray(members))
    throw new Error("Invalid project admission configuration");
  const catalog = new Map();
  for (const p of projects) {
    if (
      !p ||
      Object.keys(p).sort().join(",") !==
        "centerId,hostKey,namespace,remote,repository" ||
      !centers.has(p.centerId) ||
      catalog.has(p.centerId) ||
      [...catalog.values()].some((c) => c.repository === p.repository) ||
      !ID.test(p.namespace) ||
      !path.isAbsolute(p.repository) ||
      !/^\/[A-Za-z0-9/._-]+\.git$/.test(p.repository) ||
      p.repository.split("/").includes("..")
    )
      throw new Error("Invalid execution project mapping");
    let url;
    try {
      url = new URL(p.remote);
    } catch {
      throw new Error("Project needs an SSH Git remote");
    }
    if (
      url.protocol !== "ssh:" ||
      !url.username ||
      !/^[a-z][a-z0-9-]*$/.test(url.username) ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== p.repository ||
      url.hostname === "" ||
      /[\s\r\n]/.test(p.remote)
    )
      throw new Error(
        "Project SSH remote differs from its approved repository",
      );
    publicKey(p.hostKey);
    catalog.set(p.centerId, Object.freeze({ ...p }));
  }
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const dir = fs.lstatSync(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid() ||
    dir.mode & 0o027
  )
    throw new Error("Admission directory must be service-owned and restricted");
  const fd = fs.openSync(
    filename,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o640,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o027)
      throw new Error(
        "Admission database must be service-owned and restricted",
      );
    fs.fchmodSync(fd, 0o640);
  } finally {
    fs.closeSync(fd);
  }
  const db = new DatabaseSync(filename, { timeout: 1000 });
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
    );
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1].includes(version))
      throw new Error("Unsupported admission database version");
    if (!version)
      db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE projects(center TEXT PRIMARY KEY, join_code TEXT NOT NULL UNIQUE);
      CREATE TABLE members(center TEXT NOT NULL REFERENCES projects(center), username TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), tier TEXT NOT NULL CHECK(tier IN ('lite','pro','max')), PRIMARY KEY(center,username));
      CREATE TABLE agents(id TEXT PRIMARY KEY, owner TEXT, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('member','project')), tier TEXT NOT NULL CHECK(tier IN ('lite','pro','max')), token_hash TEXT NOT NULL UNIQUE, public_key TEXT UNIQUE, enrollment_key TEXT UNIQUE, enrollment_code_hash TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL);
      CREATE TABLE agent_projects(agent TEXT NOT NULL REFERENCES agents(id), center TEXT NOT NULL REFERENCES projects(center), PRIMARY KEY(agent,center));
      CREATE TABLE audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, at TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    for (const center of centers)
      db.prepare(
        "INSERT INTO projects VALUES(?,?) ON CONFLICT(center) DO NOTHING",
      ).run(center, joinCode());
    for (const m of members) {
      if (
        !m ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.username) ||
        !Array.isArray(m.centers) ||
        m.centers.some((c) => !centers.has(c)) ||
        !["owner", "member"].includes(m.role) ||
        !TIER.has(m.tier)
      )
        throw new Error("Invalid initial project member");
      for (const center of m.centers)
        db.prepare(
          "INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(center,username) DO NOTHING",
        ).run(center, m.username, m.role, m.tier);
    }
    for (const a of agents) {
      const old = db
        .prepare(
          "SELECT owner,owner_kind,tier,token_hash FROM agents WHERE id=?",
        )
        .get(a.id);
      if (
        old &&
        (old.owner !== a.owner ||
          old.owner_kind !== "member" ||
          old.tier !== a.tier ||
          old.token_hash !== hash(a.token))
      )
        throw new Error(
          "Existing agent differs from the approved migration input",
        );
      db.prepare(
        "INSERT INTO agents VALUES(?,?,'member',?,?,NULL,NULL,NULL,1,?) ON CONFLICT(id) DO NOTHING",
      ).run(a.id, a.owner, a.tier, hash(a.token), new Date().toISOString());
      for (const center of old ? [] : a.centers)
        db.prepare(
          "INSERT INTO agent_projects VALUES(?,?) ON CONFLICT DO NOTHING",
        ).run(a.id, center);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const tx = (work, checkDeadline = () => {}) => {
    checkDeadline();
    db.exec("BEGIN IMMEDIATE");
    try {
      checkDeadline();
      const result = work();
      checkDeadline();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const audit = (actor, action, subject) =>
    db
      .prepare("INSERT INTO audit(actor,action,subject,at) VALUES(?,?,?,?)")
      .run(actor, action, subject, new Date().toISOString());
  const access = (user, center) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM members WHERE username=? AND center=?")
        .get(user, center),
    );
  const owner = (user, center) => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM members WHERE username=? AND center=? AND role='owner'",
        )
        .get(user, center)
    )
      fail(403, "需要项目所有者权限");
  };
  const view = (a) =>
    a
      ? {
          id: a.id,
          owner: a.owner,
          ownerKind: a.owner_kind,
          tier: a.tier,
          centers: db
            .prepare(
              "SELECT center FROM agent_projects WHERE agent=? ORDER BY center",
            )
            .all(a.id)
            .map((row) => row.center),
          active: Boolean(a.active),
        }
      : null;
  const list = (center) =>
    db
      .prepare(
        "SELECT a.* FROM agents a JOIN agent_projects p ON p.agent=a.id WHERE p.center=? AND a.active=1 ORDER BY a.created_at,a.id",
      )
      .all(center)
      .map(view);
  const lookupCode = (code) => {
    if (typeof code !== "string" || !/^project_[A-Za-z0-9_-]{32}$/.test(code))
      fail(403, "项目 ID 无效或已重置");
    const project = db
      .prepare("SELECT center FROM projects WHERE join_code=?")
      .get(code);
    if (!project || !centers.has(project.center))
      fail(403, "项目 ID 无效或已重置");
    return project.center;
  };
  const enrollment = (agent) => {
    const p = catalog.get(agent.centers[0]);
    if (!p) fail(503, "此项目尚未配置可写 Git 中心");
    return {
      agent,
      centerId: p.centerId,
      namespace: p.namespace,
      remote: p.remote,
      hostKey: p.hostKey,
    };
  };
  // Pairing codes live only in this process: a restart invalidates them and the agent asks again.
  const ownerCodes = new Map(),
    ownerFailures = new Map();
  const prune = (now) => {
    for (const [key, item] of ownerCodes)
      if (item.until <= now) ownerCodes.delete(key);
    for (const [user, item] of ownerFailures)
      if (item.until <= now) ownerFailures.delete(user);
  };
  return {
    access,
    list,
    // Display names and avatars are visible between members of at least one common configured project.
    sharesProject(viewer, member) {
      return (
        viewer === member ||
        db
          .prepare(
            "SELECT a.center FROM members a JOIN members b ON b.center=a.center WHERE a.username=? AND b.username=?",
          )
          .all(viewer, member)
          .some((row) => centers.has(row.center))
      );
    },
    // The agent proves its credential by requesting the code; the member proves the
    // login by entering it. Only then does the registry record that member as owner.
    ownerCode(agentId, center) {
      const agent = db
        .prepare(
          "SELECT a.owner FROM agents a JOIN agent_projects p ON p.agent=a.id WHERE a.id=? AND p.center=? AND a.active=1",
        )
        .get(agentId, center);
      if (!agent) fail(404, "项目中没有此 agent");
      if (agent.owner) fail(409, `此 agent 已确认归属 ${agent.owner}`);
      const now = Date.now();
      prune(now);
      for (const [key, item] of ownerCodes)
        if (item.agent === agentId) ownerCodes.delete(key);
      if (ownerCodes.size >= 1000) fail(429, "待确认的归属码较多，请稍后重试");
      const code = [...randomBytes(10)]
        .map((byte) => OWNER_ALPHABET[byte & 31])
        .join("");
      ownerCodes.set(hash(code), {
        agent: agentId,
        center,
        until: now + OWNER_CODE_MS,
      });
      return {
        code: `${code.slice(0, 5)}-${code.slice(5)}`,
        expiresAt: new Date(now + OWNER_CODE_MS).toISOString(),
      };
    },
    confirmOwner(user, center, input, checkDeadline) {
      exact(input, ["code"]);
      const now = Date.now();
      prune(now);
      const failures = ownerFailures.get(user);
      if (failures?.count >= 10) fail(429, "确认码错误次数较多，请 10 分钟后重试");
      const code =
        typeof input.code === "string"
          ? input.code.toUpperCase().replace(/[\s-]/g, "")
          : "";
      const key = /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? hash(code) : null,
        item = key && ownerCodes.get(key);
      if (!item || item.center !== center) {
        if (!failures) ownerFailures.set(user, { until: now + OWNER_CODE_MS, count: 1 });
        else failures.count++;
        fail(403, "确认码无效或已过期，请让 agent 重新运行加入命令获取新码");
      }
      const agent = tx(() => {
        if (!access(user, center)) fail(403, "请先加入此项目");
        const row = db
          .prepare(
            "SELECT a.* FROM agents a JOIN agent_projects p ON p.agent=a.id WHERE a.id=? AND p.center=? AND a.active=1",
          )
          .get(item.agent, center);
        if (!row) fail(404, "项目中没有此 agent");
        if (row.owner && row.owner !== user) fail(409, "此 agent 已确认归属其他成员");
        if (!row.owner) {
          db.prepare("UPDATE agents SET owner=? WHERE id=?").run(user, row.id);
          audit(user, "agent.owner_confirmed", row.id);
        }
        return view(db.prepare("SELECT * FROM agents WHERE id=?").get(row.id));
      }, checkDeadline);
      ownerCodes.delete(key);
      return agent;
    },
    projects(user) {
      return db
        .prepare(
          "SELECT p.center,m.role,m.tier,p.join_code FROM projects p JOIN members m ON m.center=p.center WHERE m.username=? ORDER BY p.center",
        )
        .all(user)
        .filter((p) => centers.has(p.center))
        .map((p) => ({
          centerId: p.center,
          role: p.role,
          tier: p.tier,
          joinId: p.role === "owner" ? p.join_code : null,
          executionEnabled: catalog.has(p.center),
        }));
    },
    join(user, input, checkDeadline) {
      exact(input, ["projectId", "level"]);
      if (!TIER.has(input.level)) fail(400, "模型 level 须为 lite、pro 或 max");
      return tx(() => {
        const center = lookupCode(input.projectId);
        db.prepare(
          "INSERT INTO members VALUES(?,?,'member',?) ON CONFLICT(center,username) DO NOTHING",
        ).run(center, user, input.level);
        audit(user, "project.join", center);
        return { centerId: center };
      }, checkDeadline);
    },
    rotate(user, center, checkDeadline) {
      return tx(() => {
        owner(user, center);
        const code = joinCode();
        db.prepare("UPDATE projects SET join_code=? WHERE center=?").run(
          code,
          center,
        );
        audit(user, "project.id_reset", center);
        return { projectId: code };
      }, checkDeadline);
    },
    enroll(input, checkDeadline) {
      exact(input, ["projectId", "level", "publicKey", "token", "requestId"]);
      if (
        !TIER.has(input.level) ||
        typeof input.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.token) ||
        typeof input.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.requestId)
      )
        fail(400, "加入参数无效");
      const key = publicKey(input.publicKey),
        tokenHash = hash(input.token);
      return tx(() => {
        const old = db
          .prepare("SELECT * FROM agents WHERE enrollment_key=?")
          .get(input.requestId);
        if (old) {
          if (
            !old.active ||
            old.public_key !== key ||
            old.token_hash !== tokenHash ||
            old.tier !== input.level ||
            typeof input.projectId !== "string" ||
            old.enrollment_code_hash !== hash(input.projectId)
          )
            fail(409, "加入请求已变化或 agent 已撤销");
          return enrollment(view(old));
        }
        const center = lookupCode(input.projectId);
        if (!catalog.has(center)) fail(503, "此项目尚未配置可写 Git 中心");
        if (
          db
            .prepare("SELECT count(*) AS n FROM agent_projects WHERE center=?")
            .get(center).n >= 1000
        )
          fail(429, "项目 agent 数量已达上限");
        if (
          db
            .prepare("SELECT 1 FROM agents WHERE public_key=? OR token_hash=?")
            .get(key, tokenHash)
        )
          fail(409, "每个 agent 需要独立密钥与凭据");
        const id = `agent-${randomUUID()}`;
        db.prepare(
          "INSERT INTO agents VALUES(?,NULL,'project',?,?,?,?,?,1,?)",
        ).run(
          id,
          input.level,
          tokenHash,
          key,
          input.requestId,
          hash(input.projectId),
          new Date().toISOString(),
        );
        db.prepare("INSERT INTO agent_projects VALUES(?,?)").run(id, center);
        audit(`project:${center}`, "agent.join", id);
        return enrollment(
          view(db.prepare("SELECT * FROM agents WHERE id=?").get(id)),
        );
      }, checkDeadline);
    },
    authenticate(header) {
      if (typeof header !== "string" || !/^Bearer [a-f0-9]{64}$/.test(header))
        fail(401, "需要 agent 凭据");
      const agent = view(
        db
          .prepare("SELECT * FROM agents WHERE token_hash=? AND active=1")
          .get(hash(header.slice(7))),
      );
      if (!agent || agent.centers.some((c) => !centers.has(c)))
        fail(401, "agent 凭据无效或已撤销");
      return agent;
    },
    revoke(user, center, id, checkDeadline) {
      return tx(() => {
        owner(user, center);
        if (
          !db
            .prepare("SELECT 1 FROM agent_projects WHERE center=? AND agent=?")
            .get(center, id)
        )
          fail(404, "项目中没有此 agent");
        db.prepare("DELETE FROM agent_projects WHERE center=? AND agent=?").run(
          center,
          id,
        );
        if (!db.prepare("SELECT 1 FROM agent_projects WHERE agent=?").get(id))
          db.prepare("UPDATE agents SET active=0 WHERE id=?").run(id);
        audit(user, "agent.revoke", id);
        return { revoked: true };
      }, checkDeadline);
    },
    close() {
      db.close();
    },
  };
}
module.exports = { createAdmission, publicKey };
