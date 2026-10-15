#!/usr/bin/env python3
"""Inspect one Cascade entrypoint and existing center without executing dispatch."""

import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class CheckError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse otherwise echoes arbitrary argument values, including URLs.
        raise CheckError("INVALID_ARGUMENTS", "Invalid doctor arguments; use --help for supported options.")


def arguments():
    parser = Parser(description=__doc__)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--min-version", default="0.8.0")
    backend = parser.add_mutually_exclusive_group(required=True)
    backend.add_argument("--storage")
    backend.add_argument("--git-remote")
    backend.add_argument("--redis-url")
    parser.add_argument("--git-cache")
    parser.add_argument("--namespace")
    parser.add_argument("--dispatch")
    args = parser.parse_args()
    if any(value is not None and not value.strip() for value in (args.storage, args.git_remote, args.redis_url, args.git_cache, args.dispatch)):
        raise CheckError("INVALID_PATH", "Selected storage, cache and dispatch paths or URLs must not be empty.")
    if not args.agent.strip() or any(ord(c) < 32 or ord(c) == 127 for c in args.agent):
        raise CheckError("INVALID_AGENT", "--agent must be a nonempty agent ID without control characters.")
    if args.storage is not None and (args.namespace is not None or args.git_cache is not None):
        raise CheckError("INVALID_STORAGE_OPTIONS", "File storage does not accept --namespace or --git-cache.")
    if args.git_cache is not None and args.git_remote is None:
        raise CheckError("INVALID_STORAGE_OPTIONS", "--git-cache requires --git-remote.")
    if args.storage is None and (not args.namespace or not args.namespace.strip()):
        raise CheckError("NAMESPACE_REQUIRED", "Git and Redis checks require an explicit --namespace.")
    args.required_version = max((0, 8, 0), version_tuple(args.min_version, minimum=True))
    return args


def version_tuple(value, minimum=False):
    # Approved downstream wheels may carry a PEP 440 local build label.
    # Keep rejecting prereleases and malformed suffixes instead of truncating.
    pattern = (r"(?:>=)?\s*([0-9]+)\.([0-9]+)(?:\.([0-9]+))?" if minimum else
               r"([0-9]+)\.([0-9]+)\.([0-9]+)(?:\+[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*)?")
    match = re.fullmatch(pattern, value)
    if not match:
        raise CheckError("INVALID_VERSION", "Use a complete release version with an optional local build label; --min-version accepts major.minor[.patch], optionally prefixed with >=.")
    return tuple(int(part or 0) for part in match.groups())


def source_provenance(module):
    unverified = {"status": "unverified", "reason": "No matching PEP 610 source metadata was found."}
    try:
        dist = importlib.metadata.distribution("cascade-auto")
        installed_module = dist.locate_file("cascade/__init__.py")
        if Path(installed_module).resolve() != Path(module.__file__).resolve():
            return {"status": "unverified", "reason": "Imported module does not match the installed distribution location."}
        raw = dist.read_text("direct_url.json")
        if raw is None:
            return unverified
        direct = json.loads(raw)
        source = {"status": "recorded", "basis": "PEP 610 metadata, not an integrity check or administrator approval"}
        commit = direct.get("vcs_info", {}).get("commit_id", "")
        if re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", commit):
            return {**source, "kind": "vcs", "commit_id": commit.lower()}
        digest = direct.get("archive_info", {}).get("hashes", {}).get("sha256", "")
        if re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            return {**source, "kind": "archive", "sha256": digest.lower()}
        return unverified
    except (importlib.metadata.PackageNotFoundError, OSError, ValueError, TypeError, AttributeError):
        return unverified


