// 任务系统工单日报: 统计 -> 按负责人分组 -> 邮件(agently-cli)/飞书(lark-cli)推送
// 用法: node ge_report.mjs [--date=YYYY-MM-DD] [--dry-run] [--no-email] [--no-feishu]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStats, todayCN } from "./ge_stats.mjs";

const run = promisify(execFile);
// 跨平台调用 lark-cli: 非 Windows 直接 execFile("lark-cli", args, {shell:false}) 即可正确传多行正文;
// Windows 的 cmd.exe 会在第一个换行处截断多行参数, 故改用 node 直跑其 JS 入口 run.js。
const IS_WIN = process.platform === "win32";
let LARK_RUN = null;
if (IS_WIN) {
  LARK_RUN = process.env.LARK_CLI_RUN || null;
  if (!LARK_RUN) {
    try {
      const root = execSync("npm root -g", { encoding: "utf8" }).trim().replace(/\\/g, "/");
      LARK_RUN = root + "/@larksuite/cli/scripts/run.js";
    } catch { LARK_RUN = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js"; }
  }
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));

const args = process.argv.slice(2);
const getArg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const hasFlag = (n) => args.includes(`--${n}`);
const date = getArg("date") || todayCN();
const dryRun = hasFlag("dry-run");
const emailOn = !hasFlag("no-email") && (config.notify?.channels || ["email"]).includes("email");
const feishuOn = !hasFlag("no-feishu") && (config.notify?.channels || ["email"]).includes("feishu");

const log = (...a) => console.error("[report]", ...a);

function buildMessage(ownerName, projItems, grand) {
  const lines = [];
  lines.push(`【任务系统工单日报】${date}`);
  lines.push(`负责人：${ownerName}`);
  const tagCount = projItems.reduce((n, p) => n + p.items.length, 0);
  lines.push(`涉及 ${projItems.length} 个项目、${tagCount} 个技能标签`);
  for (const { project, items } of projItems) {
    lines.push("");
    lines.push(`▍项目：${project}`);
    for (const { tag } of items) {
      lines.push(`  · ${tag.label}（${tag.categoryLabel}）：进行中 ${tag.ongoing_total} ｜ 今日新增 ${tag.new_today} ｜ 未完成 ${tag.unfinished_total} ｜ 今日新增未完成 ${tag.new_today_unfinished} ｜ 今日完成 ${tag.finished_today}`);
    }
    const sub = items.reduce((acc, { tag }) => {
      for (const k of KEYS) acc[k] += tag[k];
      return acc;
    }, { ongoing_total: 0, new_today: 0, unfinished_total: 0, new_today_unfinished: 0, finished_today: 0 });
    lines.push(`  小计：进行中 ${sub.ongoing_total} ｜ 今日新增 ${sub.new_today} ｜ 未完成 ${sub.unfinished_total} ｜ 今日新增未完成 ${sub.new_today_unfinished} ｜ 今日完成 ${sub.finished_today}`);
  }
  lines.push("");
  lines.push(`【总计】进行中累计 ${grand.ongoing_total} ｜ 今日新增 ${grand.new_today} ｜ 未完成累计 ${grand.unfinished_total} ｜ 今日新增未完成 ${grand.new_today_unfinished} ｜ 今日完成 ${grand.finished_today}`);
  lines.push(`数据来源：金鹰智慧物业运营平台-任务报表（全量 ${projItems[0]?.items[0]?.tag?.statsTotal ?? "-"} 单；完成=归档状态，作废单不计入未完成/完成）`);
  return lines.join("\n");
}
const KEYS = ["ongoing_total", "new_today", "unfinished_total", "new_today_unfinished", "finished_today"];

