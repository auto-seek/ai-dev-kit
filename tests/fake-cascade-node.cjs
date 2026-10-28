#!/usr/bin/env node
// Stand-in for skills/cascade-center-agent/scripts/cascade-node-client.cjs in
// the gate suite: `--config FILE thread --task ID` answers from the config's
// "tasks" map ({id: state}) the way the center's node API does; an unknown id
// is the center's 404, and "fail" in the config makes every call fail.
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const config = JSON.parse(fs.readFileSync(value("--config"), "utf8"));
if (config.fail) {
  process.stderr.write(`cascade-node-client: ${config.fail}\n`);
  process.exit(1);
}
if (!args.includes("thread")) {
  process.stderr.write("fake-cascade-node: only thread is implemented\n");
  process.exit(2);
}
const id = value("--task");
const state = config.tasks?.[id];
if (!state) {
  process.stderr.write("cascade-node-client: Center HTTP 404: 当前中心没有此任务\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ task: { id, state, owner: null }, followers: [], messages: [], nextCursor: 0 }));
