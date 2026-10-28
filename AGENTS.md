# AGENTS.md — bangumi-sync 操作手册

> 本文件是给 Agent（从零开始读本 repo 的 AI 助手）的操作手册。人类用户请先看 [README.md](README.md)。

## 1. 这个 repo 是什么

通过 **GitHub Actions 调用 Bangumi API（bgm.tv）** 自动更新追番进度与状态的个人同步器。数据流：

```
Agent 修改 data/updates.json（增量队列）
        │ git push
        ▼
GitHub Actions（scripts/sync.mjs）
        │ ① 只读校验（任何一条不合法 → 整体中止，什么都不写）
        │ ② 应用到 Bangumi API
        ▼
   成功 → 清零 updates.json + 把最新"在看"快照写入 data/state.json，自动 commit（[skip ci]）
   失败 → updates.json 保持原样，任务标红，修正后重新 push 即可重试
```

另外每天 **00:30（UTC+8）** 定时运行一次、每次运行结束后都会刷新 `data/state.json`——
所以即使你在 bgm.tv 手动改过进度，快照最迟第二天也会同步回来。也可以在
Actions → sync → Run workflow 手动触发。

## 2. Agent 标准操作流程

1. **先 `git pull`**（重要：上一次 Actions 运行可能已经清零队列 / 更新快照，本地副本通常是旧的）
2. 读 `data/state.json` 了解当前在追什么（`watching` 按 updated_at 倒序，`ep_status` 是服务端重算后的真实完成度）
3. 把增量写进 `data/updates.json`（格式见 §3；这是队列文件，可以一次写多条）
4. `git commit` + `git push` 到 `main`
5. 观察运行结果：
   ```bash
   gh run watch "$(gh run list --workflow=sync --limit 1 --json databaseId -q '.[0].databaseId' -R Hisou-Tenshi/bangumi-sync)" -R Hisou-Tenshi/bangumi-sync --exit-status
   ```
   或直接看仓库 Actions 页面。
6. 成功 → `git pull` 拿回清零后的队列与最新快照；失败 → 看 Actions 日志里的 `::error::` 行，修正 `updates.json` 后**重推完整的正确文件**（队列没有被清零，失败的条目还在里面）

> 注意：只有改动 `data/updates.json` 的 push 才会触发同步；改文档/脚本不会。

## 3. updates.json 格式

顶层结构：`{ "updates": [ … ] }`（也接受裸数组 `[ … ]`）。每条更新：

| 字段 | 必填 | 说明 |
|---|---|---|
| `subject_id` | ✅ | Bangumi 条目 ID（条目页 URL `/subject/123456` 中的数字） |
| `status` |  | `wish` 想看 / `doing` 在看 / `done` 看过 / `on_hold` 搁置 / `dropped` 抛弃（`watching`→doing、`completed`/`watched`→done 等别名可识别） |
| `ep_status` |  | 看到第几话（书籍为第几册）。**动画条目：脚本自动把第 1..N 话批量标记为已看，由服务端重算完成度**；书籍条目：直接写 `ep_status` |
| `episode_numbers` |  | 要标记为已看的本篇集数数组，如 `[8]` |
| `episodes` |  | 要标记为已看的章节 ID 数组（章节 ID 来自 `/v0/episodes?subject_id=…`，可用于 SP 等非本篇章节） |
| `rate` |  | 0–10 整数；`0` 表示删除评分 |
| `comment` |  | 吐槽（短评） |
| `private` |  | `true` 仅自己可见 |
| `allow_decrease` |  | 进度回退时必须为 `true`，否则脚本拒绝（防误操作） |

除 `subject_id` 外全部可选，但每条至少要有一个动作字段。

### 示例

开始追某番并看到第 3 话：

```json
{ "updates": [ { "subject_id": 123456, "status": "doing", "ep_status": 3 } ] }
```

最新一话更新了，只标记第 4 话已看（不动收藏状态）：

```json
{ "updates": [ { "subject_id": 123456, "episode_numbers": [4] } ] }
```

完结打分 + 短评：

```json
{ "updates": [ { "subject_id": 123456, "status": "done", "rate": 9, "comment": "神回连发" } ] }
```

## 4. 后端校验规则（在 Actions 里执行）

以下任何一条失败，**整个队列都不会写入**，`updates.json` 保持原样：

- JSON 语法错误、字段类型错误、未知 `status` 值
- `subject_id` 不存在 / 无法访问
- `ep_status` 超出该条目已收录集数；`episode_numbers` / `episodes` 引用了不存在的章节
- 进度回退（新 `ep_status` < 当前值）且未带 `"allow_decrease": true`

已通过校验的写入是幂等的：写一半失败后直接重推队列即可续传，重复标记无副作用。

另外两个自动行为：

- 条目尚未收藏时，标记章节/设置状态会**自动创建"在看"收藏**（除非显式给了别的 `status`）
- 同一 `subject_id` 出现多条时按顺序执行，后面的覆盖前面的

## 5. 查 subject_id / 章节 ID（无需 token 的公开接口）

```bash
# 条目详情（含 type、eps 总集数）
curl -s -H 'User-Agent: bangumi-sync/1.0' https://api.bgm.tv/v0/subjects/123456

# 章节列表（id 即章节 ID；ep 字段为本篇集数，type 0=本篇 1=SP）
curl -s -H 'User-Agent: bangumi-sync/1.0' 'https://api.bgm.tv/v0/episodes?subject_id=123456&limit=200'

# 搜索条目（POST）
curl -s -X POST -H 'User-Agent: bangumi-sync/1.0' -H 'Content-Type: application/json' \
  -d '{"keyword":"葬送的芙莉莲"}' https://api.bgm.tv/v0/search/subjects
```

## 6. 禁止 / 注意事项

- ❌ 不要手改 `data/state.json`（会被下次运行覆盖）
- ❌ 不要把 `BANGUMI_API_KEY` 写进任何文件或日志；它只存在于 repo secret（本地原件在 `~/Documents/GitHub/.env`）
- ❌ 不要直接对动画条目调 API 写 `ep_status`——脚本已把进度转换为章节标记（API 规范注明 `ep_status` 仅适用于书籍条目）
- ✅ 队列清零 / 快照提交由 `github-actions[bot]` 完成，commit 带 `[skip ci]`，不会循环触发
- ✅ 快照与计数只统计动画条目（subject_type=2）

## 7. 本地手动测试

```bash
BANGUMI_API_KEY=$(grep '^BANGUMI_API_KEY=' ../.env | cut -d= -f2-) node scripts/sync.mjs
```

（在 repo 根目录运行；会真实调用 API，队列里有内容时会真实写入。）
