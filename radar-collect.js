#!/usr/bin/env node
/**
 * 积分全息轨迹 —— 数据采集层
 *
 * 把三份互不相干的本机数据拼成一张「每次请求」的宽表：
 *
 *   1. 会话记录 ~/.workbuddy/projects/…/<session>.jsonl
 *      每条带 providerData.usage 的 assistant 记录 = 一次模型请求。
 *      自带 model / credit / cwd / agent / traceId / token 明细 —— 这是主表。
 *   2. Trace ~/.workbuddy/traces/<pid>/trace_<traceId>.json
 *      里面 type=generation 的 span 就是这次 LLM 调用的耗时（毫秒）。
 *      主表靠 traceId 精确关联，拿到「每次请求耗时」。
 *   3. 会话心跳 ~/.workbuddy/sessions/<pid>.json
 *      pid → sessionId / cwd，用于补主表缺失的项目名。
 *
 * 产出 radar-data.js（window.__RADAR_DATA__），供 radar.html 直接 <script> 引入。
 * 零依赖，只用 Node 内置模块。
 *
 * 用法：
 *   node radar-collect.js              # 全量采集
 *   node radar-collect.js --days 30    # 只保留最近 30 天
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME = os.homedir();
const PROJECT_DIRS = [
  path.join(HOME, '.workbuddy', 'projects'),
  path.join(HOME, '.codebuddy', 'projects'),
].filter((d) => fs.existsSync(d));
const TRACE_DIR = path.join(HOME, '.workbuddy', 'traces');
const SESSION_DIR = path.join(HOME, '.workbuddy', 'sessions');
const OUT_FILE = path.join(__dirname, 'radar-data.js');

const argDays = (() => {
  const i = process.argv.indexOf('--days');
  const n = i !== -1 ? Number(process.argv[i + 1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const t0 = Date.now();
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 工具

/** 递归列出目录下指定后缀的文件。 */
function listFiles(dir, ext, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** cwd 太长时只留最后两段，既认得出项目又不会把整条路径塞进数据。 */
function shortProject(cwd) {
  if (!cwd) return '未知';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return '未知';
  return parts.slice(-1)[0] || '未知';
}

// ---------------------------------------------------------------- 1. Trace 索引

/**
 * 收集所有 generation span，作为「耗时 + 场景」的匹配池。
 *
 * 为什么按 span 而不是按 traceId 关联：会话记录里的 providerData.traceId 与
 * trace 文件里的 traceId 属于两套 id（实测 182 个 trace 文件与 259 个会话
 * traceId 交集为 0）。但两者的时间戳能对上——实测请求的 timestamp 约等于
 * generation span 的「结束时间」（中位差 138ms），据此做一对一就近匹配。
 *
 * 每条 span 附带「紧跟在它之后、下一次生成之前」的工具调用集合：一轮里先
 * 生成、再调工具，所以这批工具才是这次生成真正引发的动作，用于场景归类。
 */
function buildSpanPool() {
  const files = listFiles(TRACE_DIR, '.json');
  const pool = [];
  let bad = 0;

  for (const file of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { bad++; continue; }

    const all = (j.spans || [])
      .map((s) => ({
        st: Date.parse(s.startedAt),
        en: Date.parse(s.endedAt),
        dur: Number(s.duration),
        type: s.type,
        tool: s.toolName || '',
      }))
      .filter((s) => Number.isFinite(s.st))
      .sort((a, b) => a.st - b.st);

    const gens = all.filter((s) => s.type === 'generation');
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i];
      const end = Number.isFinite(g.en) ? g.en : g.st + (Number.isFinite(g.dur) ? g.dur : 0);
      const dur = Number.isFinite(g.dur) ? g.dur : (end - g.st);
      if (!(dur > 0)) continue;

      // 下一次生成开始之前的所有工具调用，就是这次生成的「动作」
      const nextStart = i + 1 < gens.length ? gens[i + 1].st : Infinity;
      const tools = {};
      for (const s of all) {
        if (!s.tool) continue;
        if (s.st >= g.st && s.st < nextStart) tools[s.tool] = (tools[s.tool] || 0) + 1;
      }

      pool.push({ end, dur, tools });
    }
  }

  pool.sort((a, b) => a.end - b.end);
  log(`[trace] 文件 ${files.length} 个，generation span ${pool.length} 条（解析失败 ${bad}）`);
  return pool;
}

// ---------------------------------------------------------------- 2. 会话心跳

/** pid → { sessionId, cwd }：jsonl 偶尔缺 cwd 时补位。 */
function buildSessionIndex() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json')); } catch { /* 无目录 */ }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (j.pid) map.set(String(j.pid), { sessionId: j.sessionId || '', cwd: j.cwd || '' });
    } catch { /* 心跳损坏不影响主流程 */ }
  }
  return map;
}

