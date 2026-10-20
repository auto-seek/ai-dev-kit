#!/usr/bin/env node
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { constants } = require("node:os");

function exitedDarwinGroup(pid) {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return false;
  for (const line of result.stdout.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) return false;
    if (Number(match[1]) === pid && !match[2].startsWith("Z")) return false;
  }
  return true;
}

function redact(text, incomplete = false) {
  const output = text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s"\\]+@/g, "$1<redacted>@");
  // A killed writer can stop before '@'. Preserve JSON quote boundaries, and
  // leave complete successful host-only URLs intact when nothing was truncated.
  return incomplete
    ? output.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s"\\]+(?=[\s"\\]|$)/g, "$1<redacted>")
    : output;
}

function commandTimeoutSeconds(storage, configured) {
  if (!["git", "file", "redis"].includes(storage)) throw new Error("storage-kind must be git, file, or redis");
  const raw = process.env.AI_DEV_KIT_CASCADE_TIMEOUT_SECONDS ?? configured;
  if (raw === undefined) return storage === "git" ? 180 : 30;
  const seconds = Number(raw);
  if (String(raw).trim() === "" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new Error("Cascade command timeout must be positive and no greater than 3600 seconds");
  }
  return seconds;
}

function runCascade(args, { timeoutSeconds }) {
  return runProcess("cascade", args, { timeoutSeconds });
}

function runProcess(command, args, { timeoutSeconds, env = process.env, input }) {
  if (process.platform === "win32") throw new Error("Cascade process supervision requires macOS/Linux; use WSL on Windows");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) {
    throw new Error("invalid Cascade command timeout");
  }
  return new Promise((resolve, reject) => {
    // Git and SSH must stay in this owned group, so a timed-out command cannot
    // leave a transport process publishing after its caller has returned.
    const child = spawn(command, args, {
      detached: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout = [], stderr = [];
    let bytes = 0, outputOverflow = false, closed = false, exitCode = 1, cancelled = null;
    let cleanupFinished = false, killTimer, releaseTimer, startError;
    const signals = { SIGINT: 130, SIGTERM: 143 };
    const handlers = {};
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(releaseTimer);
      for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
    };
    const finish = () => {
      if (!closed || (cancelled !== null && !cleanupFinished)) return;
      cleanup();
      resolve({
        code: cancelled ?? exitCode,
        stdout: redact(Buffer.concat(stdout).toString("utf8"), cancelled !== null || exitCode !== 0),
        stderr: redact(Buffer.concat(stderr).toString("utf8"), true),
      });
    };
    const signalGroup = signal => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // Darwin can return EPERM for an empty/zombie-only process group.
        // Verify that no runnable member remains; real permission errors fail.
        if (error.code === "EPERM" && process.platform === "darwin" && exitedDarwinGroup(child.pid)) return;
        if (error.code !== "ESRCH") {
          cleanup();
          reject(new Error(`cannot terminate Cascade process group: ${error.message}`));
        }
      }
    };
    const cancel = (code, reason) => {
      if (cancelled !== null || closed) return;
      cancelled = code;
      stderr.push(Buffer.from(`\ncascade-process: ${reason}; verify remote state before retrying a write\n`));
      clearTimeout(deadline);
      signalGroup("SIGTERM");
      // Even if the direct child exits on TERM, a descendant may ignore it.
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        cleanupFinished = true;
        // An SSH ControlPersist master runs outside this group. It keeps the
        // stderr passed by a killed multiplex client until the remote command
        // ends, so stop waiting for EOF once the group itself is gone.
        releaseTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 2000);
        finish();
      }, 2000);
    };
    const collect = target => chunk => {
      if (outputOverflow) return;
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) target.push(chunk);
      else {
        // A truncated URI may end inside its credentials, before the '@'.
        // Discard all captured output when the limit prevents safe redaction.
        outputOverflow = true;
        stdout.length = 0;
        stderr.length = 0;
        cancel(1, "command output exceeded 8 MiB");
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      startError = error;
      stderr.push(Buffer.from(`cascade-process: ${error.message}\n`));
    });
    child.once("exit", () => {
      // A CLI's background descendants have no work after its result is final.
      // Killing them here also closes inherited pipes before the close event.
      if (cancelled === null) signalGroup("SIGKILL");
    });
    child.on("close", (code, signal) => {
      closed = true;
      exitCode = startError ? (startError.code === "ENOENT" ? 127 : 1)
        : code === null ? 128 + (constants.signals[signal] || 1) : code;
      finish();
    });
    const deadline = setTimeout(() => cancel(124, `timed out after ${timeoutSeconds} seconds`), timeoutSeconds * 1000);
    for (const [signal, code] of Object.entries(signals)) {
      handlers[signal] = () => cancel(code, `cancelled by ${signal}`);
      process.on(signal, handlers[signal]);
    }
    if (input !== undefined) {
      // A verifier may reject its arguments before reading. Its exit status is
      // authoritative; an EPIPE must not crash the parent or log stdin bytes.
      child.stdin.on("error", error => { if (error.code !== "EPIPE") cancel(1, "command stdin failed"); });
      child.stdin.end(input);
    }
  });
}

async function main() {
  const args = process.argv.slice(2), separator = args.indexOf("--");
  if (separator < 0) throw new Error("usage: cascade-process.cjs --storage-kind git|file|redis [--timeout-seconds N] -- <cascade arguments>");
  let storage, configured;
  for (let i = 0; i < separator; i += 2) {
    if (i + 1 >= separator) throw new Error(`missing value for ${args[i]}`);
    if (args[i] === "--storage-kind") storage = args[i + 1];
    else if (args[i] === "--timeout-seconds") configured = args[i + 1];
    else throw new Error(`unknown option: ${args[i]}`);
  }
  const result = await runCascade(args.slice(separator + 1), {
    timeoutSeconds: commandTimeoutSeconds(storage, configured),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = { commandTimeoutSeconds, runCascade, runProcess, redact };
if (require.main === module) main().catch(error => {
  console.error(`cascade-process: ${redact(error.message, true)}`);
  process.exitCode = 1;
});
