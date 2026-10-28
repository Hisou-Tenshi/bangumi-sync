#!/usr/bin/env node
/**
 * bangumi-sync —— 读取 data/updates.json 变更队列，校验后通过 Bangumi API (bgm.tv) 应用，
 * 成功后清零队列，并把运行结束后的最新"在看"状态快照写入 data/state.json。
 *
 * 运行环境：GitHub Actions（Node >= 20，零第三方依赖）
 * 环境变量：
 *   BANGUMI_API_KEY    Bangumi 个人 Access Token（需 write:collection 权限），来自 repo secret
 *   GITHUB_REPOSITORY  Actions 自动提供，用于构造合规的 User-Agent
 *
 * 设计要点：
 *   1. 两阶段执行：先全部只读校验，任何一条不合法则整体失败、不写入任何内容（队列保持原样）；
 *   2. 动画条目的进度(ep_status)不直接写 API（规范标注其仅适用于书籍条目），
 *      而是转换为"标记第 1..N 话已看"的批量章节操作，由服务端重算完成度；
 *   3. 进度回退必须显式携带 allow_decrease: true，防止误操作清空进度；
 *   4. 所有请求带重试（429/5xx/网络错误），失败任务以非零码退出，队列不被清零。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://api.bgm.tv';
const TOKEN = process.env.BANGUMI_API_KEY;
const REPO = process.env.GITHUB_REPOSITORY || 'Hisou-Tenshi/bangumi-sync';
const UA = `bangumi-sync/1.0 (https://github.com/${REPO})`;
const UPDATES_FILE = path.join(ROOT, 'data', 'updates.json');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;

const SUBJECT_BOOK = 1; // 书籍条目：ep_status 可直接写
// 收藏类型（SubjectCollectionType）：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃
const COLL = { wish: 1, done: 2, doing: 3, on_hold: 4, dropped: 5 };
const COLL_NAME = Object.fromEntries(Object.entries(COLL).map(([k, v]) => [v, k]));
const EP_NONE = 0; // 章节收藏：未收藏
const EP_DONE = 2; // 章节收藏：看过

const STATUS_ALIASES = {
  wish: 'wish', want: 'wish', wanted: 'wish', 想看: 'wish',
  doing: 'doing', watching: 'doing', in_progress: 'doing', 在看: 'doing',
  done: 'done', watched: 'done', completed: 'done', complete: 'done', finished: 'done', 看过: 'done',
  on_hold: 'on_hold', onhold: 'on_hold', hold: 'on_hold', paused: 'on_hold', 搁置: 'on_hold',
  dropped: 'dropped', drop: 'dropped', 抛弃: 'dropped',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function fatal(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function writeSummary(text) {
  if (SUMMARY) {
    try { fs.appendFileSync(SUMMARY, text); } catch { /* 忽略 */ }
  }
}

let httpCalls = 0;
let USER = '-'; // 登录用户名，/v0/me 之后填充（读取端点需要真实用户名）

/** 带重试的 API 调用，返回 { status, ok, data }；429/5xx/网络错误自动重试 */
async function api(method, url, body, { retries = 3 } = {}) {
  httpCalls++;
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let lastError = '';
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      lastError = `网络错误: ${err.message}`;
      if (attempt >= retries) throw new Error(`${method} ${url} — ${lastError}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      if (attempt >= retries) throw new Error(`${method} ${url} — ${lastError}（已重试 ${retries} 次）`);
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfter * 1000, 2000 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: res.status, ok: res.ok, data };
  }
}

// ---------------------------------------------------------------- 队列读取与规范化

function loadQueue() {
  if (!fs.existsSync(UPDATES_FILE)) return [];
  const raw = fs.readFileSync(UPDATES_FILE, 'utf8');
  if (!raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`updates.json 不是合法 JSON：${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.updates;
  if (!Array.isArray(list)) throw new Error('updates.json 顶层应为 {"updates": [...]} 或数组');
  return list;
}

function toInt(v, field, idx) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error(`#${idx}: ${field} 必须是整数（收到 ${JSON.stringify(v)}）`);
  }
  return n;
}

