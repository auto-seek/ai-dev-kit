// Perspective: test users authenticating through the real password verifier.
// Invariant: synthetic accounts live only in a private, disposable fixture.
// Goal: exercise production login, never inject a trusted employee identity.
// Migration: keep real htpasswd verification when session plumbing changes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const PASSWORD = "Local-fixture-login-2026";
const HTPASSWD = process.env.PORTAL_TEST_HTPASSWD || (process.platform === "darwin" ? "/usr/sbin/htpasswd" : "/usr/bin/htpasswd");
function authFixture(root, names = ["alice", "bob"]) {
  const usersFile = path.join(root, "users.htpasswd");
  const records = names.map(name => execFileSync(HTPASSWD, ["-niB", "-C", "4", name], {
    input: Buffer.from(PASSWORD), encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
  }).trim()).join("\n") + "\n";
  fs.writeFileSync(usersFile, records, { mode: 0o600 });
  return { usersFile, htpasswdPath: HTPASSWD };
}
module.exports = { authFixture, PASSWORD, HTPASSWD };
