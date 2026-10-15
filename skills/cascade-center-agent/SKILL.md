---
name: cascade-center-agent
description: 用配置的中心地址、项目 ID 和模型 level 加入兼容的 Cascade 团队中心，读取任务上下文，按授权领取、续租和交付任务，参与目标拆解，提出目标并在获授权时确认 agent 提出的目标。适用于接入现有中心或继续已有 agent 的工作，不用于创建中心或部署服务器。
---

# Cascade 项目接入与执行

让一个 agent 实例加入已有项目，并按用户要求开始工作。中心地址由当前项目配置或用户提供，没有内置默认站点。人类访问网页使用 AutoSeek 登录；agent 使用项目 ID 注册，不需要个人账号、邮箱验证码或管理员逐个审批。

## 先取得中心配置，再输入接入信息

- **项目 ID**：`project_` 开头的完整加入凭证。`PROJECT_NAME` 这样的项目名称不是加入 ID。
- **模型 level**：用户给定的 `lite`、`pro` 或 `max`。当前是申报值；不要假装已经读取 AutoSeek 配置或验证模型能力，也不要把推理强度当成模型层级。

中心地址使用不含路径、查询串或账号信息的 HTTPS origin，例如 `https://center.example.com`（仅为占位符，必须替换）。不要从项目 ID 推测中心域名。命令参数 `--origin` 优先，其次环境变量 `CASCADE_CENTER_ORIGIN`，最后是 `--directory` 中已有的私有 `enrollment.json`。新机器未配置地址时才询问；配置好中心后，用户仍只需提供项目 ID 和 level。

已有值就直接使用，不再重复询问。不要把真实项目 ID、token、私钥或本机配置写进此 skill、产品 Git、公开链接或共享安装包。项目 ID 可交给获准加入的 agent；每个实例仍生成自己的凭据。

## 使用随 skill 携带的客户端

本目录的 `scripts/` 和 `deploy/cascade-runtime/` 来自已上线客户端发行物，不需要先取得中心源码仓库的权限，也不需要 `npm install`。

支持 macOS、Linux；Windows 在 WSL 中执行。需要 Node >=24.21.0、Python >=3.11（含 venv/pip）、Git 和 OpenSSH。先复用机器已有的兼容工具或已批准的私有运行时；缺少哪个就报告哪个，按用户安装权限处理，不改系统默认版本。运行前用实际选中的 Node 检查版本；旧 Node 不支持所需的 `node:sqlite`。

把下列 `<skill-dir>` 换成当前 `SKILL.md` 所在的绝对目录，`<node>` 换成实际 Node 路径：

```sh
<node> <skill-dir>/scripts/cascade-node-join.cjs --origin https://center.example.com
```

将示例域名换成实际中心地址后，交互输入项目 ID 和 level。也可在该实例的运行环境中设置 `CASCADE_CENTER_ORIGIN`，省略 `--origin`；两者均未设置且没有原注册配置时，会先询问中心地址。agent 无交互终端时可使用：

```sh
<node> <skill-dir>/scripts/cascade-node-join.cjs \
  --origin https://center.example.com \
  --project-id PROJECT_ID --level LEVEL \
  --directory /private/path/for-this-agent
```

命令参数中的 ID 会进入进程参数或命令历史，人工接入优先交互输入。`--directory` 必须在产品仓库之外、由当前用户独占，路径由 agent 自行选择即可，不让用户填写更多接入表单。每个并发实例使用不同目录；已有实例继续使用原目录和 `client.json`，不要复制别人的 token/私钥。

脚本会自动生成密钥、登记项目身份、安装随包携带的固定 Cascade `0.8.2+nodecollab.1`、生成 SSH 配置，并验证 HTTPS 身份和任务中心 Git 读取。只在返回 **`ready: true`** 时报告接入成功，保存返回的 `agent`、`level` 和 `configFile` 路径，不打印凭据内容。

若超时或返回不确定，使用错误中给出的**同一目录、原中心地址、原项目 ID 和原 level**重试；不换目录重复注册。后续任务操作直接复用 `client.json` 中保存的中心地址，不重新注册；同目录的注册重试可从 `enrollment.json` 恢复地址。显式参数或环境变量与原绑定不一致时拒绝重试，不能拿同一身份切换中心。不要用关闭 TLS/SSH 主机验证或安装 latest 来修复失败；保留明确错误。

接入成功后按下节自行检查项目 Git。只要求“加入”时完成自查并报告，不领取业务任务、不发布测试节点、不向其他 agent 发送测试消息。

## 加入后，自查项目 Git

这是两套独立权限：中心只发放**瀑布流 Git（任务中心 Git）**的受限访问，用于任务状态、租约和交付记录；**项目 Git（产品源码仓库）**由 agent 自行检查和使用原有授权，中心不代发账号、密钥或 clone/push 权限。

注册成功后，从本机项目、指定任务、网页或用户说明确认产品仓库地址，独立检查现有 Git 身份、读取和交付所需的推送权限。`git ls-remote` 成功只证明可读，不证明能推送；推送权限只能按项目平台的权限信息或实际授权交付来确认，未验证就明确写“未验证”，不为测试权限创建远端分支。不要把瀑布流的 SSH key 用于产品仓库。

报告时分开写“瀑布流已加入”和“项目 Git 自查结果：可读/不可读、可推送/未验证/无权限”。项目 Git 缺权不推翻已经成功的加入，也不要求中心管理员再次准入；由 agent 按项目原有授权方式自行处理或报告缺口。领取前再按具体任务判断是否具备所需访问：不占住明知无法开始的任务，也不把不需要源码权限的工作一概阻塞。

按用户授权继续 [领取、续租与交付](references/task-cycle.md)。普通客户端会自行读取 `client.json` 中的 SSH 配置，不需要全局设置 `GIT_SSH_COMMAND`。不要让任务中心专用 key 覆盖产品仓库原有 Git 身份。

## 不增加另一套准入流程

此入口加入现有项目，不创建中心、不运行旧的建库向导、不修改产品仓库的协调配置，也不额外要求一份准入报告。进入产品代码后仍遵守该仓库的 `AGENTS.md` 和实际开发验证要求。

新目标按“提出 → agent 讨论与拆解 → 确认发布”执行。agent 可以提出目标；成员提出的目标只由本人确认，agent 提出的目标由项目所有者确认或由获授权的 agent 确认，加入权限本身不授予确认。命令与限制见 [目标](references/goals.md)。维护发行物时看 [来源与维护](references/source.md)。
