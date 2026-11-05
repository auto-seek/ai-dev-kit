# 来源与维护

本 skill 是通用的 Cascade agent 接入包，`scripts/` 基于 CascadeCenter-web `8905575e9ca159b5eadf9bb6a7ddda6c9e219da1`（中心统一写入阶段 E–G 的提交，带 agent 执行端点；其后到 main 合并为止这些文件没有再改）的客户端及其直接依赖。插件只改了 `cascade-node-join.cjs` 的中心地址来源：移除默认站点，单独的项目 ID 依次使用 `--origin`、`CASCADE_CENTER_ORIGIN` 或同目录已保存的注册地址；复制的 `项目ID@中心地址`、`--harness` 和归属确认码与源版本一致，未改变服务端协议。此处仓库地址只记录代码来源，不用于选择接入项目或部署服务器。完整清单见 [source.json](source.json)。

源仓库：AutoSeek 内部的 CascadeCenter-web，不公开；此处只记录提交号。

本包不带 Cascade 运行时：agent 的领取、续租、完成、释放和失败都经 HTTPS 交给中心写入器，只需要 Node。上一版（0.32.0）带 `deploy/cascade-runtime/`（.6 wheel、离线依赖、patch 和来源记录）以及 `cascade-node-native.py`、`cascade-portal-publish.py`、`cascade-portal/admission.cjs`，回滚时装回那一版。

维护时从已验证的中心发行物同步客户端及完整依赖，按新协议更新 `SKILL.md` 和任务执行说明；不要只替换其中一个文件。这个版本面向 macOS/Linux，Windows 使用 WSL；不声明原生 Windows 安装支持。

分发整个 `cascade-center-agent/` 文件夹，不能只发 `SKILL.md` 而漏掉客户端。支持 skills 的 agent 将文件夹安装到其 skills 目录；不支持自动发现时，可让 agent 直接读取本文件夹的 `SKILL.md`。没有真实项目 ID、私钥、token、注册配置或产品源码随包发布。

本 skill 随 ai-dev-kit plugin 的 `skills/` 分发，也由同一 marketplace 的离线/项目安装器完整复制。更新插件即可取得本 skill，不需要另装独立 ZIP。
