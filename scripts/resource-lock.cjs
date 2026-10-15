#!/usr/bin/env node
// FIFO queued exclusive lock for one scarce resource (a GUI engine instance, a
// display used for visual verification) shared by many agents and worktrees.
//
// Waiters queue instead of failing fast, so dozens of agents do not spin on a
// non-blocking lock. Tickets live in the shared state root of the main checkout
// (<root>/.ai-dev-kit/locks/<name>/) and follow Lamport's bakery protocol on
// plain files: a waiter announces itself with a "choosing" file, takes one more
// than the highest visible ticket number, then removes the announcement. The
// holder is the lowest live ticket once no announcement is pending, so a number
// is never handed out below a ticket that is already queued or running.
// POSIX readdir gives no snapshot of entries created or removed during the
// scan, so each decision lists announcements first and tickets second: an
// announcement missed by the first listing was removed before the second
// began, and its ticket was linked before that removal. Ticket files are
// immutable after creation (only their mtime is refreshed), because a rename
// over a listed name could hide it from a concurrent scan. A holder claims by
// creating "<token>.held" (read by direct open, never by listing), then checks
// again: a live lower ticket from a chooser stalled past CHOOSING_STALE_MS, or
// another claim, makes it drop the claim and wait. Waiters treat any claimed
// ticket as ahead of them, whatever its number.
// Only Node built-ins are used; no flock. Shared state must be a local filesystem.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { stateRoot } = require("./project-state.cjs");

const BLOCKED = 75; // EX_TEMPFAIL: the command did not run; retry later.
const DEFAULT_WAIT_S = 1800;
const DEFAULT_MAX_HOLD_S = 3600;
const CHOOSING_STALE_MS = 30000;
const LEFTOVER_STALE_MS = 60000;
const HELD_ENV = "AI_DEV_KIT_HELD_LOCKS";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^\d{12}-[0-9a-f]{16}$/;
const TICKET = /^(\d{12})-[0-9a-f]{16}\.json$/;
const HELD = /^\d{12}-[0-9a-f]{16}\.held$/;
const CHOOSING = /^choosing-[0-9a-f]{16}\.json$/;
const HOST = os.hostname();
const USAGE = `usage:
  resource-lock.cjs run --name <res> [--wait <s|inf>] [--label <text>] [--max-hold <s>] -- <command...>
  resource-lock.cjs acquire --name <res> [--wait <s|inf>] [--label <text>] [--max-hold <s>] [--owner-pid <pid>]
  resource-lock.cjs release --name <res> --token <token>
  resource-lock.cjs status --name <res> [--json]
common: --project <dir> (default cwd; locks live in its main checkout) | --root <dir>
exit: run -> the command's code; 75 = still queued after --wait, nothing ran (retryable); 2 = usage`;

class UsageError extends Error {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = () => crypto.randomBytes(8).toString("hex");

function parse(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf("--");
  const flags = separator < 0 ? rest : rest.slice(0, separator);
  const options = { command, argv: separator < 0 ? null : rest.slice(separator + 1) };
  const valued = {
    "--name": "name", "--wait": "wait", "--label": "label", "--max-hold": "maxHold",
    "--token": "token", "--owner-pid": "ownerPid", "--root": "root", "--project": "project",
  };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--json") { options.json = true; continue; }
    const key = valued[flags[i]];
    if (!key) throw new UsageError(`unknown option: ${flags[i]}`);
    if (i + 1 >= flags.length) throw new UsageError(`missing value for ${flags[i]}`);
    options[key] = flags[++i];
  }
  if (!["run", "acquire", "release", "status"].includes(command)) throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  if (!NAME.test(options.name ?? "")) throw new UsageError("--name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  if (command === "run" && !options.argv?.length) throw new UsageError("run requires -- <command...>");
  if (command !== "run" && options.argv) throw new UsageError(`${command} does not take a command`);
  if (command === "release" && !TOKEN.test(options.token ?? "")) throw new UsageError("release requires the --token printed by acquire");
  options.waitMs = seconds(options.wait, DEFAULT_WAIT_S, "--wait", true);
  options.maxHoldMs = seconds(options.maxHold, DEFAULT_MAX_HOLD_S, "--max-hold", false);
  if (options.ownerPid !== undefined && !/^[1-9]\d*$/.test(options.ownerPid)) throw new UsageError("--owner-pid must be a positive integer");
  return options;
}

function seconds(raw, fallback, flag, allowInfinite) {
  if (raw === undefined) return fallback * 1000;
  if (allowInfinite && raw === "inf") return Infinity;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < (allowInfinite ? 0 : 1)) {
    throw new UsageError(`${flag} must be ${allowInfinite ? "a nonnegative number of seconds or inf" : "at least 1 second"}`);
  }
  return value * 1000;
}

