# bangumi-sync

通过 GitHub Actions 自动把追番进度 / 状态同步到 [Bangumi (bgm.tv)](https://bgm.tv)。

- **增量队列**：把要做的变更写进 [`data/updates.json`](data/updates.json) → push → Actions 自动校验并通过 API 应用
- **成功清零，失败保留**：全部应用成功后队列自动清零并提交；任何校验/写入失败则文件原样保留，修正后重新 push 即可重试
- **状态快照**：每次运行结束后把最新"在看"列表与统计写入 [`data/state.json`](data/state.json)（每天 00:30 UTC+8 也会定时刷新），供外部 Agent 从零了解当前追番状态；同时作为脚本后端校验的基准
- **安全写入**：进度回退需要显式 `allow_decrease`；集数/章节存在性、条目有效性均先校验后写入；动画进度通过"标记章节已看"实现（服务端重算完成度），不直接写 `ep_status`

Agent 使用说明见 **[AGENTS.md](AGENTS.md)**（含 `updates.json` 完整字段规格与示例）。

## 文件结构

```
.github/workflows/sync.yml   # push(仅 updates.json) / 手动 / 每日定时 触发
scripts/sync.mjs             # 同步脚本（Node ≥ 20，零依赖）
data/updates.json            # 变更队列（Agent 写入，成功后清零）
data/state.json              # 状态快照（Actions 生成，勿手改）
```

## 配置

仓库 Secret：`BANGUMI_API_KEY` —— Bangumi 个人 Access Token（[开发平台](https://bgm.tv/dev/app) 创建，需 `write:collection` 权限）。

手动触发：Actions → **sync** → Run workflow；本地测试见 AGENTS.md §7。

## License

[GNU Affero General Public License v3.0](LICENSE)
