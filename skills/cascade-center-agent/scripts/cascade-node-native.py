#!/usr/bin/env python3
"""Execute authenticated node-client commands against the pinned native runtime."""

import argparse
import importlib.metadata
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

# Keep the existing event-chain/replay verification and redaction contract.
spec = importlib.util.spec_from_file_location("portal_publisher", Path(__file__).with_name("cascade-portal-publish.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
require = publisher.require


def execute(args):
    require(importlib.metadata.version("cascade-auto") == "0.8.2+nodecollab.1", "Use the checksum-verified Cascade 0.8.2+nodecollab.1 runtime")
    require(args.cache_dir.is_absolute(), "An absolute private cache directory is required")
    require(args.remote and not args.remote.startswith("-") and not re.search(r"[\x00-\x20\x7f]", args.remote), "Invalid Git remote")
    if "://" in args.remote:
        remote = urlparse(args.remote)
        require(remote.scheme in {"ssh", "https", "file"} and not remote.password and (remote.scheme == "ssh" or not remote.username), "Git remote must use external credentials")
    redirected = {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"}
    require(not redirected.intersection(os.environ), "Unset inherited Git repository/config overrides")
    require(args.request_file.is_file() and args.request_file.stat().st_size <= 128 * 1024, "Request file must be at most 128 KiB")
    request = json.loads(args.request_file.read_text(), object_pairs_hook=publisher.unique_object)
    require(isinstance(request, dict), "Request must be an object")
    from cascade import CascadeClient
    from cascade.storage.git_storage import GitStorage
    from cascade.types import Contract

    storage = GitStorage(args.remote, namespace=args.namespace, cache_dir=args.cache_dir)
    before, history = publisher.read_verified(storage)
    client = CascadeClient(storage)
    action = request.get("action")
    if action in {"publish", "publish-batch"}:
        publications = [request["publication"]] if action == "publish" else request.get("publications")
        require(isinstance(publications, list) and 1 <= len(publications) <= 30, "Expected 1-30 publications")
        require(len({p["taskId"] for p in publications}) == len(publications), "Duplicate publication identity")
        specs = []
        for publication in publications:
            task_id = publication["taskId"]
            require(task_id == "portal-task-" + publication["id"], "Task identity differs from publication")
            brief = publication["brief"]
            envelope = {"schema_version": 1, "publication_id": publication["id"], "brief_sha256": publication["briefSha256"], "brief": brief}
            dependencies = {dep: Contract(f"Use versioned task input {publication['briefSha256']} and this upstream's delivered context", "Provide verified results and immutable artifact references") for dep in brief["dependencies"]}
            specs.append({"node_id": task_id, "deps": dependencies, "required_tier": brief["requiredTier"], "task_input": envelope, "publisher": publication["publisherAgent"]})
        present = [s["node_id"] in before.nodes for s in specs]
        require(not any(present) or all(present), "Only part of the immutable batch exists; stop and inspect")
        if not all(present):
            result = client.add_batch(specs)
            require(result.success, f"Native publication failed [{result.code}]: {result.message}")
        after, events = publisher.read_verified(storage)
        require([e.to_dict() for e in events[:len(history)]] == [e.to_dict() for e in history], "Existing history changed")
        for spec in specs:
            node = after.nodes.get(spec["node_id"])
            require(node is not None and node.task_input == spec["task_input"] and node.required_tier == spec["required_tier"] and node.publication["publisher"] == spec["publisher"], "Existing task differs from immutable publication; stop and inspect")
            require({parent: edge for (parent, child), edge in after.contracts.items() if child == spec["node_id"]} == spec["deps"], "Published dependency contracts differ")
        if action == "publish":
            node = after.nodes[specs[0]["node_id"]]
            return {"success": True, "task_id": specs[0]["node_id"], "publication": node.publication}
        return {"success": True, "task_ids": [s["node_id"] for s in specs]}
    require(action in {"claim", "renew", "complete", "release", "check-timeouts"}, "Unsupported native action")
    agent = request.get("agent")
    if action != "check-timeouts":
        publisher.node_id(agent)
    task_id = request.get("taskId")
    if task_id is not None:
        publisher.node_id(task_id)
    if action == "claim":
        timeout = request.get("timeout", 900)
        require(type(timeout) in (int, float) and 1 <= timeout <= 86400, "Execution lease must be between 1 and 86400 seconds")
        result = client.claim(agent, task_id=task_id, agent_tier=request["tier"], timeout=timeout)
    elif action == "check-timeouts":
        result = client.check_timeouts()
    else:
        require(task_id is not None, "Task ID is required")
        token = request.get("token")
        require(type(token) is int and token > 0, "A positive fencing token is required")
        if action == "renew":
            result = client.renew(task_id, agent_id=agent, token=token)
        elif action == "release":
            result = client.release(task_id, agent_id=agent, token=token, reason=request.get("reason", "Explicit node-client release"))
        else:
            result = client.complete(task_id, agent_id=agent, token=token, summary=request.get("summary", ""), critical=request.get("critical", {}), artifacts=request.get("artifacts", ""), deliverables=request.get("deliverables"))
    after, events = publisher.read_verified(storage)
    require([e.to_dict() for e in events[:len(history)]] == [e.to_dict() for e in history], "Existing history changed")
    return result.to_dict()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--request-file", required=True, type=Path)
    result = execute(parser.parse_args())
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(publisher.redact(str(error), incomplete=True), file=sys.stderr)
        sys.exit(1)
