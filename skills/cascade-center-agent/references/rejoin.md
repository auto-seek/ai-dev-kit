# 重新加入：切换到只走 HTTPS 的客户端

给用 ai-dev-kit 0.32.0 及以前加入团队中心的 agent。用户确认中心已经支持新客户端之后再做。做完后，本 agent 的领取、续租、完成、释放都经 HTTPS 交给中心，不再用 SSH、Python 或 Cascade。agent ID、归属和执行中的任务都不变。

下面的命令里，`<skill-dir>` 换成本 skill（`SKILL.md` 所在）的绝对目录，`D` 换成本 agent 原来的加入目录（`client.json` 所在的目录，就是 `CASCADE_NODE_CLIENT_CONFIG` 或保存的 `configFile` 所在的目录）。不要新建目录，不要复制别的 agent 的目录。

## 先判断能不能切换

用 Cascade 监督 worker（启动命令里有 `with-agent`，或运行 `python -m cascade.worker`）的 agent **不要切换**：worker 自己经 SSH 写任务中心，新客户端不支持。停在这里，告诉用户“本 agent 用监督 worker，暂不切换”。

其他 agent 继续。

## 1. 确认插件已更新

```sh
cat <skill-dir>/../../.claude-plugin/plugin.json
```

`version` 应是 `0.33.0` 或更新。不是的话先让用户更新插件。

## 2. 在原目录重新运行 join

```sh
D=/原来的/加入目录
node <skill-dir>/scripts/cascade-node-join.cjs --directory "$D" \
  --project-id "$(node -e 'const e=require(process.argv[1]);process.stdout.write(e.projectId+"@"+e.origin)' "$D/enrollment.json")" \
  --level "$(node -e 'process.stdout.write(require(process.argv[1]).level)' "$D/enrollment.json")"
```

项目 ID、中心地址和 level 都从原目录的 `enrollment.json` 取，与当初加入时相同。不要把 `enrollment.json` 或 `token` 的内容打印到聊天、日志或提交里。

看输出：

- `"ready": true`，`agent` 与原来相同：切换成功。
- 报 `This center has no center writer`：中心还不支持新客户端。不要尝试别的写入方式，告诉用户，等中心上线后再做。
- 超时或其他错误：用同一条命令原样重试，不换目录，不新建 agent。

join 改写了 `client.json`，删掉了 `with-agent`。目录里的 `runtime/`、`id_ed25519`、`ssh_config` 留着，回滚时要用，**不要删**。

## 3. 有执行中的任务时，换成新的续租

先停掉原来的续租进程（用旧插件目录脚本跑的 `renew` 循环）。再用新脚本续租，`/private/lease.json` 为 `{"token":原来的 token}`：

```sh
node <skill-dir>/scripts/cascade-node-client.cjs --config "$D/client.json" renew --task TASK_ID --input /private/lease.json
node <skill-dir>/scripts/cascade-node-client.cjs --config "$D/client.json" renew --task TASK_ID --input /private/lease.json --every 60
```

第一条应返回 `"success": true`。第二条一直运行、每 60 秒续一次，失去租约时自己退出；任务完成或释放后结束它。之后的完成、释放也用新脚本，原来的 token 继续有效。

没有执行中的任务就跳过这一步。

## 4. 自检

```sh
node <skill-dir>/scripts/cascade-node-client.cjs --config "$D/client.json" inbox
```

能正常返回即可。不要为了测试去领取任务、发布任务或给别的 agent 发消息。

## 5. 报告

告诉用户一行：

```text
已切换到 HTTPS 客户端：agent <agent ID>，ready: true；执行中的任务：<任务 ID 或“无”>，已改用新脚本续租。
```

## 回滚

只在用户要求时做。装回上一版插件（0.32.0），然后在原目录用第 2 步同样的命令重新运行 join（这次用的是旧插件的 `<skill-dir>`）。旧 join 会重新装 `runtime/` 并恢复 SSH 配置。中心关闭直接写入以后，旧插件就不能再写，回滚前先问中心维护人。
