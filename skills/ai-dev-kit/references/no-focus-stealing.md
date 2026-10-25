# No Focus Stealing

Evidence-capture code (screenshots, recordings, UI summaries, scripted play,
visual checks) must not take the host screen. It does not:

- bring a window or application to the front;
- move keyboard focus to its window;
- move, press or grab the system pointer;
- send keystrokes or clicks through the operating system.

Input reaches the program from inside: through the application's own input
queue or UI calls, or on a workstation's private screen (`ws-input`,
`ws-play`; see `templates/workstation/README.md`).

The host screen belongs to the person at the machine and is shared by every
agent on it. A capture that activates its window takes the person's
keystrokes, and two agents doing it at once break each other's captures.
Holding the host-screen lock (`resource-lock.cjs run --name ...`) orders
captures but does not make focus stealing acceptable: a capture under the lock
still leaves the foreground, focus and pointer alone.

## Allowed

- On a workstation: `ws-input`, `ws-play`, and `xdotool` or XTEST inside the
  container. They act on the container's Xvfb screen only.
- Inside the application: engine input events (Godot
  `Input.parse_input_event`, `Viewport.push_input`; Unity Input System test
  events such as `InputSystem.QueueStateEvent`), UI calls (emitting a button's
  `pressed` signal, `Control.grab_focus` inside the game's own UI), and
  rendering to a texture (`SubViewport`, `Viewport.get_texture().get_image()`).
- Window captures that do not need focus: macOS `screencapture -l <window id>`
  or `CGWindowListCreateImage`, Windows `PrintWindow`, X11 `xwd -id` or
  `import -window`.
- Starting a program in the background: macOS `open -g`, a window that is
  created without activation.

## Forbidden Calls

The scanner's rule ids are in the first column.

| Rule | Platform | Calls |
| --- | --- | --- |
| `macos.activate-app` | macOS | `NSApp.activate`, `activateIgnoringOtherApps`, `NSRunningApplication.activate(options:)` / `activateWithOptions` |
| `macos.order-front` | macOS | `makeKeyAndOrderFront`, `orderFrontRegardless`, `makeKeyWindow` |
| `macos.set-front-process` | macOS | Carbon `SetFrontProcess`, `SetFrontProcessWithOptions` |
| `macos.warp-cursor` | macOS | `CGWarpMouseCursorPosition`, `CGDisplayMoveCursorToPoint`, `CGAssociateMouseAndMouseCursorPosition` |
| `macos.post-event` | macOS | `CGEventPost`, `CGEventPostToPid`, `CGEventCreateMouseEvent`, `CGEventCreateKeyboardEvent` |
| `macos.applescript-activate` | macOS | AppleScript `tell application "X" to activate`, a bare `activate` line, JXA `Application("X").activate()` |
| `macos.system-events` | macOS | `tell application "System Events"` (keystroke, click), JXA `Application("System Events")` |
| `macos.open-front` | macOS | `open -a` / `open -b` without `-g` |
| `macos.cliclick` | macOS | `cliclick` |
| `win32.foreground` | Windows | `SetForegroundWindow`, `BringWindowToTop`, `SwitchToThisWindow`, `SetActiveWindow`, `AttachThreadInput`, `AppActivate` |
| `win32.topmost` | Windows | `HWND_TOPMOST`, WinForms `TopMost = true`, WPF `Topmost="True"` |
| `win32.cursor` | Windows | `SetCursorPos`, `ClipCursor`, WinForms `Cursor.Position =`; Unreal's `FSlateApplication::SetCursorPos` |
| `win32.send-input` | Windows | `SendInput`, `mouse_event`, `keybd_event`, `SendKeys` |
| `x11.focus-raise` | X11 | `XSetInputFocus`, `XRaiseWindow`, `XMapRaised`, `_NET_ACTIVE_WINDOW` requests |
| `x11.pointer` | X11 | `XWarpPointer`, `XGrabPointer`, `XGrabKeyboard` |
| `x11.xtest` | X11 | `XTestFakeKeyEvent`, `XTestFakeButtonEvent`, `XTestFakeMotionEvent` |
| `x11.xdotool` | X11 | `xdotool` (allowed only inside a workstation) |
| `x11.wmctrl` | X11 | `wmctrl` |
| `linux.uinput` | Linux | `ydotool`, `wtype` |
| `desktop.automation` | any | `pyautogui`, `pynput`, `robotjs`, `@nut-tree/nut-js`, `java.awt.Robot` |
| `ui.bring-to-front` | any | WinForms `BringToFront`, Unreal `SWindow::BringToFront` and `HACK_ForceToFront`, Puppeteer and Playwright `page.bringToFront()` |
| `electron.focus` | Electron | `app.focus()`, `win.moveTop()`, `setAlwaysOnTop(true)`, `focus({ steal: true })` |
| `godot.foreground` | Godot | `DisplayServer.window_move_to_foreground`, `Window.move_to_foreground` (C# `WindowMoveToForeground`, `MoveToForeground`) |
| `godot.window-focus` | Godot | `grab_focus` on a `Window` (`get_window().grab_focus()`, `GetWindow().GrabFocus()`) |
| `godot.warp-mouse` | Godot | `Input.warp_mouse`, `Viewport.warp_mouse` (C# `WarpMouse`) |
| `godot.always-on-top` | Godot | `WINDOW_FLAG_ALWAYS_ON_TOP`, `always_on_top = true` |
| `godot.mouse-capture` | Godot | `MOUSE_MODE_CAPTURED`, `MOUSE_MODE_CONFINED`, `MOUSE_MODE_CONFINED_HIDDEN` (C# `MouseModeEnum.Captured`, `Confined`) |
| `unity.cursor` | Unity | `Mouse.WarpCursorPosition`, `CursorLockMode.Locked`, `CursorLockMode.Confined` |
| `unity.editor-focus` | Unity | `EditorWindow.FocusWindowIfItsOpen` |

Game code may capture the mouse during play (an FPS camera, for example). The
rule covers the code that drives the game for evidence, which is what the
scanner's `paths` should list. When the game captures the mouse on its own
during a capture, run that capture in a workstation.

## Scanner

`scripts/focus-steal-scan.cjs` checks a project's evidence-capture code for
the calls above. It needs only Node, so a project can call it from the kit or
copy the file into its own tree.

```bash
node <kit>/scripts/focus-steal-scan.cjs --project .        # reads .ai-dev-kit/focus-steal-scan.json
node <kit>/scripts/focus-steal-scan.cjs --list-rules       # rule ids and reasons
```

Configuration (tracked, `.ai-dev-kit/focus-steal-scan.json`; the example
project's file is a starting point:
`templates/workstation/examples/starter/.ai-dev-kit/focus-steal-scan.json`):

```json
{
  "schema_version": 1,
  "paths": ["tools/capture", "Game/Scripts/Testing"],
  "exclude": ["tools/capture/vendor"],
  "rules": [
    { "id": "project.focus-helper", "pattern": "\\bWindowTools\\.Activate\\(", "reason": "our helper calls SetForegroundWindow" }
  ],
  "allow": [
    { "path": "tools/capture/in-workstation.sh", "rule": "x11.xdotool",
      "reason": "runs inside the workstation through docker exec" }
  ]
}
```

- `paths` and `exclude` are repository-relative roots (a file, or a directory
  and everything under it). In a Git checkout the scanner reads tracked files
  and new files that Git does not ignore; elsewhere it walks the roots.
- Files are read when their extension is a known source extension
  (`extensions` replaces the list) or when they have no extension and start
  with `#!`.
- `rules` adds project patterns (JavaScript regular expressions, one line at a
  time, optional `flags` without `g` or `y`), for example the project's own
  wrapper around a forbidden call.
- `allow` entries need a `path` root, a known `rule` and a non-empty `reason`;
  `match` narrows an entry to lines containing that text. An entry that
  matches nothing fails the scan, so the list stays current. Review allow
  entries like code.

Output: one finding per line, `file:line:column: rule — reason`, followed by
the source line, then a summary:

```text
tools/capture/shoot.sh:4:3: x11.xdotool — on the host xdotool moves the real pointer and focus; in a workstation drive the screen with ws-input or ws-play
    xdotool key F12
focus-steal-scan: 1 violation in 1 of 3 files
```

`--json` prints `scanned`, `violations`, `allowed` and `unused_allow`. Exit 0
means nothing was found, 1 means violations or unused allow entries, 2 means a
usage or configuration error.

Wire it into the project's own checks, for example the gate contract's
`preflight.argv` command or a test:

```bash
node "$AI_DEV_KIT/scripts/focus-steal-scan.cjs" --project . || exit 1
```

```js
test("evidence capture leaves the host screen alone", () => {
  const result = spawnSync(process.execPath, [scanner, "--project", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
```

Limits: the scanner matches text line by line. It skips whole-line comments
(`//`, `#`, `/*`, `*`, `<!--`, `REM`) and still reads comments after code. It
does not see calls made by name at run time (reflection, `eval`, `ctypes` or
P/Invoke with a computed name) or inside third-party binaries; add a project
rule for a wrapper you know of. It is a check on code review, not a sandbox.