async function resolveFeishuOpenId(owner) {
  if (owner.feishuId) return owner.feishuId;
  const key = owner.feishuEmail || owner.name;
  if (!key) return null;
  // 1) 飞书联系人库精确匹配(唯一命中才采用)
  try {
    const fc = JSON.parse(await readFile(join(__dirname, "feishu_contacts.json"), "utf8"));
    const hits = (fc.contacts || []).filter((c) => c.name === key);
    if (hits.length === 1) return hits[0].openId;
  } catch {}
  const cacheFile = join(__dirname, "data", "feishu_ids.json");
  let cache = {};
  try { cache = JSON.parse(await readFile(cacheFile, "utf8")); } catch {}
  if (cache[key]) return cache[key];
  try {
    const sub = ["contact", "+search-user", "--query", key, "--as", "user", "--format", "json"];
    const { stdout } = await run(IS_WIN ? process.execPath : "lark-cli", IS_WIN ? [LARK_RUN, ...sub] : sub, { timeout: 45000 });
    const m = stdout.match(/ou_[a-f0-9]{20,}/);
    if (m) {
      cache[key] = m[0];
      await writeFile(cacheFile, JSON.stringify(cache, null, 2));
      return m[0];
    }
  } catch (e) { log(`飞书 open_id 解析失败(${key}): ${String(e).slice(0, 100)}`); }
  return null;
}

async function sendEmail(to, subject, body) {
  const bodyFile = join(__dirname, "data", `.mail_body_${Date.now()}.md`);
  await writeFile(bodyFile, body, "utf8");
  try {
    const { stdout } = await run("agently-cli", ["message", "+send", "--to", to, "--subject", subject, "--body-file", bodyFile, "--confirmed"], { shell: true, timeout: 90000, cwd: __dirname });
    return { ok: !/error|fail/i.test(stdout.slice(0, 200)), detail: stdout.slice(0, 200) };
  } finally {
    try { await writeFile(bodyFile, ""); } catch {}
  }
}

let feishuIdentity = null; // null=自动探测(优先个人身份), 之后固定为 "user" 或 "bot"

async function trySendFeishu(identity, openId, body) {
  const sub = ["im", "+messages-send", "--as", identity, "--user-id", openId, "--text", body, "--format", "json"];
  const cmd = IS_WIN ? process.execPath : "lark-cli";
  const argv = IS_WIN ? [LARK_RUN, ...sub] : sub;
  try {
    const { stdout } = await run(cmd, argv, { timeout: 60000 });
    const j = JSON.parse(stdout);
    return { ok: j.ok === true || !!(j.message_id || j.data?.message_id), raw: j };
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    let raw = {};
    const jm = out.match(/\{[\s\S]*\}/);
    if (jm) { try { raw = JSON.parse(jm[0]); } catch {} }
    return { ok: false, raw };
  }
}

// 优先用个人身份(张宸熙可私信任意同事, 不受 bot 可用范围限制); 若缺 im:message.send_as_user 权限则自动回退 bot
async function sendFeishu(openId, body) {
  const order = feishuIdentity ? [feishuIdentity] : ["user", "bot"];
  let lastErr = "";
  for (const idt of order) {
    const r = await trySendFeishu(idt, openId, body);
    if (r.ok) { feishuIdentity = idt; return { ok: true, identity: idt, detail: (r.raw.data?.message_id || "ok") }; }
    const code = r.raw?.error?.code;
    lastErr = r.raw?.error?.message || JSON.stringify(r.raw).slice(0, 120);
    if (idt === "user" && code === 99991679) { feishuIdentity = "bot"; continue; } // 缺个人发送权限, 永久回退 bot
    if (idt === "bot") break;
  }
  return { ok: false, detail: lastErr || "发送失败" };
}

