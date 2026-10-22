#!/usr/bin/env node
// fake-docker.cjs — a stateful stand-in for the subset of the Docker CLI that
// scripts/resource-lock.cjs drives for workstation pools, so many-process pool
// tests run without a Docker daemon. tests/workstation.test.cjs covers the same
// commands against real Docker. NOT a production tool.
//
// State lives in $FAKE_DOCKER_STATE: containers/<name>.json, images.txt (one
// image per line) and calls.log (one JSON argv per call).
//   info --format "{{.MemTotal}} {{.NCPU}}"   prints $FAKE_DOCKER_MEMTOTAL (default
//                                           8218034176, an 8 GB VM) and $FAKE_DOCKER_NCPU (10)
//   image inspect <image>                    exit 0 when listed in images.txt
//   build -t <image> ...                     appends <image> to images.txt
//   run -d --name <n> [--label k=v]... ... <image> [args]   creates <n>; a used name exits 125
//   exec <n> xdpyinfo                        exit 0 while <n> exists
//   exec <n> ws-run [options] -- <cmd...>    runs <cmd...> on the host with WS_CONTAINER=<n>
//   rm -f <n>...                             removes the named containers
//   ps -a [--filter label=k=v]... --format F prints "name\trunning\t<slot label>\t<token label>"
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const state = process.env.FAKE_DOCKER_STATE;
if (!state) { process.stderr.write("fake-docker: FAKE_DOCKER_STATE is not set\n"); process.exit(2); }
const args = process.argv.slice(2);
const containers = path.join(state, "containers");
fs.mkdirSync(containers, { recursive: true });
fs.appendFileSync(path.join(state, "calls.log"), `${JSON.stringify(args)}\n`);
const file = name => path.join(containers, `${name}.json`);
const images = () => { try { return fs.readFileSync(path.join(state, "images.txt"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const fail = (code, message) => { process.stderr.write(`${message}\n`); process.exit(code); };
const VALUED = new Set(["--name", "--label", "--cpus", "--memory", "--memory-swap", "-e", "--user", "-v", "-w", "--filter", "--format", "-t", "-f", "--build-arg"]);

function options(list) {
  const found = { labels: {}, filters: [], rest: [] };
  for (let i = 0; i < list.length; i++) {
    if (VALUED.has(list[i])) {
      const value = list[++i];
      if (list[i - 1] === "--label") { const at = value.indexOf("="); found.labels[value.slice(0, at)] = value.slice(at + 1); }
      else if (list[i - 1] === "--filter") found.filters.push(value);
      else found[list[i - 1]] = value;
    } else if (list[i].startsWith("-") && !found.rest.length) found[list[i]] = true;
    else found.rest.push(list[i]);
  }
  return found;
}

const [command, ...rest] = args;
switch (command) {
  case "info":
    process.stdout.write(`${process.env.FAKE_DOCKER_MEMTOTAL || "8218034176"} ${process.env.FAKE_DOCKER_NCPU || "10"}\n`);
    break;
  case "image":
    if (rest[0] !== "inspect") fail(2, `fake-docker: unsupported image ${rest[0]}`);
    if (!images().includes(rest[1])) fail(1, `Error: No such image: ${rest[1]}`);
    break;
  case "build":
    fs.appendFileSync(path.join(state, "images.txt"), `${options(rest)["-t"]}\n`);
    break;
  case "run": {
    const found = options(rest);
    const [image, ...cmd] = found.rest;
    if (!images().includes(image)) fail(125, `Unable to find image '${image}' locally`);
    try {
      fs.writeFileSync(file(found["--name"]), JSON.stringify({ name: found["--name"], image, cmd, labels: found.labels, args: rest }), { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") fail(125, `Conflict. The container name "/${found["--name"]}" is already in use`);
      throw error;
    }
    process.stdout.write(`fake-${found["--name"]}\n`);
    break;
  }
  case "exec": {
    const [name, ...cmd] = rest;
    if (!fs.existsSync(file(name))) fail(1, `Error response from daemon: No such container: ${name}`);
    if (cmd[0] === "xdpyinfo") break;
    const argv = cmd[0] === "ws-run" ? cmd.slice(cmd.indexOf("--") + 1) : cmd;
    const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env: { ...process.env, WS_CONTAINER: name } });
    process.exit(result.status ?? 1);
  }
  case "rm":
    for (const name of rest.filter(word => !word.startsWith("-"))) {
      try { fs.unlinkSync(file(name)); process.stdout.write(`${name}\n`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    break;
  case "ps": {
    const wanted = options(rest).filters.map(filter => filter.replace(/^label=/, ""));
    for (const entry of fs.readdirSync(containers)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(containers, entry), "utf8")); } catch { continue; }
      const match = wanted.every(pair => { const at = pair.indexOf("="); return data.labels[pair.slice(0, at)] === pair.slice(at + 1); });
      if (match) {
        process.stdout.write(`${data.name}\trunning\t${data.labels["ai-dev-kit.workstation.slot"] ?? ""}\t${data.labels["ai-dev-kit.workstation.token"] ?? ""}\n`);
      }
    }
    break;
  }
  default:
    fail(2, `fake-docker: unsupported command ${command}`);
}
