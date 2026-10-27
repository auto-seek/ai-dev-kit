#!/usr/bin/env python3
"""Publish one trusted portal contract through Cascade's native Git batch API.

The role and actor are caller declarations, not native identity registration or
an ACL. The controlled center client supplies this file after scope approval;
Git credentials remain the actual write boundary.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import sys
import tempfile
from collections import namedtuple
from pathlib import Path
from urllib.parse import urlsplit


class PublishError(Exception):
    """A rejected contract or an unverified publication."""


# The node protocol runtime of agents and the center publisher. Its verified reads
# take no lease, and check only what was appended since the last verified read of
# the same cache. The receive guard pins its own runtime (cascade-node-receive.py).
NODE_RUNTIME = "0.8.2+nodecollab.6"
# Approved 0.8.0 builds serve centers without the node protocol. They have no
# lease-free read, so their verified reads keep the transaction lease.
LEGACY_RUNTIME = re.compile(r"0\.8\.0(?:\+[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*)?")
# One verified read: the snapshot, the number of events in its log, and what a
# later read needs to prove that history is unchanged (a LogCheckpoint on the
# node runtime, the event dicts on 0.8.0).
Verified = namedtuple("Verified", "graph events proof")


def redact(value, incomplete=False):
    """Apply the portal's URI credential policy to input and error messages."""
    value = re.sub(r'([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s"\\]+@', r"\1<redacted>@", str(value))
    if incomplete:
        value = re.sub(r'([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s"\\]+(?=[\s"\\]|$)', r"\1<redacted>", value)
    return value


def require(condition, message):
    if not condition:
        raise PublishError(message)


def exact(value, keys, name):
    require(isinstance(value, dict) and set(value) == set(keys), f"Invalid {name} fields")


def canonical(value):
    # Proposal keys are a closed ASCII set, and all leaves are strings or lists.
    # This matches store.cjs without relying on cross-language float formatting.
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate JSON key")
        value[key] = item
    return value


def text(value, name, maximum):
    require(isinstance(value, str) and value and value == value.strip(), f"Invalid {name}")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]", value), f"Invalid {name}")
    require(len(value.encode("utf-16-le")) // 2 <= maximum, f"Invalid {name} length")


def node_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value), "Invalid task ID")


