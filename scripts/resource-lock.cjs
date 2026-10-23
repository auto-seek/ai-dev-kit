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
//
// Workstation pools (--pool) queue the same way for N interchangeable Docker
// workstations declared in <root>/.ai-dev-kit/workstations.json. Their tickets
// live in .ai-dev-kit/pools/<pool>/, apart from the exclusive locks, so a pool
// and the real-screen lock coexist. Holders do not block waiters. Only the
// first waiter assigns: it marks itself "<token>.assigning" and checks again
// (the claim step above), frees slots whose holder ticket is gone, and takes
// the lowest free "slot-<i>.json" with an exclusive link, so a slot file never
// names two holders. Every change to slot files (assigning, freeing a dead
// holder's slot, releasing) also holds the pool's slot mutex, so a slot file
// read under it cannot change before the same process acts on it; mutex
// markers carry their process's start time so a reused pid is told apart from
// a live holder. Every claim
// gets a new container from the pool image and
// release or reclaim removes it: a recreated container is the clean state,
// because a reset inside a used one cannot show that no process or file
// survived, and start-up costs about a second.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
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
const ASSIGNING = /^\d{12}-[0-9a-f]{16}\.assigning$/;
const SLOT = /^slot-(\d+)\.json$/;
const MUTEX = /^mutex-[0-9a-f]{16}\.json$/;
// A slot-mutex marker refreshed less than this long ago is not checked for a
// reused pid: its holder wrote it moments ago, so the pid is the holder's.
const MUTEX_RECHECK_MS = 5000;
// Backstop for markers whose holder cannot be judged (another host, a marker
// without a start time). A live holder refreshes its marker after every docker
// call inside the mutex, so its marker is never older than one docker timeout
// (DOCKER_TIMEOUT_MS) however many slots it frees. Keep this far above that
// timeout when changing either.
const MUTEX_STALE_MS = 30 * 60 * 1000;
const DOCKER_TIMEOUT_MS = 120000;
const HOST = os.hostname();
const DOCKER = process.env.AI_DEV_KIT_DOCKER || "docker";
const CONFIG_FILE = path.join(".ai-dev-kit", "workstations.json");
const LABEL = "ai-dev-kit.workstation";
const EVENTS = "reclaimed.jsonl";
// c1 measured a 4K Godot Forward+ run at ~2.5 GB peak; three fit an 8 GB Docker VM.
const POOL_DEFAULTS = {
  slots: 3, cpus: 3, memory: "2.5g", screen: "1920x1080x24", user: "host", min_free_disk: "5g",
  timeout_seconds: 1800, max_hold_seconds: 3600, warn_hold_seconds: 1800,
};
const USAGE = `usage:
  resource-lock.cjs run --name <res> [--wait <s|inf>] [--label <text>] [--max-hold <s>] -- <command...>
  resource-lock.cjs acquire --name <res> [--wait <s|inf>] [--label <text>] [--max-hold <s>] [--owner-pid <pid>]
  resource-lock.cjs release --name <res> --token <token>
  resource-lock.cjs status --name <res> [--json]
workstation pools (.ai-dev-kit/workstations.json):
  resource-lock.cjs claim --pool <pool> [--wait <s|inf>] [--label <text>] [--max-hold <s>] [--owner-pid <pid>] [--out <dir>] [--json]
  resource-lock.cjs run --pool <pool> [--wait <s|inf>] [--label <text>] [--max-hold <s>] [--timeout <s>] [--out <dir>] [-- <args...>]
  resource-lock.cjs renew --pool <pool> --token <token>
  resource-lock.cjs release --pool <pool> --token <token>
  resource-lock.cjs status --pool <pool> [--json] [--warn-hold <s>] [--no-docker]
  resource-lock.cjs prune --pool <pool> [--dry-run] [--evidence-days <n>]
  resource-lock.cjs status [--json] [--warn-hold <s>]      (every lock and pool on this machine)
common: --project <dir> (default cwd; state lives in its main checkout) | --root <dir> | --config <file>
exit: run -> the command's code; 75 = still queued after --wait, or too little free disk; nothing ran (retryable);
      2 = usage or configuration error; 1 = not held (release/renew) or Docker failure`;

