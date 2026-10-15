"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runProcess, redact } = require("../cascade-process.cjs");

const states = new Set(["READY", "PENDING", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const iso = seconds => {
  if (!finite(seconds) || Math.abs(seconds) > 8.64e12) throw new Error("Invalid event or lease timestamp");
  return new Date(seconds * 1000).toISOString();
};
function optionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected text`);
  return redact(value);
}

function executionObservation(value) {
  const empty = { executionObservation: null, executionObservationError: null };
  if (value === undefined) return empty;
  const statuses = ["awaiting_source", "candidate", "in_progress", "awaiting_integration", "integrated_local", "published_remote", "deferred", "blocked"];
  const text = (item, maximum) => typeof item === "string" && item.trim().length > 0 && item.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item);
  const sha = item => item === null || typeof item === "string" && /^[a-f0-9]{40}$/.test(item);
  const invalid = !record(value) || value.schema_version !== 1 ||
    !["git-ref-observer", "center-reconciliation"].includes(value.source) ||
    !statuses.includes(value.status) || value.acceptance !== "not_verified" ||
    !text(value.publisher, 200) || !text(value.branch, 512) || !text(value.summary, 4000) ||
    ![value.head, value.local_base, value.remote_base].every(sha) ||
    typeof value.observed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.observed_at) || !Number.isFinite(Date.parse(value.observed_at));
  if (invalid) return { ...empty, executionObservationError: "实施记录格式无效；原生任务状态仍可读取，请发布方修正记录。" };
  // Only the public observation contract reaches the browser, never its private
  // source paths, credentials or surrounding coordination context.
  return { executionObservation: {
    schema_version: 1, source: value.source, publisher: redact(value.publisher), status: value.status,
    branch: redact(value.branch), head: value.head, local_base: value.local_base, remote_base: value.remote_base,
    observed_at: value.observed_at, summary: redact(value.summary), acceptance: "not_verified",
  }, executionObservationError: null };
}

function projectSnapshot(graphText, eventsText, { revision, fetchedAt, project }) {
  const graph = JSON.parse(graphText);
  if (!record(graph) || !record(graph.nodes) || !Array.isArray(graph.edges) ||
      !Number.isSafeInteger(graph.epoch) || graph.epoch < 0 ||
      !Number.isSafeInteger(graph.lamport) || graph.lamport < 0 ||
      graph.schema_version !== undefined) {
    throw new Error("Unsupported Cascade Git graph format (expected 0.7 snapshot)");
  }
  const events = eventsText.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const byNode = new Map(), eventIds = new Set();
  let previousClock = -1;
  for (const event of events) {
    if (!record(event) || typeof event.id !== "string" || eventIds.has(event.id) ||
        typeof event.type !== "string" || !record(event.data) || !finite(event.timestamp) ||
        !Number.isSafeInteger(event.logical_ts) || event.logical_ts <= previousClock ||
        event.logical_ts > graph.lamport) throw new Error("Invalid or inconsistent retained event log");
    iso(event.timestamp);
    eventIds.add(event.id);
    previousClock = event.logical_ts;
    if (typeof event.data.node_id === "string") {
      const list = event.type === "node_added" ? [] : byNode.get(event.data.node_id) || [];
      list.push({ type: event.type, at: iso(event.timestamp),
        agent: optionalText(event.data.agent_id, "event agent"),
        reason: optionalText(event.data.reason, "event reason") });
      byNode.set(event.data.node_id, list);
    }
  }
  const nodes = new Map();
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (!record(node) || node.id !== id || !id || !states.has(node.state)) {
      throw new Error(`Invalid node or unknown state: ${id}`);
    }
    const context = node.context ?? {};
    if (!record(context)) throw new Error(`Invalid context: ${id}`);
    const critical = context.critical ?? {};
    if (!record(critical)) throw new Error(`Invalid critical context: ${id}`);
    const provenance = context.provenance ?? {};
    if (!record(provenance)) throw new Error(`Invalid provenance: ${id}`);
    const agent = optionalText(node.agent_id, "agent_id");
    const reservedFor = optionalText(node.reserved_for, "reserved_for");
    if (node.task_input != null || node.publication != null) {
      const input = node.task_input, publication = node.publication;
      if (!record(input) || input.schema_version !== 1 || !record(input.brief) ||
          !/^[a-f0-9]{64}$/.test(input.brief_sha256) || typeof input.publication_id !== "string" ||
          ["title", "goal", "context", "acceptance", "baseline"].some(key => typeof input.brief[key] !== "string" || !input.brief[key].trim()) ||
          input.brief.requiredTier !== node.required_tier || !Array.isArray(input.brief.dependencies) ||
          !record(publication) || typeof publication.publisher !== "string" || !publication.publisher ||
          !finite(publication.published_at) || publication.published_at < 0 || publication.protected_until !== publication.published_at + 300) {
        throw new Error(`Invalid versioned task input or publication: ${id}`);
      }
    }
    if (node.required_tier != null && !["lite", "pro", "max"].includes(node.required_tier)) {
      throw new Error(`Unsupported required tier: ${id}`);
    }
    let leaseExpiresAt = null;
    if (node.state === "ACTIVE") {
      if (!agent || !Number.isSafeInteger(node.claim_token) || node.claim_token < 1 ||
          node.claim_token > graph.epoch || !finite(node.claimed_at) ||
          (node.timeout != null && (!finite(node.timeout) || node.timeout <= 0))) {
        throw new Error(`Incomplete ACTIVE lease: ${id}`);
      }
      if (node.timeout != null) leaseExpiresAt = iso(node.claimed_at + node.timeout);
    }
    const nodeEvents = byNode.get(id) || [];
    // Worker reports carry the published candidate separately from the context
    // producer's Git ref. Do not offer the producer checkout as a game build.
    let deliveryCommit = null;
    if (record(critical.worker) && critical.worker.publication_verified === true && typeof critical.worker.commit === "string" && /^[a-f0-9]{40}$/.test(critical.worker.commit)) {
      deliveryCommit = critical.worker.commit;
    } else if (critical.publication_verified === true && typeof critical.final_sha === "string" && /^[a-f0-9]{40}$/.test(critical.final_sha) && critical.readback_sha === critical.final_sha) {
      deliveryCommit = critical.final_sha;
    }
    // Completion clears agent_id in Cascade. Retained claim events can name the
    // contributor, but a reservation alone must never be shown as proof of work.
    const lastClaim = nodeEvents.findLast(event => event.type === "task_claimed");
    nodes.set(id, {
      id, title: node.task_input ? redact(node.task_input.brief.title) : typeof critical.title === "string" && critical.title.trim() ? redact(critical.title) : id, state: node.state,
      ...(node.task_input ? { taskInput: node.task_input, publication: node.publication } : {}),
      owner: agent || (node.state === "COMPLETED" ? lastClaim?.agent : null) || null,
      reservedFor, tier: node.required_tier ?? null, leaseExpiresAt,
      summary: optionalText(context.summary, "summary") || "",
      gitRef: optionalText(provenance.git_ref, "git_ref"),
      artifactRef: optionalText(context.artifacts_ref, "artifacts_ref"), deliveryCommit,
      ...executionObservation(critical.execution_observation),
      dependencies: [], events: nodeEvents.slice(-20),
    });
  }
  const outgoing = new Map([...nodes.keys()].map(id => [id, []]));
  const degree = new Map([...nodes.keys()].map(id => [id, 0]));
  const edgeKeys = new Set();
  for (const edge of graph.edges) {
    if (!record(edge) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) {
      throw new Error("Dependency references a missing node or itself");
    }
    if (typeof edge.expectation !== "string" || !edge.expectation.trim() ||
        typeof edge.promise !== "string" || !edge.promise.trim()) throw new Error("Missing dependency contract");
    const key = JSON.stringify([edge.from, edge.to]);
    if (edgeKeys.has(key)) throw new Error("Duplicate dependency");
    edgeKeys.add(key);
    const parent = nodes.get(edge.from);
    nodes.get(edge.to).dependencies.push({ id: parent.id, title: parent.title, state: parent.state,
      expectation: optionalText(edge.expectation, "expectation") || "",
      promise: optionalText(edge.promise, "promise") || "" });
    outgoing.get(edge.from).push(edge.to);
    degree.set(edge.to, degree.get(edge.to) + 1);
  }
  const queue = [...nodes.keys()].filter(id => degree.get(id) === 0).sort(), order = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const next of outgoing.get(id)) {
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.size) throw new Error("Task dependencies contain a cycle");
  const visible = new Set([...nodes.values()].filter(node =>
    !["COMPLETED", "CANCELLED"].includes(node.state) ||
    ["deferred", "blocked", "integrated_local"].includes(node.executionObservation?.status)).map(node => node.id));
  // Keep real ancestors with ongoing work; fold unrelated historical reports.
  const ancestors = [...visible];
  for (let i = 0; i < ancestors.length; i++) {
    for (const dependency of nodes.get(ancestors[i]).dependencies) {
      if (!visible.has(dependency.id)) { visible.add(dependency.id); ancestors.push(dependency.id); }
    }
  }
  return { revision, fetchedAt, project, nodes: [...nodes.values()],
    flow: order.filter(id => visible.has(id)), history: order.filter(id => !visible.has(id)),
    lastEventAt: events.length ? iso(events.at(-1).timestamp) : null };
}

async function createReader({ remote, namespace, project = namespace, timeoutSeconds = 30 }) {
  if (typeof remote !== "string" || !remote || remote.startsWith("-") || /[\x00-\x1f]/.test(remote)) {
    throw new Error("--remote must be a Git URL or local repository path");
  }
  if (typeof namespace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace) || namespace.includes("..") || namespace.endsWith(".lock")) {
    throw new Error("Invalid Cascade namespace");
  }
  const env = { ...process.env };
  const localEnv = await runProcess("git", ["rev-parse", "--local-env-vars"], { timeoutSeconds });
  if (localEnv.code !== 0) throw new Error(`Cannot identify Git repository environment: ${localEnv.stderr}`);
  for (const key of localEnv.stdout.trim().split("\n")) delete env[key];
  // Git does not include its server-side namespace in --local-env-vars.
  // Local transports inherit it too, which would read a different remote ref.
  delete env.GIT_NAMESPACE;
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-kit-flow-"));
  const git = async args => {
    const result = await runProcess("git", ["--git-dir", cache, "-c", "protocol.ext.allow=never", ...args], { timeoutSeconds, env });
    if (result.code !== 0) throw new Error(`Git ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
  };
  let closed = false, pending = null;
  const close = async () => {
    closed = true;
    if (pending) await pending.catch(() => {});
    await fs.rm(cache, { recursive: true, force: true });
  };
  try { await git(["init", "--bare", "--quiet", cache]); }
  catch (error) { await close(); throw error; }
  return {
    close,
    read() {
      if (closed) return Promise.reject(new Error("Snapshot reader is closed"));
      if (pending) return pending;
      pending = (async () => {
        // Keep a local ref so Git can negotiate objects already held by this reader.
        // State compaction can replace ancestry; the cache must follow that ref too.
        await git(["fetch", "--quiet", "--no-tags", "--depth=1", "--", remote,
          `+refs/heads/cascade-state/${namespace}:refs/remotes/cascade/source`]);
        const revision = (await git(["rev-parse", "--verify", "refs/remotes/cascade/source^{commit}"])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid fetched Git revision");
        // Pin both reads to the OID, never the moving ref or a checked-out file.
        const graph = await git(["show", `${revision}:data/graph.json`]);
        const events = await git(["show", `${revision}:data/events.jsonl`]);
        return projectSnapshot(graph, events, { revision, fetchedAt: new Date().toISOString(), project });
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createReader, projectSnapshot };
