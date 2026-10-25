// Perspective: a project that wires scripts/focus-steal-scan.cjs into its tests
// or gate so evidence-capture code never takes the host screen.
// Invariant: every built-in rule finds its call and is documented; whole-line
// comments and in-app or in-workstation input are not reported; each finding
// names file, line, column, rule and reason; only files under `paths`, not
// under `exclude` and not ignored by Git are read; an allow entry needs a
// reason, covers only its path, rule and match text, and an entry that matches
// nothing fails the scan; configuration errors exit 2.
// Goal: keep the scanner usable as a gate: no silent passes, no noise from
// comments, and an allowlist that cannot rot.
// Migration: real CLI processes on real files in a temporary Git repository.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const kit = path.resolve(__dirname, "..");
const scanner = path.join(kit, "scripts/focus-steal-scan.cjs");
const { RULES } = require(scanner);

// One line per rule that must be reported by that rule and no other.
const SAMPLES = {
  "macos.activate-app": "NSApp.activate(ignoringOtherApps: true)",
  "macos.order-front": "[window makeKeyAndOrderFront:nil];",
  "macos.set-front-process": "SetFrontProcess(&psn);",
  "macos.warp-cursor": "CGWarpMouseCursorPosition(point)",
  "macos.post-event": "CGEventPost(kCGHIDEventTap, event)",
  "macos.applescript-activate": 'osascript -e \'tell application "Godot" to activate\'',
  "macos.system-events": 'tell application "System Events" to keystroke "s" using command down',
  "macos.open-front": "open -a Preview shot.png",
  "macos.cliclick": "cliclick c:100,200",
  "win32.foreground": "SetForegroundWindow(hwnd);",
  "win32.topmost": "SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);",
  "win32.cursor": "Cursor.Position = new Point(10, 10);",
  "win32.send-input": "SendInput(1, inputs, sizeof(INPUT));",
  "x11.focus-raise": "XSetInputFocus(display, window, RevertToParent, CurrentTime);",
  "x11.pointer": "XWarpPointer(display, None, root, 0, 0, 0, 0, x, y);",
  "x11.xtest": "XTestFakeButtonEvent(display, 1, True, CurrentTime);",
  "x11.xdotool": "xdotool search --name Game windowactivate",
  "x11.wmctrl": "wmctrl -a Game",
  "linux.uinput": "ydotool click 0xC0",
  "desktop.automation": "pyautogui.moveTo(100, 200)",
  "ui.bring-to-front": "await page.bringToFront();",
  "electron.focus": "app.focus({ steal: true })",
  "godot.foreground": "DisplayServer.window_move_to_foreground()",
  "godot.window-focus": "get_window().grab_focus()",
  "godot.warp-mouse": "Input.WarpMouse(new Vector2(10, 10));",
  "godot.always-on-top": "DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_ALWAYS_ON_TOP, true)",
  "godot.mouse-capture": "Input.mouse_mode = Input.MOUSE_MODE_CAPTURED",
  "unity.cursor": "Cursor.lockState = CursorLockMode.Locked;",
  "unity.editor-focus": "EditorWindow.FocusWindowIfItsOpen<GameView>();",
};

// Input that stays inside the app or a workstation, and comments.
const CLEAN = [
  "button.grab_focus()",
  "_startButton.GrabFocus();",
  "open -g -a Preview shot.png",
  'docker exec "$ws" ws-input click 640 360',
  'docker exec "$ws" ws-play --note "open the shop" click 640 360',
  "# xdotool is only used inside the workstation",
  "// SetForegroundWindow would take the user's screen",
  "   * calls like XRaiseWindow are forbidden here",
  "with open(path) as handle:",
  "if (Cursor.Position == origin) return;",
  "Input.mouse_mode = Input.MOUSE_MODE_VISIBLE",
];

