# 来源与维护

本 skill 是通用的 Cascade agent 接入包，`scripts/` 基于 CascadeCenter-web 已上线版本 `47593c18f0c9321ec23d1c208160f2f7ae7a6c74` 的客户端及其直接依赖。插件只改了 `cascade-node-join.cjs` 的中心地址来源：移除默认站点，单独的项目 ID 依次使用 `--origin`、`CASCADE_CENTER_ORIGIN` 或同目录已保存的注册地址；复制的 `项目ID@中心地址`、`--harness` 和归属确认码与源版本一致，未改变服务端协议。此处仓库地址只记录代码来源，不用于选择接入项目或部署服务器。完整清单见 [source.json](source.json)。

源仓库：AutoSeek 内部的 CascadeCenter-web，不公开；此处只记录提交号。

`deploy/cascade-runtime/` 携带固定 Cascade `0.8.2+nodecollab.6` wheel、离线依赖、两个源码 patch（`node-collaboration.patch` 在上游基线上产出 .1，`node-storage-concurrency-nc6.patch` 在 .1 源码上产出 .6）、校验清单和来源记录。中心发行物还带 .5、.3、.1 的 wheel 以及 .5、.3 的 patch（.3 是中心 receive guard 的运行时，.5 是中心 publisher 的上一版运行时，都用于回滚和混跑测试）；agent 只装 .6，本包不带这五个文件，`NODE_SHA256SUMS` 相应少五行，和本包实际带的文件一一对应；其余运行时文件（含 `NODE_PROVENANCE.json`）与源版本逐字节一致。`NODE_PROVENANCE.json` 是上游原样拷贝，在本包里读要注意两点：`verification_report` 和各处的 `deployment_record` 是相对上游 CascadeCenter-web 仓库的路径，本包里没有这些文件；`kept` 列出的 .5、.3、.1 运行时包留在上游仓库，本包不带，agent 回滚时装回上一版插件（0.26.0 带 .5，0.25.0 带 .3）。wheel 内保留原项目及依赖许可。首次安装的发行物完整性检查是安装所需；日常使用不重复做副本哈希清单。

维护时从已验证的中心发行物同步客户端及完整依赖，按新协议更新 `SKILL.md` 和任务执行说明；不要只替换一个 wheel 或自行安装最新版。这个版本面向 macOS/Linux，Windows 使用 WSL；不声明原生 Windows 安装支持。

分发整个 `cascade-center-agent/` 文件夹，不能只发 `SKILL.md` 而漏掉客户端和固定运行时。支持 skills 的 agent 将文件夹安装到其 skills 目录；不支持自动发现时，可让 agent 直接读取本文件夹的 `SKILL.md`。没有真实项目 ID、私钥、token、注册配置或产品源码随包发布。

本 skill 随 ai-dev-kit plugin 的 `skills/` 分发，也由同一 marketplace 的离线/项目安装器完整复制。更新插件即可取得本 skill，不需要另装独立 ZIP。
