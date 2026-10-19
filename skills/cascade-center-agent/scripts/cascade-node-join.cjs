#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { parseArgs } = require("node:util");
const { createInterface } = require("node:readline/promises");
const { createClient } = require("./cascade-portal-client.cjs");
const { createNodeClient } = require("./cascade-node-client.cjs");
const { publicKey } = require("./cascade-portal/admission.cjs");
const { HARNESS } = require("./cascade-portal/store.cjs");
const { runProcess, redact } = require("./cascade-process.cjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function run(command, args, env) {
  const result = await runProcess(command, args, {
    timeoutSeconds: 180,
    ...(env ? { env } : {}),
  });
  if (result.code !== 0)
    throw new Error(`Setup command failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}
async function privateFile(filename) {
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    stat.size > 128 * 1024
  )
    throw new Error("Agent configuration must be a private regular file");
  return fs.readFile(filename, "utf8");
}
async function runtime(directory) {
  if (process.env.NODE_CASCADE_PYTHON) {
    const python = process.env.NODE_CASCADE_PYTHON;
    if (!path.isAbsolute(python))
      throw new Error("NODE_CASCADE_PYTHON must be absolute");
    await run(python, [
      "-c",
      "import importlib.metadata;assert importlib.metadata.version('cascade-auto')=='0.8.2+nodecollab.1'",
    ]);
    return python;
  }
  await run("python3", [
    "-c",
    "import sys;assert sys.version_info >= (3,11), 'Python >=3.11 is required'",
  ]);
  const dist = path.resolve(__dirname, "../deploy/cascade-runtime");
  const manifest = await fs.readFile(
    path.join(dist, "NODE_SHA256SUMS"),
    "utf8",
  );
  for (const line of manifest.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_+./-]+)$/.exec(line);
    if (!match || match[2].split("/").includes(".."))
      throw new Error("Invalid pinned runtime manifest");
    const actual = createHash("sha256")
      .update(await fs.readFile(path.join(dist, match[2])))
      .digest("hex");
    if (actual !== match[1])
      throw new Error("Pinned runtime checksum mismatch");
  }
  const venv = path.join(directory, "runtime"),
    python = path.join(venv, "bin/python");
  await run("python3", ["-m", "venv", venv]);
  await run(python, [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--find-links",
    path.join(dist, "node-dependencies"),
    path.join(dist, "cascade_auto-0.8.2+nodecollab.1-py3-none-any.whl"),
  ]);
  return python;
}
async function configuredOrigin(origin, directory) {
  if (origin !== undefined) return origin;
  if (process.env.CASCADE_CENTER_ORIGIN !== undefined)
    return process.env.CASCADE_CENTER_ORIGIN;
  if (directory) {
    try {
      return JSON.parse(await privateFile(path.join(directory, "enrollment.json"))).origin;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
// The portal copies "<project ID>@<center origin>"; project IDs never contain "@".
// A bare ID keeps the separate origin; there is no built-in center.
function projectAddress(value, origin) {
  const at = typeof value === "string" ? value.indexOf("@") : -1;
  if (at < 0) return { projectId: value, origin };
  const center = value.slice(at + 1);
  if (origin !== undefined && origin !== center)
    throw new Error("--origin differs from the center address in the project ID");
  return { projectId: value.slice(0, at), origin: center };
}
async function join({ projectId, level, origin, directory, harness }) {
  ({ projectId, origin } = projectAddress(projectId, origin));
  if (
    !/^project_[A-Za-z0-9_-]{32}$/.test(projectId || "") ||
    !["lite", "pro", "max"].includes(level)
  )
    throw new Error("Enter a valid project ID and lite, pro or max");
  if (harness !== undefined && !HARNESS.test(harness))
    throw new Error("--harness must be a lowercase name such as codex, claude or antigravity");
  origin = await configuredOrigin(origin, directory);
  if (origin === undefined)
    throw new Error("Center address is required: use the copied ID@origin, --origin or CASCADE_CENTER_ORIGIN");
  const url = URL.parse(origin) ?? {};
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new Error("An exact HTTPS center origin is required");
  directory = path.resolve(
    directory || path.join(os.homedir(), ".cascade/agents", randomUUID()),
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    /[\r\n\0]/.test(directory)
  )
    throw new Error("Agent directory must be private");
  const pendingFile = path.join(directory, "enrollment.json"),
    tokenFile = path.join(directory, "token"),
    key = path.join(directory, "id_ed25519");
  let pending;
  try {
    pending = JSON.parse(await privateFile(pendingFile));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // The per-directory lock prevents two shells from registering the same private key as different agents.
    const lock = await fs.open(
      path.join(directory, ".setup-lock"),
      "wx",
      0o600,
    );
    try {
      try {
        await fs.access(key);
        throw new Error(
          "Incomplete local setup: use a new empty agent directory",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "cascade-project-agent",
        "-f",
        key,
      ]);
      const pub = (await fs.readFile(`${key}.pub`, "utf8"))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      pending = {
        origin,
        projectId,
        level,
        requestId: randomUUID(),
        publicKey: publicKey(pub),
        token: randomBytes(32).toString("hex"),
      };
      await fs.writeFile(tokenFile, pending.token, { mode: 0o600, flag: "wx" });
      await fs.writeFile(pendingFile, JSON.stringify(pending), {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      await lock.close();
      await fs.unlink(path.join(directory, ".setup-lock"));
    }
  }
  try {
    if (
      pending.origin !== origin ||
      pending.projectId !== projectId ||
      pending.level !== level
    )
      throw new Error(
        "Resume requires the same project ID, level and center origin",
      );
    if ((await privateFile(tokenFile)).trim() !== pending.token)
      throw new Error("Local enrollment token changed");
    await privateFile(key);
    const python = await runtime(directory);
    const transport = await createClient({ origin, tokenFile });
    const { origin: ignored, ...body } = pending;
    const enrolled = await transport.api("join", body);
    const remote = new URL(enrolled.remote);
    if (
      remote.protocol !== "ssh:" ||
      remote.password ||
      !/^[a-z][a-z0-9-]*$/.test(remote.username) ||
      !/^[A-Za-z0-9.:-]+$/.test(remote.hostname) ||
      !/^\/[A-Za-z0-9/._-]+\.git$/.test(remote.pathname) ||
      remote.pathname.split("/").includes("..") ||
      remote.hash ||
      remote.search
    )
      throw new Error("Center returned an invalid SSH repository");
    publicKey(enrolled.hostKey);
    if (
      !enrolled.agent ||
      enrolled.agent.ownerKind !== "project" ||
      enrolled.agent.tier !== level ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(enrolled.agent.id)
    )
      throw new Error("Center returned an invalid agent binding");
    const hosts = path.join(directory, "known_hosts"),
      sshConfig = path.join(directory, "ssh_config"),
      configFile = path.join(directory, "client.json");
    const host =
      remote.port && remote.port !== "22"
        ? `[${remote.hostname}]:${remote.port}`
        : remote.hostname;
    await fs.writeFile(hosts, `${host} ${enrolled.hostKey}\n`, { mode: 0o600 });
    const sshPath = (value) =>
      '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    await fs.writeFile(
      sshConfig,
      `Host *\n  IdentityFile ${sshPath(key)}\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${sshPath(hosts)}\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ConnectTimeout 10\n  ServerAliveInterval 15\n  ServerAliveCountMax 2\n  ClearAllForwardings yes\n  RequestTTY no\n`,
      { mode: 0o600 },
    );
    const config = {
      origin,
      tokenFile,
      centerId: enrolled.centerId,
      remote: enrolled.remote,
      namespace: enrolled.namespace,
      cascadePython: python,
      cacheDir: path.join(directory, "cache"),
      sshConfig,
    };
    const temp = path.join(directory, `.config-${randomUUID()}`);
    await fs.writeFile(temp, JSON.stringify(config, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, configFile);
    const client = await createNodeClient(config);
    const ssh = `ssh -F ${quote(sshConfig)}`;
    const refs = await run(
      "git",
      [
        "ls-remote",
        "--exit-code",
        config.remote,
        `refs/heads/cascade-state/${config.namespace}`,
      ],
      { ...process.env, GIT_SSH_COMMAND: ssh },
    );
    if (!/^[a-f0-9]{40}\s+refs\/heads\/cascade-state\//.test(refs))
      throw new Error("Project Git state ref is unavailable");
    const environment = `export GIT_SSH_COMMAND=${quote(ssh)}\nexport CASCADE_NODE_CLIENT_CONFIG=${quote(configFile)}\n`;
    await fs.writeFile(path.join(directory, "environment.sh"), environment, {
      mode: 0o600,
    });
    // Existing supervisors inherit the same SSH identity, message binding and native lease protocol.
    await fs.writeFile(
      path.join(directory, "with-agent"),
      `#!/bin/sh\nset -eu\n${environment}exec "$@"\n`,
      { mode: 0o700 },
    );
    if (harness !== undefined) await client.api("agent-profile", { harness });
    // A signed-in project member confirms ownership by entering this short-lived code on the web.
    const ownerCode = enrolled.agent.owner
      ? null
      : await client.api("owner-code", {});
    return {
      agent: enrolled.agent.id,
      level,
      owner: enrolled.agent.owner,
      ...(harness !== undefined ? { harness } : {}),
      centerId: enrolled.centerId,
      configFile,
      environment: path.join(directory, "environment.sh"),
      ...(ownerCode
        ? { ownerConfirmation: { ...ownerCode, confirmAt: `${origin}/#projects` } }
        : {}),
      ready: true,
    };
  } catch (error) {
    throw new Error(
      `${error.message}. Resume with the same inputs and --directory ${directory}; do not create another agent for an uncertain response.`,
      { cause: error },
    );
  }
}
async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["project-id", "level", "origin", "directory", "harness"].map((k) => [
        k,
        { type: "string" },
      ]),
    ),
  });
  let projectId = values["project-id"],
    level = values.level,
    origin = values.origin;
  // A copied ID@origin names its center; a bare ID needs a configured one.
  const centerMissing = async () =>
    !projectId?.includes("@") &&
    (await configuredOrigin(origin, values.directory)) === undefined;
  if (!projectId || !level || (await centerMissing())) {
    if (!process.stdin.isTTY)
      throw new Error("Supply --project-id and --level, and configure the center with the copied ID@origin, --origin or CASCADE_CENTER_ORIGIN; or run interactively");
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      projectId ||= (await prompt.question("项目 ID（可含 @中心地址）：")).trim();
      if (await centerMissing())
        origin = (await prompt.question("中心地址（HTTPS，无路径）：")).trim();
      level ||= (await prompt.question("模型 level（lite/pro/max）：")).trim();
    } finally {
      prompt.close();
    }
  }
  console.log(
    JSON.stringify(
      await join({
        projectId,
        level,
        origin,
        directory: values.directory,
        harness: values.harness,
      }),
      null,
      2,
    ),
  );
}
module.exports = { join, projectAddress };
if (require.main === module)
  main().catch((error) => {
    console.error(`cascade-node-join: ${redact(error.message, true)}`);
    process.exitCode = 1;
  });
