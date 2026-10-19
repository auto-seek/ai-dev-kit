#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parseArgs } = require("node:util");
const { randomUUID } = require("node:crypto");
const { createClient } = require("./cascade-portal-client.cjs");
const { runProcess, redact } = require("./cascade-process.cjs");
const { digest } = require("./cascade-portal/store.cjs");

function centerRoute(config) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.centerId || "")) throw new Error("An explicit centerId is required");
  return `collaboration/${config.centerId}/`;
}
function verifySource(config, source) {
  if (!path.isAbsolute(config.cascadePython || "") || !path.isAbsolute(config.cacheDir || "")) throw new Error("A pinned Python and private absolute Git cache are required");
  if (source.namespace !== config.namespace || source.remoteSha256 !== digest(config.remote)) throw new Error("Client and portal refer to different coordination repositories");
}
async function native(config, request) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-node-"));
  let value;
  try {
    const filename = path.join(temp, "request.json");
    await fs.writeFile(filename, JSON.stringify(request), { mode: 0o600 });
    let env = process.env;
    if (config.sshConfig) {
      if (!path.isAbsolute(config.sshConfig) || /[\r\n\0]/.test(config.sshConfig)) throw new Error("Invalid agent SSH configuration path");
      const stat = await fs.lstat(config.sshConfig);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error("Agent SSH configuration must be private");
      const quoted = "'" + config.sshConfig.replaceAll("'", "'\\''") + "'";
      env = {...env,GIT_SSH_COMMAND:`ssh -F ${quoted}`};
    }
    const result = await runProcess(config.cascadePython, [path.join(__dirname, "cascade-node-native.py"),
      "--remote", config.remote, "--namespace", config.namespace, "--cache-dir", config.cacheDir, "--request-file", filename], { timeoutSeconds: 180, env });
    if (result.code !== 0 && result.code !== 2) throw new Error(`Native operation failed (${result.code}): ${result.stderr || result.stdout}. Inspect the remote state before retrying.`);
    value = JSON.parse(result.stdout);
    const receiptDir = path.join(config.cacheDir, "node-receipts");
    try {
      await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
      const receiptFile = path.join(receiptDir, `${randomUUID()}.json`);
      await fs.writeFile(receiptFile, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      value.receiptFile = receiptFile;
    } catch (error) { value.receiptError = `Native result is authoritative; save this response before continuing. Receipt storage failed: ${redact(error.message, true)}`; }
    return value;
  } finally {
    try { await fs.rm(temp, { recursive: true, force: true }); }
    catch (error) { if (!value) throw error; value.cleanupError = `Private request cleanup failed: ${redact(error.message, true)}`; }
  }
}
async function createNodeClient(config, { activeLease = false } = {}) {
  const transport = await createClient(config), base = centerRoute(config);
  const api = (route, body) => transport.api(base + route, body);
  if (!path.isAbsolute(config.cacheDir || "")) throw new Error("A private absolute cache directory is required");
  const bindingFile = path.join(config.cacheDir, "node-agent-binding.json");
  const credentialHash = digest((await fs.readFile(config.tokenFile, "utf8")).trim());
  let meta;
  if (activeLease) {
    const stat = await fs.lstat(bindingFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > 128 * 1024) throw new Error("Saved agent binding is not a private regular file");
    const binding = JSON.parse(await fs.readFile(bindingFile, "utf8"));
    if (binding.origin !== config.origin || binding.centerId !== config.centerId || binding.credentialHash !== credentialHash || Date.now() - binding.verifiedAt > 86400000) throw new Error("Saved agent binding changed or expired; authenticate with inbox before renewing this execution");
    meta = binding.meta; verifySource(config, meta);
  } else {
    meta = await api("meta");
    const own = meta.agents.find(a => a.id === meta.currentAgent);
    if (!own) throw new Error("A separately registered agent credential is required");
    await fs.mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(config.cacheDir, `.node-binding-${randomUUID()}.json`);
    await fs.writeFile(temporary, JSON.stringify({ meta, origin: config.origin, centerId: config.centerId, credentialHash, verifiedAt: Date.now() }), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, bindingFile);
  }
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(taskId || "")) throw new Error("Invalid task ID");
    let after = 0, first; const messages = [];
    for (;;) {
      const page = await api(`tasks/${taskId}?after=${after}`);
      first ||= page; messages.push(...page.messages);
      if (page.messages.length < 100) return { ...first, messages, nextCursor: page.nextCursor };
      if (page.nextCursor <= after || messages.length >= 10000) throw new Error("Node history is too large; inspect it with explicit cursors");
      after = page.nextCursor;
    }
  }
  return {
    api, inbox, thread, identity,
    async execute(action, input = {}) {
      if (!["claim", "renew", "complete", "release"].includes(action)) throw new Error("Unsupported execution action");
      verifySource(config, meta);
      const messages = action === "complete" ? await inbox() : null;
      if (messages && messages.messages.some(m => m.taskId === input.taskId && !m.receipts.find(r => r.agentId === identity.id)?.readAt)) {
        return { success: false, code: "UNREAD_NODE_MESSAGES", message: "Read and explicitly acknowledge pending node messages before completing", inbox: messages };
      }
      const result = await native(config, { ...input, action, agent: identity.id, tier: identity.tier });
      if (result.success && action === "claim") {
        const id = result.data?.task_id;
        if (!id) throw new Error("Native claim returned no task identity; inspect native state");
        // The complete node history closes the gap before the new owner follows.
        try { result.nodeThread = await thread(id); }
        catch (error) { result.contextError = `Claim succeeded; preserve token ${result.data.token}. Read node history before starting: ${error.message}`; }
      }
      try { return { ...result, inbox: messages || await inbox() }; }
      catch (error) { return { ...result, inboxError: `Native result is final. Message retrieval failed: ${error.message}` }; }
    },
  };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["config", "task", "input", "cursor", "harness"].map(k => [k, { type: "string" }])) });
  const [command] = positionals;
  if (positionals.length !== 1 || !["inbox", "read", "thread", "follow", "message", "publish", "goal", "workflows", "workflow", "question", "plan", "confirm", "retry", "claim", "renew", "complete", "release", "profile", "owner-code"].includes(command)) throw new Error("Usage: cascade-node-client.cjs --config FILE inbox|read|thread|follow|message|publish|goal|workflows|workflow|question|plan|confirm|retry|claim|renew|complete|release|owner-code [--task ID] [--input JSON_FILE], or profile --harness NAME");
  const client = await createNodeClient(JSON.parse(await fs.readFile(values.config, "utf8")), { activeLease: ["renew", "release"].includes(command) });
  const input = values.input ? JSON.parse(await fs.readFile(values.input, "utf8")) : {};
  let result;
  if (command === "inbox") result = await client.inbox();
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
  else if (["follow", "message"].includes(command)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(values.task || "")) throw new Error("A valid task ID is required");
    result = await client.api(`tasks/${values.task}/${command === "follow" ? "follow" : "messages"}`, input);
  } else result = await client.execute(command, { ...input, ...(values.task ? { taskId: values.task } : {}) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.success === false) process.exitCode = 2;
}
module.exports = { createNodeClient, native, centerRoute, verifySource };
if (require.main === module) main().catch(error => { console.error(`cascade-node-client: ${redact(error.message, true)}`); process.exitCode = 1; });
