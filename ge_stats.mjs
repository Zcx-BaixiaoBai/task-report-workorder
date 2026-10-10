// 工单统计模块: 拉取全量工单 + 字典, 按技能标签(业务子类)聚合指标
// 口径 v1 (待用户细化):
//   进行中累计   = taskStatus=="1"
//   未完成累计   = taskStatus=="1"  (当前数据下与进行中相同; 作废"4"不计入)
//   今日新增     = createTime 为当天 (任意状态)
//   今日新增未完成 = createTime 为当天 且 taskStatus=="1"
//   今日完成     = taskStatus=="2"(归档) 且 finishTime 为当天
import { getToken } from "./ge_login.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(__dirname, "config.json"), "utf8"));
const API = `${config.baseUrl}${config.apiPrefix}`;

export function todayCN(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }); // YYYY-MM-DD
}
// 昨日(亚洲/上海时区)
export function yesterdayCN(d = new Date()) {
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  return todayCN(y);
}

async function apiGet(path, params = {}, retryAuth = true) {
  const token = await getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (j.code === 401 && retryAuth) {
    // token 失效: 删缓存重登再试一次
    const { login } = await import("./ge_login.mjs");
    await login({ quiet: true });
    return apiGet(path, params, false);
  }
  if (j.code !== undefined && j.code !== 200) throw new Error(`接口 ${path} 返回异常: ${JSON.stringify(j).slice(0, 150)}`);
  return j;
}

export async function fetchAllWorkorders() {
  const rows = [];
  let pageNum = 1;
  const pageSize = 500;
  for (;;) {
    const j = await apiGet("/task/request/list", { pageNum, pageSize, searchType: 10 });
    rows.push(...(j.rows || []));
    if (rows.length >= (j.total ?? 0) || !(j.rows || []).length) break;
    pageNum++;
    if (pageNum > 200) throw new Error("分页超过 200 页, 疑似死循环");
  }
  return rows;
}

export async function fetchDicts() {
  const sub = await apiGet("/system/dict/data/type/business_subcategory");
  let cat = [];
  try { cat = (await apiGet("/system/dict/data/type/business_category")).data || []; } catch {}
  const catFallback = {
    aispbj: "AI视频巡更", wxbs: "维修报事", wxbsnb: "维修报事(内部)",
    sbbj: "设备报警", zhgl: "综合管理", ks: "客服",
  };
  const catMap = {};
  for (const c of cat) catMap[c.dictValue] = c.dictLabel;
  const tags = (sub.data || []).map((d) => {
    const catKey = String(d.dictValue).split("_")[0];
    return { value: d.dictValue, label: d.dictLabel, category: catKey, categoryLabel: catMap[catKey] || catFallback[catKey] || catKey };
  });
  // 去重: 同 dictValue 可能出现两次(如 aispbj_08)
  const seen = new Set();
  return tags.filter((t) => (seen.has(t.value) ? false : seen.add(t.value)));
}

export async function fetchProjects() {
  try {
    const j = await apiGet("/system/sysproject/listAll");
    return (j.data || j.rows || []).map((p) => ({ id: p.projectId, name: p.projectName }));
  } catch { return []; }
}

export async function fetchUsers() {
  try {
    const j = await apiGet("/system/user/select");
    return (j.data || j.rows || []).map((u) => ({ value: u.value, text: u.text }));
  } catch { return []; }
}

export async function runStats({ date = todayCN(), asOf = null } = {}) {
  const [rows, tags, projects] = await Promise.all([fetchAllWorkorders(), fetchDicts(), fetchProjects()]);
  const tagMap = new Map(tags.map((t) => [t.value, t]));
  const projMap = new Map(projects.map((p) => [p.id, p.name]));
  const blank = () => ({ ongoing_total: 0, new_today: 0, unfinished_total: 0, new_today_unfinished: 0, finished_today: 0, finished_total: 0, voided_total: 0, all_total: 0 });
  const accumulate = (m, r, created, finished) => {
    // asOf 截止: created 晚于 asOf 的工单不计入任何累计/当日指标(晨报取昨日快照)
    if (asOf && created > asOf) return;
    m.all_total++;
    if (r.taskStatus === "1") { m.ongoing_total++; m.unfinished_total++; }
    if (r.taskStatus === "2") m.finished_total++;
    if (r.taskStatus === "4") m.voided_total++;
    if (created === date) {
      m.new_today++;
      if (r.taskStatus === "1") m.new_today_unfinished++;
    }
    if (r.taskStatus === "2" && finished === date) m.finished_today++;
  };
  const byTag = new Map();                                    // 全局: tagValue -> metrics
  const byProj = new Map();                                   // projectId -> {name, totals, byTag: Map}
  for (const r of rows) {
    const key = r.busSubcategory || "_unknown";
    const created = String(r.createTime || "").slice(0, 10);
    const finished = String(r.finishTime || "").slice(0, 10);
    if (!byTag.has(key)) byTag.set(key, blank());
    accumulate(byTag.get(key), r, created, finished);
    const pid = r.taskCompany ?? "_noproject";
    if (!byProj.has(pid)) byProj.set(pid, { id: pid, name: r.taskCompanyName || projMap.get(pid) || String(pid), totals: blank(), byTag: new Map() });
    const pj = byProj.get(pid);
    accumulate(pj.totals, r, created, finished);
    if (!pj.byTag.has(key)) pj.byTag.set(key, blank());
    accumulate(pj.byTag.get(key), r, created, finished);
  }
  const decorate = (value, m) => {
    const t = tagMap.get(value);
    return {
      value,
      label: t ? t.label : (value === "_unknown" ? "未分类" : value),
      category: t ? t.category : "_other",
      categoryLabel: t ? t.categoryLabel : "其他",
      ...m,
    };
  };
  const sortTags = (arr) => arr.sort((a, b) => b.ongoing_total - a.ongoing_total || b.all_total - a.all_total);
  const tagStats = sortTags([...byTag.entries()].map(([v, m]) => decorate(v, m)));
  const projectStats = [...byProj.values()]
    .map((p) => ({ id: p.id, name: p.name, totals: p.totals, tags: sortTags([...p.byTag.entries()].map(([v, m]) => decorate(v, m))) }))
    .sort((a, b) => b.totals.all_total - a.totals.all_total);
  const totals = blank();
  for (const t of tagStats) for (const k of Object.keys(totals)) totals[k] += t[k];
  return { date, generatedAt: new Date().toISOString(), workorderTotal: rows.length, totals, tags: tagStats, projects: projectStats };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const s = await runStats();
  console.log(JSON.stringify(s, null, 2));
}
