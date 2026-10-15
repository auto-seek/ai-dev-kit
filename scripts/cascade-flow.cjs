#!/usr/bin/env node
"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { createReader } = require("./cascade-flow/snapshot.cjs");
const { redact } = require("./cascade-process.cjs");

async function startViewer({ reader, port = 4317, refreshMs = 15000 }) {
  const assets = new Map();
  for (const [route, file, type] of [
    ["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
    ["/layout.js", "layout.js", "text/javascript"], ["/vendor/dagre-3.1.1.esm.js", "vendor/dagre-3.1.1.esm.js", "text/javascript"],
  ]) assets.set(route, { body: await fs.readFile(path.join(__dirname, "cascade-flow", file)), type });
  let state = { status: "loading", refreshing: false, checkedAt: null, error: null, snapshot: null };
  let pending = null, completedAt = 0;
  const refresh = () => {
    if (pending) return pending;
    state.refreshing = true;
    pending = reader.read().then(snapshot => {
      state = { status: "fresh", refreshing: false, checkedAt: new Date().toISOString(), error: null, snapshot };
    }).catch(error => {
      state = { ...state, status: "error", refreshing: false, checkedAt: new Date().toISOString(), error: redact(error.message, true) };
    }).finally(() => { pending = null; completedAt = Date.now(); });
    return pending;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) {
      res.writeHead(403); res.end("Local same-origin access only"); return;
    }
    if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end("Read-only viewer"); return; }
    if (req.url === "/api/snapshot") {
      if (!pending && (!completedAt || Date.now() - completedAt >= refreshMs)) void refresh();
      res.writeHead(state.status === "error" ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(state)); return;
    }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8` }); res.end(asset.body);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
      if (pending) await pending;
      await reader.close();
    } };
}

async function main() {
  const { values } = parseArgs({ options: {
    remote: { type: "string" }, namespace: { type: "string" }, title: { type: "string" },
    port: { type: "string", default: "4317" }, timeout: { type: "string", default: "30" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: ai-dev-kit-flow --remote <Git URL/path> --namespace <name> [--title <name>] [--port 4317] [--timeout 30]\nRead-only local viewer; requires Node >= 22 and Git. Binds only to 127.0.0.1."); return;
  }
  const port = Number(values.port), timeoutSeconds = Number(values.timeout);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 180) throw new Error("Timeout must be in (0, 180] seconds");
  const reader = await createReader({ remote: values.remote, namespace: values.namespace, project: values.title || values.namespace, timeoutSeconds });
  let viewer;
  try { viewer = await startViewer({ reader, port }); }
  catch (error) { await reader.close(); throw error; }
  console.log(`Cascade task flow: ${viewer.url}\nRead-only Git snapshots. Ctrl+C stops the viewer.`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await viewer.close();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}

module.exports = { startViewer };
if (require.main === module) main().catch(error => { console.error(`cascade-flow: ${redact(error.message, true)}`); process.exitCode = 1; });