/**
 * sessionId → 会话标题。
 *
 * WorkBuddy 新建会话时默认在 WorkBuddy 下开一个 `2026-10-14-13-27-42` 这样的
 * 时间戳目录，直接拿来当「项目」毫无辨识度。数据库里存了用户看得懂的标题，
 * 用它替换，页面上才认得出「这次是在干什么」。
 */
function buildSessionTitles() {
  const map = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(HOME, '.workbuddy', 'workbuddy.db'), { readOnly: true });
    for (const r of db.prepare('SELECT id, title, custom_title FROM sessions').all()) {
      const t = String(r.custom_title || r.title || '').trim();
      if (r.id && t && !/^新会话|^untitled/i.test(t)) map.set(String(r.id), t);
    }
    db.close();
  } catch { /* 没有 node:sqlite 或表结构变了，退回用目录名 */ }
  return map;
}

// ---------------------------------------------------------------- 3. 主表

/** 从一条 assistant 记录里取「这次请求」的宽表行；不是请求则返回 null。 */
function rowOf(d) {
  const pd = d && d.providerData;
  if (!pd || typeof pd !== 'object') return null;

  const ru = pd.rawUsage || {};
  const u = d.message && d.message.usage;
  const pu = pd.usage;
  if (!ru.prompt_tokens && !u && !pu) return null;

  const inp = Number(ru.prompt_tokens || (u && u.input_tokens) || (pu && pu.inputTokens) || 0);
  const out = Number(ru.completion_tokens || (u && u.output_tokens) || (pu && pu.outputTokens) || 0);
  if (!inp && !out) return null;

  const credit = Number(ru.credit);
  const cacheRead = Number(
    ru.cache_read_input_tokens
    || (ru.prompt_tokens_details && ru.prompt_tokens_details.cached_tokens)
    || 0
  );

  return {
    // 主键：同一条消息可能被写多次，用 messageId 去重
    key: String(pd.messageId || d.id || ''),
    t: Number(d.timestamp) || Date.parse(d.timestamp) || 0,
    m: String(pd.model || pd.requestModelName || 'unknown'),
    p: shortProject(d.cwd),
    a: String(pd.agent || ''),
    i: inp,
    o: out,
    c: Number.isFinite(credit) ? credit : null,
    cr: cacheRead,
    x: String(pd.traceId || '').replace(/^trace_/, ''),
    sid: String(d.sessionId || ''),
  };
}

async function collectRequests(spanPool, sessionIndex, titles) {
  const files = [];
  for (const dir of PROJECT_DIRS) listFiles(dir, '.jsonl', files);

  const byKey = new Map();
  let lines = 0, bad = 0, hits = 0;

  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      lines++;
      // 绝大多数行不含 usage（用户消息、工具结果），先做廉价过滤
      if (line.indexOf('"usage"') === -1 && line.indexOf('"rawUsage"') === -1) continue;
      let d;
      try { d = JSON.parse(line); } catch { bad++; continue; }
      const row = rowOf(d);
      if (!row || !row.t) continue;
      hits++;
      // 同一 messageId 保留字段最全的一份（有些重写记录 usage 为 0）
      const prev = byKey.get(row.key);
      if (!prev || (prev.i + prev.o) < (row.i + row.o)) byKey.set(row.key, row);
    }
  }

  log(`[jsonl] 文件 ${files.length} 个，行 ${lines}，带用量 ${hits}，去重后 ${byKey.size}`);

  // 补项目名（jsonl 缺 cwd 时，用 sessionId 反查心跳表）
  const cwdBySession = new Map();
  for (const v of sessionIndex.values()) {
    if (v.sessionId && v.cwd) cwdBySession.set(v.sessionId, v.cwd);
  }

  const rows = [];
  let creditMissing = 0;

  for (const r of byKey.values()) {
    if (r.p === '未知' && r.sid && cwdBySession.has(r.sid)) r.p = shortProject(cwdBySession.get(r.sid));

    // 时间戳目录没有辨识度，换成用户看得懂的会话标题
    let proj = r.p;
    if (/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(proj) && titles.has(r.sid)) {
      proj = titles.get(r.sid).slice(0, 24);
    }

    if (r.c === null) creditMissing++;
    rows.push({
      t: r.t,
      m: r.m,
      p: proj,
      a: r.a,
      i: r.i,
      o: r.o,
      c: r.c === null ? 0 : Math.round(r.c * 100) / 100,
      cr: r.cr,
      d: null,
      x: r.x,
      s: '',
    });
  }

  rows.sort((a, b) => a.t - b.t);

  // ---- 耗时与场景：请求 timestamp ≈ span 结束时间，一对一就近分配 ----
  // 窗口 12 秒：中位误差只有 138ms，12 秒足以容纳落库延迟，又能挡住错配。
  const MATCH_WINDOW_MS = 12 * 1000;
  const used = new Uint8Array(spanPool.length);
  const cands = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const t = rows[ri].t;
    // 第一个 end >= t 的位置
    let lo = 0, hi = spanPool.length - 1, pos = spanPool.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spanPool[mid].end >= t) { pos = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let k = Math.max(0, pos - 3); k < Math.min(spanPool.length, pos + 4); k++) {
      const gap = Math.abs(spanPool[k].end - t);
      if (gap <= MATCH_WINDOW_MS) cands.push({ gap, ri, si: k });
    }
  }

  // 全局按误差从小到大分配，避免「先到先得」把精确的配对挤掉
  cands.sort((a, b) => a.gap - b.gap);
  const done = new Uint8Array(rows.length);
  let durMatched = 0, matchedSpans = 0;
  for (const c of cands) {
    if (done[c.ri] || used[c.si]) continue;
    done[c.ri] = 1; used[c.si] = 1;
    const sp = spanPool[c.si];
    rows[c.ri].d = Math.round(sp.dur);
    rows[c.ri].s = classifyScene(sp.tools, rows[c.ri].a);
    durMatched++; matchedSpans++;
  }

  // 没配上耗时的，场景退回 agent 字段
  for (const r of rows) if (!r.s) r.s = classifyScene(null, r.a);

  return { rows, durMatched, matchedSpans, creditMissing };
}

