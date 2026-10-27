# 搭建带项目 ID 的 Git 瀑布流

用于搭建与 `cascade-center-agent` 对接的团队中心：Git 保存任务状态，Portal 管理账号、项目准入、消息和草案，独立 publisher 将确认后的任务写入 Git。agent 在各自机器执行，服务器部署成功不代表模型已经开始工作。

## 先确认已有资源

从项目说明和现有部署发现源码仓库、任务中心、域名、主机、管理员和已批准发行物；只问尚不明确且会影响实施的项。已有项目中心就复用，不再建第二份可写图。已有共享 Portal 时优先按其扩容流程增加项目，不能覆盖其他项目配置。

把本次资源记录在项目自己的配置中，使用以下占位符整理，不能把示例值直接用于部署：

| 配置 | 含义 |
| --- | --- |
| `CENTER_ORIGIN` | 本次中心的 HTTPS origin，例如 `https://center.example.com` |
| `PROJECT_NAME`、`NAMESPACE` | 项目显示名和专用任务命名空间 |
| `TASK_STATE_GIT` | 瀑布流状态仓库 |
| `PRODUCT_GIT` | 产品源码仓库，权限独立 |
| `CENTER_RELEASE` | 获准且与客户端兼容的完整服务器发行物 |

将实际 `CENTER_ORIGIN` 用于 Portal 的 `--public-origin`、反向代理站点及身份回调配置。网页复制的 `项目ID@中心地址` 取 `--public-origin`，它必须是用户实际访问的地址；接入端用单独的项目 ID 时，传 `--origin` 或设置 `CASCADE_CENTER_ORIGIN`。可视化复用同一实例的 `client.json`，本地 viewer 使用其任务 remote/namespace。项目名称、地址、账号和密钥不写入通用 skill。

明确三种权限：

- **任务状态 Git**：每个项目一个独立 bare 仓库和 namespace，服务端发放受限访问。
- **产品源码 Git**：保留项目原有权限，加入后的 agent 自查；中心不代发源码读写权限。
- **网页与运维**：人类通过 AutoSeek 登录；项目成员资格、publisher 身份和服务器管理权各自独立。普通 agent 加入权限不包含部署、网页管理员或 publisher 权限。

若用户只问方案，给出资源、配置和验收步骤；若已授权搭建，则完成可准备的配置并在授权范围内执行。缺服务器或身份提供方管理权限时说明具体缺口，不通过修改账号权限自行扩大范围。

## 使用完整的 Center 发行物

`ai-dev-kit` 根目录历史门户不是项目 ID 服务的部署源。使用项目指定的 **CascadeCenter-web** 兼容完整发行物 `CENTER_RELEASE`。本插件客户端与 viewer 的上游仓库和清单见 [来源记录](../../cascade-center-agent/references/source.json)，该记录不指定部署站点或业务仓库。客户端的上游基线为 `51a3e5e07f285ccfc4be71da4ad247af6306fb31`，viewer 为 `46e91ac5af695d8eaf7c5fc2ff4db6ee77f24123`（见 [viewer 来源](../../cascade-flow/references/source.json)），配套运行时为 `0.8.2+nodecollab.6`（中心 receive guard 仍固定 `0.8.2+nodecollab.3`）；更换版本时验证整个服务与客户端的兼容性，不安装 latest 或降级为旧写入端。

在已取得的发行物中先读这些实际文件，再按其中参数准备配置，不凭本文猜测不存在的自动安装命令：

| 文件 | 用途 |
| --- | --- |
| `deploy/cascade-portal/README.md` | 服务布局、共享门户扩容、备份恢复；尤其末尾“AutoSeek 单一登录与项目 ID”“对话拆解与整批任务发布” |
| `deploy/cascade-portal/project-access.example.json` | 准入库、成员、项目 remote/namespace/bare 仓库和已核对的 SSH 主机公钥 |
| `deploy/cascade-portal/centers.example.json` | 额外中心的读图配置；仅加到这里不会成为可执行中心 |
| `docs/project-admission.md` | 项目 ID、独立 agent 凭据、层级和撤权边界 |
| `docs/node-collaboration.md`、`docs/workflow-planning.md` | 节点消息、原生租约、publisher、草案确认与恢复 |

示例中的公司域名、服务器、仓库和旧密码部署配置都不是新项目默认值。替换为本次批准的资源；不要改他人的站点或照搬其凭据。单独取得插件无需 Center 源码权限，**搭建服务器**则仍需取得完整发行物。

## 实施次序

1. **准备任务 Git。** 复用 [项目 Git 中心指南](../../ai-dev-kit/references/project-center.md) 的专属仓库、权限、原生初始化和恢复步骤，但使用本次配套运行时。已有状态先保全并核对，不创建替代空图。升级已有中心时先处理仍会写入的旧执行器。
2. **准备 Portal 和 publisher。** 使用独立服务账号、私有状态目录、固定运行时和完整静态资源，HTTPS 反向代理仅到 loopback。按发行物配置原生 publisher，区分“网页记录草案”与“任务实际进入 Git”。不要执行用户上传的候选代码。
3. **配置 AutoSeek。** 使用批准的身份客户端、精确 callback 和受限身份票据；由身份提供方管理员完成所需登记。缺少配置就明确未就绪，不自动切回密码。本人授权验收由用户操作，账号存在和模拟测试都不能代替。
4. **配置项目 ID 准入。** Portal 通过 `--project-access-config` 读取 root 管理的配置；可执行项目的 `remote`、`namespace` 必须与 Portal source 精确匹配，每个项目不同 bare 仓库。权限数据库由 Portal 写入，Git 用户仅可读。项目所有者从“我的项目”取得真实 ID，不手造 ID 或把它提交进仓库。
5. **接上受限 SSH 和写入校验。** 按发行物配置 `cascade-project-git.py` 的 `AuthorizedKeysCommand` 和 forced command，同时配置 `cascade-node-receive.py --admission ...`。保留已有 ref、磁盘及归档约束。不能只开动态公钥却漏掉撤权校验，或给自动加入的 agent 开 shell/转发/publisher 权限。先检查配置并保留管理连接，再按授权重载服务。
6. **交付入口。** 返回中心网页、该项目的私有加入 ID、接入 skill、服务/publisher 状态、备份恢复位置及尚未就绪项。新任务仍是 agent 对话拆解、用户网页确认后发布；搭建行为不授权直接发布业务任务。

## 验收什么

在隔离测试项目/仓库验证两实例分别加入、重复请求不生成重复身份、层级限制、只有一个领取赢家、续租和释放、撤权后的 HTTP/SSH/写入拒绝。保留默认五分钟发布保护和原有心跳，不为演示降低限制。

对实际部署检查服务健康、目标 Git ref、真实账号可见范围和网页读回；确认页面能缩放拖动、依赖方向正确、草案确认才发布。新增生产测试节点或注册执行器要在用户明确的验收范围内，不能拿已有业务任务做连通性测试。测试环境通过与生产完成分别报告。

回滚保留准入、撤权、会话和新增任务数据，使用兼容 schema 的发行物；不能靠恢复旧权限文件或覆盖旧数据库让已撤权账号重新获得访问。备份恢复按该发行物 runbook 执行。
