"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { runProcess } = require("../cascade-process.cjs");
const { PortalError } = require("./store.cjs");

const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fingerprint = value => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
// Public synthetic fixtures, never employee credentials. A platform's crypt
// support must be proven; htpasswd can return "mismatch" for unsupported SHA2.
const PROBE_PASSWORD = "cascade-auth-capability-fixture";
const PROBES = {
  bcrypt: "$2y$05$S/JEHdOyC0NIMTZwf/otku4c9ka8PYw/9FIPp09MSv08ld.1//TKe",
  sha256: "$5$53u.ERSCs1dZwKgq$lGhhcEGiqB0plXVUWEyVICncMifYBR9rbv.IOK4kLBA",
  sha512: "$6$EZE3hN8K6PYOKar8$Fp0j3RP4ZpYEdC3EUcSpwIsBeRjRDsL3jFktk489H83xB3w/qJRliWMZfEsCNnts7OyBtACo/O73Pi1ShZvM5/",
};
function error(status, code, message) { const e = new PortalError(status, message); e.code = code; throw e; }
const unavailable = () => error(503, "auth_unavailable", "登录服务暂不可用，请联系管理员检查账号文件和密码校验工具。");
const required = () => error(401, "auth_required", "登录已失效，请重新登录。未提交内容暂留在此页面。");
function algorithm(hash) {
  if (/^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.test(hash)) return "bcrypt";
  const match = /^\$([56])\$(?:rounds=([1-9][0-9]{3,6})\$)?[./A-Za-z0-9]{1,16}\$([./A-Za-z0-9]+)$/.exec(hash);
  if (match && (!match[2] || Number(match[2]) <= 1000000) && match[3].length === (match[1] === "5" ? 43 : 86)) return match[1] === "5" ? "sha256" : "sha512";
  unavailable();
}
async function createAuth({ usersFile, htpasswdPath, privateDir, localDevelopment = false,
  idleMs = 30 * 60 * 1000, absoluteMs = 8 * 60 * 60 * 1000,
  windowMs = 5 * 60 * 1000, verifierTimeoutSeconds = 5 }) {
  if (!path.isAbsolute(usersFile || "") || !path.isAbsolute(htpasswdPath || "")) throw new Error("Absolute users-file and htpasswd paths are required");
  for (const value of [idleMs, absoluteMs, windowMs, verifierTimeoutSeconds]) if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid authentication duration");
  const supported = new Set(), sessions = new Map(), users = new Map(), ips = new Map();
  let verifying = 0;
  const cookieName = localDevelopment ? "cascade_session_dev" : "__Host-cascade_session";
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${localDevelopment ? "" : "; Secure"}`;
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  const privateStat = await fs.lstat(privateDir);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink() || (privateStat.mode & 0o077) || privateStat.uid !== process.getuid()) unavailable();
  // This directory is exclusively owned by this single-instance service.
  for (const name of await fs.readdir(privateDir)) {
    if (!/^verify-[a-zA-Z0-9]+$/.test(name)) unavailable();
    await fs.rm(path.join(privateDir, name), { recursive: true });
  }
  async function accounts(checkSupport = true) {
    let file;
    try {
      file = await fs.open(usersFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o027) || (!localDevelopment && stat.uid !== 0)) unavailable();
      const bytes = await file.readFile();
      if (bytes.length > 1024 * 1024) unavailable();
      const content = bytes.toString("utf8"), result = new Map();
      if (content.includes("\uFFFD") || content.includes("\0")) unavailable();
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        const colon = line.indexOf(":"), user = line.slice(0, colon), hash = line.slice(colon + 1);
        if (colon < 0 || !USER.test(user) || result.has(user) || result.size >= 1000) unavailable();
        const kind = algorithm(hash);
        if (checkSupport && !supported.has(kind)) unavailable();
        result.set(user, { line, kind, fingerprint: fingerprint(line) });
      }
      if (!result.size) unavailable();
      return result;
    } catch { unavailable(); }
    finally { if (file) await file.close(); }
  }
  async function verify(line, user, password) {
    const directory = await fs.mkdtemp(path.join(privateDir, "verify-"));
    try {
      const filename = path.join(directory, "record");
      await fs.writeFile(filename, `${line}\n`, { flag: "wx", mode: 0o600 });
      return (await runProcess(htpasswdPath, ["-vi", filename, user], { timeoutSeconds: verifierTimeoutSeconds, input: password })).code;
    } finally { await fs.rm(directory, { recursive: true }); }
  }
  for (const kind of new Set([...(await accounts(false)).values()].map(record => record.kind))) {
    if (await verify(`probe:${PROBES[kind]}`, "probe", Buffer.from(PROBE_PASSWORD)) !== 0 ||
        await verify(`probe:${PROBES[kind]}`, "probe", Buffer.from(`${PROBE_PASSWORD}-wrong`)) !== 3) {
      throw new Error(`Password verifier cannot verify ${kind}; install a compatible htpasswd before starting`);
    }
    supported.add(kind);
  }
  function expired(session, now = Date.now()) { return now - session.createdAt >= absoluteMs || now - session.activeAt >= idleMs; }
  function prune() { for (const [key, session] of sessions) if (expired(session)) sessions.delete(key); }
  function attempt(map, key, maximum) {
    const now = Date.now();
    for (const [name, item] of map) if (now >= item.until) map.delete(name);
    let item = map.get(key);
    if (!item) { if (map.size >= 10000) error(429, "login_limited", "登录尝试较多，请五分钟后重试。"); item = { until: now + windowMs, count: 0 }; map.set(key, item); }
    if (++item.count > maximum) error(429, "login_limited", "登录尝试较多，请五分钟后重试。");
  }
  function tokenKey(req) {
    const values = String(req.headers.cookie || "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? fingerprint(token) : null;
  }
  function describe(session) { return { user: session.user, csrfToken: session.csrf, expiresAt: new Date(session.createdAt + absoluteMs).toISOString(), idleExpiresAt: new Date(session.activeAt + idleMs).toISOString() }; }
  async function authenticate(req, res) {
    const key = tokenKey(req), session = sessions.get(key);
    if (!session || expired(session)) { sessions.delete(key); required(); }
    const record = (await accounts()).get(session.user);
    if (sessions.get(key) !== session || expired(session) || record?.fingerprint !== session.fingerprint) {
      sessions.delete(key); required();
    }
    return session;
  }
  function csrf(req, session) {
    const actual = Buffer.from(String(req.headers["x-cascade-csrf"] || "")), expected = Buffer.from(session.csrf);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) error(403, "csrf_invalid", "登录状态已变化，请重新登录后再提交。");
  }
  return {
    authenticate, csrf, describe,
    async login(req, res, input) {
      const ip = req.headers["x-real-ip"] || (localDevelopment ? req.socket.remoteAddress : "");
      if (typeof ip !== "string" || !isIP(ip)) unavailable();
      attempt(ips, ip, 60);
      const user = input.username, password = input.password;
      if (typeof user !== "string" || !USER.test(user) || typeof password !== "string" || !password.isWellFormed() || !password.length || /[\0\r\n]/.test(password) || Buffer.byteLength(password) > 255) error(400, "login_input", "请输入有效账号和密码；密码不能包含换行或超过 255 字节。");
      attempt(users, user, 5);
      if (verifying >= 4) error(429, "login_busy", "登录服务繁忙，请稍后重试。");
      verifying++;
      const bytes = Buffer.from(password);
      input.password = undefined;
      try {
        const record = (await accounts()).get(user);
        const kind = record?.kind || supported.values().next().value;
        if (kind === "bcrypt" && bytes.length > 72) error(400, "login_input", "此账号的密码不能超过 72 字节。");
        const code = await verify(record?.line || `probe:${PROBES[kind]}`, record ? user : "probe", bytes);
        if (code !== 0 && code !== 3) unavailable();
        if (!record || code !== 0) error(401, "invalid_credentials", "账号或密码不正确，请重新输入。");
        if ((await accounts()).get(user)?.fingerprint !== record.fingerprint) error(401, "invalid_credentials", "账号信息已更新，请重新登录。");
        if (res.destroyed) return null;
        prune();
        const replaced = sessions.get(tokenKey(req));
        if (sessions.size + (replaced ? 0 : 1) > 1000 || [...sessions.values()].filter(session => session.user === user).length + (replaced?.user === user ? 0 : 1) > 10) error(429, "sessions_full", "登录会话已达上限，请退出其他会话或稍后重试。");
        const token = random(), now = Date.now();
        const session = { user, fingerprint: record.fingerprint, csrf: random(), createdAt: now, activeAt: now };
        // Reauthentication replaces this browser's old session; never reuse a
        // supplied token. No await between capacity check and insertion.
        sessions.delete(tokenKey(req)); sessions.set(fingerprint(token), session);
        res.setHeader("Set-Cookie", cookie(token, Math.ceil(absoluteMs / 1000)));
        return describe(session);
      } finally { bytes.fill(0); verifying--; }
    },
    activity(session) { if (expired(session)) required(); session.activeAt = Date.now(); return describe(session); },
    logout(req, res) { sessions.delete(tokenKey(req)); res.setHeader("Set-Cookie", cookie("", 0)); },
    close() { sessions.clear(); users.clear(); ips.clear(); },
  };
}
module.exports = { createAuth };