/** 规范化单条更新；无可执行动作时返回 null */
function normalizeEntry(raw, idx) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`#${idx}: 每条更新必须是对象`);
  }
  const e = { subject_id: toInt(raw.subject_id ?? raw.subject ?? raw.id, 'subject_id', idx) };
  if (e.subject_id <= 0) throw new Error(`#${idx}: subject_id 必须为正整数`);

  if (raw.status != null) {
    const key = String(raw.status).trim().toLowerCase();
    const s = STATUS_ALIASES[key];
    if (!s) throw new Error(`#${idx}: 未知状态 "${raw.status}"（支持 wish|doing|done|on_hold|dropped 及常见别名）`);
    e.status = s;
  }
  if (raw.ep_status != null) {
    const n = toInt(raw.ep_status, 'ep_status', idx);
    if (n < 0) throw new Error(`#${idx}: ep_status 不能为负数`);
    e.ep_status = n;
  }
  if (raw.rate != null) {
    const n = toInt(raw.rate, 'rate', idx);
    if (n < 0 || n > 10) throw new Error(`#${idx}: rate 取值 0-10（0 表示删除评分）`);
    e.rate = n;
  }
  if (raw.comment != null) e.comment = String(raw.comment);
  if (raw.private != null) e.private = Boolean(raw.private);

  if (raw.episodes != null) {
    e.episodes = [...new Set([].concat(raw.episodes).map((v) => toInt(v, 'episodes[]', idx)))];
    if (!e.episodes.length) throw new Error(`#${idx}: episodes 不能为空数组`);
    if (e.episodes.some((n) => n <= 0)) throw new Error(`#${idx}: episodes 中存在无效章节 ID`);
  }
  if (raw.episode_numbers != null) {
    e.episode_numbers = [...new Set([].concat(raw.episode_numbers).map((v) => toInt(v, 'episode_numbers[]', idx)))];
    if (!e.episode_numbers.length) throw new Error(`#${idx}: episode_numbers 不能为空数组`);
    if (e.episode_numbers.some((n) => n <= 0)) throw new Error(`#${idx}: episode_numbers 中存在无效集数`);
  }
  if (raw.allow_decrease != null) e.allow_decrease = Boolean(raw.allow_decrease);

  const actionable = e.status != null || e.ep_status != null || e.rate != null ||
    e.comment != null || e.private != null || e.episodes != null || e.episode_numbers != null;
  return actionable ? e : null;
}

// ---------------------------------------------------------------- 状态抓取（快照 / 校验基准）

/** 拉取某收藏类型下的全部动画条目收藏（含内嵌 SlimSubject） */
async function fetchAnimeByStatus(type) {
  const out = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const r = await api('GET', `/v0/users/${USER}/collections?subject_type=2&type=${type}&limit=${limit}&offset=${offset}`);
    if (!r.ok) throw new Error(`拉取收藏列表失败(type=${COLL_NAME[type]}): HTTP ${r.status}`);
    const data = Array.isArray(r.data?.data) ? r.data.data : [];
    out.push(...data);
    const total = Number(r.data?.total ?? 0);
    if (out.length >= total || data.length === 0) break;
  }
  return out;
}

/** 各收藏类型的动画条目数量 */
async function fetchCounts() {
  const counts = {};
  await Promise.all(Object.values(COLL).map(async (t) => {
    const r = await api('GET', `/v0/users/${USER}/collections?subject_type=2&type=${t}&limit=1&offset=0`);
    if (!r.ok) throw new Error(`拉取收藏计数失败(type=${COLL_NAME[t]}): HTTP ${r.status}`);
    counts[COLL_NAME[t]] = Number(r.data?.total ?? 0);
  }));
  return counts;
}