/**
 * 场景归类：优先看这一轮真实调用过哪些工具，而不是猜 prompt 关键词。
 * 没有 trace 的请求退回 providerData.agent 字段。
 */
function classifyScene(tools, agent) {
  if (tools) {
    if (tools.Edit || tools.Write || tools.MultiEdit) return 'Coding';
    if (tools.Agent || tools.TaskCreate || tools.TaskUpdate || tools.TaskOutput) return 'Agent';
    if (tools.Bash || tools.PowerShell) return 'Debug';
    if (tools.WebSearch || tools.WebFetch || tools.Read || tools.Grep || tools.Glob) return 'Research';
    return 'Chat';
  }
  const a = String(agent || '').toLowerCase();
  if (a === 'explore' || a === 'general-purpose' || a === 'claude') return 'Agent';
  if (a === 'cli') return 'Chat';
  return 'Chat';
}

// ---------------------------------------------------------------- 主流程

(async () => {
  log('积分全息轨迹 · 数据采集');
  log('');

  const spanPool = buildSpanPool();
  const sessionIndex = buildSessionIndex();
  const titles = buildSessionTitles();
  const { rows, durMatched, matchedSpans, creditMissing } = await collectRequests(spanPool, sessionIndex, titles);

  // 时间窗过滤
  const cutoff = argDays ? Date.now() - argDays * 86400000 : 0;
  const kept = cutoff ? rows.filter((r) => r.t >= cutoff) : rows;

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'local',
    total: kept.length,
    dropped: rows.length - kept.length,
    range: {
      from: kept.length ? kept[0].t : 0,
      to: kept.length ? kept[kept.length - 1].t : 0,
    },
    // 数据完整度声明，页面上要如实标出来
    coverage: {
      durationMatched: durMatched,
      spanPool: spanPool.length,
      durationRequests: kept.filter((r) => r.d != null).length,
      creditMissing,
    },
    rows: kept,
  };

  const head = '/* 由 radar-collect.js 自动生成，请勿手工编辑 */\n';
  fs.writeFileSync(OUT_FILE, head + 'window.__RADAR_DATA__ = ' + JSON.stringify(payload) + ';\n', 'utf8');

  const size = fs.statSync(OUT_FILE).size;
  log('');
  log(`[输出] ${path.basename(OUT_FILE)}  ${(size / 1024).toFixed(0)} KB`);
  log(`[规模] ${kept.length} 次请求，${new Date(payload.range.from).toLocaleString()} ~ ${new Date(payload.range.to).toLocaleString()}`);
  log(`[耗时] ${payload.coverage.durationRequests}/${kept.length} 次有耗时（匹配率 ${(payload.coverage.durationRequests / Math.max(1, kept.length) * 100).toFixed(1)}%）`);
  log(`[耗时] 匹配 span ${matchedSpans}/${spanPool.length} 条（trace 只保留最近约 11 天）`);
  log(`[积分] 缺失 ${creditMissing} 条（按 0 计，占比 ${(creditMissing / Math.max(1, kept.length) * 100).toFixed(1)}%）`);
  log(`[用时] ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
})();
