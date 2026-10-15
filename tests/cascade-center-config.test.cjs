// Perspective: an agent joining the center chosen by its project owner.
// Invariant: registration only reaches the configured HTTPS origin, and a retry
// keeps the same identity and center. Missing configuration never selects a site.
// Goal: prevent accidental registration or credential reuse in another center.
// Migration: retain these CLI/TLS boundary checks with the packaged join client.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { runProcess } = require("../scripts/cascade-process.cjs");

const skill = path.resolve(__dirname, "../skills/cascade-center-agent");
const script = path.join(skill, "scripts/cascade-node-join.cjs");
const projectId = "project_0123456789abcdefghijklmnopqrstuv";

test("packaged join CLI selects a configured center and preserves retry identity", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-center-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  const run = (command, args, extra = {}) => runProcess(command, args, {
    timeoutSeconds: 60, env: { ...env, ...extra },
  });
  const ok = result => assert.equal(result.code, 0, result.stderr);
  const python = path.join(root, "runtime/bin/python");
  ok(await run("python3", ["-m", "venv", path.join(root, "runtime")]));
  ok(await run(python, ["-m", "pip", "install", "--no-index", "--find-links",
    path.join(skill, "deploy/cascade-runtime/node-dependencies"),
    path.join(skill, "deploy/cascade-runtime/cascade_auto-0.8.2+nodecollab.1-py3-none-any.whl")]));
  const cert = path.join(root, "server.pem"), key = path.join(root, "server.key");
  ok(await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-sha256", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext",
    "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert]));
  env.NODE_CASCADE_PYTHON = python;
  env.NODE_EXTRA_CA_CERTS = cert;
  const centers = [];
  for (let i = 0; i < 2; i++) {
    const requests = [];
    const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, method: req.method, body: JSON.parse(body), authorization: req.headers.authorization });
      // Registration rejection ends the journey before Git; the real client,
      // runtime check, private files and TLS transport still execute.
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Fixture admission closed" }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    centers.push({ origin: `https://127.0.0.1:${server.address().port}`, requests });
  }
  const [a, b] = centers;
  const join = (directory, args = [], extra = {}) => run(process.execPath, [script,
    "--project-id", projectId, "--level", "pro", "--directory", directory, ...args], extra);
  const pending = directory => fs.readFile(path.join(directory, "enrollment.json"), "utf8");
  const rejected = result => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Center HTTP 409: Fixture admission closed/);
    assert.match(result.stderr, /Resume with the same inputs/);
  };

  await t.test("missing and invalid origins fail before creating an identity", async () => {
    for (const [index, origin] of [undefined, "", "http://127.0.0.1", `${a.origin}/`,
      `${a.origin}/flow`, `${a.origin}?x=1`, `${a.origin}#flow`, "https://user:pass@127.0.0.1", "bad-url"].entries()) {
      const directory = path.join(root, `invalid-${index}`);
      const result = await join(directory, origin === undefined ? [] : ["--origin", origin]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, origin === undefined ? /configure the center/ : /exact HTTPS center origin/);
      await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    }
    assert.equal(a.requests.length + b.requests.length, 0);
  });

  await t.test("programmatic join also requires an explicit or configured origin", async () => {
    const directory = path.join(root, "api-no-origin");
    const result = await run(process.execPath, ["-e",
      "require(process.argv[1]).join({projectId:process.argv[3],level:'pro',directory:process.argv[2]}).catch(error=>{console.error(error.message);process.exitCode=1;});",
      script, directory, projectId]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Center address is required/);
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    assert.equal(a.requests.length + b.requests.length, 0);
  });

  const saved = path.join(root, "saved-agent");
  await t.test("environment config reaches that HTTPS server and is saved", async () => {
    rejected(await join(saved, [], { CASCADE_CENTER_ORIGIN: a.origin }));
    assert.equal(a.requests.length, 1);
    assert.equal(b.requests.length, 0);
    const request = a.requests[0];
    assert.equal(request.path, "/api/agent/join");
    assert.equal(request.method, "POST");
    assert.equal(request.body.projectId, projectId);
    assert.equal(request.body.level, "pro");
    assert.equal(JSON.parse(await pending(saved)).origin, a.origin);
  });
  await t.test("same-directory retry recovers origin without registering a new identity", async () => {
    const before = await pending(saved);
    rejected(await join(saved));
    assert.equal(a.requests.length, 2);
    assert.deepEqual(a.requests[1], a.requests[0]);
    assert.equal(await pending(saved), before);
  });
  await t.test("explicit origin overrides environment for a new instance", async () => {
    const directory = path.join(root, "second-agent");
    rejected(await join(directory, ["--origin", b.origin], { CASCADE_CENTER_ORIGIN: a.origin }));
    assert.equal(b.requests.length, 1);
    assert.equal(a.requests.length, 2);
    assert.equal(JSON.parse(await pending(directory)).origin, b.origin);
  });
  await t.test("changing an existing center is rejected without sending credentials", async () => {
    const before = await pending(saved);
    for (const [args, extra] of [[["--origin", b.origin], {}], [[], { CASCADE_CENTER_ORIGIN: b.origin }]]) {
      const result = await join(saved, args, extra);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Resume requires the same project ID, level and center origin/);
    }
    assert.equal(await pending(saved), before);
    assert.equal(a.requests.length, 2);
    assert.equal(b.requests.length, 1);
  });
  await t.test("broken private configuration is reported instead of selecting another center", async () => {
    const directory = path.join(root, "broken-agent");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, "enrollment.json"), "{broken", { mode: 0o600 });
    const result = await join(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /JSON/);
    assert.deepEqual(await fs.readdir(directory), ["enrollment.json"]);
    assert.equal(a.requests.length + b.requests.length, 3);
  });
});