function lockDir(options, create) {
  const base = options.root ? path.resolve(options.root) : stateRoot(options.project || process.cwd());
  const locks = path.join(base, ".ai-dev-kit", "locks");
  const dir = path.join(locks, options.name);
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
    // Tickets are machine-local runtime state; keep them out of every commit.
    try { fs.writeFileSync(path.join(locks, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return dir;
}

// Complete content appears under the final name at once; link() is exclusive
// like open('wx'), so an existing file is never overwritten.
function createExclusive(dir, name, data) {
  const temp = path.join(dir, `.tmp-${rand()}`);
  fs.writeFileSync(temp, `${JSON.stringify(data)}\n`, { flag: "wx" });
  try { fs.linkSync(temp, path.join(dir, name)); } finally { unlinkQuiet(temp); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function touch(file) {
  const now = new Date();
  try { fs.utimesSync(file, now, now); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function removeTicket(dir, token) {
  const removed = unlinkQuiet(path.join(dir, `${token}.json`));
  unlinkQuiet(path.join(dir, `${token}.held`));
  return removed;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// EPERM (including a zombie-only group on Darwin) counts as alive: keeping a
// lock a little longer is safe, handing the resource to two users is not.
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch (error) { if (error.code !== "ESRCH" && error.code !== "EPERM") throw error; }
}

function withHeld(dir, entry) {
  const held = readJson(path.join(dir, `${entry.token}.held`));
  return held ? { ...entry.ticket, ...held } : entry.ticket;
}

function staleReason(dir, entry, now) {
  if (!entry.ticket) return "unreadable ticket";
  let data = withHeld(dir, entry);
  if (data.host === HOST && data.pid && !alive(data.pid)) {
    // The .held file is written before its writer can exit: read it again
    // after observing the death, or a just-finished acquire looks abandoned.
    data = withHeld(dir, entry);
    // A killed runner can leave its command's process group using the resource.
    if (data.pid && !alive(data.pid) && !(data.pgid && groupAlive(data.pgid))) {
      entry.data = data;
      return `owner pid ${data.pid} is gone`;
    }
  }
  entry.data = data;
  const idle = now - Math.max(entry.mtimeMs, data.held_at || 0);
  const limit = data.max_hold_ms || DEFAULT_MAX_HOLD_S * 1000;
  if (idle > limit) return `not refreshed for ${Math.round(idle / 1000)}s (max-hold ${limit / 1000}s)`;
  return null;
}

function describe(entry) {
  const { label, pid, host } = entry.data || entry.ticket || {};
  return `"${label ?? "?"}" pid ${pid ?? "-"}${host && host !== HOST ? `@${host}` : ""}`;
}

function list(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function statQuiet(file) {
  try { return fs.statSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Two sequential listings; see the header for why their order matters.
function scan(dir, reclaim) {
  const now = Date.now();
  const tickets = [], choosing = [];
  for (const name of list(dir).filter(name => CHOOSING.test(name))) {
    const file = path.join(dir, name), stat = statQuiet(file);
    if (!stat) continue;
    const data = readJson(file);
    const dead = !data || (data.host === HOST && !alive(data.pid)) || now - stat.mtimeMs > CHOOSING_STALE_MS;
    if (!dead) choosing.push(name);
    else if (reclaim) unlinkQuiet(file);
  }
  const names = list(dir);
  const listed = new Set(names);
  for (const name of names) {
    const file = path.join(dir, name);
    if (CHOOSING.test(name)) continue;
    const stat = statQuiet(file);
    if (!stat) continue;
    if (TICKET.test(name)) {
      const entry = { name, token: name.slice(0, -5), ticket: readJson(file), mtimeMs: stat.mtimeMs };
      entry.stale = staleReason(dir, entry, now);
      if (entry.stale && reclaim) {
        if (removeTicket(dir, entry.token)) process.stderr.write(`resource-lock: reclaimed ${entry.token} (${describe(entry)}): ${entry.stale}\n`);
      } else tickets.push(entry);
    } else if (reclaim && now - stat.mtimeMs > LEFTOVER_STALE_MS &&
      (name.startsWith(".tmp-") || (HELD.test(name) && !listed.has(name.replace(/\.held$/, ".json"))))) {
      unlinkQuiet(file); // left by a writer or reclaimer that died mid-step
    }
  }
  return { tickets, choosing };
}

function enqueue(dir, info, maxHoldMs) {
  const announcement = `choosing-${rand()}.json`;
  createExclusive(dir, announcement, { pid: process.pid, host: HOST });
  try {
    let highest = 0;
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(TICKET);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    const token = `${String(highest + 1).padStart(12, "0")}-${rand()}`;
    createExclusive(dir, `${token}.json`, {
      ...info, host: HOST, cwd: process.cwd(), created_at: Date.now(), max_hold_ms: maxHoldMs,
    });
    return token;
  } finally {
    unlinkQuiet(path.join(dir, announcement));
  }
}

function blockers(tickets, token) {
  const mine = tickets.find(entry => entry.token === token);
  return mine && tickets.filter(entry => entry.token !== token && (entry.name < mine.name || entry.data?.held_at));
}

// Resolves { held: true } once first in line and claimed with `holding` as the
// .held content, or { held: false } when the deadline passes or the ticket is
// lost. Pending announcements are millisecond-scale and only delay the
// decision; they never count as being blocked. Polling backs off to at most one
// second and refreshes the waiter's ticket so it is not taken for stale.
async function waitTurn(dir, token, waitMs, maxHoldMs, holding) {
  const deadline = Date.now() + waitMs;
  const ceiling = Math.min(1000, maxHoldMs / 4);
  const heldPath = path.join(dir, `${token}.held`);
  let delay = 25;
  for (;;) {
    const { tickets, choosing } = scan(dir, true);
    let ahead = blockers(tickets, token);
    if (!ahead) return { held: false, lost: true };
    if (!ahead.length && !choosing.length) {
      createExclusive(dir, `${token}.held`, { ...holding, held_at: Date.now() });
      ahead = blockers(scan(dir, true).tickets, token);
      if (ahead?.length === 0) return { held: true };
      unlinkQuiet(heldPath);
      if (!ahead) return { held: false, lost: true };
    }
    if (ahead.length && Date.now() >= deadline) return { held: false, blocker: ahead[0] };
    touch(path.join(dir, `${token}.json`));
    await sleep(Math.max(1, Math.min(delay, deadline - Date.now())));
    delay = Math.min(ceiling, delay * 2);
  }
}

function blockedExit(options, outcome, dir, token) {
  removeTicket(dir, token);
  const why = outcome.lost
    ? "lost its queue ticket while waiting (reclaimed after max-hold)"
    : `is still held by ${describe(outcome.blocker)} after ${options.waitMs / 1000}s`;
  process.stderr.write(`resource-lock: BLOCKED (retryable): ${options.name} ${why}; command not run\n`);
  process.exit(BLOCKED);
}

function heldLocks() {
  return (process.env[HELD_ENV] || "").split(path.delimiter).filter(Boolean);
}

// Not re-entrant: inside a command that holds this resource, another run or
// acquire would queue behind its own holder forever. Compare real paths so a
// symlinked root or project path is still recognised.
function refuseNested(dir, options) {
  const real = fs.realpathSync(dir);
  if (heldLocks().includes(real)) {
    throw new UsageError(`nested ${options.command} of "${options.name}" inside a command holding it would wait on itself; call the command directly`);
  }
  return real;
}

async function run(options) {
  const dir = lockDir(options, true);
  const real = refuseNested(dir, options);
  const label = options.label ?? options.argv.join(" ").slice(0, 160);
  const token = enqueue(dir, { pid: process.pid, label }, options.maxHoldMs);
  const ticketPath = path.join(dir, `${token}.json`);
  let child = null, childExited = false, finishing = false;
  process.on("exit", () => {
    if (child?.pid && !childExited) signalGroup(child.pid, "SIGKILL");
    removeTicket(dir, token);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(signal, () => {
      if (!child?.pid) process.exit(code);
      // Forward to the whole command group; escalate if it ignores the signal.
      signalGroup(child.pid, signal);
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 10000).unref();
    });
  }

  const outcome = await waitTurn(dir, token, options.waitMs, options.maxHoldMs, {});
  if (!outcome.held) blockedExit(options, outcome, dir, token);

  const finish = async code => {
    if (finishing) return;
    finishing = true;
    childExited = true;
    if (child.pid) {
      // Background descendants must not keep using the resource after release.
      signalGroup(child.pid, "SIGTERM");
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await sleep(100);
      signalGroup(child.pid, "SIGKILL");
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await sleep(50);
    }
    removeTicket(dir, token);
    process.exit(code);
  };
  child = spawn(options.argv[0], options.argv.slice(1), {
    detached: true,
    env: { ...process.env, [HELD_ENV]: [...heldLocks(), real].join(path.delimiter) },
    // A background process group reading a terminal would stop on SIGTTIN while holding the lock.
    stdio: [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"],
  });
  child.on("error", error => {
    process.stderr.write(`resource-lock: cannot start ${options.argv[0]}: ${error.message}\n`);
    finish(error.code === "ENOENT" ? 127 : 126);
  });
  child.on("exit", (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] || 1)));
  if (!child.pid) return;
  // Atomic replace; readers open .held directly and see the old or new claim.
  const temp = path.join(dir, `.tmp-${rand()}`);
  fs.writeFileSync(temp, `${JSON.stringify({ pgid: child.pid, held_at: Date.now() })}\n`, { flag: "wx" });
  fs.renameSync(temp, path.join(dir, `${token}.held`));
  let warned = false;
  setInterval(() => {
    if (!touch(ticketPath) && !warned && !finishing) {
      warned = true;
      process.stderr.write(`resource-lock: warning: ${options.name} ticket ${token} was removed while the command runs\n`);
    }
  }, Math.max(200, Math.min(options.maxHoldMs / 4, 15000))).unref();
}

async function acquire(options) {
  const dir = lockDir(options, true);
  refuseNested(dir, options);
  const owner = options.ownerPid ? Number(options.ownerPid) : null;
  const label = options.label ?? `acquire (owner pid ${owner ?? "unchecked"})`;
  const token = enqueue(dir, { pid: process.pid, label }, options.maxHoldMs);
  let held = false;
  process.on("exit", () => { if (!held) removeTicket(dir, token); });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => process.exit(code));
  // Nobody refreshes the ticket after this process exits, so max-hold is its
  // lease. Without --owner-pid the caller's liveness cannot be checked.
  const outcome = await waitTurn(dir, token, options.waitMs, options.maxHoldMs, { pid: owner });
  if (!outcome.held) blockedExit(options, outcome, dir, token);
  held = true;
  process.stdout.write(`${token}\n`);
}

function release(options) {
  if (!removeTicket(lockDir(options, false), options.token)) {
    process.stderr.write(`resource-lock: ${options.name} ticket ${options.token} not found (already released, or reclaimed after max-hold)\n`);
    process.exitCode = 1;
  }
}

function status(options) {
  const dir = lockDir(options, false);
  const now = Date.now();
  const round = ms => Math.round(ms / 100) / 10;
  const entries = scan(dir, false).tickets.map(entry => ({
    token: entry.token,
    label: entry.data?.label ?? null,
    pid: entry.data?.pid ?? null,
    host: entry.data?.host ?? null,
    cwd: entry.data?.cwd ?? null,
    age_s: entry.data?.created_at ? round(now - entry.data.created_at) : null,
    held_s: entry.data?.held_at ? round(now - entry.data.held_at) : null,
    stale: entry.stale,
  }));
  const live = entries.filter(entry => !entry.stale);
  live.forEach((entry, index) => { entry.state = index ? "waiting" : entry.held_s === null ? "acquiring" : "holding"; });
  const result = { name: options.name, dir, holder: live[0] ?? null, queue: live.slice(1), stale: entries.filter(entry => entry.stale) };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [result.holder
    ? `${options.name}: ${result.holder.state} by "${result.holder.label}" (pid ${result.holder.pid ?? "-"}), ${result.queue.length} waiting`
    : `${options.name}: free`];
  for (const entry of [...live, ...result.stale]) {
    const age = entry.state === "holding" ? `held ${entry.held_s}s` : `queued ${entry.age_s}s`;
    lines.push(`  ${(entry.state ?? "stale").padEnd(9)} pid ${String(entry.pid ?? "-").padEnd(7)} ${age.padEnd(14)} ${entry.label ?? ""}` +
      `${entry.cwd ? `  [${entry.cwd}]` : ""}${entry.stale ? `  (${entry.stale})` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (process.platform === "win32") throw new Error("resource-lock requires macOS/Linux process groups; use WSL on Windows");
  if (options.command === "run") return run(options);
  if (options.command === "acquire") return acquire(options);
  if (options.command === "release") return release(options);
  return status(options);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`resource-lock: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}