function project(t, config, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidk-focus-scan-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  if (config) write(".ai-dev-kit/focus-steal-scan.json", JSON.stringify(config, null, 2));
  for (const [file, body] of Object.entries(files)) write(file, body);
  const scan = (args = [], expected = 0) => {
    const result = spawnSync(process.execPath, [scanner, "--project", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, expected, `${result.stdout}${result.stderr}`);
    return result.stdout + result.stderr;
  };
  return { root, write, scan };
}

test("every built-in rule reports its own sample line and is named in the reference", t => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), RULES.map(rule => rule.id).sort(), "each rule needs exactly one sample");
  const p = project(t, { schema_version: 1, paths: ["src"], extensions: [".txt"] }, {
    "src/samples.txt": `${Object.values(SAMPLES).join("\n")}\n`,
  });
  const report = JSON.parse(p.scan(["--json"], 1));
  assert.deepEqual(report.violations.map(hit => [hit.line, hit.rule]), Object.keys(SAMPLES).map((id, index) => [index + 1, id]));
  for (const hit of report.violations) assert.equal(hit.reason, RULES.find(rule => rule.id === hit.rule).reason);
  const reference = fs.readFileSync(path.join(kit, "skills/ai-dev-kit/references/no-focus-stealing.md"), "utf8");
  for (const rule of RULES) assert.ok(reference.includes(`\`${rule.id}\``), `${rule.id} is not listed in references/no-focus-stealing.md`);
});

test("comments and input inside the app or a workstation are not reported", t => {
  const p = project(t, { schema_version: 1, paths: ["src"], extensions: [".txt"] }, { "src/clean.txt": `${CLEAN.join("\n")}\n` });
  assert.match(p.scan(), /^focus-steal-scan: 0 violations in 0 of 1 files$/m);
});

