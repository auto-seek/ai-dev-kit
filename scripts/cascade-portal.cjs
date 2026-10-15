#!/usr/bin/env node
"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { createReader } = require("./cascade-flow/snapshot.cjs");
const { createStore, PortalError, fail, canonical, digest, dispatchContract, text } = require("./cascade-portal/store.cjs");
const { redact } = require("./cascade-process.cjs");
const { createAuth } = require("./cascade-portal/auth.cjs");

const MAX_FILE = 64 * 1024 * 1024;
const MAX_STORAGE = 512 * 1024 * 1024;
async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyStorage(store, directory) {
  const artifacts = store.listArtifacts(), expected = new Set(artifacts.map(item => item.id));
  const names = await fs.readdir(directory);
  if (names.some(name => !expected.has(name))) throw new Error("Unregistered artifact files found; stop and reconcile the upload journal before restarting");
  for (const artifact of artifacts) {
    const filename = path.join(directory, artifact.id), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes || await hashFile(filename) !== artifact.sha256) throw new Error("Artifact storage differs from its database; restore or investigate before restarting");
  }
  if (store.artifactBytes() > MAX_STORAGE) throw new Error("Artifact storage exceeds the configured quota");
}
function sameSecret(value, expected) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function nativeSpecs(request, rootTask) {
  const contract = dispatchContract(request), id = `portal-${request.id}`, reviewId = `${id}-review`;
  const bound = `portal-contract:${canonical(contract)}`;
  const dependencies = [...new Set([rootTask, ...contract.proposal.dependencies])];
  if (dependencies.includes(id) || dependencies.includes(reviewId)) fail(400, "工单不能依赖自身或后继审查");
  return { contract, taskIds: [id, reviewId], specs: [
    { node_id: id, required_tier: contract.proposal.requiredTier,
      deps: Object.fromEntries(dependencies.map(dep => [dep, { expectation: bound,
        promise: `上游 ${dep} 提供其真实完成证据与批准基线；完整需求合同见 expectation，实施仍须有效租约、范围核对、独立复审和最终 HEAD preflight。` }])) },
    { node_id: reviewId, required_tier: contract.proposal.requiredTier === "max" ? "max" : "pro", reserved_for: "codex-team-center",
      deps: { [id]: { expectation: bound,
        promise: "交付精确候选 SHA、可获取结果分支、完整变更、实际测试及独立复审/内容绑定 preflight；不得自审、自动合并或把网页意见当技术门禁。" } } },
  ] };
}
function verifyDispatch(snapshot, request, rootTask) {
  const plan = nativeSpecs(request, rootTask), byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  for (const spec of plan.specs) {
    const node = byId.get(spec.node_id);
    if (!node || node.tier !== spec.required_tier || node.reservedFor !== (spec.reserved_for ?? null)) fail(409, "正式任务身份、预约或能力层级与提案不符");
    if (node.dependencies.length !== Object.keys(spec.deps).length) fail(409, "正式任务前置数量与提案不符");
    for (const [id, edge] of Object.entries(spec.deps)) {
      const found = node.dependencies.find(item => item.id === id);
      if (!found || found.expectation !== edge.expectation || found.promise !== edge.promise) fail(409, "正式任务未绑定此需求的精确版本与合同");
    }
  }
  return { taskIds: plan.taskIds, proposalVersion: plan.contract.proposalVersion,
    proposalSha256: plan.contract.proposalSha256, coordinationRevision: snapshot.revision };
}
async function readJson(req, maximum = 128 * 1024) {
  if ((req.headers["content-type"] || "").split(";")[0] !== "application/json") fail(415, "请使用 JSON 请求");
  if (Number(req.headers["content-length"]) > maximum) fail(413, maximum === 4096 ? "登录请求超过 4 KiB" : "请求超过 128 KiB");
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maximum) fail(413, maximum === 4096 ? "登录请求超过 4 KiB" : "请求超过 128 KiB"); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail(400, "JSON 格式错误"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "JSON 请求必须是对象");
  return value;
}
function mediaType(name, first) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png" && first.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext) && first[0] === 255 && first[1] === 216 && first[2] === 255) return "image/jpeg";
  if (ext === ".mp4" && first.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (ext === ".webm" && first.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return "video/webm";
  if ([".png", ".jpg", ".jpeg", ".mp4", ".webm"].includes(ext)) fail(415, "文件内容与媒体类型不符");
  if ([".zip", ".gz", ".pdf", ".md", ".txt", ".json", ".patch", ".dmg", ".exe", ".pck"].includes(ext)) return "application/octet-stream";
  fail(415, "不支持此产物类型；网页或脚本不能在门户内执行");
}
function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) fail(416, "Range 无效");
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) fail(416, "Range 超出文件");
  return { start, end, partial: true };
}

