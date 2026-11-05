#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");
const { parseArgs } = require("node:util");
const { createInterface } = require("node:readline/promises");
const { createClient } = require("./cascade-portal-client.cjs");
const { createNodeClient } = require("./cascade-node-client.cjs");
const { HARNESS } = require("./cascade-portal/store.cjs");
const { redact } = require("./cascade-process.cjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid() &&
    !(stat.mode & 0o077)
  );
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
  origin = await configuredOrigin(origin, directory);
  if (origin === undefined)
    throw new Error("Center address is required: use the copied ID@origin, --origin or CASCADE_CENTER_ORIGIN");
  if (
    !/^project_[A-Za-z0-9_-]{32}$/.test(projectId || "") ||
    !["lite", "pro", "max"].includes(level)
  )
    throw new Error("Enter a valid project ID and lite, pro or max");
  if (harness !== undefined && !HARNESS.test(harness))
    throw new Error("--harness must be a lowercase name such as codex, claude or antigravity");
  const url = URL.parse(origin) ?? {};
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new Error("An exact HTTPS center origin is required");
  directory = path.resolve(
    directory ||
      path.join(os.homedir(), ".cascade/agents", randomBytes(8).toString("hex")),
  );
  if (/[\r\n\0]/.test(directory) || !(await privateDirectory(directory)))
    throw new Error("Agent directory must be private");
  const pendingFile = path.join(directory, "enrollment.json"),
    tokenFile = path.join(directory, "token");
  let pending;
  try {
    pending = JSON.parse(await privateFile(pendingFile));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // The per-directory lock prevents two shells from registering the same directory as different agents.
    const lock = await fs.open(
      path.join(directory, ".setup-lock"),
      "wx",
      0o600,
    );
    try {
      try {
        await fs.access(tokenFile);
        throw new Error(
          "Incomplete local setup: use a new empty agent directory",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // The agent writes only through the center over HTTPS, so it registers no SSH key.
      pending = {
        origin,
        projectId,
        level,
        requestId: randomUUID(),
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
    const transport = await createClient({ origin, tokenFile });
    // A directory set up by an earlier version keeps the public key it registered, so the
    // center recognises the same enrollment and returns the same agent.
    const { origin: ignored, ...body } = pending;
    const enrolled = await transport.api("join", body);
    if (
      !enrolled.agent ||
      enrolled.agent.ownerKind !== "project" ||
      enrolled.agent.tier !== level ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(enrolled.agent.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(enrolled.centerId || "")
    )
      throw new Error("Center returned an invalid agent binding");
    const configFile = path.join(directory, "client.json");
    const config = {
      origin,
      tokenFile,
      centerId: enrolled.centerId,
      cacheDir: path.join(directory, "cache"),
    };
    const temp = path.join(directory, `.config-${randomUUID()}`);
    await fs.writeFile(temp, JSON.stringify(config, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, configFile);
    const client = await createNodeClient(config);
    // The center executes this agent's work only through its writer; reading the agent's
    // leases there checks the writer and the credential end to end.
    client.requireWriter();
    const leases = await client.api("execution/leases");
    if (leases.agent !== enrolled.agent.id)
      throw new Error("The center writer answered for another agent");
    const environment = `export CASCADE_NODE_CLIENT_CONFIG=${quote(configFile)}\n`;
    await fs.writeFile(path.join(directory, "environment.sh"), environment, {
      mode: 0o600,
    });
    // with-agent gave a supervised Cascade worker this agent's SSH identity for direct Git
    // writes. Those writes are gone: such a worker needs Cascade's center HTTPS mode.
    await fs.rm(path.join(directory, "with-agent"), { force: true });
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
      level ||= (await prompt.question("模型 level（lite/pro/max）：")).trim();
      if (await centerMissing())
        origin = (await prompt.question("中心地址（HTTPS，无路径）：")).trim();
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