// 兜底汇总: 发给回退接收人(默认张宸熙), 覆盖全部项目/标签数据 + 未送达名单
function buildFallbackDigest(stats, unreachable) {
  const L = [];
  L.push(`【工单日报·兜底汇总】${date}`);
  L.push(`以下 ${unreachable.length} 位负责人飞书/邮件均未送达（应用可用范围未覆盖），完整数据汇总给您：`);
  for (const p of stats.projects || []) {
    if (!p.totals.all_total) continue;
    L.push('');
    L.push(`▍${p.name}：进行中 ${p.totals.ongoing_total} ｜ 今日新增 ${p.totals.new_today} ｜ 未完成 ${p.totals.unfinished_total} ｜ 今日新增未完成 ${p.totals.new_today_unfinished} ｜ 今日完成 ${p.totals.finished_today}`);
    for (const t of p.tags.filter((x) => x.all_total > 0).slice(0, 12)) {
      L.push(`  · ${t.label}：进行中 ${t.ongoing_total} ｜ 新增 ${t.new_today} ｜ 完成 ${t.finished_today}`);
    }
  }
  L.push('');
  L.push(`【全局】进行中 ${stats.totals.ongoing_total} ｜ 今日新增 ${stats.totals.new_today} ｜ 未完成 ${stats.totals.unfinished_total} ｜ 今日新增未完成 ${stats.totals.new_today_unfinished} ｜ 今日完成 ${stats.totals.finished_today}`);
  L.push('未送达负责人：' + unreachable.map((r) => r.owner).join('、'));
  L.push('建议：飞书后台将日报应用的"可用范围"改为"全部成员"并发布，或授权个人发送权限。');
  return L.join('\n');
}

// 发给本人的完整日报(不群发负责人): 全局 + 各项目 + 各标签五指标
function buildSelfDigest(stats) {
  const L = [];
  L.push(`【工单日报】${date}`);
  L.push(`【全局】进行中 ${stats.totals.ongoing_total} ｜ 今日新增 ${stats.totals.new_today} ｜ 未完成 ${stats.totals.unfinished_total} ｜ 今日新增未完成 ${stats.totals.new_today_unfinished} ｜ 今日完成 ${stats.totals.finished_today}`);
  L.push(`（全量 ${stats.workorderTotal} 单，作废 ${stats.totals.voided_total}）`);
  for (const p of stats.projects || []) {
    if (!p.totals.all_total) continue;
    L.push('');
    L.push(`▍${p.name}：进行中 ${p.totals.ongoing_total} ｜ 今日新增 ${p.totals.new_today} ｜ 未完成 ${p.totals.unfinished_total} ｜ 今日新增未完成 ${p.totals.new_today_unfinished} ｜ 今日完成 ${p.totals.finished_today}`);
    for (const t of p.tags.filter((x) => x.ongoing_total > 0 || x.new_today > 0 || x.finished_today > 0)) {
      L.push(`  · ${t.label}：进行中 ${t.ongoing_total} ｜ 新增 ${t.new_today} ｜ 未完成 ${t.unfinished_total} ｜ 新增未完成 ${t.new_today_unfinished} ｜ 完成 ${t.finished_today}`);
    }
  }
  return L.join('\n');
}

// ---- main ----
await mkdir(join(__dirname, "data"), { recursive: true });
const stats = await runStats({ date });
await writeFile(join(__dirname, "data", `stats-${date}.json`), JSON.stringify(stats, null, 2));
log(`统计完成: 全量 ${stats.workorderTotal} 单, 快照已存 data/stats-${date}.json`);

// 模式: self=只发本人(默认) / owners=按负责人群发
const sendTo = config.notify?.sendTo || "self";
if (sendTo === "self") {
  const selfId = config.notify?.selfFeishuId || config.notify?.fallbackFeishuId || "";
  const digest = buildSelfDigest(stats);
  let result = null;
  if (!selfId && !dryRun) { result = { ok: false, detail: "未配置 notify.selfFeishuId(接收人 open_id)" }; log("错误: " + result.detail); }
  else if (dryRun) { result = { ok: true, dryRun: true, message: digest }; log(`[dry-run] 发本人:\n${digest}`); }
  else if (feishuOn) { result = await sendFeishu(selfId, digest); log(`日报已发本人(${selfId.slice(0, 12)}…): ${result.ok ? "成功" : "失败 " + result.detail}`); }
  await writeFile(join(__dirname, "data", `push-log-${date}.json`), JSON.stringify({ mode: "self", recipient: selfId, result, totals: stats.totals }, null, 2));
  console.log(JSON.stringify({ ok: !!result?.ok, date, mode: "self", recipient: selfId, totals: stats.totals, result }, null, 2));
  process.exit(result?.ok ? 0 : 1);
}