async function startPortal({ remote, namespace, project = namespace, rootTask, dataDir, publicOrigin,
  proxySecret, agentToken, usersFile, htpasswdPath = "/usr/bin/htpasswd", port = 4317, localDevelopment = false, refreshMs = 15000, authOptions }) {
  if (authOptions && !localDevelopment) throw new Error("Authentication test options require local development");
  if (typeof proxySecret !== "string" || proxySecret.length < 32 || typeof agentToken !== "string" || agentToken.length < 32 || proxySecret === agentToken) throw new Error("Two distinct secrets of at least 32 characters are required");
  if (typeof rootTask !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(rootTask)) throw new Error("A valid project root task is required");
  if (!localDevelopment) {
    const u = new URL(publicOrigin);
    if (u.protocol !== "https:" || u.origin !== publicOrigin || u.username || u.password) throw new Error("Production portal requires an exact HTTPS origin");
  }
  if (!path.isAbsolute(dataDir)) throw new Error("Portal data directory must be absolute");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const blobs = path.join(dataDir, "artifacts"); await fs.mkdir(blobs, { recursive: true, mode: 0o700 });
  const assets = new Map();
  for (const [route, folder, file, type] of [
    ["/", "cascade-portal", "index.html", "text/html"], ["/portal.js", "cascade-portal", "app.js", "text/javascript"],
    ["/portal.css", "cascade-portal", "style.css", "text/css"], ["/flow", "cascade-flow", "index.html", "text/html"],
    ["/app.js", "cascade-flow", "app.js", "text/javascript"], ["/style.css", "cascade-flow", "style.css", "text/css"],
    ["/layout.js", "cascade-flow", "layout.js", "text/javascript"], ["/vendor/dagre-3.1.1.esm.js", "cascade-flow", "vendor/dagre-3.1.1.esm.js", "text/javascript"],
  ]) assets.set(route, { body: await fs.readFile(path.join(__dirname, folder, file)), type });
  assets.get("/flow").body = Buffer.from(assets.get("/flow").body.toString().replace("<body>", '<body data-portal="true">').replace('<span class="read-only">只读任务流</span>', '<a href="/">返回团队中心</a>'));
  assets.set("/login", assets.get("/"));
  const auth = await createAuth({ usersFile, htpasswdPath, privateDir: path.join(dataDir, "auth-private"), localDevelopment, ...authOptions });
  const store = createStore(path.join(dataDir, "portal.sqlite"));
  let reader;
  try {
    await verifyStorage(store, blobs);
    reader = await createReader({ remote, namespace, project, timeoutSeconds: 30 });
  } catch (error) { store.close(); throw error; }
  let state = { status: "loading", refreshing: false, checkedAt: null, error: null, snapshot: null };
  let pending = null, completedAt = 0, uploading = false, storageError = null;
  const refresh = () => {
    if (pending) return pending;
    state.refreshing = true;
    pending = reader.read().then(snapshot => {
      state = { status: "fresh", refreshing: false, checkedAt: new Date().toISOString(), error: null, snapshot };
      return snapshot;
    }).catch(error => {
      state = { ...state, status: "error", refreshing: false, checkedAt: new Date().toISOString(), error: redact(error.message, true) };
      throw error;
    }).finally(() => { pending = null; completedAt = Date.now(); });
    return pending;
  };
  const snapshotState = () => { if (!pending && (!completedAt || Date.now() - completedAt >= refreshMs)) void refresh().catch(() => {}); return state; };
  const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
  let origin = publicOrigin;
  const activeRequests = new Set();
  const handleRequest = async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!sameSecret(req.headers["x-cascade-proxy"], proxySecret)) fail(403, "受信入口验证失败");
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) fail(403, "只允许同源访问");
      const url = new URL(req.url, origin), route = url.pathname;
      const agentRoute = route.startsWith("/api/agent/");
      if (req.method !== "GET" && !agentRoute && req.headers.origin !== origin) fail(403, "写入需要同源 Origin");
      if (req.method === "POST" && route === "/api/auth/login" && !url.search) {
        const result = await auth.login(req, res, await readJson(req, 4096));
        if (result && !res.destroyed) json(res, 200, result); return;
      }
      const publicAsset = ["/login", "/portal.js", "/portal.css"].includes(route);
      let session, user;
      if (agentRoute) { if (!sameSecret(req.headers.authorization, `Bearer ${agentToken}`)) fail(401, "中心身份验证失败"); }
      else if (!publicAsset) {
        try { session = await auth.authenticate(req, res); user = session.user; }
        catch (error) {
          if (error.status === 401 && req.method === "GET" && ["/", "/flow"].includes(route)) {
            res.writeHead(303, { Location: route === "/flow" ? "/login?next=%2Fflow" : "/login" }); res.end(); return;
          }
          throw error;
        }
        if (req.method !== "GET") auth.csrf(req, session);
      }
      if (req.method === "GET" && assets.has(route) && (!url.search || route === "/login")) {
        const asset = assets.get(route); res.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8` }); res.end(asset.body); return;
      }
      if (req.method === "GET" && route === "/api/auth/session") { json(res, 200, auth.describe(session)); return; }
      if (req.method === "POST" && route === "/api/auth/activity") { json(res, 200, auth.activity(session)); return; }
      if (req.method === "POST" && route === "/api/auth/logout") { auth.logout(req, res); json(res, 200, { loggedOut: true }); return; }
      const employeeInput = async () => {
        const input = await readJson(req);
        // Body streaming may overlap logout, expiry, or an account change.
        if (await auth.authenticate(req, res) !== session) fail(401, "登录状态已变化");
        auth.csrf(req, session); return input;
      };
      if (req.method === "GET" && route === "/api/snapshot") { const s = snapshotState(); json(res, s.status === "error" ? 503 : 200, s); return; }
      if (req.method === "GET" && route === "/api/portal") { json(res, 200, { user, project, ...store.overview(), storageError, coordination: snapshotState() }); return; }
      if (req.method === "GET" && route === "/api/agent/queue") { json(res, 200, { project, rootTask, namespace, remoteSha256: digest(remote), ...store.centerQueue() }); return; }
      if (req.method === "POST" && route === "/api/requests") { json(res, 201, store.createRequest(user, await employeeInput())); return; }
      let match;
      if ((match = /^\/api\/requests\/([a-f0-9-]{36})\/reply$/.exec(route)) && req.method === "POST") { json(res, 200, store.reply(user, match[1], await employeeInput())); return; }
      if ((match = /^\/api\/agent\/requests\/([a-f0-9-]{36})\/contract$/.exec(route)) && req.method === "GET") { json(res, 200, nativeSpecs(store.getRequest(match[1]), rootTask)); return; }
      if ((match = /^\/api\/agent\/requests\/([a-f0-9-]{36})$/.exec(route)) && req.method === "GET") { json(res, 200, store.getRequest(match[1])); return; }
      if ((match = /^\/api\/agent\/requests\/([a-f0-9-]{36})$/.exec(route)) && req.method === "POST") {
        const input = await readJson(req);
        const dispatch = input.action === "publish" ? verifyDispatch(await refresh(), store.getRequest(match[1]), rootTask) : null;
        json(res, 200, store.updateRequest(match[1], input, dispatch)); return;
      }
      if (req.method === "POST" && route === "/api/agent/candidates") {
        const input = await readJson(req), snapshot = await refresh();
        const node = snapshot.nodes.find(node => node.id === input.taskId);
        if (!node || node.state !== "COMPLETED" || node.deliveryCommit !== input.sha) fail(409, "候选必须与正式完成报告中的精确交付 SHA 一致");
        json(res, 201, store.addCandidate(input)); return;
      }
      if ((match = /^\/api\/agent\/candidates\/([a-f0-9-]{36})\/artifacts$/.exec(route)) && req.method === "POST") {
        if (storageError) fail(503, storageError);
        if (uploading) fail(429, "另一份产物正在上传，请稍后明确重试");
        const candidateId = match[1], name = text(url.searchParams.get("name"), "文件名", 180);
        if (/[\\/\r\n]/.test(name) || name === "." || name === "..") fail(400, "文件名不能含路径");
        if (store.getCandidate(candidateId).manifestSha256) fail(409, "候选产物清单已封存，不能追加或替换");
        const length = Number(req.headers["content-length"]);
        if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILE) fail(413, "单份产物须为 1 字节至 64 MiB，且提供 Content-Length");
        if (store.artifactBytes() + length > MAX_STORAGE) fail(507, "产物存储已达 512 MiB 上限，需要明确扩容或归档");
        uploading = true;
        const id = randomUUID(), filename = path.join(blobs, id); let handle, committed = false, uploadError;
        try {
          handle = await fs.open(filename, "wx", 0o600);
          const hash = createHash("sha256"); let bytes = 0, first = Buffer.alloc(0);
          for await (const chunk of req) {
            bytes += chunk.length; if (bytes > length) fail(413, "上传超过声明长度");
            if (first.length < 512) first = Buffer.concat([first, chunk]).subarray(0, 512);
            hash.update(chunk); await handle.writeFile(chunk);
          }
          if (bytes !== length) fail(400, "上传内容不完整");
          await handle.sync(); await handle.close(); handle = null;
          const directory = await fs.open(blobs, "r");
          try { await directory.sync(); } finally { await directory.close(); }
          const metadata = { id, name, mime: mediaType(name, first), bytes, sha256: hash.digest("hex") };
          if ((await fs.stat(filename)).size !== bytes || await hashFile(filename) !== metadata.sha256) throw new Error("Uploaded artifact failed disk verification");
          store.addArtifact(candidateId, metadata); committed = true; json(res, 201, metadata);
        } catch (error) { uploadError = error; throw error; }
        finally {
          const cleanupErrors = [];
          try {
            if (handle) { try { await handle.close(); } catch (error) { cleanupErrors.push(error); } }
            if (!committed) { try { await fs.rm(filename, { force: true }); } catch (error) { cleanupErrors.push(error); } }
            if (cleanupErrors.length) {
              storageError = "上传清理失败，产物写入已停止；需检查磁盘与数据库后重启";
              throw new AggregateError([...(uploadError ? [uploadError] : []), ...cleanupErrors], storageError);
            }
          } finally { uploading = false; }
        }
        return;
      }
      if ((match = /^\/api\/agent\/candidates\/([a-f0-9-]{36})\/seal$/.exec(route)) && req.method === "POST") {
        if (storageError) fail(503, storageError);
        const candidate = store.getCandidate(match[1]);
        for (const artifact of candidate.artifacts) {
          const filename = path.join(blobs, artifact.id), stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes || await hashFile(filename) !== artifact.sha256) throw new Error("Artifact disk verification failed before sealing");
        }
        json(res, 200, store.sealCandidate(candidate.id, digest(candidate.artifacts))); return;
      }
      if ((match = /^\/artifacts\/([a-f0-9-]{36})$/.exec(route)) && req.method === "GET") {
        const artifact = store.getArtifact(match[1]), filename = path.join(blobs, artifact.id);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes || await hashFile(filename) !== artifact.sha256) throw new Error("Artifact file is missing or changed");
        res.setHeader("Accept-Ranges", "bytes");
        const range = byteRange(req.headers.range, artifact.bytes);
        res.setHeader("Content-Type", artifact.mime);
        res.setHeader("Content-Disposition", `${artifact.mime === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
        res.setHeader("Content-Length", range.end - range.start + 1);
        if (range.partial) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${artifact.bytes}`);
        res.writeHead(range.partial ? 206 : 200);
        await pipeline(createReadStream(filename, { start: range.start, end: range.end }), res); return;
      }
      if ((match = /^\/api\/candidates\/([a-f0-9-]{36})\/reviews$/.exec(route)) && req.method === "POST") { json(res, 201, store.addReview(user, match[1], await employeeInput())); return; }
      if ((match = /^\/api\/agent\/reviews\/([a-f0-9-]{36})$/.exec(route)) && req.method === "POST") { store.processReview(match[1], await readJson(req)); json(res, 200, { processed: true }); return; }
      fail(404, "入口不存在");
    } catch (error) {
      if (res.headersSent) { res.destroy(error); return; }
      json(res, error instanceof PortalError ? error.status : 503, { error: redact(error.message, true), ...(error.code && error instanceof PortalError ? { code: error.code } : {}) });
    }
  };
  const server = http.createServer((req, res) => {
    const task = handleRequest(req, res).finally(() => activeRequests.delete(task));
    activeRequests.add(task);
  });
  server.maxConnections = 128;
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
  catch (error) { store.close(); await reader.close(); throw error; }
  if (localDevelopment && !publicOrigin) origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin, port: server.address().port, async close() {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await Promise.allSettled([...activeRequests]);
    if (pending) await pending.catch(() => {});
    await reader.close(); store.close(); auth.close();
  } };
}
async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(["remote", "namespace", "title", "root-task", "data-dir", "public-origin", "proxy-secret-file", "agent-token-file", "users-file", "htpasswd", "port"].map(key => [key, { type: "string" }])) });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const portal = await startPortal({ remote: values.remote, namespace: values.namespace, project: values.title,
    usersFile: values["users-file"], htpasswdPath: values.htpasswd,
    rootTask: values["root-task"], dataDir: values["data-dir"], publicOrigin: values["public-origin"], port,
    proxySecret: (await fs.readFile(values["proxy-secret-file"], "utf8")).trim(), agentToken: (await fs.readFile(values["agent-token-file"], "utf8")).trim() });
  console.log(`Cascade team center listening on 127.0.0.1:${portal.port}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { if (stopping) return; stopping = true; await portal.close(); });
}
module.exports = { startPortal, nativeSpecs, verifyDispatch, byteRange };
if (require.main === module) main().catch(error => { console.error(`cascade-portal: ${redact(error.message, true)}`); process.exitCode = 1; });
