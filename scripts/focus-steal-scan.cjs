#!/usr/bin/env node
// Finds calls in evidence-capture code that take the host screen: bringing a
// window to the front, moving keyboard focus, or moving or pressing the
// system pointer and keyboard. Evidence code injects input inside the app or
// a workstation instead (skills/ai-dev-kit/references/no-focus-stealing.md).
// Node only and no kit modules, so a project can also copy this file.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const USAGE = `usage: focus-steal-scan.cjs [--project <dir>] [--config <file>] [--json]
       focus-steal-scan.cjs --list-rules
config: <project>/.ai-dev-kit/focus-steal-scan.json unless --config names another
exit: 0 nothing found; 1 violations, or allow entries that matched nothing; 2 usage or configuration error`;
const CONFIG = path.join(".ai-dev-kit", "focus-steal-scan.json");
const EXTENSIONS = [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".m", ".mm", ".swift", ".cs", ".fs", ".vb",
  ".gd", ".py", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1",
  ".bat", ".cmd", ".applescript", ".java", ".kt", ".rs", ".go", ".lua", ".rb", ".pl"];

// [id, pattern, reason]. Patterns run on one line at a time.
const RULES = [
  ["macos.activate-app", /\bactivateIgnoringOtherApps\b|\bNSApp(?:lication\.shared)?\.activate\b|\bactivateWithOptions\b|\.activate\(\s*options\s*:/,
    "activating an application brings it to the front and takes keyboard focus"],
  ["macos.order-front", /\bmakeKeyAndOrderFront\b|\borderFrontRegardless\b|\bmakeKeyWindow\b/,
    "ordering a window to the front or making it key takes the screen and keyboard focus"],
  ["macos.set-front-process", /\bSetFrontProcess(?:WithOptions)?\b/, "SetFrontProcess brings a process to the front"],
  ["macos.warp-cursor", /\bCGWarpMouseCursorPosition\b|\bCGDisplayMoveCursorToPoint\b|\bCGAssociateMouseAndMouseCursorPosition\b/,
    "this moves or detaches the system pointer"],
  ["macos.post-event", /\bCGEventPost(?:ToPid|ToPSN)?\b|\bCGEventCreate(?:Mouse|Keyboard)Event\b/,
    "synthesized system events act on the real pointer and the focused window"],
  ["macos.applescript-activate", /\btell\s+(?:application|app)\b.*\bactivate\b|\bApplication\([^)]*\)\.activate\(|^\s*activate\s*$/i,
    "AppleScript activate brings the application to the front"],
  ["macos.system-events", /\btell\s+(?:application|app)\s+"System Events"|\bApplication\(\s*["']System Events["']\s*\)/i,
    "System Events keystrokes and clicks go to the front application on the real screen"],
  ["macos.open-front", /\bopen(?:\s+-[A-Za-fh-z]+)*\s+-[A-Za-fh-z]*[ab][A-Za-fh-z]*\b/,
    "open -a or -b without -g brings the application to the front; use open -g, or run the program in a workstation"],
  ["macos.cliclick", /\bcliclick\b/, "cliclick moves and clicks the real pointer"],
  ["win32.foreground", /\b(?:SetForegroundWindow|BringWindowToTop|SwitchToThisWindow|SetActiveWindow|AttachThreadInput|AppActivate)\b/,
    "this brings a window to the front or takes keyboard focus from the user's window"],
  ["win32.topmost", /\bHWND_TOPMOST\b|\btopmost\s*=\s*"?true\b/i, "a topmost window covers the user's windows"],
  ["win32.cursor", /\b(?:SetCursorPos|ClipCursor)\b|\bCursor\.Position\s*=(?!=)/,
    "this moves or confines the system pointer (Win32, WinForms, Unreal's FSlateApplication)"],
  ["win32.send-input", /\b(?:SendInput|mouse_event|keybd_event|SendKeys)\b/,
    "synthesized input goes to the real pointer and the focused window"],
  ["x11.focus-raise", /\b(?:XSetInputFocus|XRaiseWindow|XMapRaised)\b|\b_NET_ACTIVE_WINDOW\b/,
    "this raises a window or moves keyboard focus on the X display"],
  ["x11.pointer", /\b(?:XWarpPointer|XGrabPointer|XGrabKeyboard)\b/, "this moves or grabs the pointer or keyboard of the X display"],
  ["x11.xtest", /\bXTestFake\w*Event\b/, "XTEST injects input into the whole X display"],
  ["x11.xdotool", /\bxdotool\b/, "on the host xdotool moves the real pointer and focus; in a workstation drive the screen with ws-input or ws-play"],
  ["x11.wmctrl", /\bwmctrl\b/, "wmctrl activates and raises windows"],
  ["linux.uinput", /\bydotool\b|\bwtype\b/, "uinput tools inject input into the real session"],
  ["desktop.automation", /\bpyautogui\b|\bpynput\b|\brobotjs\b|@nut-tree\b|\bjava\.awt\.Robot\b|\bnew\s+Robot\s*\(/,
    "desktop automation libraries move the system pointer and type into the focused window"],
  ["ui.bring-to-front", /\bbring_?to_?front\b|\bHACK_ForceToFront\b/i,
    "this brings a window to the front (WinForms, Unreal, Puppeteer and Playwright pages)"],
  ["electron.focus", /\bapp\.focus\s*\(|\.moveTop\s*\(|\bsetAlwaysOnTop\s*\(\s*true|\.focus\s*\(\s*\{\s*steal\s*:\s*true/,
    "this brings an Electron window to the front"],
  ["godot.foreground", /\b(?:window_)?move_to_foreground\b|\b(?:Window)?MoveToForeground\b/,
    "Godot's move_to_foreground brings the window to the front"],
  ["godot.window-focus", /\b(?:get_window\(\)|GetWindow\(\)|root)\.(?:grab_focus|GrabFocus)\b/,
    "grab_focus on a Window takes keyboard focus from the user's window (Control.grab_focus stays inside the game)"],
  ["godot.warp-mouse", /\bwarp_mouse\b|\bWarpMouse\b/, "warp_mouse moves the system pointer"],
  ["godot.always-on-top", /\bWINDOW_FLAG_ALWAYS_ON_TOP\b|\bWindowFlags\.AlwaysOnTop\b|\balways_on_top\s*=\s*true\b|\bAlwaysOnTop\s*=\s*true\b/,
    "an always-on-top window covers the user's windows"],
  ["godot.mouse-capture", /\bMOUSE_MODE_(?:CAPTURED|CONFINED(?:_HIDDEN)?)\b|\bMouseModeEnum\.(?:Captured|Confined(?:Hidden)?)\b/,
    "capturing or confining the mouse takes the system pointer while the window has focus"],
  ["unity.cursor", /\bWarpCursorPosition\b|\bCursorLockMode\.(?:Locked|Confined)\b/, "this moves or locks the system pointer"],
  ["unity.editor-focus", /\bFocusWindowIfItsOpen\b/, "this brings the Unity editor window to the front"],
].map(([id, pattern, reason]) => ({ id, pattern, reason }));

class UsageError extends Error {}

function parse(argv) {
  const options = { project: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") options.json = true;
    else if (flag === "--list-rules") options.listRules = true;
    else if (flag === "--project" || flag === "--config") {
      if (i + 1 >= argv.length) throw new UsageError(`missing value for ${flag}`);
      options[flag.slice(2)] = argv[++i];
    } else throw new UsageError(`unknown option: ${flag}`);
  }
  return options;
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const under = (file, root) => file === root || file.startsWith(`${root}/`);
const text = value => typeof value === "string" && value.trim() !== "";

function relativeRoot(value, what) {
  if (!text(value) || path.isAbsolute(value) || value.split(/[\\/]/).some(part => part === ".." || part === "." || part === "")) {
    throw new UsageError(`${what} must be repository-relative paths without ".", ".." or empty parts, e.g. "tools/capture"`);
  }
  return value;
}

function loadConfig(project, file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    throw new UsageError(error.code === "ENOENT" ? `${file} does not exist; list the evidence-capture code to scan in it` : `${file}: ${error.message}`);
  }
  const fail = message => { throw new UsageError(`${file}: ${message}`); };
  if (!isObject(raw)) fail("must hold a JSON object");
  const unknown = Object.keys(raw).filter(key => !["schema_version", "paths", "exclude", "extensions", "rules", "allow"].includes(key));
  if (unknown.length) fail(`unknown key ${unknown.join(", ")}`);
  if (raw.schema_version !== 1) fail("schema_version must be 1");
  if (!Array.isArray(raw.paths) || !raw.paths.length) fail("paths must list the evidence-capture code to scan");
  const paths = raw.paths.map(value => relativeRoot(value, "paths"));
  if (!Array.isArray(raw.exclude ?? [])) fail("exclude must be a list");
  const exclude = (raw.exclude ?? []).map(value => relativeRoot(value, "exclude"));
  const extensions = raw.extensions ?? EXTENSIONS;
  if (!Array.isArray(extensions) || extensions.some(value => typeof value !== "string" || !/^\.[\w.-]+$/.test(value))) {
    fail('extensions must list file extensions such as ".cs"');
  }
  const rules = [...RULES];
  if (!Array.isArray(raw.rules ?? [])) fail("rules must be a list");
  for (const [index, rule] of (raw.rules ?? []).entries()) {
    if (!isObject(rule) || !/^[a-z0-9][\w.-]*$/.test(rule.id ?? "") || !text(rule.pattern) || !text(rule.reason)) {
      fail(`rules[${index}] needs an "id" (lowercase, e.g. "project.focus-helper"), a "pattern" and a "reason"`);
    }
    if (rules.some(known => known.id === rule.id)) fail(`rules[${index}]: rule ${rule.id} already exists`);
    let pattern;
    try { pattern = new RegExp(rule.pattern, rule.flags ?? ""); } catch (error) { fail(`rules[${index}].pattern: ${error.message}`); }
    if (pattern.global || pattern.sticky) fail(`rules[${index}].flags must not include g or y`);
    rules.push({ id: rule.id, pattern, reason: rule.reason });
  }
  if (!Array.isArray(raw.allow ?? [])) fail("allow must be a list");
  const allow = (raw.allow ?? []).map((entry, index) => {
    if (!isObject(entry) || !rules.some(rule => rule.id === entry.rule) || !text(entry.reason) || (entry.match !== undefined && !text(entry.match))) {
      fail(`allow[${index}] needs "path", a known "rule" (see --list-rules), a non-empty "reason" and optionally a "match" text`);
    }
    return { index, path: relativeRoot(entry.path, `allow[${index}].path`), rule: entry.rule, reason: entry.reason.trim(), match: entry.match, used: 0 };
  });
  return { paths, exclude, extensions, rules, allow };
}

// Tracked and untracked-but-not-ignored files when the project is a Git
// checkout, so build output and vendored caches stay out; otherwise a walk.
function listFiles(project, roots) {
  const listed = spawnSync("git", ["-C", project, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots.map(root => `:(literal)${root}`)],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (listed.status === 0) return [...new Set(listed.stdout.split("\0").filter(Boolean))].sort();
  const files = [];
  const walk = rel => {
    const full = path.join(project, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    if (stat.isFile()) { files.push(rel); return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(full).sort()) if (![".git", "node_modules"].includes(name)) walk(`${rel}/${name}`);
  };
  for (const root of roots) walk(root);
  return [...new Set(files)].sort();
}

// Whole-line comments are skipped; a comment after code is still scanned.
const COMMENT = /^\s*(?:\/\/|#|\/\*|\*(?:\s|\/|$)|<!--|REM\s)/i;

function scanFile(project, file, config, report) {
  const body = fs.readFileSync(path.join(project, file));
  if (body.subarray(0, 8192).includes(0)) return false;
  const content = body.toString("utf8");
  if (!config.extensions.includes(path.extname(file).toLowerCase()) && !(path.extname(file) === "" && content.startsWith("#!"))) return false;
  content.split(/\r?\n/).forEach((line, index) => {
    if (COMMENT.test(line) && !(index === 0 && line.startsWith("#!"))) return;
    for (const rule of config.rules) {
      const found = rule.pattern.exec(line);
      if (!found) continue;
      const hit = { path: file, line: index + 1, column: found.index + 1, rule: rule.id, reason: rule.reason, text: line.trim() };
      const entry = config.allow.find(allow => under(file, allow.path) && allow.rule === rule.id && (allow.match === undefined || line.includes(allow.match)));
      if (entry) { entry.used++; report.allowed.push({ ...hit, allowed_because: entry.reason }); } else report.violations.push(hit);
    }
  });
  return true;
}

function scan(project, config) {
  const report = { scanned: 0, violations: [], allowed: [], unused_allow: [] };
  const files = listFiles(project, config.paths).filter(file => !config.exclude.some(root => under(file, root)));
  for (const file of files) if (scanFile(project, file, config, report)) report.scanned++;
  report.unused_allow = config.allow.filter(entry => !entry.used).map(({ index, path: file, rule, reason }) => ({ index, path: file, rule, reason }));
  return report;
}

function render(report) {
  const lines = [];
  for (const hit of report.violations) lines.push(`${hit.path}:${hit.line}:${hit.column}: ${hit.rule} — ${hit.reason}`, `    ${hit.text}`);
  for (const entry of report.unused_allow) {
    lines.push(`allow[${entry.index}] (${entry.path}, ${entry.rule}) matched nothing; remove it or fix its path, rule or match`);
  }
  const files = new Set(report.violations.map(hit => hit.path)).size;
  lines.push(`focus-steal-scan: ${report.violations.length} violation${report.violations.length === 1 ? "" : "s"} in ${files} of ${report.scanned} files` +
    `${report.allowed.length ? ` (${report.allowed.length} allowed)` : ""}`);
  return `${lines.join("\n")}\n`;
}

module.exports = { RULES, loadConfig, scan };

if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.listRules) {
      process.stdout.write(RULES.map(rule => `${rule.id}\t${rule.reason}`).join("\n") + "\n");
      process.exit(0);
    }
    const project = path.resolve(options.project);
    const config = loadConfig(project, options.config ? path.resolve(options.config) : path.join(project, CONFIG));
    const report = scan(project, config);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    process.exit(report.violations.length || report.unused_allow.length ? 1 : 0);
  } catch (error) {
    process.stderr.write(`focus-steal-scan: ${error.message}\n${error instanceof UsageError ? "" : error.stack ?? ""}`);
    if (error instanceof UsageError && /^(unknown option|missing value)/.test(error.message)) process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