def check_runtime(report, args):
    import cascade
    from cascade.events import EventType

    report["runtime"].update(
        version=cascade.__version__,
        module_path=str(Path(cascade.__file__).resolve()),
        source=source_provenance(cascade),
        required_version=".".join(str(part) for part in args.required_version),
    )
    if version_tuple(cascade.__version__) < args.required_version:
        raise CheckError("RUNTIME_TOO_OLD", "Select a Cascade runtime meeting required_version (doctor always requires at least 0.8.0).")
    if EventType("task_retried").value != "task_retried":
        raise CheckError("EVENT_UNSUPPORTED", "This entrypoint cannot parse task_retried; select a compatible Cascade runtime.")
    report["runtime"]["status"] = "ok"
    report["protocol"].update(status="compatible", task_retried=True)


def check_center(report, args):
    from cascade.storage import FileStorage, GitStorage

    backend = "file" if args.storage is not None else "git" if args.git_remote is not None else "redis"
    report["center"]["storage"] = backend
    if backend == "file":
        if not (Path(args.storage) / "graph.json").is_file():
            raise CheckError("CENTER_MISSING", "The selected file center has no graph.json; select or restore the existing center.")
        storage = FileStorage(args.storage)
    elif backend == "git":
        from cascade.storage.git_ref_lease import _validate_namespace

        _validate_namespace(args.namespace)
        state_ref = f"refs/heads/cascade-state/{args.namespace}"
        found = subprocess.run(
            ["git", "ls-remote", "--exit-code", "--", args.git_remote, state_ref],
            capture_output=True, text=True, timeout=15, check=False,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if found.returncode == 2:
            raise CheckError("CENTER_MISSING", "The remote has no selected Cascade state ref; verify the remote and namespace. No center was created.")
        if found.returncode != 0:
            raise CheckError("CENTER_UNREACHABLE", "Cannot read the selected Git state ref; check Git access, credentials and connectivity locally.")
        storage = GitStorage(args.git_remote, namespace=args.namespace, cache_dir=args.git_cache)
    else:
        import redis
        from cascade.storage.redis_storage import RedisStorage

        client = redis.Redis.from_url(
            args.redis_url, decode_responses=True, socket_connect_timeout=10, socket_timeout=10,
        )
        storage = RedisStorage(client, namespace=args.namespace)

    # Native locks keep graph and full history in one snapshot. Git may update
    # lease refs/cache, and Redis may update its internal clock on load; this
    # path never saves a graph, changes ownership or emits a business event.
    with storage.lock(timeout=10):
        if not storage.exists():
            raise CheckError("CENTER_MISSING", "The selected center has no graph snapshot; select or restore the existing center.")
        graph = storage.load()
        if graph is None:
            raise CheckError("CENTER_MISSING", "The selected center has no graph snapshot; no recovery or initialization was attempted.")
        events = storage.events.read_all()
        valid, _ = storage.events.verify_chain()
        if not valid:
            raise CheckError("EVENT_CHAIN_INVALID", "Native event-chain verification failed; preserve the center and inspect its event history before recovery.")
        result = {
            "status": "ok", "storage": backend, "graph_nodes": len(graph.nodes),
            "event_count": len(events), "event_chain_valid": True,
            "task_retried_events": sum(event.type.value == "task_retried" for event in events),
        }
    report["center"].update(result)


def remote_identity(remote):
    # Git aliases are resolved by the caller. Local paths can differ only in
    # spelling; network remotes must match exactly rather than guessing aliases.
    if "://" in remote or re.match(r"[^/]+@[^:]+:", remote):
        return remote
    return str(Path(remote).expanduser().resolve())


def check_dispatch(report, args):
    from cascade.worker.config import WorkerConfig

    result = report["dispatch"]
    raw = Path(args.dispatch).read_bytes()
    result["sha256"] = hashlib.sha256(raw).hexdigest()
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CheckError("DISPATCH_INVALID", f"Dispatch JSON at line {error.lineno}, column {error.colno}: {error.msg}.") from None
    try:
        config = WorkerConfig.from_dict(document)
    except ValueError as error:
        message = str(error)
        # WorkerConfig's constraints contain field names, not supplied values.
        # Its normalize_tier helper is the exception: it quotes the bad input.
        if message.startswith("Invalid capability tier "):
            message = "worker.agent_tier is invalid; use a native supported capability tier"
        elif not re.match(r"^(?:[a-z][a-z0-9_.]*|validation command|bootstrap command) (?:must |is not a valid Git remote$)", message):
            # Exceptions from URL parsing can quote an invalid bracketed host.
            message = "configuration parsing failed; check field types and Git remote syntax"
        raise CheckError("DISPATCH_INVALID", f"Native dispatch validation: {message}") from None
    result["native_config_valid"] = True
    if config.agent_id != args.agent:
        raise CheckError("DISPATCH_AGENT_MISMATCH", "Dispatch worker.agent_id differs from --agent; select the intended worker configuration.")
    if args.git_remote is None or config.namespace != args.namespace or remote_identity(config.git_remote) != remote_identity(args.git_remote):
        raise CheckError("DISPATCH_CENTER_MISMATCH", "Dispatch coordination must match the selected Git remote and namespace; no commands were executed.")
    result.update(status="valid", center_matches=True, agent_matches=True)


def failure(report, scope, error):
    report[scope if scope != "input" else "runtime"]["status"] = "error"
    error_scope = scope
    if isinstance(error, CheckError):
        code, message = error.code, str(error)
    elif isinstance(error, (ImportError, ModuleNotFoundError)):
        code, message = "DEPENDENCY_MISSING", "A required native dependency is unavailable in this interpreter; check the selected Cascade installation."
        error_scope = "runtime"
    elif isinstance(error, FileNotFoundError):
        code, message = "FILE_MISSING", "A required local file or executable is missing; check the selected path and runtime environment."
    elif isinstance(error, PermissionError):
        code, message = "PERMISSION_DENIED", "The check could not access a required resource; check local permissions without changing the center."
    elif isinstance(error, subprocess.TimeoutExpired):
        code, message = "TIMEOUT", "The native check exceeded its timeout; check local Git connectivity and access before retrying."
    elif scope == "dispatch":
        code, message = "DISPATCH_INVALID", "Dispatch JSON failed native WorkerConfig validation; check its fields against this Cascade runtime. No commands were executed."
    else:
        code, message = "NATIVE_CHECK_FAILED", "The native check failed; inspect the selected runtime, center snapshot, full event history and access locally. No fallback or recovery was attempted."
    # Native exceptions may contain entire URLs, config values or command logs.
    # Keep their category and an actionable stage, never their untrusted text.
    report["errors"].append({"scope": error_scope, "code": code, "message": message, "error_type": type(error).__name__})
    if scope in {"runtime", "input"}:
        report["protocol"]["status"] = "error"


def main():
    report = {
        "schema_version": 1, "success": False, "scope": "entrypoint-only",
        "runtime": {"status": "not_checked", "sys_executable": sys.executable, "sys_prefix": sys.prefix},
        "protocol": {"status": "not_checked", "scope": "selected interpreter only; other machines and running processes are not checked"},
        "center": {"status": "not_checked"},
        "dispatch": {"status": "not_requested", "execution": "not_run"},
        "limitations": "Protocol and configuration checks do not prove harness execution, business readiness, authorization or fleet-wide migration.",
        "errors": [],
    }
    try:
        args = arguments()
    except CheckError as error:
        failure(report, "input", error)
    else:
        # Only this JSON is public output; native warnings can contain task data.
        with open(os.devnull, "w") as sink, redirect_stdout(sink), redirect_stderr(sink):
            try:
                check_runtime(report, args)
            except Exception as error:
                failure(report, "runtime", error)
            if report["runtime"]["status"] == "ok":
                try:
                    check_center(report, args)
                except Exception as error:
                    failure(report, "center", error)
            if args.dispatch is not None:
                report["dispatch"]["status"] = "not_checked"
                if report["runtime"]["status"] == "ok":
                    try:
                        check_dispatch(report, args)
                    except Exception as error:
                        failure(report, "dispatch", error)
        report["success"] = not report["errors"]
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
