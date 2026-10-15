#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { parseArgs } = require("node:util");
const { runProcess, redact } = require("./cascade-process.cjs");
const { digest } = require("./cascade-portal/store.cjs");

async function createClient(config) {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.origin !== config.origin || origin.username || origin.password) throw new Error("Center origin must be an exact HTTPS origin");
  const token = (await fs.readFile(config.tokenFile, "utf8")).trim();
  if (token.length < 32) throw new Error("Center token is missing or invalid");
  const api = async (route, body, upload) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (upload) {
      headers["Content-Type"] = "application/octet-stream"; headers["Content-Length"] = String(upload.bytes);
      const stream = createReadStream(upload.filename); let request;
      try {
        // Built-in fetch has a separate five-minute response-header budget.
        // The upload needs one explicit total budget, including disk verification.
        return await new Promise((resolve, reject) => {
          request = https.request(`${origin.origin}/api/agent/${route}`, { method: "POST", headers, agent: false,
            signal: AbortSignal.timeout(upload.timeoutMs + 5000) }, response => {
            let bytes = 0; const chunks = [];
            response.on("data", chunk => {
              bytes += chunk.length;
              if (bytes > 128 * 1024) { response.destroy(new Error("Center upload response exceeds 128 KiB")); return; }
              chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                if (response.statusCode >= 300 && response.statusCode < 400) throw new Error("Center upload redirects are forbidden");
                const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Center HTTP ${response.statusCode}: ${result.error || "request failed"}`);
                resolve(result);
              } catch (error) { reject(error); }
            });
          });
          request.on("error", reject); stream.on("error", error => request.destroy(error)); stream.pipe(request);
        });
      } finally { stream.destroy(); if (request) request.destroy(); }
    }
    const response = await fetch(`${origin.origin}/api/agent/${route}`, {
      method: body !== undefined ? "POST" : "GET", headers,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(65000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Center HTTP ${response.status}: ${result.error || "request failed"}`);
    return result;
  };
  return {
    api,
    async upload(id, filename, name = path.basename(filename)) {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error("Artifact must be a regular, nonempty, nonsymlink file");
      const { artifactPolicy: policy } = await api("queue");
      if (!policy || ["maxFileBytes", "maxStorageBytes", "diskReserveBytes", "uploadTimeoutMs", "downloadTimeoutMs"].some(key => !Number.isSafeInteger(policy[key]) || policy[key] < 1) ||
          policy.maxFileBytes > policy.maxStorageBytes || policy.uploadTimeoutMs > 86400000 || policy.downloadTimeoutMs > 86400000) throw new Error("Center returned an invalid artifact policy");
      if (stat.size > policy.maxFileBytes) throw new Error(`Artifact exceeds center limit of ${policy.maxFileBytes} bytes`);
      try {
        return await api(`candidates/${id}/artifacts?name=${encodeURIComponent(name)}`, undefined,
          { filename, bytes: stat.size, timeoutMs: policy.uploadTimeoutMs });
      } catch (error) {
        throw new Error(`${error.message}. Do not blindly retry; read candidate ${id} and compare the recorded artifact size and SHA256.`, { cause: error });
      }
    },
    async publish(id) {
      if (config.role !== "orchestrator" || config.actor !== "codex-team-center") throw new Error("Publishing requires the configured project center role and actor");
      if (!path.isAbsolute(config.cascadePython || "") || !path.isAbsolute(config.cacheDir || "")) throw new Error("Publishing requires a pinned Python runtime and an absolute dedicated Git cache");
      if (typeof config.remote !== "string" || !config.remote || config.remote.startsWith("-") || /[\x00-\x20\x7f]/.test(config.remote)) throw new Error("An explicit coordination Git remote is required");
      if (config.remote.includes("://")) {
        const remote = new URL(config.remote);
        if (!["ssh:", "https:", "file:"].includes(remote.protocol) || remote.password || remote.protocol !== "ssh:" && remote.username) throw new Error("Git remote credentials must use the configured credential helper or SSH key, not URL userinfo");
      }
      const queue = await api("queue");
      if (queue.namespace !== config.namespace || queue.remoteSha256 !== digest(config.remote)) throw new Error("Local publisher and portal are bound to different coordination repositories");
      let request = await api(`requests/${id}`);
      if (request.state === "published") return request;
      if (request.state === "planned") request = await api(`requests/${id}`, { action: "prepare", version: request.version });
      if (request.state !== "dispatching") throw new Error("Request needs a complete, reviewed plan before publishing");
      const plan = await api(`requests/${id}/contract`);
      if (plan.contract.requestId !== id || plan.contract.proposalVersion !== request.version) throw new Error("Frozen request and task contract disagree");
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-portal-publish-"));
      try {
        const filename = path.join(temp, "specs.json");
        await fs.writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
        const result = await runProcess(config.cascadePython, [path.join(__dirname, "cascade-portal-publish.py"),
          "--remote", config.remote, "--namespace", config.namespace, "--cache-dir", config.cacheDir,
          "--specs-file", filename, "--root-task", queue.rootTask, "--role", config.role, "--actor", config.actor], { timeoutSeconds: 180 });
        if (result.code !== 0) throw new Error(`Native publication failed (${result.code}): ${result.stderr || result.stdout}. The request stays frozen; read the request and exact native nodes before retrying.`);
        // The server independently fetches and checks both native contracts.
        return await api(`requests/${id}`, { action: "publish", version: request.version });
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    },
  };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: Object.fromEntries(["config", "id", "input", "file", "name"].map(key => [key, { type: "string" }])) });
  if (positionals.length !== 1 || !["queue", "request", "update", "publish", "candidate", "upload", "seal", "review"].includes(positionals[0])) throw new Error("Usage: cascade-portal-client.cjs --config FILE queue|request|update|publish|candidate|upload|seal|review [--id ID] [--input JSON_FILE] [--file ARTIFACT]");
  const client = await createClient(JSON.parse(await fs.readFile(values.config, "utf8")));
  const command = positionals[0];
  if ((!["queue", "candidate"].includes(command) || command === "candidate" && values.id !== undefined) && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(values.id || "")) throw new Error("A request/candidate/review UUID is required");
  let input;
  if (["update", "review"].includes(command) || command === "candidate" && values.id === undefined) input = JSON.parse(await fs.readFile(values.input, "utf8"));
  let result;
  if (command === "queue") result = await client.api("queue");
  else if (command === "request") result = await client.api(`requests/${values.id}`);
  else if (command === "update") result = await client.api(`requests/${values.id}`, input);
  else if (command === "publish") result = await client.publish(values.id);
  else if (command === "candidate") {
    if (values.id !== undefined && values.input !== undefined) throw new Error("Use candidate --id for readback or --input for registration, not both");
    result = await client.api(values.id === undefined ? "candidates" : `candidates/${values.id}`, input);
  }
  else if (command === "seal") result = await client.api(`candidates/${values.id}/seal`, {});
  else if (command === "review") result = await client.api(`reviews/${values.id}`, input);
  else if (command === "upload") {
    result = await client.upload(values.id, values.file, values.name);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
module.exports = { createClient };
if (require.main === module) main().catch(error => { console.error(`cascade-portal-client: ${redact(error.message, true)}`); process.exitCode = 1; });
