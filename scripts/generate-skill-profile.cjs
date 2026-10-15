#!/usr/bin/env node
// Generate a lightweight ai-dev-kit v2 profile from repository signals.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage: node scripts/generate-skill-profile.cjs <project-path> [options]

Options:
  --out <file>        Write profile to file instead of stdout
  --name <name>       Override project name
  --type <type>       Override project type
  --profile <name>    Enforcement profile: light|balanced|strict (default: balanced)
`);
}

let projectPath = "";
let outFile = "";
let projectName = "";
let projectType = "auto";
let enforcementProfile = "balanced";

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg === "--out") {
    outFile = args[++index] ?? "";
  } else if (arg === "--name") {
    projectName = args[++index] ?? "";
  } else if (arg === "--type") {
    projectType = args[++index] ?? "auto";
  } else if (arg === "--profile") {
    enforcementProfile = args[++index] ?? "balanced";
  } else if (!projectPath) {
    projectPath = arg;
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!projectPath) {
  usage();
  process.exit(1);
}

const root = path.resolve(projectPath);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Project path is not a directory: ${root}`);
  process.exit(1);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  } catch {
    return undefined;
  }
}

function yamlScalar(value) {
  if (value === "" || value === undefined || value === null) return '""';
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function firstExistingScript(scripts, names) {
  for (const name of names) {
    if (scripts?.[name]) return `npm run ${name}`;
  }
  return "";
}

function detectCommands() {
  const pkg = readJson("package.json");
  if (pkg?.scripts) {
    return {
      dev: firstExistingScript(pkg.scripts, ["dev", "start"]),
      build: firstExistingScript(pkg.scripts, ["build"]),
      test: firstExistingScript(pkg.scripts, ["test", "unit", "test:unit"]),
      lint: firstExistingScript(pkg.scripts, ["lint"]),
      typecheck: firstExistingScript(pkg.scripts, ["typecheck", "type-check", "tsc"]),
      e2e: firstExistingScript(pkg.scripts, ["test:e2e", "e2e", "test:playwright"]),
    };
  }

  if (exists("pyproject.toml")) {
    const runner = exists("uv.lock") ? "uv run" : "python -m";
    return {
      dev: "",
      build: exists("pyproject.toml") ? `${runner} build` : "",
      test: exists("tests") ? `${runner} pytest` : "",
      lint: exists("ruff.toml") || exists("pyproject.toml") ? `${runner} ruff check .` : "",
      typecheck: `${runner} pyright`,
      e2e: "",
    };
  }

  if (exists("go.mod")) {
    return { dev: "", build: "go build ./...", test: "go test ./...", lint: "", typecheck: "", e2e: "" };
  }

  if (exists("Cargo.toml")) {
    return { dev: "", build: "cargo build", test: "cargo test", lint: "cargo clippy", typecheck: "cargo check", e2e: "" };
  }

  if (exists("project.godot")) {
    return {
      dev: "godot --path .",
      build: "",
      test: "",
      lint: "",
      typecheck: "godot --headless --path . --quit",
      e2e: "",
    };
  }

  return { dev: "", build: "", test: "", lint: "", typecheck: "", e2e: "" };
}

function detectSourceDirs() {
  const candidates = [
    "src",
    "app",
    "lib",
    "packages",
    "services",
    "autoseek",
    "cli",
    "scripts",
    "bootstrap",
    "telemetry",
    "templates",
    "tests",
  ];
  return candidates.filter(exists);
}

function detectProjectType(commands, sourceDirs) {
  if (projectType !== "auto") return projectType;
  if (exists("project.godot")) return "gamedev";
  if (exists("package.json") && (exists("src/components") || exists("app") || exists("pages"))) {
    return exists("server") || exists("api") ? "fullstack" : "frontend";
  }
  if (exists("pyproject.toml") || exists("go.mod") || exists("Cargo.toml")) return "backend";
  if (commands.build || commands.test || sourceDirs.length > 0) return "generic";
  return "unknown";
}

const commands = detectCommands();
const sourceDirs = detectSourceDirs();
const resolvedName = projectName || path.basename(root);
const resolvedType = detectProjectType(commands, sourceDirs);
const subtractionThreshold = { light: 15, balanced: 10, strict: 5 }[enforcementProfile] ?? 10;
let targetBranch = "main";
for (const candidate of ["dev", "main", "master"]) {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--verify", `refs/heads/${candidate}`], { stdio: "ignore" });
    targetBranch = candidate;
    break;
  } catch { /* Try the next existing conventional trunk. */ }
}
const lines = [];
lines.push("# AI Dev Kit skill-first profile");
lines.push("# Generated by scripts/generate-skill-profile.cjs");
lines.push(`project_name: ${yamlScalar(resolvedName)}`);
lines.push(`project_type: ${yamlScalar(resolvedType)}`);
lines.push(`enforcement_profile: ${yamlScalar(enforcementProfile)}`);
lines.push("");
lines.push("source_dirs:");
if (sourceDirs.length === 0) {
  lines.push("  - .");
} else {
  for (const dir of sourceDirs) lines.push(`  - ${yamlScalar(dir)}`);
}
lines.push("");
lines.push("commands:");
for (const key of ["dev", "build", "test", "lint", "typecheck", "e2e"]) {
  lines.push(`  ${key}: ${yamlScalar(commands[key] ?? "")}`);
}
lines.push("");
lines.push("graph:");
lines.push("  provider: auto");
lines.push("  candidates:");
for (const provider of [
  "serena",
  "codegraph",
  "code-review-graph",
  "codebase-memory-mcp",
  "graphify",
  "understand-anything",
  "repomix",
]) {
  lines.push(`    - ${provider}`);
}
lines.push("  fallback_search: rg");
lines.push("");
lines.push("workflow:");
lines.push("  feature_ledger: docs/development/feature-ledger.md");
lines.push("  fallback_feature_ledger: .ai-dev-kit/workflow/feature-ledger.md");
lines.push("  requirements_ledger: .ai-dev-kit/workflow/LEDGER.md");
lines.push("  findings: .ai-dev-kit/workflow/findings.jsonl");
lines.push("  doc_registry: .ai-dev-kit/docs/registry.yml");
lines.push("");
lines.push("review:");
lines.push("  # Test roots are declared in tracked .ai-dev-kit/test-scope.json (not inferred from language).");
lines.push("  test_review_required: true");
lines.push("  doc_review_required: true");
lines.push("  merge_guardian_required: true");
lines.push("  architecture_review_required_for:");
lines.push("    - public_api");
lines.push("    - module_boundary");
lines.push("    - new_abstraction");
lines.push("    - shared_utility");
lines.push("");
lines.push("merge_policy:");
lines.push(`  target_branch: ${targetBranch}`);
lines.push("  require_feature_worktree: true");
lines.push("  block_placeholders: true");
lines.push("  block_open_critical_findings: true");
lines.push("  block_open_high_findings_on_preflight: true");
lines.push("");
lines.push("subtraction:");
lines.push("  # Max commits a feature branch may accumulate without a recorded");
lines.push("  # /ai-dev-kit-clean pass before preflight/merge fails on subtraction debt.");
lines.push(`  every_commits: ${subtractionThreshold}`);
lines.push("  gate_enabled: true");

const output = `${lines.join("\n")}\n`;
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), output);
} else {
  process.stdout.write(output);
}
