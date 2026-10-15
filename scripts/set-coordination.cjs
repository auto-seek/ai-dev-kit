#!/usr/bin/env node
// set-coordination.cjs — idempotently write the `coordination:` block into a
// project's .ai-dev-kit/profile.yml. Used by bootstrap/init-skill.sh
// (--coordination) and by the /ai-dev-kit-cascade-init wizard. Re-running
// replaces the existing block in place — it never duplicates it.

"use strict";

const fs = require("node:fs");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const profilePath = args.profile;
if (!profilePath) {
  console.error("set-coordination: --profile <path> is required");
  process.exit(1);
}

const engine = (args.engine || "cascade").trim();
if (engine !== "cascade" && engine !== "ledger") {
  console.error(`set-coordination: --engine must be cascade or ledger (got ${engine})`);
  process.exit(1);
}

// Default role is self-serve (0.9.0): the agent plans its own work items into
// the shared graph via scripts/cascade-lane.cjs and executes them itself. It
// uses the engine's canonical ID + reserved_for transaction, so it is the default
// for the common single-agent-per-checkout setup. Pass --role orchestrator
// (graph owner, one per namespace) or --role worker (claims unreserved nodes)
// to opt into the multi-agent split.
const VALID_ROLES = ["self-serve", "orchestrator", "worker"];
const role = (args.role || "self-serve").trim();
if (!VALID_ROLES.includes(role)) {
  console.error(`set-coordination: --role must be one of ${VALID_ROLES.join(", ")} (got ${role})`);
  process.exit(1);
}
const storage = (args.storage || "file").trim();
const VALID_STORAGE = ["file", "git", "redis"];
if (!VALID_STORAGE.includes(storage)) {
  console.error(`set-coordination: --storage must be one of ${VALID_STORAGE.join(", ")} (got ${storage})`);
  process.exit(1);
}
const storagePath = (args["storage-path"] || ".ai-dev-kit/cascade").trim();
const gitRemote = (args["git-remote"] || "").trim();
const gitCache = (args["git-cache"] || "").trim();
const redisUrl = (args["redis-url"] || "").trim();
const namespace = (args.namespace || "default").trim();
const namespaceGiven = args.namespace !== undefined;
const minVersion = (args["min-version"] || ">=0.8.0").trim();
// --local: write a machine-local overlay block (typically to
// .ai-dev-kit/profile.local.yml, which must stay gitignored). The gate reads
// the overlay per-key over the tracked profile, so the tracked baseline keeps
// redis_url: "" and the real URL never reaches git. The overlay must also
// carry `storage: redis` — a URL override alone is dead config when the
// tracked baseline says `storage: file`, because the gate selects the backend
// from cascade.storage before it ever reads cascade.redis_url.
const localOverlay = args.local === true;
if (localOverlay && !redisUrl) {
  console.error("set-coordination: --local requires --redis-url (the overlay exists to point this machine at redis)");
  process.exit(1);
}

function renderBlock() {
  if (localOverlay) {
    // Comment sits INSIDE the block so the strip-and-replace pass swaps it
    // atomically on re-runs instead of stacking copies above the block.
    const lines = [
      "coordination:",
      "  # Machine-local coordination overrides — NEVER commit this file.",
      "  cascade:",
      "    storage: redis",
      `    redis_url: "${redisUrl}"`,
    ];
    // Only an EXPLICIT --namespace lands in the overlay: writing the default
    // would silently shadow the tracked profile's namespace per-key.
    if (namespaceGiven) lines.push(`    namespace: ${namespace}`);
    return lines.join("\n");
  }
  const lines = [
    "coordination:",
    `  engine: ${engine}`,
    `  role: ${role}`,
    "  cascade:",
    `    storage: ${storage}`,
    `    storage_path: ${storagePath}`,
    `    git_remote: "${gitRemote}"`,
    `    git_cache: "${gitCache}"`,
    `    redis_url: "${redisUrl}"`,
    `    namespace: ${namespace}`,
    `    min_version: "${minVersion}"`,
  ];
  return lines.join("\n");
}

let text = "";
if (fs.existsSync(profilePath)) {
  text = fs.readFileSync(profilePath, "utf8");
}

// Strip any existing top-level coordination: block (heading through the line
// before the next top-level key, or EOF). Leading comment lines directly above
// the block that describe it are left untouched — they are harmless.
const lines = text.split(/\r?\n/);
const kept = [];
let skipping = false;
for (const line of lines) {
  if (!skipping && /^coordination:\s*(?:#.*)?$/.test(line)) {
    skipping = true;
    continue;
  }
  if (skipping) {
    // A new top-level key (non-indented, non-comment, non-blank) ends the block.
    if (/^[^\s#]/.test(line)) {
      skipping = false;
      kept.push(line);
    }
    // otherwise: still inside the block (indented / blank / comment) — drop it
    continue;
  }
  kept.push(line);
}

let body = kept.join("\n").replace(/\s+$/, "");
const block = renderBlock();
const output = body.length > 0 ? `${body}\n\n${block}\n` : `${block}\n`;

fs.writeFileSync(profilePath, output);
if (localOverlay) {
  const keys = namespaceGiven ? "storage=redis, redis_url, namespace" : "storage=redis, redis_url";
  console.log(`set-coordination: wrote machine-local overlay (${keys}) to ${profilePath}`);
} else {
  console.log(`set-coordination: wrote engine=${engine} storage=${storage} role=${role} to ${profilePath}`);
}
