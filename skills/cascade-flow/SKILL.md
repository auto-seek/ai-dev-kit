---
name: cascade-flow
description: 查看或启动 Git 瀑布流任务图，了解阶段、依赖、执行状态和交付。已有团队中心时打开其网页；需要本地查看时启动随包提供的只读 viewer。不用于创建任务、领取任务或部署公网服务。
---

# 查看瀑布流

先从当前项目说明、已接入的私有 `client.json` 或用户给的入口确认是哪一个中心。不要把产品源码 Git 当成任务状态 Git，也不要把 `project_…` 加入凭证当成网页的 center ID。只查看任务不需要登记新 agent 或领取工作。

## 已有网页，直接打开

优先复用已配置的团队中心。网页地址从该实例 `client.json` 的 `origin` 和 `centerId` 或项目入口取得，URL 形如 `CENTER_ORIGIN/flow?center=<编码后的-centerId>`；单个任务用 `#task=<编码后的-taskId>`。`CENTER_ORIGIN` 是实际配置的 HTTPS origin，不是固定域名；缺少地址或 ID 时补问，不套用其他项目的入口。从已知配置取 ID，不能猜项目、附带 token 或把完整加入凭证写进 URL。已有用户会话就复用，登录交给用户本人，不索取验证码或 Cookie。

先看整体阶段和前后依赖，再展开目标任务。说明哪些可开始、哪些等上游、哪些在执行，以及实际交付了什么；“已报完成”不等于已经验收。中心页面支持鼠标滚轮缩放、拖动画布和节点导航；不要通过更改任务依赖来调整显示。

## 需要本地任务图

使用本 skill 的 `scripts/cascade-flow.cjs`，已经附带完整静态资源和 Dagre 许可，不需要下载 CDN、安装 npm 包或取得 Center 源码。需要 Node >=24.21.0 和 Git；只读取快照不需要 Python/model runtime。把 `<skill-dir>` 换成当前 skill 的绝对路径：

```sh
node <skill-dir>/scripts/cascade-flow.cjs \
  --remote TASK_STATE_GIT --namespace NAMESPACE --title PROJECT_NAME --port 0
```

使用实际兼容的 Node。远端和 namespace 来自项目的任务中心配置；必须已经存在 `refs/heads/cascade-state/<namespace>`。认证失败和缺少状态 ref 都要如实报告，不能自动创建空图或改读另一个项目。

对已通过 `cascade-center-agent` 接入的实例，可从它自己的 `client.json` 读取 `remote`、`namespace` 和 `sshConfig`。只在 viewer 启动子进程中用 `GIT_SSH_COMMAND` 指向该 SSH 配置；配置路径按 shell 规则引用。不要全局 export，也不要将此 key 用于项目 Git。没有读取权限就指出具体缺口，不用其他 agent 的凭据。

打开命令实际打印的 `http://127.0.0.1:<port>`，读回 `/api/snapshot` 确认 `status: fresh` 和目标节点/依赖；服务开始监听不等于已经读到图。后台进程通过当前工具保留可停止的进程句柄，报告入口及停止方式。`SIGINT`/`SIGTERM` 会关闭服务并清理它自己的临时缓存。

此 viewer 只绑定 loopback，不修改任务、租约或共享缓存。它有滚轮缩放、空白处拖动和节点依赖查看；登录、消息、工作流草案确认发布使用团队中心网页。不要把本地 viewer 反向代理到公网。要搭建共享网页，转到 [搭建中心](../ai-dev-kit-cascade-init/SKILL.md)。

刷新失败时保留“旧快照”的含义和具体错误，不能将旧结果报告为最新进度。检查完一次截图也不代表后续持续刷新正常。

## 维护

只读 viewer 来自 CascadeCenter-web 的已验证发行物，版本和资源清单见 [source.json](references/source.json)。维护时同步入口、快照读取、进程工具、所有页面资源和 vendor 许可；不要混用 plugin 根目录的旧 viewer 资源。随包代码不代表部署了一台网页服务器。