function slimWatching(items) {
  return items
    .map((c) => ({
      subject_id: c.subject_id,
      name: c.subject?.name ?? '',
      name_cn: c.subject?.name_cn ?? '',
      air_date: c.subject?.date ?? null,
      eps: c.subject?.eps ?? null,          // 条目收录的总集数（连载中可能为 0/空）
      ep_status: c.ep_status ?? 0,          // 服务端重算后的真实完成度
      rate: c.rate ?? 0,
      comment: c.comment ?? '',
      private: Boolean(c.private),
      updated_at: c.updated_at ?? null,
    }))
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
}

async function getCollection(subjectId) {
  // GET 单条收藏挂在 /v0/users/{username}/... 下（`-` 占位符仅对写入端点有效）
  const r = await api('GET', `/v0/users/${USER}/collections/${subjectId}`);
  if (r.status === 404) return null; // 尚未收藏
  if (!r.ok) throw new Error(`读取收藏失败(subject=${subjectId}): HTTP ${r.status}`);
  return r.data;
}

/** 拉取条目全部章节；byNumber 仅收录本篇(type=0)的 集数→ID 映射 */
async function fetchSubjectEpisodes(subjectId) {
  const byId = new Map();
  const byNumber = new Map();
  const limit = 200; // /v0/episodes 规范上限
  for (let offset = 0; ; offset += limit) {
    const r = await api('GET', `/v0/episodes?subject_id=${subjectId}&limit=${limit}&offset=${offset}`);
    if (!r.ok) throw new Error(`拉取章节列表失败(subject=${subjectId}): HTTP ${r.status}`);
    const data = Array.isArray(r.data?.data) ? r.data.data : [];
    for (const ep of data) {
      byId.set(ep.id, ep);
      if ((ep.type ?? 0) === 0 && ep.ep != null) byNumber.set(Math.trunc(ep.ep), ep.id);
    }
    const total = Number(r.data?.total ?? 0);
    if (byId.size >= total || data.length === 0) break;
  }
  return { byId, byNumber, maxEp: byNumber.size ? Math.max(...byNumber.keys()) : 0 };
}

// ---------------------------------------------------------------- 校验与写入

/** 同一条目的读取结果缓存（校验阶段填充，应用阶段复用） */
const subjectCache = new Map(); // subject_id -> { subjectType, episodes, col }

async function subjectCtx(subjectId) {
  if (!subjectCache.has(subjectId)) {
    const col = await getCollection(subjectId);
    let subjectType = col?.subject_type;
    if (subjectType == null) {
      const s = await api('GET', `/v0/subjects/${subjectId}`);
      if (!s.ok) throw new Error(`条目 ${subjectId} 不存在或无法访问（HTTP ${s.status}），请确认 subject_id`);
      subjectType = s.data?.type;
    }
    const episodes = await fetchSubjectEpisodes(subjectId);
    subjectCache.set(subjectId, { subjectType, episodes, col });
  }
  return subjectCache.get(subjectId);
}

/** 只读校验单条更新，返回错误信息数组（空数组=通过） */
async function validateEntry(e, idx) {
  const errs = [];
  const ctx = await subjectCtx(e.subject_id);
  const col = ctx.col;
  const curEp = col?.ep_status ?? 0;

  if (e.ep_status != null) {
    if (ctx.subjectType === SUBJECT_BOOK) {
      if (e.ep_status < curEp && !e.allow_decrease) {
        errs.push(`书籍进度回退 ${curEp} → ${e.ep_status}，需要 "allow_decrease": true`);
      }
    } else {
      if (!ctx.episodes.maxEp) {
        errs.push('该条目没有已收录的本篇章节，无法设置动画进度');
      } else if (e.ep_status > ctx.episodes.maxEp) {
        errs.push(`ep_status=${e.ep_status} 超出该条目已有集数（最大第 ${ctx.episodes.maxEp} 话）`);
      }
      if (e.ep_status < curEp && !e.allow_decrease) {
        errs.push(`进度回退 ${curEp} → ${e.ep_status}，需要 "allow_decrease": true`);
      }
      if (!errs.length) {
        const missing = [];
        for (let n = Math.min(e.ep_status, curEp) + 1; n <= Math.max(e.ep_status, curEp); n++) {
          if (!ctx.episodes.byNumber.has(n)) missing.push(n);
        }
        if (missing.length) errs.push(`章节列表缺少第 ${missing.join(', ')} 话，无法完成标记`);
      }
    }
  }
  if (e.episode_numbers) {
    for (const n of e.episode_numbers) {
      if (!ctx.episodes.byNumber.has(n)) errs.push(`第 ${n} 话不存在或不属于本篇`);
    }
  }
  if (e.episodes) {
    for (const id of e.episodes) {
      if (!ctx.episodes.byId.has(id)) errs.push(`章节 ID ${id} 不属于条目 ${e.subject_id}`);
    }
  }
  return errs;
}