class UsageError extends Error {}
class ConfigError extends Error {}
class BlockedError extends Error {}
class MutexBusyError extends Error {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Synchronous, for the exit handlers that release slots.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rand = () => crypto.randomBytes(8).toString("hex");

function parse(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf("--");
  const flags = separator < 0 ? rest : rest.slice(0, separator);
  const options = { command, argv: separator < 0 ? null : rest.slice(separator + 1) };
  const valued = {
    "--name": "name", "--wait": "wait", "--label": "label", "--max-hold": "maxHold",
    "--token": "token", "--owner-pid": "ownerPid", "--root": "root", "--project": "project",
    "--pool": "pool", "--out": "out", "--timeout": "timeout", "--warn-hold": "warnHold", "--config": "config",
    "--evidence-days": "evidenceDays",
  };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--json") { options.json = true; continue; }
    if (flags[i] === "--no-docker") { options.noDocker = true; continue; }
    if (flags[i] === "--dry-run") { options.dryRun = true; continue; }
    const key = valued[flags[i]];
    if (!key) throw new UsageError(`unknown option: ${flags[i]}`);
    if (i + 1 >= flags.length) throw new UsageError(`missing value for ${flags[i]}`);
    options[key] = flags[++i];
  }
  if (!["run", "acquire", "release", "status", "claim", "renew", "prune"].includes(command)) throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  if (options.name !== undefined && options.pool !== undefined) throw new UsageError("use --name for an exclusive lock or --pool for a workstation pool, not both");
  if (options.pool !== undefined && !NAME.test(options.pool)) throw new UsageError("--pool must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  const pooled = options.pool !== undefined;
  if (["claim", "renew", "prune"].includes(command) && !pooled) throw new UsageError(`${command} requires --pool <pool>`);
  if (!pooled && !(command === "status" && options.name === undefined) && !NAME.test(options.name ?? "")) {
    throw new UsageError("--name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  }
  if (command === "acquire" && pooled) throw new UsageError("acquire takes --name; use claim --pool for a workstation");
  if (command === "run" && !pooled && !options.argv?.length) throw new UsageError("run requires -- <command...>");
  if (command !== "run" && options.argv) throw new UsageError(`${command} does not take a command`);
  if (["release", "renew"].includes(command) && !TOKEN.test(options.token ?? "")) throw new UsageError(`${command} requires the --token printed by ${pooled ? "claim" : "acquire"}`);
  options.waitMs = seconds(options.wait, DEFAULT_WAIT_S, "--wait", true);
  // A pool's lease defaults to its configured max_hold_seconds.
  options.maxHoldMs = pooled && options.maxHold === undefined ? null : seconds(options.maxHold, DEFAULT_MAX_HOLD_S, "--max-hold", false);
  if (options.ownerPid !== undefined && !/^[1-9]\d*$/.test(options.ownerPid)) throw new UsageError("--owner-pid must be a positive integer");
  if (options.ownerPid !== undefined && !["acquire", "claim"].includes(command)) throw new UsageError("--owner-pid applies to acquire and claim");
  if (options.timeout !== undefined && !(command === "run" && pooled && /^\d+$/.test(options.timeout))) throw new UsageError("--timeout takes whole seconds and applies to run --pool");
  if (options.warnHold !== undefined && !(command === "status" && /^\d+$/.test(options.warnHold))) throw new UsageError("--warn-hold takes whole seconds and applies to status");
  if (options.out !== undefined && !(pooled && ["claim", "run"].includes(command))) throw new UsageError("--out applies to claim and run --pool");
  if (options.noDocker && command !== "status") throw new UsageError("--no-docker applies to status");
  if ((options.dryRun || options.evidenceDays !== undefined) && command !== "prune") throw new UsageError("--dry-run and --evidence-days apply to prune");
  if (options.evidenceDays !== undefined && !/^\d+$/.test(options.evidenceDays)) throw new UsageError("--evidence-days takes a whole number of days");
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

function baseDir(options) {
  return options.root ? path.resolve(options.root) : stateRoot(options.project || process.cwd());
}

function stateDir(base, kind, name, create) {
  const parent = path.join(base, ".ai-dev-kit", kind);
  const dir = path.join(parent, name);
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
    // Tickets are machine-local runtime state; keep them out of every commit.
    try { fs.writeFileSync(path.join(parent, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return dir;
}

function lockDir(options, create) {
  return stateDir(baseDir(options), "locks", options.name, create);
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
  unlinkQuiet(path.join(dir, `${token}.assigning`));
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
// onReclaim(entry) runs for each ticket this scan reclaims.
function scan(dir, reclaim, onReclaim) {
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
        if (removeTicket(dir, entry.token)) {
          process.stderr.write(`resource-lock: reclaimed ${entry.token} (${describe(entry)}): ${entry.stale}\n`);
          onReclaim?.(entry);
        }
      } else tickets.push(entry);
    } else if (reclaim && now - stat.mtimeMs > LEFTOVER_STALE_MS &&
      (name.startsWith(".tmp-") || ((HELD.test(name) || ASSIGNING.test(name)) && !listed.has(name.replace(/\.(held|assigning)$/, ".json"))))) {
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

const round = ms => Math.round(ms / 100) / 10;

function lockReport(name, dir) {
  const now = Date.now();
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
  return { name, dir, holder: live[0] ?? null, queue: live.slice(1), stale: entries.filter(entry => entry.stale) };
}

function status(options) {
  if (options.pool !== undefined) return poolStatus(options);
  if (options.name === undefined) return overviewStatus(options);
  const result = lockReport(options.name, lockDir(options, false));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [result.holder
    ? `${options.name}: ${result.holder.state} by "${result.holder.label}" (pid ${result.holder.pid ?? "-"}), ${result.queue.length} waiting`
    : `${options.name}: free`];
  for (const entry of [result.holder, ...result.queue, ...result.stale].filter(Boolean)) {
    const age = entry.state === "holding" ? `held ${entry.held_s}s` : `queued ${entry.age_s}s`;
    lines.push(`  ${(entry.state ?? "stale").padEnd(9)} pid ${String(entry.pid ?? "-").padEnd(7)} ${age.padEnd(14)} ${entry.label ?? ""}` +
      `${entry.cwd ? `  [${entry.cwd}]` : ""}${entry.stale ? `  (${entry.stale})` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---- Workstation pools ----

class DockerError extends Error {}
class NotHeldError extends Error {}
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const projectId = base => crypto.createHash("sha256").update(base).digest("hex").slice(0, 8);
const gib = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const lastLine = text => String(text).trim().split("\n").pop() || "no output";
const quote = word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

function onlyKeys(object, keys, where, fail) {
  const extra = Object.keys(object).filter(key => !keys.includes(key));
  if (extra.length) fail(`unknown setting ${extra.join(", ")} in ${where}`);
}

function wholeSeconds(value, fallback, where, min, fail) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) fail(`${where} must be a whole number of seconds, at least ${min}`);
  return value;
}

function memoryBytes(value) {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(String(value));
  return match ? Math.floor(Number(match[1]) * UNITS[(match[2] || "b").toLowerCase()]) : NaN;
}

// <root>/.ai-dev-kit/workstations.json is tracked project config; relative paths
// in it resolve against the project root.
function loadConfig(base, options) {
  const file = options.config ? path.resolve(options.config) : path.join(base, CONFIG_FILE);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") throw new ConfigError(`no workstation pools are declared: ${file} does not exist (see templates/workstation/README.md)`);
    throw new ConfigError(`${file}: ${error instanceof SyntaxError ? `invalid JSON: ${error.message}` : error.message}`);
  }
  const fail = message => { throw new ConfigError(`${file}: ${message}`); };
  if (!isObject(raw)) fail("must hold a JSON object");
  onlyKeys(raw, ["schema_version", "warn_hold_seconds", "pools"], "the top level", fail);
  if (raw.schema_version !== 1) fail("schema_version must be 1");
  const warnHoldS = wholeSeconds(raw.warn_hold_seconds, POOL_DEFAULTS.warn_hold_seconds, "warn_hold_seconds", 0, fail);
  if (!isObject(raw.pools) || !Object.keys(raw.pools).length) fail("pools must map at least one pool name to its settings");
  const pools = {};
  for (const [name, settings] of Object.entries(raw.pools)) {
    if (!NAME.test(name)) fail(`pool name "${name}" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`);
    pools[name] = poolSettings(name, settings, base, warnHoldS, fail);
  }
  return { file, warnHoldS, pools };
}

function poolSettings(name, raw, base, warnHoldS, fail) {
  const at = key => `pools.${name}.${key}`;
  if (!isObject(raw)) fail(`pools.${name} must be an object`);
  onlyKeys(raw, ["image", "build", "slots", "cpus", "memory", "screen", "env", "mounts", "start", "user", "min_free_disk",
    "requires", "prepare", "timeout_seconds", "max_hold_seconds", "warn_hold_seconds"], `pools.${name}`, fail);
  const pool = { ...POOL_DEFAULTS, ...raw, name };
  if (typeof pool.image !== "string" || !/^[a-z0-9][\w./:@-]*$/i.test(pool.image)) fail(`${at("image")} must name a Docker image; add "build" to build it from a Dockerfile`);
  if (raw.build !== undefined) {
    if (!isObject(raw.build) || typeof raw.build.dockerfile !== "string") fail(`${at("build")} needs a "dockerfile" path`);
    onlyKeys(raw.build, ["dockerfile", "context", "args"], at("build"), fail);
    const args = raw.build.args ?? {};
    if (!isObject(args) || Object.values(args).some(value => typeof value !== "string")) fail(`${at("build.args")} must map names to strings`);
    pool.build = {
      dockerfile: path.resolve(base, raw.build.dockerfile),
      context: path.resolve(base, raw.build.context ?? path.dirname(raw.build.dockerfile)),
      args,
    };
  }
  if (!Number.isInteger(pool.slots) || pool.slots < 1 || pool.slots > 64) fail(`${at("slots")} must be a whole number from 1 to 64`);
  if (typeof pool.cpus !== "number" || !(pool.cpus > 0)) fail(`${at("cpus")} must be a positive number`);
  pool.memoryBytes = memoryBytes(pool.memory);
  if (!(pool.memoryBytes >= 64 * UNITS.m)) fail(`${at("memory")} must be at least 64m, written like "2.5g" or "512m"`);
  if (typeof pool.screen !== "string" || !/^\d+x\d+x(8|16|24)$/.test(pool.screen)) fail(`${at("screen")} must look like 1920x1080x24`);
  pool.minFreeDiskBytes = memoryBytes(pool.min_free_disk);
  if (!(pool.minFreeDiskBytes >= 0)) fail(`${at("min_free_disk")} must be a size such as "5g" or "0"`);
  pool.env = raw.env ?? {};
  if (!isObject(pool.env) || Object.entries(pool.env).some(([key, value]) => !/^[A-Za-z_]\w*$/.test(key) || typeof value !== "string")) {
    fail(`${at("env")} must map variable names to strings`);
  }
  if (!Array.isArray(raw.mounts ?? [])) fail(`${at("mounts")} must be a list`);
  pool.mounts = (raw.mounts ?? []).map((mount, index) => {
    if (!isObject(mount) || typeof mount.source !== "string" || typeof mount.target !== "string" || !path.isAbsolute(mount.target)) {
      fail(`${at(`mounts[${index}]`)} needs a "source" path and an absolute "target"`);
    }
    onlyKeys(mount, ["source", "target", "readonly"], at(`mounts[${index}]`), fail);
    const source = mount.source.startsWith("~/") ? path.join(os.homedir(), mount.source.slice(2)) : path.resolve(base, mount.source);
    return { source, target: mount.target, readonly: mount.readonly === true };
  });
  if (!Array.isArray(pool.start) || !pool.start.length || pool.start.some(word => typeof word !== "string" || !word)) {
    fail(`${at("start")} must be a non-empty list of command words, e.g. ["godot", "--path", "Game"]`);
  }
  if (!["host", "image"].includes(pool.user)) fail(`${at("user")} must be "host" (your uid) or "image"`);
  pool.requires = raw.requires ?? [];
  if (!Array.isArray(pool.requires) || pool.requires.some(item => typeof item !== "string" || !item || path.isAbsolute(item) || item.split(/[\\/]/).includes(".."))) {
    fail(`${at("requires")} must list paths inside the checkout, e.g. ["Game/.godot/imported"]`);
  }
  pool.prepare = raw.prepare ?? "";
  if (typeof pool.prepare !== "string") fail(`${at("prepare")} must be text telling how to prepare a checkout on the host`);
  pool.timeoutS = wholeSeconds(raw.timeout_seconds, POOL_DEFAULTS.timeout_seconds, at("timeout_seconds"), 0, fail);
  pool.maxHoldS = wholeSeconds(raw.max_hold_seconds, POOL_DEFAULTS.max_hold_seconds, at("max_hold_seconds"), 1, fail);
  pool.warnHoldS = wholeSeconds(raw.warn_hold_seconds, warnHoldS, at("warn_hold_seconds"), 0, fail);
  return pool;
}

function docker(args, timeout = DOCKER_TIMEOUT_MS) {
  const result = spawnSync(DOCKER, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new DockerError(`cannot run ${DOCKER} ${args[0]}: ${result.error.message}`);
  return result;
}

function dockerOut(args, what) {
  const result = docker(args);
  if (result.status !== 0) throw new DockerError(`${what}: ${lastLine(result.stderr || result.stdout)}`);
  return result.stdout;
}

// Limits are caps, not reservations, but three measured 4K runs peaked at 7.1
// of 7.65 GiB together: declaring more than Docker has invites the OOM killer.
function dockerCapacity(config) {
  const [memTotal, cpus] = dockerOut(["info", "--format", "{{.MemTotal}} {{.NCPU}}"],
    "cannot read Docker's memory and CPUs (is Docker running?)").trim().split(/\s+/).map(Number);
  const pools = Object.values(config.pools);
  const need = pools.reduce((sum, pool) => sum + pool.slots * pool.memoryBytes, 0);
  const problems = [];
  for (const pool of pools) if (pool.cpus > cpus) problems.push(`pool ${pool.name} gives each workstation ${pool.cpus} CPUs but Docker has ${cpus}`);
  if (need > memTotal) {
    problems.push(`the pools may use ${gib(need)} of memory (${pools.map(pool => `${pool.name}: ${pool.slots} × ${gib(pool.memoryBytes)}`).join(", ")}), ` +
      `more than the ${gib(memTotal)} Docker can use; lower slots or memory in ${config.file}, or give Docker more memory (Docker Desktop: Settings > Resources)`);
  }
  return { mem_total: memTotal, cpus, need, problems };
}

function ensureImage(ctx) {
  const { pool } = ctx;
  if (docker(["image", "inspect", pool.image]).status === 0) return;
  if (!pool.build) throw new DockerError(`image ${pool.image} of pool ${pool.name} is not available locally; build it, or declare "build" for the pool`);
  process.stderr.write(`resource-lock: building ${pool.image} for pool ${pool.name}\n`);
  // The label lets prune find superseded images this pool built, and only those.
  const args = ["build", "-t", pool.image, "-f", pool.build.dockerfile, "--label", `${LABEL}.image=${ctx.id}/${pool.name}`];
  for (const [key, value] of Object.entries(pool.build.args)) args.push("--build-arg", `${key}=${value}`);
  // Build output goes to stderr so claim's stdout stays machine-readable.
  const result = spawnSync(DOCKER, [...args, pool.build.context], { stdio: ["ignore", 2, 2] });
  if (result.error || result.status !== 0) throw new DockerError(`docker build of ${pool.image} failed`);
}

function poolContext(options) {
  const base = baseDir(options);
  const config = loadConfig(base, options);
  const pool = config.pools[options.pool];
  if (!pool) throw new ConfigError(`${config.file} declares no pool "${options.pool}" (declared: ${Object.keys(config.pools).join(", ")})`);
  return { base, config, pool, id: projectId(base), dir: stateDir(base, "pools", options.pool, false) };
}

function containerName(ctx, slot, token) {
  return `aidk-ws-${ctx.id}-${ctx.pool.name}-${slot}-${token.slice(-6)}`;
}

function poolContainers(id, pool, slot, withSize = false) {
  const filters = ["--filter", `label=${LABEL}=${id}/${pool}`];
  if (slot !== undefined) filters.push("--filter", `label=${LABEL}.slot=${slot}`);
  const format = `{{.Names}}\t{{.State}}\t{{.Label "${LABEL}.slot"}}\t{{.Label "${LABEL}.token"}}${withSize ? "\t{{.Size}}" : ""}`;
  return dockerOut(["ps", "-a", ...(withSize ? ["-s"] : []), ...filters, "--format", format], "cannot list workstations")
    .split("\n").filter(Boolean).map(line => {
      const [name, state, slotLabel, token, size] = line.split("\t");
      // Size is "<writable layer> (virtual <with image>)"; only the first part is this container's own.
      return { name, state, slot: slotLabel ? Number(slotLabel) : null, token: token || null, ...(withSize ? { writable: size.split(" (")[0] } : {}) };
    });
}

// Actual use, never apparent file sizes: df of Docker's disk (seen from a
// throwaway container), statfs of the host disk, allocated blocks of evidence.
function vmDisk(image) {
  const line = dockerOut(["run", "--rm", "--entrypoint", "df", image, "-Pk", "/"], "cannot read the free disk of Docker").trim().split("\n").pop();
  const [, total, used, free] = line.split(/\s+/).map(Number);
  return { total: total * 1024, used: used * 1024, free: free * 1024 };
}

function hostDisk(dir) {
  let at = path.resolve(dir);
  while (!fs.existsSync(at)) at = path.dirname(at);
  const stat = fs.statfsSync(at);
  return { path: at, total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
}

function allocated(dir, seen = new Set()) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const stat = fs.lstatSync(file);
    if (seen.has(`${stat.dev}:${stat.ino}`)) continue;
    seen.add(`${stat.dev}:${stat.ino}`);
    total += stat.blocks * 512;
    if (entry.isDirectory()) total += allocated(file, seen);
  }
  return total;
}

// On Docker Desktop the VM disk is a sparse file on the host disk, so both need room.
function checkDisk(ctx, options) {
  const need = ctx.pool.minFreeDiskBytes;
  if (!need) return;
  const vm = vmDisk(ctx.pool.image);
  const host = hostDisk(options.out ?? ctx.dir);
  const short = [];
  if (vm.free < need) short.push(`Docker's disk has ${gib(vm.free)} free`);
  if (host.free < need) short.push(`the host disk at ${host.path} has ${gib(host.free)} free`);
  if (short.length) {
    throw new BlockedError(`pool ${ctx.pool.name} needs ${gib(need)} free (min_free_disk) but ${short.join(" and ")}; ` +
      `free space (resource-lock.cjs prune --pool ${ctx.pool.name} removes unused workstations, old images and, with --evidence-days, old evidence) and retry; nothing ran`);
  }
}

function worktree(options) {
  const dir = path.resolve(options.project || process.cwd());
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 ? top.stdout.trim() : dir;
}

function readSlots(dir) {
  const slots = new Map();
  for (const name of list(dir)) {
    const match = name.match(SLOT);
    const record = match && readJson(path.join(dir, name));
    if (record) slots.set(Number(match[1]), record);
  }
  return slots;
}

function slotOf(dir, token) {
  for (const [slot, record] of readSlots(dir)) if (record.token === token) return { slot, record };
  return null;
}

function logEvent(dir, event) {
  fs.appendFileSync(path.join(dir, EVENTS), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function readEvents(dir, limit) {
  let text;
  try { text = fs.readFileSync(path.join(dir, EVENTS), "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(Boolean).slice(-limit).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// A reclaimed holder is never dropped silently: the reclaim is printed, logged
// and shown by status, and the holder's own renew or release reports it.
function noteReclaim(ctx) {
  return entry => {
    const data = entry.data ?? {};
    if (data.slot === undefined) return;
    const running = data.pid && data.host === HOST && alive(data.pid) ? ` while owner pid ${data.pid} was still running` : "";
    logEvent(ctx.dir, { event: "reclaimed", slot: data.slot, token: entry.token, label: data.label ?? null, pid: data.pid ?? null, reason: `${entry.stale}${running}` });
    process.stderr.write(`resource-lock: reclaimed workstation slot ${data.slot} of pool ${ctx.pool.name} from "${data.label ?? "?"}": ${entry.stale}${running}\n`);
  };
}

// Start time of a process as ps prints it in the C locale, or null when the
// process is gone. A pid that now has another start time was reused.
function processStart(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

let ownStart;

// A marker is left over when its holder cannot act any more: its pid is gone,
// or belongs to a later process (another start time), or the marker has not
// been refreshed for MUTEX_STALE_MS. ps runs only for markers older than
// MUTEX_RECHECK_MS, at most once per pid per acquisition.
function leftoverMarker(holder, mtimeMs, starts) {
  const age = Date.now() - mtimeMs;
  if (age > MUTEX_STALE_MS) return true;
  if (holder.host !== HOST) return false;
  if (!alive(holder.pid)) return true;
  if (age < MUTEX_RECHECK_MS || !holder.started) return false;
  if (!starts.has(holder.pid)) starts.set(holder.pid, processStart(holder.pid));
  const start = starts.get(holder.pid);
  return start !== null && start !== holder.started;
}

// Mark, then list markers: a marker that exists for a whole listing is in it,
// so of two contenders at least one sees the other and backs off. Markers whose
// holder cannot act any more are removed. fn receives beat(), which refreshes
// this holder's marker; call it after every slow step inside the mutex.
function withSlots(dir, fn, waitMs = 60000) {
  const name = `mutex-${rand()}.json`;
  const mine = path.join(dir, name);
  const deadline = Date.now() + waitMs;
  const starts = new Map();
  ownStart ??= processStart(process.pid);
  let delay = 2;
  for (;;) {
    createExclusive(dir, name, { pid: process.pid, host: HOST, started: ownStart });
    let holder = null;
    for (const other of list(dir)) {
      if (!MUTEX.test(other) || other === name) continue;
      const file = path.join(dir, other);
      const data = readJson(file), stat = statQuiet(file);
      if (!data || !stat) continue;
      if (leftoverMarker(data, stat.mtimeMs, starts)) {
        unlinkQuiet(file);
        process.stderr.write(`resource-lock: removed slot-mutex marker ${other} of pid ${data.pid}: its holder can no longer act\n`);
        continue;
      }
      holder = data;
      break;
    }
    if (!holder) {
      try { return fn(() => touch(mine)); } finally { unlinkQuiet(mine); }
    }
    unlinkQuiet(mine);
    if (Date.now() >= deadline) {
      const error = new MutexBusyError(`the slots of ${dir} stayed locked by pid ${holder.pid} for ${waitMs / 1000}s`);
      error.holder = holder;
      throw error;
    }
    pause(delay + Math.random() * delay);
    delay = Math.min(100, delay * 2);
  }
}

// Runs under the slot mutex in the assigning section; holders whose ticket is
// gone never touch their slot file. beat() after each docker rm keeps this
// holder's mutex marker younger than one docker timeout.
function freeOrphans(ctx, live, beat) {
  for (const [slot, record] of readSlots(ctx.dir)) {
    if (live.has(record.token)) continue;
    const removed = record.container ? docker(["rm", "-f", record.container]).status === 0 : true;
    beat();
    logEvent(ctx.dir, { event: "freed", slot, token: record.token, container: record.container ?? null, label: record.label ?? null, removed });
    unlinkQuiet(path.join(ctx.dir, `slot-${slot}.json`));
    process.stderr.write(`resource-lock: removed workstation ${record.container} (slot ${slot} of pool ${ctx.pool.name}, "${record.label ?? "?"}"): ` +
      `its holder ticket is gone${removed ? "" : "; docker rm failed, the next claim of this slot retries"}\n`);
  }
}

function poolBlockers(dir, { tickets, choosing }, token) {
  const mine = tickets.find(entry => entry.token === token);
  const holders = new Set([...readSlots(dir).values()].map(record => record.token));
  const ahead = mine ? tickets.filter(entry => entry.token !== token && !holders.has(entry.token) &&
    (entry.name < mine.name || fs.existsSync(path.join(dir, `${entry.token}.assigning`)))) : [];
  return { mine, ahead, choosing: choosing.length };
}

// Resolves { held: true, slot, container } once this ticket has a slot, or
// { held: false } at the deadline or when the ticket is lost.
async function waitSlot(ctx, token, waitMs, maxHoldMs, holding, label) {
  const { dir, pool } = ctx;
  const deadline = Date.now() + waitMs;
  const ceiling = Math.min(1000, maxHoldMs / 4);
  const onReclaim = noteReclaim(ctx);
  let delay = 25;
  for (;;) {
    let view = poolBlockers(dir, scan(dir, true, onReclaim), token);
    if (!view.mine) return { held: false, lost: true };
    if (!view.ahead.length && !view.choosing) {
      createExclusive(dir, `${token}.assigning`, { pid: process.pid, host: HOST });
      try {
        const again = scan(dir, true, onReclaim);
        view = poolBlockers(dir, again, token);
        if (!view.mine) return { held: false, lost: true };
        if (!view.ahead.length) {
          let assigned = null;
          try {
            // Wait for the mutex no longer than the claim's own --wait (at least 1s, at most 60s).
            assigned = withSlots(dir, beat => {
              freeOrphans(ctx, new Set(again.tickets.map(entry => entry.token)), beat);
              const taken = readSlots(dir);
              for (let slot = 0; slot < pool.slots; slot++) {
                if (taken.has(slot)) continue;
                const container = containerName(ctx, slot, token);
                try {
                  createExclusive(dir, `slot-${slot}.json`, {
                    token, container, label, pid: process.pid, owner_pid: holding.pid ?? null, host: HOST, cwd: process.cwd(), claimed_at: Date.now(),
                  });
                } catch (error) { if (error.code === "EEXIST") continue; throw error; }
                createExclusive(dir, `${token}.held`, { ...holding, slot, held_at: Date.now() });
                return { held: true, slot, container };
              }
              return null;
            }, Math.min(60000, Math.max(1000, deadline - Date.now())));
          } catch (error) {
            if (!(error instanceof MutexBusyError)) throw error;
            if (Date.now() >= deadline) return { held: false, holders: [...readSlots(dir).values()], ahead: view.ahead.length, mutex: error.holder };
          }
          if (assigned) return assigned;
        }
      } finally { unlinkQuiet(path.join(dir, `${token}.assigning`)); }
    }
    if (Date.now() >= deadline) return { held: false, holders: [...readSlots(dir).values()], ahead: view.ahead.length };
    touch(path.join(dir, `${token}.json`));
    await sleep(Math.max(1, Math.min(delay, deadline - Date.now())));
    delay = Math.min(ceiling, delay * 2);
  }
}

function blockedPool(ctx, options, outcome) {
  const holders = outcome.holders ?? [];
  const why = outcome.lost ? "lost its queue ticket while waiting (reclaimed after max-hold)"
    : `has no free workstation after ${options.waitMs / 1000}s (${holders.length} of ${ctx.pool.slots} held` +
      `${holders.length ? `: ${holders.map(record => `"${record.label}" pid ${record.owner_pid ?? record.pid}`).join(", ")}` : ""}` +
      `${outcome.ahead ? `; ${outcome.ahead} waiting ahead` : ""}` +
      `${outcome.mutex ? `; the slot mutex is held by pid ${outcome.mutex.pid}` : ""})`;
  process.stderr.write(`resource-lock: BLOCKED (retryable): pool ${ctx.pool.name} ${why}; nothing ran\n`);
  process.exit(BLOCKED);
}

// Every claim starts a new container from the image: the clean state.
async function startWorkstation(ctx, slot, container, token, out, project) {
  const { pool } = ctx;
  for (const mount of pool.mounts) if (!fs.existsSync(mount.source)) throw new ConfigError(`pool ${pool.name} mounts ${mount.source}, which does not exist`);
  // Leftovers of this slot whose removal failed earlier.
  for (const row of poolContainers(ctx.id, pool.name, slot)) docker(["rm", "-f", row.name]);
  const env = { LP_NUM_THREADS: String(Math.max(1, Math.floor(pool.cpus))), WS_SCREEN: pool.screen, ...pool.env };
  const args = ["run", "-d", "--name", container,
    "--label", `${LABEL}=${ctx.id}/${pool.name}`, "--label", `${LABEL}.slot=${slot}`, "--label", `${LABEL}.token=${token}`,
    "--cpus", String(pool.cpus), "--memory", String(pool.memoryBytes), "--memory-swap", String(pool.memoryBytes)];
  if (pool.user === "host") args.push("--user", `${process.getuid()}:${process.getgid()}`);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  // The worktree keeps its host path, so absolute paths in build outputs hold on both sides.
  args.push("-v", `${project}:${project}`, "-w", project, "-v", `${out}:/ws/out`);
  for (const mount of pool.mounts) args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  dockerOut([...args, pool.image, "--screen", pool.screen], `cannot start workstation ${container}`);
  for (let i = 0; i < 100; i++) {
    if (docker(["exec", container, "xdpyinfo"], 10000).status === 0) return;
    await sleep(100);
  }
  throw new DockerError(`workstation ${container} started but its screen did not answer within 10s`);
}

// Undo a claim that did not complete, or end a run. The container is always
// this claim's own; the slot file is removed only if it still names this
// claim, checked and removed under the slot mutex. Refreshing the ticket alone
// is not enough: a ticket whose owner pid is gone is reclaimed however fresh.
function giveBack(ctx, token, assigned) {
  if (assigned) {
    const file = path.join(ctx.dir, `slot-${assigned.slot}.json`);
    try {
      withSlots(ctx.dir, () => {
        docker(["rm", "-f", assigned.container]);
        if (readJson(file)?.token === token) unlinkQuiet(file);
      }, 10000);
    } catch (error) {
      process.stderr.write(`resource-lock: ${error.message}; the next claim frees slot ${assigned.slot}\n`);
      try { docker(["rm", "-f", assigned.container]); } catch { /* reported above */ }
    }
  }
  removeTicket(ctx.dir, token);
}

// Copies made inside a workstation through the bind mount are real data on the
// host, while the host can clone (APFS clonefile, reflink): prepare checkouts
// on the host, and refuse a claim for a checkout that is not prepared.
function requirePrepared(ctx, project) {
  const missing = ctx.pool.requires.filter(item => !fs.existsSync(path.join(project, item)));
  if (missing.length) {
    throw new Error(`checkout ${project} lacks ${missing.join(", ")}, which pool ${ctx.pool.name} requires; ` +
      `prepare it on the host, not in a workstation${ctx.pool.prepare ? `: ${ctx.pool.prepare}` : ""}; nothing ran`);
  }
}

// claim.json ties the evidence directory to the workstation it came from; a
// player review cites it. Written by the claimer, outside the container.
function recordClaim(ctx, outcome, out, project, label) {
  const image = docker(["image", "inspect", "--format", "{{.Id}}", ctx.pool.image]);
  fs.writeFileSync(path.join(out, "claim.json"), `${JSON.stringify({
    schema_version: 1, pool: ctx.pool.name, slot: outcome.slot, workstation: outcome.container, label,
    image: ctx.pool.image, image_id: image.status === 0 ? image.stdout.trim() : null, screen: ctx.pool.screen,
    start: ctx.pool.start, cpus: ctx.pool.cpus, memory: ctx.pool.memory, worktree: project, host: HOST,
    claimed_at: new Date().toISOString(),
  }, null, 2)}\n`);
}

function evidenceDir(ctx, options, token) {
  const out = options.out ? path.resolve(options.out) : path.join(ctx.dir, "out", token);
  fs.mkdirSync(out, { recursive: true });
  return out;
}

function commonFlags(options) {
  const flags = options.root ? ["--root", path.resolve(options.root)] : ["--project", baseDir(options)];
  return options.config ? [...flags, "--config", path.resolve(options.config)] : flags;
}

async function claim(options) {
  const ctx = poolContext(options);
  const capacity = dockerCapacity(ctx.config);
  if (capacity.problems.length) throw new ConfigError(capacity.problems.join("; "));
  ensureImage(ctx);
  checkDisk(ctx, options);
  const project = worktree(options);
  requirePrepared(ctx, project);
  stateDir(ctx.base, "pools", ctx.pool.name, true);
  const owner = options.ownerPid ? Number(options.ownerPid) : null;
  const maxHoldMs = options.maxHoldMs ?? ctx.pool.maxHoldS * 1000;
  const label = options.label ?? `claim (owner pid ${owner ?? "unchecked"})`;
  const token = enqueue(ctx.dir, { pid: process.pid, label }, maxHoldMs);
  let assigned = null, done = false;
  process.on("exit", () => { if (!done) giveBack(ctx, token, assigned); });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => process.exit(code));
  // Nobody refreshes the ticket after this process exits, so max-hold is the
  // lease: renew it, or pass --owner-pid so a dead owner frees it at once.
  const outcome = await waitSlot(ctx, token, options.waitMs, maxHoldMs, { pid: owner }, label);
  if (!outcome.held) blockedPool(ctx, options, outcome);
  assigned = outcome;
  const out = evidenceDir(ctx, options, token);
  await startWorkstation(ctx, outcome.slot, outcome.container, token, out, project);
  recordClaim(ctx, outcome, out, project, label);
  done = true;
  const tool = [process.execPath, __filename].map(quote).join(" ");
  const result = {
    token, pool: ctx.pool.name, slot: outcome.slot, workstation: outcome.container, out,
    lease_s: maxHoldMs / 1000, owner_pid: owner,
    exec: [DOCKER, "exec", outcome.container, "ws-run", "--timeout", String(ctx.pool.timeoutS), "--", ...ctx.pool.start].map(quote).join(" "),
    renew: [tool, "renew", "--pool", ctx.pool.name, "--token", token, ...commonFlags(options).map(quote)].join(" "),
    release: [tool, "release", "--pool", ctx.pool.name, "--token", token, ...commonFlags(options).map(quote)].join(" "),
  };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n`
    : `${Object.entries(result).map(([key, value]) => `${key}=${value ?? ""}`).join("\n")}\n`);
}

async function runPool(options) {
  const ctx = poolContext(options);
  const capacity = dockerCapacity(ctx.config);
  if (capacity.problems.length) throw new ConfigError(capacity.problems.join("; "));
  ensureImage(ctx);
  checkDisk(ctx, options);
  const project = worktree(options);
  requirePrepared(ctx, project);
  stateDir(ctx.base, "pools", ctx.pool.name, true);
  const argv = options.argv ?? [];
  const maxHoldMs = options.maxHoldMs ?? ctx.pool.maxHoldS * 1000;
  const label = options.label ?? [...ctx.pool.start, ...argv].join(" ").slice(0, 160);
  const token = enqueue(ctx.dir, { pid: process.pid, label }, maxHoldMs);
  const ticketPath = path.join(ctx.dir, `${token}.json`);
  let assigned = null, child = null, childExited = false;
  process.on("exit", () => {
    if (child?.pid && !childExited) signalGroup(child.pid, "SIGKILL");
    giveBack(ctx, token, assigned);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(signal, () => {
      if (!child?.pid) process.exit(code);
      signalGroup(child.pid, signal);
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 10000).unref();
    });
  }
  const outcome = await waitSlot(ctx, token, options.waitMs, maxHoldMs, {}, label);
  if (!outcome.held) blockedPool(ctx, options, outcome);
  assigned = outcome;
  const out = evidenceDir(ctx, options, token);
  await startWorkstation(ctx, outcome.slot, outcome.container, token, out, project);
  recordClaim(ctx, outcome, out, project, label);
  const timeout = options.timeout !== undefined ? options.timeout : String(ctx.pool.timeoutS);
  child = spawn(DOCKER, ["exec", outcome.container, "ws-run", "--timeout", timeout, "--", ...ctx.pool.start, ...argv], {
    detached: true,
    stdio: [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"],
  });
  // Releasing removes the container, which also stops anything left inside it.
  const finish = code => { childExited = true; process.exit(code); };
  child.on("error", error => {
    process.stderr.write(`resource-lock: cannot start ${DOCKER} exec: ${error.message}\n`);
    finish(127);
  });
  child.on("exit", (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] || 1)));
  if (!child.pid) return;
  // Like run --name: an orphaned docker exec keeps the slot until its group ends.
  const temp = path.join(ctx.dir, `.tmp-${rand()}`);
  fs.writeFileSync(temp, `${JSON.stringify({ pgid: child.pid, slot: outcome.slot, held_at: Date.now() })}\n`, { flag: "wx" });
  fs.renameSync(temp, path.join(ctx.dir, `${token}.held`));
  setInterval(() => touch(ticketPath), Math.max(200, Math.min(maxHoldMs / 4, 15000))).unref();
}

// A token proves ownership; status never prints tokens. Refreshing the ticket
// first keeps it from expiring between this check and the release.
function heldBy(dir, pool, token, verb) {
  if (!touch(path.join(dir, `${token}.json`))) {
    const reclaimed = readEvents(dir, 1000).reverse().find(event => event.token === token && event.event === "reclaimed");
    throw new NotHeldError(reclaimed
      ? `pool ${pool} ticket ${token} was reclaimed at ${reclaimed.at} (${reclaimed.reason}); its workstation is removed`
      : `pool ${pool} ticket ${token} is not held (already released, or claimed in another pool or project)`);
  }
  const found = slotOf(dir, token);
  if (!found) throw new NotHeldError(`pool ${pool} ticket ${token} is still waiting for a workstation; nothing to ${verb}`);
  return found;
}

// Under the slot mutex the slot file found by heldBy stays this claim's until
// it is removed here, even if a scan reclaims the ticket meanwhile.
function releasePool(options) {
  const dir = stateDir(baseDir(options), "pools", options.pool, false);
  if (!fs.existsSync(dir)) throw new NotHeldError(`pool ${options.pool} ticket ${options.token} is not held (no claims in this pool)`);
  const { slot, record } = withSlots(dir, () => {
    const found = heldBy(dir, options.pool, options.token, "release");
    const removed = docker(["rm", "-f", found.record.container]);
    if (removed.status !== 0) {
      process.stderr.write(`resource-lock: docker rm ${found.record.container} failed (${lastLine(removed.stderr)}); the next claim of slot ${found.slot} removes it\n`);
    }
    unlinkQuiet(path.join(dir, `slot-${found.slot}.json`));
    removeTicket(dir, options.token);
    return found;
  });
  process.stdout.write(`released ${record.container} (slot ${slot} of pool ${options.pool})\n`);
}

function renew(options) {
  const dir = stateDir(baseDir(options), "pools", options.pool, false);
  const { slot, record } = heldBy(dir, options.pool, options.token, "renew");
  const ticket = readJson(path.join(dir, `${options.token}.json`)) ?? {};
  process.stdout.write(`renewed ${record.container} (slot ${slot} of pool ${options.pool}) for ${(ticket.max_hold_ms ?? DEFAULT_MAX_HOLD_S * 1000) / 1000}s\n`);
}

function poolReport(base, name, config, options = {}) {
  const dir = stateDir(base, "pools", name, false);
  const pool = config?.pools[name] ?? null;
  const now = Date.now();
  const { tickets } = scan(dir, false);
  const records = readSlots(dir);
  const byToken = new Map(tickets.map(entry => [entry.token, entry]));
  const warn = options.warnHoldS ?? pool?.warnHoldS ?? config?.warnHoldS ?? POOL_DEFAULTS.warn_hold_seconds;
  const slots = [];
  for (let slot = 0; slot < Math.max(pool?.slots ?? 0, ...[...records.keys()].map(index => index + 1)); slot++) {
    const record = records.get(slot);
    if (!record) {
      if (slot < (pool?.slots ?? 0)) slots.push({ slot, state: "free" });
      continue;
    }
    const entry = byToken.get(record.token);
    const data = entry?.data ?? {};
    const heldMs = now - record.claimed_at;
    const leaseMs = entry ? (data.max_hold_ms ?? DEFAULT_MAX_HOLD_S * 1000) - (now - Math.max(entry.mtimeMs, data.held_at || 0)) : null;
    const owner = record.owner_pid ?? null;
    slots.push({
      slot, state: entry && !entry.stale ? "holding" : "stale", workstation: record.container ?? null, holder: record.token.slice(-6),
      label: record.label ?? null, pid: record.pid ?? null, pid_alive: record.pid && record.host === HOST ? alive(record.pid) : null,
      owner_pid: owner, owner_alive: owner && record.host === HOST ? alive(owner) : null,
      host: record.host ?? null, cwd: record.cwd ?? null, held_s: round(heldMs), lease_left_s: leaseMs === null ? null : round(Math.max(0, leaseMs)),
      over_warn: warn > 0 && heldMs > warn * 1000,
      stale: !entry ? "holder ticket is gone; the next claim removes this workstation" : entry.stale,
    });
  }
  const holders = new Set([...records.values()].map(record => record.token));
  const queue = tickets.filter(entry => !holders.has(entry.token) && !entry.stale).map(entry => ({
    label: entry.data?.label ?? null, pid: entry.data?.pid ?? null, cwd: entry.data?.cwd ?? null,
    waited_s: round(now - (entry.data?.created_at ?? entry.mtimeMs)),
  }));
  const report = {
    pool: name, dir, warn_hold_s: warn,
    config: pool && { image: pool.image, slots: pool.slots, cpus: pool.cpus, memory: pool.memory, screen: pool.screen, max_hold_s: pool.maxHoldS },
    slots, queue, recent: readEvents(dir, 5),
  };
  if (!pool) report.config_error = config ? `${config.file} declares no pool "${name}"` : options.configError ?? "no configuration";
  const out = path.join(dir, "out");
  report.evidence = { path: out, runs: list(out).length, allocated_bytes: fs.existsSync(out) ? allocated(out) : 0 };
  if (options.docker && config && pool) {
    try {
      const capacity = dockerCapacity(config);
      const containers = poolContainers(projectId(base), name, undefined, true).map(row => ({
        ...row, token: undefined, matches: row.slot !== null && records.get(row.slot)?.container === row.name,
      }));
      const image = dockerOut(["image", "ls", "--filter", `reference=${pool.image}`, "--format", "{{.Size}}"], "cannot read the image size").trim().split("\n")[0] || null;
      report.docker = {
        mem_total: capacity.mem_total, need: capacity.need, problems: capacity.problems, containers,
        disk: { vm: vmDisk(pool.image), host: hostDisk(dir), image: { name: pool.image, size: image }, min_free: pool.minFreeDiskBytes },
      };
    } catch (error) { report.docker = { error: error.message }; }
  }
  return report;
}

function duration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
}

// A claim without --owner-pid is held by its lease alone; its claim process has exited.
function holderLine(entry, warn) {
  const who = entry.owner_pid ? `owner pid ${entry.owner_pid}${entry.owner_alive === false ? " (gone)" : ""}`
    : entry.pid_alive === false ? "no owner pid" : `pid ${entry.pid ?? "-"}`;
  const lease = entry.lease_left_s === null ? "" : `, lease ${duration(entry.lease_left_s)} left`;
  return `"${entry.label ?? "?"}" ${who}, held ${duration(entry.held_s)}${lease}` +
    `${entry.over_warn ? `  ! held over ${duration(warn)}` : ""}`;
}

function renderPool(report, indent = "") {
  const held = report.slots.filter(slot => slot.state !== "free").length;
  const longest = report.queue.length ? `, longest ${duration(Math.max(...report.queue.map(entry => entry.waited_s)))}` : "";
  const config = report.config ? ` (${report.config.slots} × ${report.config.cpus} CPUs / ${report.config.memory}, ${report.config.image})` : "";
  const lines = [`${indent}pool ${report.pool}: ${held} of ${report.config?.slots ?? report.slots.length} workstations held, ${report.queue.length} waiting${longest}${config}`];
  if (report.config_error) lines.push(`${indent}  config: ${report.config_error}`);
  for (const slot of report.slots) {
    if (slot.state === "free") { lines.push(`${indent}  slot ${slot.slot}  free`); continue; }
    lines.push(`${indent}  slot ${slot.slot}  ${slot.state.padEnd(7)}  ${slot.workstation}  ${holderLine(slot, report.warn_hold_s)}` +
      `${slot.state === "stale" ? `  (${slot.stale})` : ""}${slot.cwd ? `  [${slot.cwd}]` : ""}`);
  }
  for (const entry of report.queue) {
    lines.push(`${indent}  waiting  pid ${entry.pid ?? "-"}  waited ${duration(entry.waited_s)}  ${entry.label ?? ""}${entry.cwd ? `  [${entry.cwd}]` : ""}`);
  }
  return lines;
}

function poolStatus(options) {
  const base = baseDir(options);
  let config = null, configError = null;
  try { config = loadConfig(base, options); } catch (error) { if (!(error instanceof ConfigError)) throw error; configError = error.message; }
  const warnHoldS = options.warnHold === undefined ? undefined : Number(options.warnHold);
  const report = poolReport(base, options.pool, config, { warnHoldS, configError, docker: !options.noDocker });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = renderPool(report);
  if (report.recent.length) {
    lines.push("recent:");
    for (const event of report.recent) {
      lines.push(`  ${event.at}  ${event.event} slot ${event.slot} "${event.label ?? "?"}"${event.reason ? `: ${event.reason}` : ""}${event.container ? ` (${event.container})` : ""}`);
    }
  }
  if (report.docker?.error) lines.push(`docker: ${report.docker.error}`);
  else if (report.docker) {
    const { disk, containers } = report.docker;
    const strays = containers.filter(row => !row.matches);
    lines.push(`docker: pools may use ${gib(report.docker.need)} of ${gib(report.docker.mem_total)} memory; ${containers.length} workstation container(s)` +
      `${strays.length ? `, not held by any slot: ${strays.map(row => row.name).join(", ")}` : ""}`);
    for (const problem of report.docker.problems) lines.push(`docker: ${problem}`);
    lines.push(`disk: Docker ${gib(disk.vm.used)} used, ${gib(disk.vm.free)} free; host ${gib(disk.host.free)} free at ${disk.host.path}; ` +
      `claims need ${gib(disk.min_free)} free on both`);
    lines.push(`  image ${disk.image.name}: ${disk.image.size ?? "not present"} (Docker's count, one copy for every workstation)`);
    for (const row of containers) lines.push(`  workstation ${row.name}: ${row.writable} writable layer (${row.state})`);
  }
  lines.push(`  evidence ${report.evidence.path}: ${report.evidence.runs} run(s), ${gib(report.evidence.allocated_bytes)} allocated`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Removes what no holder uses: workstation containers that no slot names,
// images this pool built that are not configured and not in a container, and
// (only with --evidence-days) old evidence of claims no longer held. Volumes
// are not touched; pools create none.
function prune(options) {
  const base = baseDir(options);
  const id = projectId(base);
  const dir = stateDir(base, "pools", options.pool, false);
  let pool = null;
  try { pool = loadConfig(base, options).pools[options.pool] ?? null; } catch (error) { if (!(error instanceof ConfigError)) throw error; }
  const verb = options.dryRun ? "would remove" : "removed";
  const before = { host: hostDisk(base), vm: pool ? vmDisk(pool.image) : null };
  const lines = [];
  // Containers first, then slot records: a slot record exists before its container.
  const containers = poolContainers(id, options.pool);
  const named = new Set([...readSlots(dir).values()].map(record => record.container));
  for (const row of containers.filter(row => !named.has(row.name))) {
    if (!options.dryRun) docker(["rm", "-f", row.name]);
    lines.push(`${verb} workstation ${row.name} (${row.state}, held by no slot)`);
  }
  const built = dockerOut(["image", "ls", "--filter", `label=${LABEL}.image=${id}/${options.pool}`, "--format", "{{.Repository}}:{{.Tag}}"],
    "cannot list workstation images").split("\n").filter(Boolean);
  for (const image of built) {
    if (image === pool?.image) continue;
    if (dockerOut(["ps", "-a", "--filter", `ancestor=${image}`, "--format", "{{.Names}}"], "cannot list containers").trim()) {
      lines.push(`kept image ${image}: a container still uses it`);
      continue;
    }
    if (!options.dryRun) dockerOut(["image", "rm", image], `cannot remove image ${image}`);
    lines.push(`${verb} image ${image} (built for this pool, no longer configured)`);
  }
  if (options.evidenceDays !== undefined) {
    const out = path.join(dir, "out");
    const live = new Set(scan(dir, false).tickets.filter(entry => !entry.stale).map(entry => entry.token));
    const cutoff = Date.now() - Number(options.evidenceDays) * 86400000;
    for (const token of list(out)) {
      const file = path.join(out, token);
      const stat = statQuiet(file);
      if (!stat?.isDirectory() || live.has(token) || stat.mtimeMs > cutoff) continue;
      // A filed player review keeps its evidence until keep_until (player-review.cjs).
      const filed = readJson(path.join(file, "review", "filed.json"));
      if (filed?.keep_until && Date.parse(filed.keep_until) > Date.now()) {
        lines.push(`kept evidence ${file}: player review ${filed.request} until ${filed.keep_until.slice(0, 10)}`);
        continue;
      }
      const size = allocated(file);
      if (!options.dryRun) fs.rmSync(file, { recursive: true, force: true });
      lines.push(`${verb} evidence ${file} (${gib(size)} allocated)`);
    }
  }
  if (!lines.length) lines.push(`pool ${options.pool}: nothing to remove`);
  if (!options.dryRun) {
    const host = hostDisk(base), vm = pool ? vmDisk(pool.image) : null;
    lines.push(`free disk: host ${gib(before.host.free)} -> ${gib(host.free)}` +
      `${vm ? `, Docker ${gib(before.vm.free)} -> ${gib(vm.free)}` : ""} (other processes also change these)`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Read-only view of every exclusive lock and workstation pool of a project on
// this machine (nothing goes to the center). Docker is not queried.
function overview(base, options = {}) {
  let config = null, configError = null;
  try { config = loadConfig(base, {}); } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (fs.existsSync(path.join(base, CONFIG_FILE))) configError = error.message;
  }
  const warn = options.warnHoldS ?? config?.warnHoldS ?? POOL_DEFAULTS.warn_hold_seconds;
  const dirs = kind => list(path.join(base, ".ai-dev-kit", kind)).filter(name => NAME.test(name) && statQuiet(path.join(base, ".ai-dev-kit", kind, name))?.isDirectory());
  const locks = dirs("locks").map(name => {
    const report = lockReport(name, stateDir(base, "locks", name, false));
    return { ...report, over_warn: warn > 0 && (report.holder?.held_s ?? 0) > warn };
  });
  const names = [...new Set([...Object.keys(config?.pools ?? {}), ...dirs("pools")])].sort();
  const pools = names.map(name => poolReport(base, name, config, { warnHoldS: options.warnHoldS, configError }));
  return { warn_hold_s: warn, config_error: configError, locks, pools };
}

function renderOverview(report) {
  if (report.error) return [`resources: unreadable (${report.error})`];
  const lines = ["resources on this machine (not reported to the center):"];
  if (report.config_error) lines.push(`  workstation config: ${report.config_error}`);
  for (const lock of report.locks) {
    const waiting = lock.queue.length ? `, ${lock.queue.length} waiting (longest ${duration(Math.max(...lock.queue.map(entry => entry.age_s ?? 0)))})` : "";
    lines.push(lock.holder
      ? `  lock ${lock.name}: ${lock.holder.state} by "${lock.holder.label}" pid ${lock.holder.pid ?? "-"}` +
        `${lock.holder.held_s === null ? "" : ` for ${duration(lock.holder.held_s)}`}${waiting}${lock.over_warn ? `  ! held over ${duration(report.warn_hold_s)}` : ""}`
      : `  lock ${lock.name}: free`);
  }
  for (const pool of report.pools) lines.push(...renderPool(pool, "  "));
  if (!report.locks.length && !report.pools.length) lines.push("  no locks or workstation pools in use");
  return lines;
}

function overviewStatus(options) {
  const report = overview(baseDir(options), { warnHoldS: options.warnHold === undefined ? undefined : Number(options.warnHold) });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderOverview(report).join("\n")}\n`);
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (process.platform === "win32") throw new Error("resource-lock requires macOS/Linux process groups; use WSL on Windows");
  const pooled = options.pool !== undefined;
  if (options.command === "run") return pooled ? runPool(options) : run(options);
  if (options.command === "acquire") return acquire(options);
  if (options.command === "release") return pooled ? releasePool(options) : release(options);
  if (options.command === "claim") return claim(options);
  if (options.command === "renew") return renew(options);
  if (options.command === "prune") return prune(options);
  return status(options);
}

module.exports = { overview, renderOverview };

if (require.main === module) {
  main().catch(error => {
    if (error instanceof BlockedError) {
      process.stderr.write(`resource-lock: BLOCKED (retryable): ${error.message}\n`);
      process.exit(BLOCKED);
    }
    process.stderr.write(`resource-lock: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exit(error instanceof UsageError || error instanceof ConfigError ? 2 : 1);
  });
}
