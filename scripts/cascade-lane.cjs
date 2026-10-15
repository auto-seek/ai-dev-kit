#!/usr/bin/env node
// Project-profile adapter for Cascade's native atomic reservation protocol.
// Canonical IDs and reserved_for are checked together by the engine transaction.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { stateRoot } = require("./project-state.cjs");
const { commandTimeoutSeconds, runCascade, runProcess, redact } = require("./cascade-process.cjs");

function fail(message) {
  console.error(`cascade-lane: ${redact(message, true)}`);
  process.exit(1);
}
function coordBlock(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  let inCoord = false,
    inCascade = false;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^coordination:\s*(?:#.*)?$/.test(raw)) {
      inCoord = true;
      inCascade = false;
      continue;
    }
    if (inCoord && /^[^\s#]/.test(raw)) inCoord = false;
    if (!inCoord) continue;
    const line = raw.replace(/\s+#.*$/, "");
    const m2 = line.match(/^  (\w+):\s*(.*)$/),
      m4 = line.match(/^    (\w+):\s*(.*)$/);
    if (m2 && m2[1] === "cascade" && !m2[2]) {
      inCascade = true;
      continue;
    }
    if (m2) {
      inCascade = false;
      values[m2[1]] = m2[2].replace(/^"|"$/g, "");
    } else if (m4 && inCascade)
      values[`cascade.${m4[1]}`] = m4[2].replace(/^"|"$/g, "");
  }
  return values;
}
function tier(value, flag) {
  if (value !== undefined && !["lite", "pro", "max"].includes(value))
    fail(`${flag} must be one of lite, pro, max`);
  return value;
}
function slugValue(value, flag) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))
    fail(`${flag} must be a canonical 1-200 character task slug without '@' or paths`);
  return value;
}
function agentValue(value, flag) {
  if (typeof value !== "string" || !value.trim() || /[@\u0000-\u001f\u007f]/.test(value))
    fail(`${flag} must be a nonempty agent ID without '@' or control characters`);
  return value.trim();
}
function textValue(value, flag) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail(`${flag} must contain nonempty text`);
  return value;
}
function jsonValue(value, flag) {
  try { return JSON.parse(value); }
  catch { fail(`${flag} must contain valid JSON`); }
}
function objectValue(value, flag) {
  const object = jsonValue(value, flag);
  if (!object || typeof object !== "object" || Array.isArray(object))
    fail(`${flag} must be a JSON object`);
  return object;
}
function leaseSeconds(value) {
  const seconds = Number(value);
  if (String(value).trim() === "" || !Number.isFinite(seconds) || seconds <= 0)
    fail("--timeout / cascade.lease_seconds must be finite positive seconds");
  return String(seconds);
}
async function main() {
  const options = Object.fromEntries([
    "profile", "agent", "role", "slug", "deps", "dependents", "expectations",
    "required-tier", "reserved-for", "agent-tier", "timeout", "token", "summary",
    "critical", "artifacts", "deliveries", "reason", "python", "dispatch", "failure-event", "op-id",
  ].map(key => [key, { type: "string" }]));
  options.open = { type: "boolean" };
  options.fail = { type: "boolean" };
  const parsed = parseArgs({ options, allowPositionals: true, strict: true, tokens: true });
  const args = parsed.values, command = parsed.positionals[0];
  const allowed = {
    add: ["slug", "deps", "dependents", "expectations", "required-tier", "open", "reserved-for"],
    claim: ["slug", "agent-tier", "timeout"],
    renew: ["slug", "token", "timeout"],
    release: ["slug", "token", "reason"],
    finish: ["slug", "token", "summary", "critical", "artifacts", "deliveries", "fail", "reason"],
    doctor: ["dispatch"],
    retry: ["slug", "failure-event", "op-id", "reason"],
  };
  if (parsed.positionals.length !== 1 || !Object.hasOwn(allowed, command))
    fail(
      "usage: cascade-lane.cjs --profile <profile.yml> --agent <id> [--python <absolute interpreter>] <add|claim|renew|release|finish|doctor|retry> [command options]",
    );
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === "option")) {
    if (seen.has(token.name)) fail(`duplicate option --${token.name}`);
    seen.add(token.name);
    if (!["profile", "agent", "role", "python", ...allowed[command]].includes(token.name))
      fail(`--${token.name} is not valid for ${command}`);
  }
  if (typeof args.profile !== "string" || !args.profile.trim())
    fail("--profile <path to .ai-dev-kit/profile.yml> is required");
  const agent = agentValue(args.agent, "--agent");
  if (args.python !== undefined) {
    if (!path.isAbsolute(args.python)) fail("--python must be the absolute path of the actual Cascade interpreter");
    try { fs.accessSync(args.python, fs.constants.X_OK); }
    catch { fail("--python must name an executable interpreter"); }
  }
  if (command === "doctor" && !args.python) fail("doctor requires --python to check the actual execution environment");
  const slug = args.slug === undefined ? undefined : slugValue(args.slug, "--slug");
  let root;
  try {
    root = stateRoot(path.resolve(path.dirname(args.profile), ".."));
  } catch (error) {
    fail(error.message);
  }
  const profile = path.join(root, ".ai-dev-kit", "profile.yml");
  if (!fs.existsSync(profile)) fail(`profile not found: ${profile}`);
  const tracked = coordBlock(profile),
    local = coordBlock(path.join(root, ".ai-dev-kit", "profile.local.yml"));
  const value = (key) => local[key] || tracked[key] || "";
  if (value("engine") !== "cascade")
    fail("coordination.engine must be cascade; run /ai-dev-kit-cascade-init");
  const role = args.role ?? value("role");
  if (!["self-serve", "orchestrator", "worker"].includes(role))
    fail("coordination.role must be self-serve, orchestrator, or worker");
  // Build and validate the complete native command before any coordination I/O.
  let call;
  if (command === "add") {
    if (!slug) fail("add requires --slug");
    if (role === "worker") fail("workers cannot publish tasks or reservations");
    if (args.open && role !== "orchestrator") fail("--open requires the orchestrator role");
    if (args.open && args["reserved-for"] !== undefined) fail("--open and --reserved-for are mutually exclusive");
    const owner = args["reserved-for"] === undefined ? agent : agentValue(args["reserved-for"], "--reserved-for");
    if (role !== "orchestrator" && owner !== agent) fail("only an orchestrator can reserve work for another agent");
    call = ["add-node", "--id", slug];
    if (!args.open) call.push("--reserved-for", owner);
    if (tier(args["required-tier"], "--required-tier") !== undefined)
      call.push("--required-tier", args["required-tier"]);
    const edges = new Set();
    for (const flag of ["deps", "dependents"]) {
      if (args[flag] === undefined) continue;
      const ids = args[flag].split(",").map(id => slugValue(id.trim(), `--${flag}`));
      for (const id of ids) {
        if (id === slug || edges.has(id)) fail("dependencies must be distinct and cannot name the new task itself");
        edges.add(id);
      }
      call.push(`--${flag}`, ids.join(","));
    }
    const contracts = args.expectations === undefined ? [] : jsonValue(args.expectations, "--expectations");
    if (!Array.isArray(contracts)) fail("--expectations must be a JSON array of node_id, expectation and promise objects");
    const contracted = new Set();
    for (const contract of contracts) {
      if (!contract || typeof contract !== "object" || Array.isArray(contract) ||
          Object.keys(contract).some(key => !["node_id", "expectation", "promise"].includes(key)))
        fail("each --expectations object must contain only node_id, expectation and promise");
      const id = slugValue(contract.node_id, "expectations.node_id");
      textValue(contract.expectation, "expectations.expectation");
      textValue(contract.promise, "expectations.promise");
      if (!edges.has(id) || contracted.has(id)) fail("--expectations must name each dependency/dependent exactly once");
      contracted.add(id);
    }
    if (contracted.size !== edges.size) fail("each dependency/dependent requires an expectation and promise in --expectations");
    if (args.expectations !== undefined) call.push("--expectations", JSON.stringify(contracts));
  } else if (command === "claim") {
    if (role === "self-serve" && !slug) fail("self-serve claim requires --slug");
    call = ["get-task", "--agent", agent, "--timeout", leaseSeconds(args.timeout ?? (value("cascade.lease_seconds") || "1800"))];
    if (slug) call.push("--task", slug);
    if (tier(args["agent-tier"], "--agent-tier") !== undefined)
      call.push("--agent-tier", args["agent-tier"]);
  } else if (command === "retry") {
    if (role !== "orchestrator") fail("retry requires the orchestrator role and an existing scoped retry authorization");
    if (!slug) fail("retry requires --slug");
    call = ["retry-task", "--task", slug, "--agent", agent,
      "--failure-event", textValue(args["failure-event"], "--failure-event"),
      "--op-id", textValue(args["op-id"], "--op-id"),
      "--reason", textValue(args.reason, "--reason")];
  } else if (command !== "doctor") {
    if (!slug || !/^[0-9]+$/.test(args.token || "") || BigInt(args.token) <= 0n)
      fail(`${command} requires --slug and a positive integer --token`);
    call = [command === "renew" ? "renew-task" : "finish-task", "--task", slug, "--agent", agent, "--token", args.token];
    if (command === "renew") {
      call.push("--timeout", leaseSeconds(args.timeout ?? (value("cascade.lease_seconds") || "1800")));
    } else if (command === "release" || args.fail) {
      if (["summary", "critical", "artifacts", "deliveries"].some(key => args[key] !== undefined))
        fail("failed/released work uses --reason, not successful delivery options");
      call.push(command === "release" ? "--release" : "--fail", "--reason", textValue(args.reason, "--reason"));
    } else {
      if (args.reason !== undefined) fail("--reason requires finish --fail or release");
      call.push("--success");
      for (const flag of ["summary", "artifacts"]) {
        if (args[flag] !== undefined) call.push(`--${flag}`, textValue(args[flag], `--${flag}`));
      }
      if (args.critical !== undefined) call.push("--critical", JSON.stringify(objectValue(args.critical, "--critical")));
      if (args.deliveries !== undefined) {
        const entries = Object.entries(objectValue(args.deliveries, "--deliveries"));
        if (!entries.length) fail("--deliveries must contain actual downstream delivery confirmations");
        for (const [id, text] of entries)
          call.push("--deliver", slugValue(id, "deliveries task ID"), textValue(text, "delivery text"));
      }
    }
  }
  const base = [];
  const storage = value("cascade.storage");
  const timeoutSeconds = commandTimeoutSeconds(storage, value("cascade.command_timeout_seconds") || undefined);
  const run = async commandArgs => {
    const result = args.python
      ? await runProcess(args.python, ["-B", "-m", "cascade.cli", ...commandArgs], { timeoutSeconds })
      : await runCascade(commandArgs, { timeoutSeconds });
    if (result.code !== 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.code);
    }
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout;
  };
  if (storage === "git") {
    const configured =
      process.env.AI_DEV_KIT_CASCADE_GIT_REMOTE || value("cascade.git_remote");
    if (!configured) fail("storage=git requires cascade.git_remote");
    let remote;
    try {
      remote = execFileSync(
        "git",
        ["-C", root, "remote", "get-url", configured],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      remote =
        path.isAbsolute(configured) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(configured) ||
        /^[^/]+@[^:]+:/.test(configured)
          ? configured
          : path.resolve(root, configured);
    }
    base.push("--git-remote", remote);
    const cache = value("cascade.git_cache");
    if (cache) base.push("--git-cache", path.resolve(root, cache));
  } else if (storage === "redis") {
    const url =
      process.env.AI_DEV_KIT_CASCADE_REDIS_URL || value("cascade.redis_url");
    if (!url) fail("storage=redis requires cascade.redis_url");
    base.push("--redis-url", url);
  } else if (storage === "file")
    base.push(
      "--storage",
      path.resolve(root, value("cascade.storage_path") || ".ai-dev-kit/cascade"),
    );
  else fail("coordination.cascade.storage must be file, git, or redis");
  if (storage !== "file") {
    if (!value("cascade.namespace")) fail("Git/Redis coordination requires an explicit cascade.namespace");
    base.push("--namespace", value("cascade.namespace"));
  }

  if (command === "doctor") {
    const doctorArgs = ["-B", path.join(__dirname, "cascade-doctor.py"), "--agent", agent,
      "--min-version", value("cascade.min_version") || ">=0.8.0", ...base];
    if (args.dispatch !== undefined) doctorArgs.push("--dispatch", path.resolve(args.dispatch));
    const result = await runProcess(args.python, doctorArgs, { timeoutSeconds });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }

  const version = (await run(["--version"])).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!version || (+version[1] === 0 && +version[2] < 7))
    fail("Cascade >=0.7.0 is required for atomic reserved_for ownership");
  const configuredMinimum = value("cascade.min_version");
  const minimum = configuredMinimum.match(/^(?:>=)?\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (configuredMinimum && !minimum) fail("cascade.min_version must be major.minor[.patch], optionally prefixed with >=");
  const below = expected => {
    for (let i = 0; i < 3; i++) {
      const difference = Number(version[i + 1]) - expected[i];
      if (difference) return difference < 0;
    }
    return false;
  };
  if (minimum && below(minimum.slice(1).map(part => Number(part ?? 0)))) fail("Cascade is below the project's cascade.min_version; repair this runtime before accessing the center");
  if (command === "retry" && below([0, 8, 0])) fail("retry requires Cascade >=0.8.0 and shared namespace protocol compatibility");
  // This read checks migration only. The engine decides add/claim atomically.
  let nodes;
  try {
    const doc = JSON.parse(await run([...base, "list-nodes"]));
    if (doc.success !== true || !Array.isArray(doc.data?.nodes))
      throw new Error("missing successful nodes payload");
    nodes = doc.data.nodes;
    if (
      nodes.some(
        (node) =>
          typeof node.id !== "string" ||
          !Object.hasOwn(node, "reserved_for") ||
          (node.reserved_for !== null && typeof node.reserved_for !== "string"),
      )
    )
      throw new Error("missing native reserved_for contract");
  } catch (error) {
    fail(
      `list-nodes did not return the Cascade 0.7 JSON contract: ${error.message}`,
    );
  }
  if (nodes.some((node) => node.id.includes("@")))
    fail(
      "legacy @lane nodes require explicit migration to canonical IDs with reserved_for; see docs/coordination-0.7-migration.md",
    );

  process.stdout.write(await run([...base, ...call]));
}

main().catch(error => fail(error.message));
