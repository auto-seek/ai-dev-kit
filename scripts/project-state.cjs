#!/usr/bin/env node
// One checkout owns coordination config and workflow evidence for all its worktrees.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
function stateRoot(project) {
  const root = path.resolve(project);
  let common;
  try {
    common = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    // Pre-git bootstrap is an explicit supported project state. Other Git
    // failures (missing executable, corrupt repository, permissions) stay errors.
    if (/not a git repository/i.test(String(error.stderr))) return root;
    throw error;
  }
  const main = path.dirname(path.resolve(root, common));
  if (
    main !== root &&
    !fs.existsSync(path.join(main, ".ai-dev-kit", "profile.yml"))
  ) {
    throw new Error(
      `main worktree has no .ai-dev-kit/profile.yml: ${main}; bootstrap the main checkout first`,
    );
  }
  return main;
}
module.exports = { stateRoot };
if (require.main === module) {
  try {
    console.log(stateRoot(process.argv[2] || "."));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