const projectOwners = config.projectOwners || {};
const groups = new Map(); // key: email|feishu|name -> {owner, byProject: Map<项目名, items[]>}
for (const proj of stats.projects || []) {
  const ownersOfProj = projectOwners[String(proj.id)] || {};
  for (const tag of proj.tags) {
    const o = ownersOfProj[tag.value];
    if (!o || o.enabled === false || !o.name) continue;
    const key = o.email || o.feishuId || o.name;
    if (!groups.has(key)) groups.set(key, { owner: o, byProject: new Map() });
    const g = groups.get(key);
    if (!g.byProject.has(proj.name)) g.byProject.set(proj.name, []);
    g.byProject.get(proj.name).push({ tag: { ...tag, statsTotal: stats.workorderTotal } });
  }
}

if (!groups.size) {
  log("未配置任何技能标签负责人, 跳过推送。请先在配置前端设置负责人。");
  console.log(JSON.stringify({ ok: true, date, pushed: 0, reason: "no-owners", totals: stats.totals }));
  process.exit(0);
}

const results = [];
for (const { owner, byProject } of groups.values()) {
  const projItems = [...byProject.entries()].map(([project, items]) => ({ project, items }));
  const grand = projItems.reduce((acc, p) => {
    for (const { tag } of p.items) for (const k of KEYS) acc[k] += tag[k];
    return acc;
  }, { ongoing_total: 0, new_today: 0, unfinished_total: 0, new_today_unfinished: 0, finished_today: 0 });
  const msg = buildMessage(owner.name, projItems, grand);
  const allTags = projItems.flatMap((p) => p.items.map((i) => i.tag.label));
  const subject = `【工单日报 ${date}】${[...new Set(allTags)].slice(0, 3).join("/")}${allTags.length > 3 ? " 等" : ""}`;
  const rec = { owner: owner.name, email: owner.email || null, scope: projItems.map((p) => ({ project: p.project, tags: p.items.map((i) => i.tag.label) })) };
  if (dryRun) {
    rec.dryRun = true;
    rec.message = msg;
    log(`[dry-run] ${owner.name}:\n${msg}\n----`);
  } else {
    if (emailOn && owner.email) {
      try { rec.emailResult = await sendEmail(owner.email, subject, msg); }
      catch (e) { rec.emailResult = { ok: false, detail: String(e).slice(0, 150) }; }
      await new Promise((r) => setTimeout(r, 7000)); // agently-cli 限速 10 次/分钟
    }
    if (feishuOn) {
      const openId = await resolveFeishuOpenId(owner);
      if (openId) {
        try { rec.feishuResult = await sendFeishu(openId, msg); rec.feishuTo = openId; }
        catch (e) { rec.feishuResult = { ok: false, detail: String(e).slice(0, 150) }; }
      } else rec.feishuResult = { ok: false, detail: "无法解析 open_id" };
    }
  }
  results.push(rec);
}

// 兜底: 有负责人完全发不出去时, 把完整汇总发给回退接收人(默认张宸熙), 保证日报不丢失
const fallbackId = config.notify?.fallbackFeishuId || "";
const unreachable = results.filter((r) => !r.dryRun && !((r.feishuResult || {}).ok) && !((r.emailResult || {}).ok));
let fallbackResult = null;
if (!dryRun && feishuOn && fallbackId && unreachable.length) {
  try {
    const digest = buildFallbackDigest(stats, unreachable);
    fallbackResult = await sendFeishu(fallbackId, digest);
    log(`兜底汇总已发回退人(${fallbackId.slice(0, 12)}…): ${fallbackResult.ok ? "成功" : "失败 " + fallbackResult.detail}`);
  } catch (e) { fallbackResult = { ok: false, detail: String(e.message || e).slice(0, 120) }; log("兜底发送异常: " + fallbackResult.detail); }
}

await writeFile(join(__dirname, "data", `push-log-${date}.json`), JSON.stringify({ results, fallback: fallbackResult }, null, 2));
const failed = results.filter((r) => !r.dryRun && ((r.emailResult && !r.emailResult.ok) || (r.feishuResult && !r.feishuResult.ok)));
console.log(JSON.stringify({ ok: !failed.length, date, pushed: results.length, failed: failed.length, fallback: fallbackResult, results }, null, 2));
process.exit(failed.length ? 1 : 0);
