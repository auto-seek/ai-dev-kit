# 来源与维护

本 skill 是通用的 Cascade agent 接入包，`scripts/` 基于 CascadeCenter-web 已上线版本 `2c2c515c078a58fae401f1c78c36a09e7a1ad2a5` 的客户端及其直接依赖。插件只改了 `cascade-node-join.cjs` 的中心地址来源：移除默认站点，单独的项目 ID 依次使用 `--origin`、`CASCADE_CENTER_ORIGIN` 或同目录已保存的注册地址；复制的 `项目ID@中心地址`、`--harness` 和归属确认码与源版本一致，未改变服务端协议。此处仓库地址只记录代码来源，不用于选择接入项目或部署服务器。完整清单见 [source.json](source.json)。

源仓库：AutoSeek 内部的 CascadeCenter-web，不公开；此处只记录提交号。

`deploy/cascade-runtime/` 携带固定 Cascade `0.8.2+nodecollab.3` wheel、离线依赖、两个源码 patch（`node-collaboration.patch` 产出 .1，`node-storage-concurrency.patch` 在其上产出 .3）、校验清单和来源记录。中心发行物还带 `0.8.2+nodecollab.1` wheel 供其回滚和混合运行时测试；agent 只装 .3，本包不带 .1 wheel，`NODE_SHA256SUMS` 相应少一行，其余运行时文件（含 `NODE_PROVENANCE.json`）与源版本逐字节一致。`NODE_PROVENANCE.json` 是上游原样拷贝，在本包里读要注意两点：`verification_report` 和 `deployment_record` 是相对上游 CascadeCenter-web 仓库的路径，本包里没有这些文件；`previous` 说 .1 运行时包保留用于回滚，指的是上游仓库，本包不带这个包，回滚要用上游仓库或旧版插件。wheel 内保留原项目及依赖许可。首次安装的发行物完整性检查是安装所需；日常使用不重复做副本哈希清单。

维护时从已验证的中心发行物同步客户端及完整依赖，按新协议更新 `SKILL.md` 和任务执行说明；不要只替换一个 wheel 或自行安装最新版。这个版本面向 macOS/Linux，Windows 使用 WSL；不声明原生 Windows 安装支持。

分发整个 `cascade-center-agent/` 文件夹，不能只发 `SKILL.md` 而漏掉客户端和固定运行时。支持 skills 的 agent 将文件夹安装到其 skills 目录；不支持自动发现时，可让 agent 直接读取本文件夹的 `SKILL.md`。没有真实项目 ID、私钥、token、注册配置或产品源码随包发布。

本 skill 随 ai-dev-kit plugin 的 `skills/` 分发，也由同一 marketplace 的离线/项目安装器完整复制。更新插件即可取得本 skill，不需要另装独立 ZIP。
