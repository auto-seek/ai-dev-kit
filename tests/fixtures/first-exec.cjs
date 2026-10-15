// macOS Gatekeeper blocks the first exec of a newly written script while syspolicyd
// looks up a notarization ticket online; that took 0.1-4.4 s on a maintainer host.
// A test that puts a fresh script under a seconds-scale deadline runs it once through
// this helper first, so the deadline measures the subject and not the host policy check.
"use strict";
const { spawnSync } = require("node:child_process");
const SETTLE = "AIDK_SETTLE_FIRST_EXEC";
// First statement of generated Node fixture scripts: the settling run exits before fixture work.
const settleGuard = `if (process.env.${SETTLE}) process.exit(0);`;
function settleFirstExec(file, args = [], env = process.env) {
  const result = spawnSync(file, args, { env: { ...env, [SETTLE]: "1" }, stdio: "ignore", timeout: 60000 });
  if (result.error) throw result.error;
}
module.exports = { settleFirstExec, settleGuard };
