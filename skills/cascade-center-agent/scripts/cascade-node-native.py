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
# Verified reads take no lease and check only events appended since the last one.
spec = importlib.util.spec_from_file_location("portal_publisher", Path(__file__).with_name("cascade-portal-publish.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
require = publisher.require


def withdraw(client, request):
    """Cancel a task and every unfinished task downstream of it in one state write.

    Each task gets its own node_cancelled event, because the receive guard refuses an
    event that changes any task but its own. A cancelled claim leaves the ACTIVE
    claims, so the write deletes its heartbeat in the same atomic push. The event
    reason starts with the withdrawal ID; the center's readback looks for it.
    """
    from cascade.core.state import NodeState
    from cascade.events import EventType
    from cascade.types import ErrorCode, Result

    withdrawal = request.get("withdrawal")
    publisher.exact(withdrawal, ["id", "taskId", "reason", "author"], "withdrawal")
    require(re.fullmatch(r"[a-f0-9-]{36}", withdrawal["id"] or ""), "Invalid withdrawal ID")
    root = withdrawal["taskId"]; publisher.node_id(root)
    publisher.text(withdrawal["reason"], "withdrawal reason", 1000)
    publisher.text(withdrawal["author"], "withdrawal author", 210)
    resume = request.get("resume", False)
    require(type(resume) is bool, "Invalid resume flag")
    reason = f"Withdrawal {withdrawal['id']}: {withdrawal['reason']}"
    # Who asked is recorded beside the reason so that executors and readers see it in Git.
    detail = {"id": withdrawal["id"], "task_id": root, "requested_by": withdrawal["author"]}

    def body(tx):
        graph = tx.graph
        node = graph.nodes.get(root)
        if node is None:
            return Result(success=False, message=f"Task {root} not found", code=ErrorCode.TASK_NOT_FOUND)
        # Only a resumed round accepts a root it may already have cancelled; the center's
        # readback then checks that this withdrawal wrote that cancellation.
        if node.state == NodeState.CANCELLED and not resume:
            return Result(success=False, message=f"Task {root} was already cancelled before this withdrawal ran", code=ErrorCode.TASK_TERMINAL)
        order, seen = [root], {root}
        for current in order:
            for child in sorted(graph.get_dependents(current), key=lambda n: n.id):
                if child.id not in seen:
                    seen.add(child.id); order.append(child.id)
        cancelled = []
        for task_id in order:
            target = graph.nodes[task_id]
            if target.state == NodeState.CANCELLED or (task_id != root and target.state == NodeState.COMPLETED):
                continue
            cancelled.append({"task_id": task_id, "state": target.state.name,
                              "executor": target.agent_id if target.state == NodeState.ACTIVE else None})
            target.update_state(NodeState.CANCELLED)
            tx.emit(EventType.NODE_CANCELLED, node_id=task_id, reason=reason, withdrawal=detail)
        return tx.ok(Result(success=True, message=f"Withdrew {len(cancelled)} task(s)",
                            data={"withdrawal_id": withdrawal["id"], "task_id": root, "cancelled": cancelled}))

    return client._transact(body)


def withdrawn_claim(storage, task_id, result):
    """A refusal that names the withdrawal, when a claim failed because its task was withdrawn."""
    from cascade.events import EventType

    if result.get("success") or result.get("code") != "TASK_NOT_ACTIVE" or (result.get("data") or {}).get("state") != "CANCELLED":
        return result
    with storage.read_snapshot():
        events = storage.events.read_all()
    event = next((e for e in reversed(events) if e.type == EventType.NODE_CANCELLED and e.data.get("node_id") == task_id), None)
    detail = event and event.data.get("withdrawal")
    if not isinstance(detail, dict):
        return result
    root = detail.get("task_id")
    origin = "" if root == task_id else f"（随上游任务 {root} 一起撤回）"
    reason = str(event.data.get("reason", "")).removeprefix(f"Withdrawal {detail.get('id')}: ")
    return {"success": False, "code": "TASK_WITHDRAWN",
            "message": f"任务 {task_id} 已撤回{origin}，原因：{reason}。本次领取已作废：续租、完成和释放都会被拒绝，已做的工作不会被接收。请停止工作，不要提交结果。",
            "data": {"task_id": task_id, "withdrawal": detail, "withdrawn_at": event.timestamp}}


def execute(args):
    require(importlib.metadata.version("cascade-auto") == publisher.NODE_RUNTIME, f"Use the checksum-verified Cascade {publisher.NODE_RUNTIME} runtime")
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
    client = CascadeClient(storage)
    action = request.get("action")
    if action == "renew":
        # A renewal only moves the claim's heartbeat ref and appends no event; the
        # center hook checks the claim, token and lease, so no log is read here.
        publisher.node_id(request.get("agent")); publisher.node_id(request.get("taskId"))
        token = request.get("token")
        require(type(token) is int and token > 0, "A positive fencing token is required")
        return withdrawn_claim(storage, request["taskId"], client.renew(request["taskId"], agent_id=request["agent"], token=token).to_dict())
    before = publisher.read_verified(storage)
    if action == "withdraw":
        result = withdraw(client, request)
        after = publisher.read_verified(storage, before).graph
        if result.success:
            for item in result.data["cancelled"]:
                require(after.nodes[item["task_id"]].state.name == "CANCELLED", "Withdrawn task is not cancelled on readback; stop and inspect")
        return result.to_dict()
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
        present = [s["node_id"] in before.graph.nodes for s in specs]
        require(not any(present) or all(present), "Only part of the immutable batch exists; stop and inspect")
        if not all(present):
            result = client.add_batch(specs)
            require(result.success, f"Native publication failed [{result.code}]: {result.message}")
        after = publisher.read_verified(storage, before).graph
        for spec in specs:
            node = after.nodes.get(spec["node_id"])
            require(node is not None and node.task_input == spec["task_input"] and node.required_tier == spec["required_tier"] and node.publication["publisher"] == spec["publisher"], "Existing task differs from immutable publication; stop and inspect")
            require({parent: edge for (parent, child), edge in after.contracts.items() if child == spec["node_id"]} == spec["deps"], "Published dependency contracts differ")
        if action == "publish":
            node = after.nodes[specs[0]["node_id"]]
            return {"success": True, "task_id": specs[0]["node_id"], "publication": node.publication}
        return {"success": True, "task_ids": [s["node_id"] for s in specs]}
    require(action in {"claim", "complete", "release", "check-timeouts"}, "Unsupported native action")
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
        if action == "release":
            result = client.release(task_id, agent_id=agent, token=token, reason=request.get("reason", "Explicit node-client release"))
        else:
            result = client.complete(task_id, agent_id=agent, token=token, summary=request.get("summary", ""), critical=request.get("critical", {}), artifacts=request.get("artifacts", ""), deliverables=request.get("deliverables"))
    publisher.read_verified(storage, before)
    return withdrawn_claim(storage, task_id, result.to_dict()) if action in {"complete", "release"} else result.to_dict()


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
