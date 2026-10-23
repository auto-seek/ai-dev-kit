#!/usr/bin/env node
// fake-docker.cjs — a stateful stand-in for the subset of the Docker CLI that
// scripts/resource-lock.cjs drives for workstation pools, so many-process pool
// tests run without a Docker daemon. tests/workstation.test.cjs covers the same
// commands against real Docker. NOT a production tool.
//
// State lives in $FAKE_DOCKER_STATE: containers/<name>.json, images.txt (one
// image per line, optionally "<image>\t<label k=v>") and calls.log (one JSON
// argv per call).
//   info --format "{{.MemTotal}} {{.NCPU}}"   prints $FAKE_DOCKER_MEMTOTAL (default
//                                           8218034176, an 8 GB VM) and $FAKE_DOCKER_NCPU (10)
//   image inspect [--format F] <image>       exit 0 when listed in images.txt; with --format
//                                           prints a stable fake image id
//   image ls --filter reference=<i>|label=<k=v> --format F   "1.81GB" per reference match,
//                                           "<image>" per label match
//   image rm <image>                         removes it from images.txt
//   build -t <image> [--label k=v] ...       appends <image> (and its label) to images.txt
//   run --rm --entrypoint df <image> -Pk /   df output with $FAKE_DOCKER_DISK_FREE_KB free (default 400 GiB)
//   run -d --name <n> [--label k=v]... ... <image> [args]   creates <n>; a used name exits 125
//   exec <n> xdpyinfo                        exit 0 while <n> exists
//   exec <n> ws-run [options] -- <cmd...>    runs <cmd...> on the host with WS_CONTAINER=<n>
//   rm -f <n>...                             removes the named containers, after
//                                           $FAKE_DOCKER_RM_DELAY_MS (default 0)
//   ps -a [-s] [--filter label=k=v|ancestor=<i>]... --format F
//                                           prints "name\trunning\t<slot label>\t<token label>[\t4.05MB (virtual 1.34GB)]"
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
const imageLines = () => { try { return fs.readFileSync(path.join(state, "images.txt"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const images = () => imageLines().map(line => line.split("\t")[0]);
const fail = (code, message) => { process.stderr.write(`${message}\n`); process.exit(code); };
const VALUED = new Set(["--name", "--label", "--cpus", "--memory", "--memory-swap", "-e", "--user", "-v", "-w", "--filter", "--format", "-t", "-f", "--build-arg", "--entrypoint"]);

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
  case "image": {
    const [verb, ...more] = rest;
    if (verb === "inspect") {
      const image = options(more).rest[0];
      if (!images().includes(image)) fail(1, `Error: No such image: ${image}`);
      if (options(more)["--format"]) process.stdout.write(`sha256:${require("node:crypto").createHash("sha256").update(image).digest("hex")}\n`);
      break;
    }
    if (verb === "rm") {
      const keep = imageLines().filter(line => line.split("\t")[0] !== more[0]);
      fs.writeFileSync(path.join(state, "images.txt"), keep.map(line => `${line}\n`).join(""));
      process.stdout.write(`Untagged: ${more[0]}\n`);
      break;
    }
    if (verb !== "ls") fail(2, `fake-docker: unsupported image ${verb}`);
    for (const filter of options(more).filters) {
      if (filter.startsWith("reference=") && images().includes(filter.slice(10))) process.stdout.write("1.81GB\n");
      if (filter.startsWith("label=")) {
        for (const line of imageLines()) if (line.split("\t")[1] === filter.slice(6)) process.stdout.write(`${line.split("\t")[0]}\n`);
      }
    }
    break;
  }
  case "build": {
    const found = options(rest);
    const label = Object.entries(found.labels).map(([key, value]) => `${key}=${value}`)[0];
    fs.appendFileSync(path.join(state, "images.txt"), `${found["-t"]}${label ? `\t${label}` : ""}\n`);
    break;
  }
  case "run": {
    const found = options(rest);
    if (found["--rm"] && found["--entrypoint"] === "df") {
      const total = 474095688, free = Number(process.env.FAKE_DOCKER_DISK_FREE_KB || 419430400);
      process.stdout.write(`Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay ${total} ${total - free} ${free} 3% /\n`);
      break;
    }
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
    if (process.env.FAKE_DOCKER_RM_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DOCKER_RM_DELAY_MS));
    for (const name of rest.filter(word => !word.startsWith("-"))) {
      try { fs.unlinkSync(file(name)); process.stdout.write(`${name}\n`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    break;
  case "ps": {
    const found = options(rest);
    for (const entry of fs.readdirSync(containers)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(containers, entry), "utf8")); } catch { continue; }
      const match = found.filters.every(filter => {
        if (filter.startsWith("ancestor=")) return data.image === filter.slice(9);
        const pair = filter.replace(/^label=/, ""), at = pair.indexOf("=");
        return data.labels[pair.slice(0, at)] === pair.slice(at + 1);
      });
      if (match) {
        process.stdout.write(`${data.name}\trunning\t${data.labels["ai-dev-kit.workstation.slot"] ?? ""}\t${data.labels["ai-dev-kit.workstation.token"] ?? ""}` +
          `${found["-s"] ? "\t4.05MB (virtual 1.34GB)" : ""}\n`);
      }
    }
    break;
  }
  default:
    fail(2, `fake-docker: unsupported command ${command}`);
}