async function patchEpisodes(subjectId, episodeIds, type) {
  if (!episodeIds.length) return;
  const r = await api('PATCH', `/v0/users/-/collections/${subjectId}/episodes`, {
    episode_id: episodeIds,
    type,
  });
  if (!r.ok) {
    throw new Error(`标记章节失败(subject=${subjectId}, ${episodeIds.length} 个): HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  }
}

/** 应用单条更新（第二阶段，可能产生写操作；失败抛出异常） */
async function applyEntry(e) {
  const ctx = subjectCache.get(e.subject_id);
  const col = ctx.col;
  const curEp = col?.ep_status ?? 0;
  const isBook = ctx.subjectType === SUBJECT_BOOK;
  const acts = [];

  // 1) 收藏级修改（状态/评分/吐槽/私密；书籍进度）。POST 不存在则创建、存在则修改。
  const body = {};
  if (e.status != null) body.type = COLL[e.status];
  if (e.rate != null) body.rate = e.rate;
  if (e.comment != null) body.comment = e.comment;
  if (e.private != null) body.private = e.private;
  if (isBook && e.ep_status != null) body.ep_status = e.ep_status;

  const markEpisodes = !isBook && (e.ep_status != null || e.episode_numbers != null || e.episodes != null);
  const needCollectionWrite = Object.keys(body).length > 0 || (markEpisodes && !col);
  if (needCollectionWrite) {
    if (!col && body.type == null) body.type = COLL.doing; // 为标记章节自动创建收藏时，默认"在看"
    const r = await api(col ? 'PATCH' : 'POST', `/v0/users/-/collections/${e.subject_id}`, body);
    if (!r.ok) {
      throw new Error(`更新收藏失败(subject=${e.subject_id}): HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    acts.push(`${col ? 'PATCH' : 'POST'} collection ${JSON.stringify(body)}`);
  }

  // 2) 动画进度 → 批量章节标记（服务端会重算条目完成度）
  if (markEpisodes) {
    const toWatch = [];
    if (e.ep_status != null && e.ep_status > curEp) {
      for (let n = curEp + 1; n <= e.ep_status; n++) toWatch.push(ctx.episodes.byNumber.get(n));
    }
    if (e.ep_status != null && e.ep_status < curEp) {
      const toUnwatch = [];
      for (let n = e.ep_status + 1; n <= curEp; n++) toUnwatch.push(ctx.episodes.byNumber.get(n));
      await patchEpisodes(e.subject_id, toUnwatch.filter(Boolean), EP_NONE);
      acts.push(`${toUnwatch.length} 个章节标记为未看（进度回退）`);
    }
    if (e.episode_numbers) for (const n of e.episode_numbers) toWatch.push(ctx.episodes.byNumber.get(n));
    if (e.episodes) toWatch.push(...e.episodes);

    const uniq = [...new Set(toWatch.filter(Boolean))];
    if (uniq.length) {
      await patchEpisodes(e.subject_id, uniq, EP_DONE);
      acts.push(`标记 ${uniq.length} 个章节已看`);
    }
  }
  return acts;
}

// ---------------------------------------------------------------- 主流程

if (!TOKEN) fatal('缺少环境变量 BANGUMI_API_KEY（请在 repo Settings → Secrets 中配置）');

let rawEntries;
try {
  rawEntries = loadQueue();
} catch (err) {
  fatal(err.message);
}

const normalizeErrors = [];
const entries = [];
rawEntries.forEach((raw, i) => {
  try {
    const e = normalizeEntry(raw, i + 1);
    if (e) entries.push(e);
  } catch (err) {
    normalizeErrors.push(err.message);
  }
});

const meRes = await api('GET', '/v0/me');
if (!meRes.ok) fatal(`认证失败：GET /v0/me → HTTP ${meRes.status}，请检查 BANGUMI_API_KEY 是否有效`);
const me = meRes.data;
USER = encodeURIComponent(String(me.username ?? me.id));
log(`已认证：${me.nickname || me.username} (@${me.username})`);
log(`队列：${rawEntries.length} 条原始记录 → ${entries.length} 条有效更新` +
  (normalizeErrors.length ? `，${normalizeErrors.length} 条格式错误` : ''));

// —— 第一阶段：全部只读校验，任何失败则整体中止（不写入任何内容） ——
const validationErrors = [...normalizeErrors];
for (let i = 0; i < entries.length; i++) {
  try {
    const errs = await validateEntry(entries[i], i + 1);
    validationErrors.push(...errs.map((m) => `#${i + 1}（subject ${entries[i].subject_id}）：${m}`));
  } catch (err) {
    validationErrors.push(`#${i + 1}（subject ${entries[i].subject_id}）：${err.message}`);
  }
}

if (validationErrors.length) {
  writeSummary(['## ❌ 校验未通过，队列保持不变', '', ...validationErrors.map((e) => `- ${e}`), ''].join('\n'));
  for (const msg of validationErrors) console.error(`::error::${msg}`);
  fatal(`共 ${validationErrors.length} 个错误；本次未向 Bangumi 写入任何内容，data/updates.json 保持原样。修正后重新 push 即可重试。`);
}

// —— 第二阶段：逐条应用 ——
const applied = [];
for (let i = 0; i < entries.length; i++) {
  let acts;
  try {
    acts = await applyEntry(entries[i]);
  } catch (err) {
    writeSummary(['## ❌ 写入失败', '', `- #${i + 1}（subject ${entries[i].subject_id}）：${err.message}`, '',
      '此前已应用的条目为幂等操作，重新 push 队列即可续传。', ''].join('\n'));
    fatal(`#${i + 1}（subject ${entries[i].subject_id}）：${err.message}`);
  }
  applied.push({ index: i + 1, subject_id: entries[i].subject_id, actions: acts });
  await sleep(300); // 轻微限速
}

// —— 运行结束：抓取最新状态写入快照，并清零队列 ——
const watching = await fetchAnimeByStatus(COLL.doing);
const counts = await fetchCounts();
const state = {
  version: 1,
  synced_at: new Date().toISOString(),
  user: { id: me.id, username: me.username, nickname: me.nickname },
  summary: counts,
  watching: slimWatching(watching),
};
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

fs.mkdirSync(path.dirname(UPDATES_FILE), { recursive: true });
fs.writeFileSync(UPDATES_FILE, JSON.stringify({ updates: [] }, null, 2) + '\n');

const lines = [
  '## ✅ Bangumi 同步完成',
  '',
  `用户：${me.nickname || me.username} (@${me.username})`,
  `应用更新：${applied.length} 条`,
  '',
  ...applied.map((a) => `- #${a.index} subject ${a.subject_id}：${a.actions.join('；') || '（无可执行变更）'}`),
  '',
  `在看 ${counts.doing} ｜ 想看 ${counts.wish} ｜ 看过 ${counts.done} ｜ 搁置 ${counts.on_hold} ｜ 抛弃 ${counts.dropped}（仅动画条目）`,
  '',
  `API 调用 ${httpCalls} 次；快照已更新 data/state.json，队列已清零。`,
];
writeSummary(lines.join('\n') + '\n');
log(lines.slice(2).join('\n'));
log('完成：data/state.json 已更新为最新状态，data/updates.json 已清零。');