def validate_plan(plan, root_task):
    node_id(root_task)
    exact(plan, ["contract", "taskIds", "specs"], "plan")
    contract = plan["contract"]
    exact(contract, ["requestId", "proposalVersion", "proposalSha256", "proposal"], "contract")
    request = contract["requestId"]
    require(isinstance(request, str) and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", request), "Invalid request UUID")
    version = contract["proposalVersion"]
    require(type(version) is int and 1 <= version <= 9007199254740991, "Invalid proposal version")
    proposal = contract["proposal"]
    exact(proposal, ["title", "goal", "scope", "nonGoals", "acceptance", "requiredTier", "baseSha", "dependencies"], "proposal")
    text(proposal["title"], "title", 160)
    text(proposal["goal"], "goal", 20000)
    for key in ("scope", "nonGoals", "acceptance"):
        require(isinstance(proposal[key], list) and 1 <= len(proposal[key]) <= 30, f"Invalid {key}")
        for entry in proposal[key]:
            text(entry, key, 2000)
    require(proposal["requiredTier"] in ("lite", "pro", "max"), "Invalid required tier")
    require(isinstance(proposal["baseSha"], str) and re.fullmatch(r"[a-f0-9]{40}", proposal["baseSha"]), "Invalid base SHA")
    dependencies = proposal["dependencies"]
    require(isinstance(dependencies, list) and len(dependencies) <= 30, "Invalid dependencies")
    for dependency in dependencies:
        node_id(dependency)
    require(len(dependencies) == len(set(dependencies)), "Duplicate dependencies")
    require(redact(canonical(proposal)) == canonical(proposal), "Proposal contains a credential-bearing URI")
    digest = hashlib.sha256(canonical(proposal).encode("utf-8")).hexdigest()
    require(contract["proposalSha256"] == digest, "Proposal SHA256 does not match canonical proposal")
    ids = [f"portal-{request}", f"portal-{request}-review"]
    require(plan["taskIds"] == ids, "Task IDs do not match request UUID")
    specs = plan["specs"]
    require(isinstance(specs, list) and len(specs) == 2, "Exactly two task specs are required")
    exact(specs[0], ["node_id", "required_tier", "deps"], "implementation spec")
    exact(specs[1], ["node_id", "required_tier", "reserved_for", "deps"], "review spec")
    require([spec["node_id"] for spec in specs] == ids, "Spec IDs do not match request UUID")
    require(specs[0]["required_tier"] == proposal["requiredTier"], "Implementation tier differs from proposal")
    require(specs[1]["required_tier"] == ("max" if proposal["requiredTier"] == "max" else "pro"), "Invalid independent review tier")
    require(specs[1]["reserved_for"] == "codex-team-center", "Independent review must be reserved for the center")
    bound = "portal-contract:" + canonical(contract)
    for spec in specs:
        require(isinstance(spec["deps"], dict) and spec["deps"], "Task dependencies are required")
        for dependency, edge in spec["deps"].items():
            node_id(dependency)
            exact(edge, ["expectation", "promise"], "edge contract")
            require(edge["expectation"] == bound, "Edge expectation is not the complete bound contract")
            expected_promise = (
                f"上游 {dependency} 提供其真实完成证据与批准基线；完整需求合同见 expectation，实施仍须有效租约、范围核对、独立复审和最终 HEAD preflight。"
                if spec["node_id"] == ids[0] else
                "交付精确候选 SHA、可获取结果分支、完整变更、实际测试及独立复审/内容绑定 preflight；不得自审、自动合并或把网页意见当技术门禁。"
            )
            require(edge["promise"] == expected_promise, "Edge promise differs from the portal contract")
    actual_deps = set(specs[0]["deps"])
    require(not actual_deps.intersection(ids), "Implementation cannot depend on itself or its review")
    require(actual_deps == set(dependencies) | {root_task}, "Dependencies differ from the proposal plus configured project root")
    require(set(specs[1]["deps"]) == {ids[0]}, "Review must depend only on its implementation")
    return contract, specs


def load_checkpoint(path):
    """The checkpoint of this cache's last verified read; None means verify the whole log."""
    from cascade.verification import LogCheckpoint

    try:
        return LogCheckpoint.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return None
    except (OSError, KeyError, TypeError, ValueError):
        return None


def save_checkpoint(path, checkpoint):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".verified-log-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(checkpoint.to_dict(), target, separators=(",", ":"))
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def read_verified(storage, previous=None):
    """Read and verify one committed state.

    With ``previous`` from an earlier read of the same storage, the accepted
    event history must also be unchanged. The node runtime verifies only what
    was appended since the checkpoint kept beside its Git cache; a missing or
    unusable checkpoint means the whole log is verified.
    """
    if LEGACY_RUNTIME.fullmatch(importlib.metadata.version("cascade-auto")):
        from cascade.replay import replay, verify

        with storage.lock():
            graph = storage.load()
            require(graph is not None, "Existing coordination graph is required")
            events = storage.events.read_all()
            require(storage.events.verify_chain()[0], "Event chain verification failed")
            require(not verify(events, graph, storage.content), "Event replay differs from snapshot")
            require(replay(events, storage.content).contracts == graph.contracts, "Replayed edge contracts differ from snapshot")
        history = [event.to_dict() for event in events]
        require(previous is None or history[:len(previous.proof)] == previous.proof, "Existing event history changed")
        return Verified(graph, len(history), history)
    require(callable(getattr(storage, "read_snapshot", None)),
            f"This Cascade runtime cannot read state without the transaction lease; install {NODE_RUNTIME}")
    from cascade.verification import verify_storage

    path = Path(storage.cache_dir) / "verified-log.json"
    with storage.read_snapshot():
        graph, result = verify_storage(storage, previous.proof if previous else load_checkpoint(path), consume=True)
    require(graph is not None, "Existing coordination graph is required")
    require(not result.corruption, f"Invalid event log: {result.corruption}")
    require(result.chain_valid, "Event chain verification failed")
    require(not result.replay_diffs, "Event replay differs from snapshot")
    require(result.contracts_match, "Replayed edge contracts differ from snapshot")
    require(previous is None or result.prefix_preserved, "Existing event history changed")
    require(result.checkpoint is not None, "Verified event log must end with a newline")
    save_checkpoint(path, result.checkpoint)
    return Verified(graph, result.events, result.checkpoint)


def matching_nodes(graph, specs):
    present = [spec["node_id"] in graph.nodes for spec in specs]
    require(all(present) or not any(present), "Only one portal task exists; inspect without overwriting")
    if not any(present):
        return False
    from cascade.types import Contract

    for spec in specs:
        node = graph.nodes[spec["node_id"]]
        require(node.required_tier == spec["required_tier"] and node.reserved_for == spec.get("reserved_for"), "Existing task tier or reservation differs")
        incoming = {parent: edge for (parent, child), edge in graph.contracts.items() if child == node.id}
        expected = {parent: Contract(**edge) for parent, edge in spec["deps"].items()}
        require(incoming == expected, "Existing task dependencies or complete contracts differ")
    return True


def check_runtime_version(version):
    # Source approval still belongs to deployment; a local label is not an upgrade.
    # Other node runtimes are refused: agents and the center switch these scripts
    # and their node runtime together.
    require(version == NODE_RUNTIME or LEGACY_RUNTIME.fullmatch(version),
            f"Use the approved Cascade 0.8.0 environment (an approved local build is allowed) or the pinned {NODE_RUNTIME} node runtime")


def publish(args):
    check_runtime_version(importlib.metadata.version("cascade-auto"))
    require(args.role == "orchestrator" and args.actor == "codex-team-center", "Publication requires the configured center actor and orchestrator role")
    require(args.cache_dir.is_absolute(), "Cache directory must be absolute")
    require(args.remote and not args.remote.startswith("-") and not re.search(r"[\x00-\x20\x7f]", args.remote), "Invalid Git remote")
    if "://" in args.remote:
        remote = urlsplit(args.remote)
        require(remote.scheme in ("ssh", "https", "file"), "Unsupported Git remote transport")
        require(remote.password is None and (remote.scheme == "ssh" or remote.username is None), "Credential-bearing Git remote is forbidden; use the configured credential provider")
    else:
        require(args.remote.startswith("/") or re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+", args.remote), "Use an absolute local or explicit SSH Git remote")
    redirected = {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"}
    require(not redirected.intersection(os.environ), "Unset inherited Git repository/config overrides before publishing")
    # The server repeats the approved contract on every incoming edge. Its GET
    # response can exceed the 128 KiB limit used for a single proposal POST.
    require(args.specs_file.is_file() and args.specs_file.stat().st_size <= 8 * 1024 * 1024, "Specs file must be a regular file of at most 8 MiB")
    plan = json.loads(args.specs_file.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    contract, specs = validate_plan(plan, args.root_task)
    from cascade import CascadeClient
    from cascade.storage.git_storage import GitStorage
    from cascade.types import Contract

    storage = GitStorage(args.remote, namespace=args.namespace, cache_dir=args.cache_dir)
    before = read_verified(storage)
    existed = matching_nodes(before.graph, specs)
    if not existed:
        native = [{**spec, "deps": {parent: Contract(**edge) for parent, edge in spec["deps"].items()}} for spec in specs]
        result = CascadeClient(storage).add_batch(native)
        require(result.success, f"Native add_batch did not confirm publication [{result.code}]: {result.message}; inspect the remote before any further action")
    # A new native read synchronizes from the remote; a successful return from
    # add_batch alone is not a publication receipt. No failed write is retried here.
    after = read_verified(storage, before)
    require(matching_nodes(after.graph, specs), "Published tasks are missing on fresh readback")
    return {"taskIds": plan["taskIds"], "proposalVersion": contract["proposalVersion"],
            "proposalSha256": contract["proposalSha256"], "actor": args.actor,
            "alreadyPublished": existed, "readbackVerified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--root-task", required=True)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--specs-file", required=True, type=Path)
    parser.add_argument("--role", required=True, choices=["orchestrator"])
    parser.add_argument("--actor", required=True, choices=["codex-team-center"])
    args = parser.parse_args()
    try:
        result = publish(args)
    except PublishError as error:
        print(f"cascade-portal-publish: {redact(error, incomplete=True)}", file=sys.stderr)
        return 1
    except Exception as error:
        # Keep the transport/runtime diagnosis, not Result.data or private logs.
        print(f"cascade-portal-publish: {type(error).__name__}: {redact(error, incomplete=True)}; publication is unverified. Inspect the input, runtime and remote before retrying.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
