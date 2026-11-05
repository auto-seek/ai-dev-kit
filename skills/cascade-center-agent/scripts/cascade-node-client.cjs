#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { randomUUID } = require("node:crypto");
const { createClient } = require("./cascade-portal-client.cjs");
const { redact } = require("./cascade-process.cjs");
const { digest, canonical } = require("./cascade-portal/store.cjs");

function centerRoute(config) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.centerId || "")) throw new Error("An explicit centerId is required");
  return `collaboration/${config.centerId}/`;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// Statuses whose request the center decided not to run, or ran and answered: retrying cannot change them.
const FINAL = new Set([400, 401, 403, 404, 409, 413, 501]);
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error(`${directory} must be a private directory`);
  return directory;
}
async function writePrivate(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filename);
}
// Writes go to the center writer through the portal. Each one has a UUID v4 request ID, saved
// in the private cache before it is sent and resent with the same body until the center decides
// it: a lost answer then returns the original result instead of running the request twice.
function executionStore(config) {
  if (!path.isAbsolute(config.cacheDir || "")) throw new Error("A private absolute cache directory is required");
  const pending = path.join(config.cacheDir, "node-requests"), receipts = path.join(config.cacheDir, "node-receipts");
  return {
    // The saved request with this route and body, so a rerun after an unknown outcome reuses its ID.
    async open(route, body) {
      await privateDirectory(config.cacheDir); await privateDirectory(pending);
      for (const name of (await fs.readdir(pending)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).sort()) {
        const saved = JSON.parse(await fs.readFile(path.join(pending, name), "utf8"));
        const { requestId, ...rest } = saved.body;
        if (saved.route === route && canonical(rest) === canonical(body)) return { ...saved, file: path.join(pending, name), reused: true };
      }
      const requestId = randomUUID(), file = path.join(pending, `${requestId}.json`), saved = { route, body: { requestId, ...body }, createdAt: new Date().toISOString() };
      await writePrivate(file, saved);
      return { ...saved, file, reused: false };
    },
    async settle(request, result) {
      const value = { ...result };
      try {
        await privateDirectory(receipts);
        const receiptFile = path.join(receipts, `${request.body.requestId}.json`);
        await writePrivate(receiptFile, result);
        value.receiptFile = receiptFile;
      } catch (error) { value.receiptError = `The center's result is authoritative; save this response before continuing. Receipt storage failed: ${redact(error.message, true)}`; }
      await fs.rm(request.file, { force: true });
      return value;
    },
    find: async requestId => {
      const file = path.join(pending, `${requestId}.json`);
      try { return { ...JSON.parse(await fs.readFile(file, "utf8")), file }; } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
  };
}
function centerError(answer) {
  const { status, body } = answer;
  if (body?.code === "NO_CENTER_WRITER") return new Error("This center has no center writer. This client executes tasks only through it and never writes over SSH; use the previous plugin for this center.");
  return Object.assign(new Error(`Center HTTP ${status}${body?.code ? ` ${body.code}` : ""}: ${body?.error || body?.message || "request failed"}`), { status, code: body?.code });
}
// Resends one request until the center decides it: backoff from 1 to 30 seconds with jitter,
// Retry-After on 429, 65 seconds per attempt, and a total of `limitSeconds` (10 minutes).
async function deliver(transport, route, body, { limitSeconds = 600, log = () => {} } = {}) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let answer, reason;
    try { answer = await transport.request(route, body, 65000); }
    catch (error) { reason = error.message; }
    if (answer && answer.status >= 200 && answer.status < 300) return { decided: true, body: answer.body };
    if (answer && FINAL.has(answer.status)) throw centerError(answer);
    reason ??= `HTTP ${answer.status}${answer.body?.code ? ` ${answer.body.code}` : ""}: ${answer.body?.error || ""}`;
    const backoff = Math.min(30, 2 ** attempt) * (0.5 + Math.random() / 2);
    const wait = Math.max(1, answer?.status === 429 && Number(answer.retryAfter) > 0 ? Number(answer.retryAfter) : backoff);
    if ((Date.now() - started) / 1000 + wait > limitSeconds) return { decided: false, reason };
    log(`retrying in ${wait.toFixed(1)} s with the same request ID: ${reason}`);
    await sleep(wait * 1000);
  }
}
async function createNodeClient(config) {
  const transport = await createClient(config), base = centerRoute(config), store = executionStore(config);
  const api = (route, body) => transport.api(base + route, body);
  const limitSeconds = config.executionRetrySeconds ?? 600;
  if (!Number.isFinite(limitSeconds) || limitSeconds < 1 || limitSeconds > 600) throw new Error("executionRetrySeconds must be 1-600");
  const meta = await api("meta");
  const identity = meta.agents.find(a => a.id === meta.currentAgent);
  if (!identity) throw new Error("A separately registered agent credential is required");
  async function inbox() {
    const messages = []; let after = 0, unread = 0;
    for (;;) {
      const page = await api(`inbox?unread=true&after=${after}`);
      messages.push(...page.messages); unread = page.unread;
      if (page.messages.length) await api("receipts", { messageIds: page.messages.map(m => m.id), state: "pulled" });
      if (page.messages.length < 100) break;
      if (page.nextCursor <= after || messages.length >= 10000) throw new Error("Inbox is too large; inspect it with explicit cursors before continuing");
      after = page.nextCursor;
    }
    const planning = await api("workflows?pending=true"), workflows = planning.workflows.map(({id,author,description,state,version}) => ({id,author,description,state,version}));
    return { messages, unread, workflows, workflowNextCursor: planning.nextCursor, goalConfirmation: Boolean(meta.goalConfirmation) };
  }
  async function thread(taskId) {
    if (!TASK_ID.test(taskId || "")) throw new Error("Invalid task ID");
    let after = 0, first; const messages = [];
    for (;;) {
      const page = await api(`tasks/${taskId}?after=${after}`);
      first ||= page; messages.push(...page.messages);
      if (page.messages.length < 100) return { ...first, messages, nextCursor: page.nextCursor };
      if (page.nextCursor <= after || messages.length >= 10000) throw new Error("Node history is too large; inspect it with explicit cursors");
      after = page.nextCursor;
    }
  }
  const writer = () => { if (meta.centerWriter !== true) throw centerError({ status: 501, body: { code: "NO_CENTER_WRITER" } }); };
  const token = input => {
    if (!Number.isSafeInteger(input.token) || input.token < 1) throw new Error("A positive fencing token is required in the input");
    return input.token;
  };
  // The request body each action sends; requestId is added when the request is saved.
  const bodies = {
    claim: input => ({ taskId: input.taskId ?? null, ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) }),
    complete: input => ({ taskId: input.taskId, token: token(input), summary: input.summary ?? "", critical: input.critical ?? {}, artifacts: input.artifacts ?? "", deliverables: input.deliverables ?? null }),
    release: input => ({ taskId: input.taskId, token: token(input), reason: input.reason ?? "Explicit node-client release" }),
    fail: input => ({ taskId: input.taskId, token: token(input), reason: input.reason ?? "", cascade: input.cascade ?? false }),
  };
  // One renewal attempt: it needs no request ID, and a failed one is simply sent again on the next interval.
  async function renew(input) {
    writer();
    if (!TASK_ID.test(input.taskId || "")) throw new Error("A valid task ID is required");
    const answer = await transport.request(`${base}execution/renew`, { leases: [{ taskId: input.taskId, token: token(input) }], ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) }, 65000);
    if (answer.status !== 200) throw centerError(answer);
    return answer.body.leases[0];
  }
  return {
    api, inbox, thread, identity, renew, requireWriter: writer,
    async execute(action, input = {}, { log } = {}) {
      if (!["claim", "renew", "complete", "release", "fail"].includes(action)) throw new Error("Unsupported execution action");
      writer();
      if (action === "renew") {
        const result = await renew(input);
        try { return { ...result, inbox: await inbox() }; }
        catch (error) { return { ...result, inboxError: `The renewal result is final. Message retrieval failed: ${error.message}` }; }
      }
      if (action !== "claim" && !TASK_ID.test(input.taskId || "")) throw new Error("A valid task ID is required");
      const messages = action === "complete" ? await inbox() : null;
      if (messages && messages.messages.some(m => m.taskId === input.taskId && !m.receipts.find(r => r.agentId === identity.id)?.readAt)) {
        // The unread message may be the withdrawal notice; say so instead of asking to read it first.
        const { record } = (await api(`tasks/${input.taskId}`)).withdrawal;
        if (record?.state === "withdrawn" && record.tasks.some(task => task.id === input.taskId)) {
          const origin = record.taskId === input.taskId ? "" : `（随上游任务 ${record.taskId} 一起撤回）`;
          return { success: false, code: "TASK_WITHDRAWN", message: `任务 ${input.taskId} 已撤回${origin}，原因：${record.reason}。本次领取已作废：续租、完成和释放都会被拒绝，已做的工作不会被接收。请停止工作，不要提交结果。`, withdrawal: record, inbox: messages };
        }
        return { success: false, code: "UNREAD_NODE_MESSAGES", message: "Read and explicitly acknowledge pending node messages before completing", inbox: messages };
      }
      const route = `${base}execution/${action}`, request = await store.open(route, bodies[action](input));
      const delivered = await deliver(transport, route, request.body, { limitSeconds, log });
      if (!delivered.decided) return { success: false, code: "OUTCOME_UNKNOWN", requestId: request.body.requestId, requestFile: request.file,
        message: `结果未知：${limitSeconds} 秒内中心没有给出结果（${delivered.reason}）。不要换请求 ID：用 request --id ${request.body.requestId} 查询，或原样重跑这条命令，会用同一请求 ID 重试。` };
      const result = await store.settle(request, delivered.body);
      if (result.success && action === "claim") {
        const id = result.data?.task_id;
        if (!id) throw new Error("The claim returned no task identity; inspect the center state");
        // The complete node history closes the gap before the new owner follows.
        try { result.nodeThread = await thread(id); }
        catch (error) { result.contextError = `Claim succeeded; preserve token ${result.data.token}. Read node history before starting: ${error.message}`; }
      }
      try { return { ...result, inbox: messages || await inbox() }; }
      catch (error) { return { ...result, inboxError: `The center's result is final. Message retrieval failed: ${error.message}` }; }
    },
    // The center's record of a request, which settles a saved request whose outcome was unknown.
    async request(requestId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId || "")) throw new Error("Use --id with a request ID");
      writer();
      const answer = await transport.request(`${base}execution/requests/${requestId}`, undefined, 65000);
      if (answer.status !== 200) throw centerError(answer);
      const saved = await store.find(requestId);
      return saved ? store.settle(saved, answer.body) : answer.body;
    },
  };
}
// Renews every `seconds` until the lease is lost or the process is stopped. Each result is one
// JSON line; a failed attempt is reported and the next interval tries again.
async function renewLoop(client, input, seconds, signal) {
  const lost = new Set(["TASK_WITHDRAWN", "STALE_TOKEN", "TASK_NOT_ACTIVE", "TASK_NOT_FOUND", "WRONG_AGENT"]);
  while (!signal.aborted) {
    let result;
    try { result = await client.renew(input); }
    catch (error) { result = { success: false, error: redact(error.message, true) }; }
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
    if (!result.success && lost.has(result.code)) return result;
    await new Promise(resolve => { const timer = setTimeout(resolve, seconds * 1000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
  }
  return { success: true, stopped: true };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["config", "task", "input", "cursor", "harness", "id", "every"].map(k => [k, { type: "string" }])) });
  const [command] = positionals;
  if (positionals.length !== 1 || !["inbox", "read", "thread", "follow", "message", "publish", "goal", "workflows", "workflow", "question", "plan", "confirm", "retry", "claim", "renew", "complete", "release", "fail", "request", "withdraw", "profile", "owner-code"].includes(command)) throw new Error("Usage: cascade-node-client.cjs --config FILE inbox|read|thread|follow|message|publish|goal|workflows|workflow|question|plan|confirm|retry|claim|renew|complete|release|fail|withdraw|owner-code [--task ID] [--input JSON_FILE], renew --every SECONDS, request --id REQUEST_ID, or profile --harness NAME");
  const client = await createNodeClient(JSON.parse(await fs.readFile(values.config, "utf8")));
  const input = values.input ? JSON.parse(await fs.readFile(values.input, "utf8")) : {};
  let result;
  if (command === "renew" && values.every !== undefined) {
    const seconds = Number(values.every);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) throw new Error("--every takes 5-3600 seconds");
    const stop = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => stop.abort());
    result = await renewLoop(client, { ...input, taskId: values.task }, seconds, stop.signal);
    if (result.success === false) process.exitCode = 2;
    return;
  }
  if (command === "request") result = await client.request(values.id);
  else if (command === "inbox") result = await client.inbox();
  else if (command === "thread") result = await client.thread(values.task);
  else if (command === "read") result = await client.api("receipts", { messageIds: input.messageIds, state: "read" });
  else if (command === "workflows") result = await client.api(`workflows?pending=true${values.cursor ? `&cursor=${encodeURIComponent(values.cursor)}` : ""}`);
  else if (command === "goal") {
    if (typeof input.description !== "string") throw new Error("goal input needs a description");
    // A key derived from the text makes an uncertain retry return the same goal instead of a duplicate.
    result = await client.api("workflows", { description: input.description, idempotencyKey: input.idempotencyKey ?? `goal-${digest(input.description).slice(0, 32)}` });
  }
  else if (["workflow", "question", "plan", "confirm", "retry"].includes(command)) {
    if (!/^[a-f0-9-]{36}$/.test(values.task || "")) throw new Error("Use --task with the workflow request ID");
    if (command === "confirm") result = await client.api(`workflows/${values.task}/confirm`, input);
    else if (command === "retry") result = await client.api(`workflows/${values.task}/retry`, {});
    else result = await client.api(`workflows/${values.task}`, command === "workflow" ? undefined : { ...input, action: command });
  }
  else if (command === "publish") result = await client.api("publications", input);
  else if (command === "profile") result = await client.api("agent-profile", { harness: values.harness });
  else if (command === "owner-code") result = await client.api("owner-code", {});
  else if (["follow", "message", "withdraw"].includes(command)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(values.task || "")) throw new Error("A valid task ID is required");
    // A key derived from task and reason makes an uncertain retry return the same withdrawal.
    if (command === "withdraw") result = await client.api(`tasks/${values.task}/withdraw`, { reason: input.reason, idempotencyKey: input.idempotencyKey ?? `withdraw-${digest([values.task, input.reason ?? ""]).slice(0, 32)}` });
    else result = await client.api(`tasks/${values.task}/${command === "follow" ? "follow" : "messages"}`, input);
  } else result = await client.execute(command, { ...input, ...(values.task ? { taskId: values.task } : {}) }, { log: line => console.error(`cascade-node-client: ${redact(line, true)}`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.success === false) process.exitCode = 2;
}
module.exports = { createNodeClient, centerRoute, deliver, renewLoop };
if (require.main === module) main().catch(error => { console.error(`cascade-node-client: ${redact(error.message, true)}`); process.exitCode = 1; });