test("a finding names file, line, column, rule and reason, and only listed, tracked-or-new, non-excluded code is read", t => {
  const p = project(t, { schema_version: 1, paths: ["tools/capture", "Game/Scripts"], exclude: ["Game/Scripts/Editor"] }, {
    "tools/capture/shoot.sh": "#!/bin/bash\nset -e\nws=$1\n  xdotool key F12\n",
    "tools/capture/drive": "#!/usr/bin/env bash\nwmctrl -a Game\n",
    "tools/capture/notes.md": "xdotool is mentioned in prose only\n",
    "tools/capture/blob.bin": Buffer.from([0, 1, 2, 0x78, 0x64, 0x6f, 0x74, 0x6f, 0x6f, 0x6c]),
    "tools/capture/build/out.sh": "xdotool click 1\n",
    "tools/capture/.gitignore": "build/\n",
    "Game/Scripts/Shots.cs": "class Shots {\n  void Front() { DisplayServer.WindowMoveToForeground(); }\n}\n",
    "Game/Scripts/Editor/Dock.cs": "SetForegroundWindow(hwnd);\n",
    "Game/Other.cs": "SetForegroundWindow(hwnd);\n",
  });
  const out = p.scan([], 1);
  assert.match(out, /^Game\/Scripts\/Shots\.cs:2:32: godot\.foreground — Godot's move_to_foreground brings the window to the front\n {4}void Front\(\) \{ DisplayServer\.WindowMoveToForeground\(\); \}$/m);
  assert.match(out, /^tools\/capture\/drive:2:1: x11\.wmctrl — wmctrl activates and raises windows$/m);
  assert.match(out, /^tools\/capture\/shoot\.sh:4:3: x11\.xdotool — on the host xdotool moves the real pointer/m);
  assert.doesNotMatch(out, /notes\.md|blob\.bin|build\/out\.sh|Editor\/Dock\.cs|Game\/Other\.cs/);
  assert.match(out, /^focus-steal-scan: 3 violations in 3 of 3 files$/m);
});

test("an allow entry covers only its path, rule and match text, and one that matches nothing fails the scan", t => {
  const config = {
    schema_version: 1, paths: ["tools"],
    allow: [
      { path: "tools/ws/inside.sh", rule: "x11.xdotool", reason: "runs inside the workstation through docker exec" },
      { path: "tools/host.sh", rule: "x11.xdotool", match: "--sync", reason: "waits for the private screen only" },
    ],
  };
  const p = project(t, config, {
    "tools/ws/inside.sh": "xdotool mousemove 10 10\n",
    "tools/host.sh": "xdotool windowactivate 42\nwmctrl -a Game\n",
  });
  const out = p.scan([], 1);
  assert.match(out, /^tools\/host\.sh:1:1: x11\.xdotool/m);
  assert.match(out, /^tools\/host\.sh:2:1: x11\.wmctrl/m);
  assert.doesNotMatch(out, /inside\.sh:/);
  assert.match(out, /^allow\[1\] \(tools\/host\.sh, x11\.xdotool\) matched nothing; remove it or fix its path, rule or match$/m);
  assert.match(out, /^focus-steal-scan: 2 violations in 1 of 2 files \(1 allowed\)$/m);
  const report = JSON.parse(p.scan(["--json"], 1));
  assert.deepEqual(report.allowed.map(hit => [hit.path, hit.rule, hit.allowed_because]),
    [["tools/ws/inside.sh", "x11.xdotool", "runs inside the workstation through docker exec"]]);
  p.write("tools/host.sh", "xdotool --sync windowactivate 42\n");
  assert.match(p.scan(), /^focus-steal-scan: 0 violations in 0 of 2 files \(2 allowed\)$/m);
  p.write("tools/ws/inside.sh", "echo moved\n");
  assert.match(p.scan([], 1), /^allow\[0\] \(tools\/ws\/inside\.sh, x11\.xdotool\) matched nothing/m);
});

test("project rules extend the built-in ones", t => {
  const p = project(t, {
    schema_version: 1, paths: ["src"],
    rules: [{ id: "project.focus-helper", pattern: "\\bFocusHelper\\.Steal\\(", reason: "our helper calls SetForegroundWindow" }],
  }, { "src/a.cs": "FocusHelper.Steal(window);\n" });
  assert.match(p.scan([], 1), /^src\/a\.cs:1:1: project\.focus-helper — our helper calls SetForegroundWindow$/m);
});

test("configuration errors exit 2 and name the setting", t => {
  const cases = [
    [null, /focus-steal-scan\.json does not exist; list the evidence-capture code to scan in it/],
    [{ schema_version: 1, paths: [] }, /paths must list the evidence-capture code to scan/],
    [{ schema_version: 1, paths: ["../outside"] }, /paths must be repository-relative paths/],
    [{ schema_version: 1, paths: ["src"], colour: "red" }, /unknown key colour/],
    [{ schema_version: 1, paths: ["src"], allow: [{ path: "src", rule: "x11.xdotool", reason: " " }] }, /allow\[0\] needs "path", a known "rule"/],
    [{ schema_version: 1, paths: ["src"], allow: [{ path: "src", rule: "x11.nothing", reason: "why" }] }, /allow\[0\] needs "path", a known "rule"/],
    [{ schema_version: 1, paths: ["src"], rules: [{ id: "x11.xdotool", pattern: "a", reason: "b" }] }, /rules\[0\]: rule x11\.xdotool already exists/],
    [{ schema_version: 1, paths: ["src"], rules: [{ id: "project.bad", pattern: "(", reason: "b" }] }, /rules\[0\]\.pattern: Invalid regular expression/],
  ];
  for (const [config, message] of cases) {
    const p = project(t, config, { "src/a.cs": "class A {}\n" });
    assert.match(p.scan([], 2), message);
  }
  const p = project(t, { schema_version: 1, paths: ["src"] }, {});
  assert.match(p.scan(["--colour"], 2), /unknown option: --colour\nusage: focus-steal-scan\.cjs/);
});

test("--list-rules prints every rule with its reason", () => {
  const result = spawnSync(process.execPath, [scanner, "--list-rules"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), RULES.map(rule => `${rule.id}\t${rule.reason}`));
});
