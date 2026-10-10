// 每日工单可视化分析报告(HTML) - 仅金鹰世界商场+写字楼，按技能标签分类、落实到负责人
// 用法: node ge_report_html.mjs [--date=YYYY-MM-DD] [--project=18,19]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStats, todayCN, yesterdayCN } from "./ge_stats.mjs";
import { runAnalysis } from "./ge_ai_analysis.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(__dirname, "config.json"), "utf8"));
const args = process.argv.slice(2);
const getArg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const date = getArg("date") || yesterdayCN(); // 晨报=昨日
const asOf = date; // 累计指标截止昨日(createTime<=昨日), 排除今日新增
const projectFilter = (getArg("project") || (config.report?.projectIds || []).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
// 报告可配置项(标题/平台名/项目匹配), 未配置则取全部项目
const REPORT_TITLE = config.report?.title || "金鹰工单分析晨报";
const PLATFORM_NAME = config.report?.platformName || "金鹰智慧物业运营平台";
const CONFIG_PORT = process.env.PORT || "8790";
const nameRe = config.report?.projectNameRegex ? new RegExp(config.report.projectNameRegex) : null;
const matchProject = (p) => (!projectFilter.length && !nameRe) || projectFilter.includes(String(p.id)) || (nameRe && nameRe.test(p.name));

// 联系人部门反查
let contacts = {};
try {
  const fc = JSON.parse(await readFile(join(__dirname, "feishu_contacts.json"), "utf8"));
  for (const c of fc.contacts || []) contacts[c.openId] = c;
} catch {}

const log = (...a) => console.error("[report-html]", ...a);

function ownerOf(pid, tagValue) {
  const po = config.projectOwners || {};
  const o = (po[String(pid)] || {})[tagValue];
  if (!o || !o.name) return null;
  const dept = o.feishuId && contacts[o.feishuId]?.dept;
  return { name: o.name, openId: o.feishuId || "", dept: dept || "", enabled: o.enabled !== false };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 数据驱动的建议生成
function buildSuggestions(want, ownerOfFn) {
  const today = [], improve = [];
  const ownerTags = new Map(); // name -> {tags:[], backlog:0, projects:Set}
  let noOwnerBacklog = 0;
  for (const proj of want) {
    let projFinished = 0, projNew = 0;
    for (const t of proj.tags) {
      if (t.all_total === 0) continue;
      projFinished += t.finished_today; projNew += t.new_today;
      const o = ownerOfFn(proj.id, t.value);
      if (o) {
        if (!ownerTags.has(o.name)) ownerTags.set(o.name, { name: o.name, backlog: 0, tags: [], projects: new Set() });
        const rec = ownerTags.get(o.name);
        rec.backlog += t.unfinished_total; rec.projects.add(proj.name);
        if (t.unfinished_total > 0) rec.tags.push({ label: t.label, unfinished: t.unfinished_total, newUnfin: t.new_today_unfinished, finished: t.finished_today });
      } else if (t.ongoing_total > 0) noOwnerBacklog += t.ongoing_total;
      if (t.new_today_unfinished > 0) today.push(`「${t.label}」（${proj.name}）昨日新增未完成 <b>${t.new_today_unfinished}</b> 单，建议${o ? ` <b>${esc(o.name)}</b>` : "负责人"}今日跟进处置。`);
      else if (t.ongoing_total >= 10 && t.finished_today === 0) today.push(`「${t.label}」（${proj.name}）积压 ${t.ongoing_total} 单且昨日零完成，建议${o ? ` <b>${esc(o.name)}</b>` : "负责人"}优先清理。`);
    }
    if (projNew > 0 && projFinished === 0) improve.push(`<b>${esc(proj.name)}</b> 昨日新增 ${projNew} 单、完成 0 单，建议排查处置链路是否畅通。`);
  }
  // 负责人负荷
  for (const r of ownerTags.values()) {
    const top = r.tags.filter((x) => x.unfinished >= 5).sort((a, b) => b.unfinished - a.unfinished).slice(0, 2);
    if (r.backlog >= 20 || r.tags.length >= 5) improve.push(`<b>${esc(r.name)}</b> 负责 ${r.tags.length} 个标签、累计未完成 ${r.backlog} 单${top.length ? `（重点：${top.map((x) => `${esc(x.label)} ${x.unfinished}`).join("、")}）` : ""}，建议评估是否增援或拆分职责。`);
  }
  if (noOwnerBacklog > 0) improve.push(`仍有 <b>${noOwnerBacklog}</b> 单进行中工单所属技能标签<b>未配置负责人</b>，建议尽快在配置前端补齐。`);
  // 写字楼覆盖
  const office = want.find((p) => /写字楼/.test(p.name));
  if (office) {
    const hasOwner = office.tags.some((t) => ownerOfFn(office.id, t.value)?.name);
    if (!hasOwner) improve.push(`<b>${esc(office.name)}</b> 尚未配置任何负责人，建议参照商场配置补齐，否则该项目的日报无法落实到人。`);
  }
  // 净增趋势
  const grandNew = want.reduce((s, p) => s + p.totals.new_today, 0);
  const grandFin = want.reduce((s, p) => s + p.totals.finished_today, 0);
  const net = grandNew - grandFin;
  if (net > 5) improve.push(`昨日新增 ${grandNew} 单 vs 完成 ${grandFin} 单，净增 <b>${net}</b> 单，积压呈上升趋势，建议关注处置产能。`);
  return { today: today.slice(0, 8), improve: improve.slice(0, 6) };
}

function suggestionsHTML(s) {
  const card = (title, items, cls) => items.length ? `<div class="sug ${cls}"><div class="sug-h">${title}</div><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : "";
  return (s.today.length || s.improve.length) ? `<div class="suggestions">${card("今日建议", s.today, "today")}${card("改进建议", s.improve, "improve")}</div>` : "";
}

function efficiencyHTML(analysis) {
  const e = analysis?.efficiency;
  if (!e) return "";
  const cards = [];
  if (e.completionRate !== null) {
    const cls = e.completionRate >= 70 ? "down" : e.completionRate >= 40 ? "neutral" : "up";
    cards.push(`<div class="eff-card ${cls}"><div class="v">${e.completionRate}%</div><div class="k">完成率</div></div>`);
  }
  const netCls = e.netGrowth > 0 ? "up" : e.netGrowth < 0 ? "down" : "neutral";
  cards.push(`<div class="eff-card ${netCls}"><div class="v">${e.netGrowth > 0 ? "+" : ""}${e.netGrowth}</div><div class="k">净增</div></div>`);
  if (e.cumulativeRate !== null) cards.push(`<div class="eff-card neutral"><div class="v">${e.cumulativeRate}%</div><div class="k">累计完成率</div></div>`);
  if (e.newCompletionRate !== null) {
    const cls = e.newCompletionRate >= 60 ? "down" : "up";
    cards.push(`<div class="eff-card ${cls}"><div class="v">${e.newCompletionRate}%</div><div class="k">即时完成率</div></div>`);
  }
  return cards.length ? `<div class="efficiency">${cards.join("")}</div>` : "";
}

function trendHTML(analysis) {
  const h = analysis?.history || [];
  if (h.length < 2) return "";
  const arrow = (dir, diff) => diff === 0 ? `<span class="dir flat">→</span>` : `<span class="dir ${dir}">${dir === "up" ? "↑" : "↓"}${Math.abs(diff)}</span>`;
  const rows = h.map((d, i) => {
    const p = i > 0 ? h[i - 1] : null;
    const oDiff = p ? d.ongoing - p.ongoing : 0;
    const nDiff = p ? d.newToday - p.newToday : 0;
    const fDiff = p ? d.finished - p.finished : 0;
    const net = d.newToday - d.finished;
    return `<tr><td>${d.date}</td><td>${d.ongoing}${p ? arrow(oDiff > 0 ? "up" : oDiff < 0 ? "down" : "flat", oDiff) : ""}</td><td>${d.newToday}${p ? arrow(nDiff > 0 ? "up" : nDiff < 0 ? "down" : "flat", nDiff) : ""}</td><td>${d.finished}${p ? arrow(fDiff > 0 ? "up" : fDiff < 0 ? "down" : "flat", fDiff) : ""}</td><td>${net > 0 ? "+" : ""}${net}</td></tr>`;
  }).join("");
  return `<div class="trend-section"><h3>趋势分析（近${h.length}日）</h3><table class="trend-table"><thead><tr><th>日期</th><th>进行中</th><th>新增</th><th>完成</th><th>净增</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function aiInsightsHTML(analysis, suggestions) {
  const ai = analysis?.ai;
  if (!ai) return suggestionsHTML(suggestions);
  let html = '<div class="ai-section">';
  if (ai.overall) html += `<div class="ai-overall">${esc(ai.overall)}</div>`;
  html += '<div class="ai-grid">';
  const levelLabel = (l) => l === "high" ? "高" : l === "medium" ? "中" : "低";
  const priorityLabel = (p) => p === "high" ? "紧急" : p === "medium" ? "重要" : "一般";
  if (ai.risks?.length) {
    html += '<div class="ai-card risks"><h4>风险预警</h4>';
    for (const r of ai.risks) {
      const lvl = r.level || "medium";
      html += `<div class="ai-item"><span class="level level-${lvl}">${levelLabel(lvl)}</span><span class="ai-title">${esc(r.title)}</span><div class="ai-detail">${esc(r.detail)}</div></div>`;
    }
    html += "</div>";
  }
  if (ai.insights?.length) {
    html += '<div class="ai-card insights-card"><h4>数据洞察</h4>';
    for (const ins of ai.insights) {
      html += `<div class="ai-item"><span class="ai-title">${esc(ins.title)}</span><div class="ai-detail">${esc(ins.detail)}</div></div>`;
    }
    html += "</div>";
  }
  if (ai.recommendations?.length) {
    html += '<div class="ai-card recommendations"><h4>处置建议</h4>';
    for (const rec of ai.recommendations) {
      const pri = rec.priority || "medium";
      html += `<div class="ai-item"><span class="level level-${pri}">${priorityLabel(pri)}</span><span class="ai-title">${esc(rec.title)}</span><div class="ai-detail">${esc(rec.detail)}</div></div>`;
    }
    html += "</div>";
  }
  html += "</div></div>";
  return html;
}

function hot(v, kind) {
  if (kind === "ongoing") return v >= 10 ? "hot" : v >= 3 ? "warm" : "";
  if (kind === "new" && v > 0) return "warm";
  if (kind === "finish" && v > 0) return "good";
  return "";
}

const KPI_ICONS = { ongoing: "⏳", new: "📥", unfinished: "📋", newUnfin: "⚠️", finished: "✅" };
function kpiCard(k, v, cls) {
  return `<div class="kpi ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
}

function render(stats, analysis) {
  const want = (stats.projects || []).filter(matchProject);
  const suggestions = buildSuggestions(want, ownerOf);
  const allOwners = []; // 负责人汇总(跨项目)
  const ownerIdx = new Map();
  const acc = (name, tag, m, pname) => {
    if (!ownerIdx.has(name)) { ownerIdx.set(name, { name, tags: [], proj: new Set() }); allOwners.push(ownerIdx.get(name)); }
    const o = ownerIdx.get(name);
    o.tags.push({ label: tag.label, project: pname, ...m });
    o.proj.add(pname);
    ["ongoing_total", "new_today", "unfinished_total", "new_today_unfinished", "finished_today", "all_total"].forEach((k) => { o[k] = (o[k] || 0) + m[k]; });
  };

  const grand = { ongoing_total: 0, new_today: 0, unfinished_total: 0, new_today_unfinished: 0, finished_today: 0, all_total: 0, finished_total: 0, voided_total: 0 };
  const projectHTML = want.map((proj) => {
    Object.keys(grand).forEach((k) => { grand[k] += proj.totals[k]; });
    const rows = proj.tags.filter((t) => t.all_total > 0)
      .map((t) => {
        const o = ownerOf(proj.id, t.value);
        if (o) acc(o.name, t, t, proj.name);
        const ownerCell = o
          ? `<span class="owner">${esc(o.name)}</span>${o.dept ? `<span class="dept">${esc(o.dept.replace(/^物业集团-项目公司-/, ""))}</span>` : ""}`
          : `<span class="no-owner">未配置</span>`;
        return `<tr>
          <td class="tag">${esc(t.label)}<span class="tagcode">${esc(t.value)}</span></td>
          <td>${esc(t.categoryLabel)}</td>
          <td>${ownerCell}</td>
          <td class="num ${hot(t.ongoing_total, "ongoing")}">${t.ongoing_total}</td>
          <td class="num ${hot(t.new_today, "new")}">${t.new_today}</td>
          <td class="num">${t.unfinished_total}</td>
          <td class="num ${hot(t.new_today_unfinished, "new")}">${t.new_today_unfinished}</td>
          <td class="num ${hot(t.finished_today, "finish")}">${t.finished_today}</td>
          <td class="num">${t.finished_total}</td>
          <td class="num mut">${t.voided_total}</td>
        </tr>`;
      }).join("");
    return `<section class="proj">
      <h2>${esc(proj.name)} <span class="muted">截至昨日共 ${proj.totals.all_total} 单</span></h2>
      <div class="kpis">${kpiCard("进行中(截至昨日)", proj.totals.ongoing_total, hot(proj.totals.ongoing_total, "ongoing"), KPI_ICONS.ongoing)}${kpiCard("昨日新增", proj.totals.new_today, "", KPI_ICONS.new)}${kpiCard("未完成(截至昨日)", proj.totals.unfinished_total, "", KPI_ICONS.unfinished)}${kpiCard("昨日新增未完成", proj.totals.new_today_unfinished, "warm", KPI_ICONS.newUnfin)}${kpiCard("昨日完成", proj.totals.finished_today, "good", KPI_ICONS.finished)}</div>
      <div class="tbl-wrap"><table><thead><tr><th>技能标签</th><th>分类</th><th>负责人</th><th class="num">进行中</th><th class="num">昨日新增</th><th class="num">未完成</th><th class="num">昨日新增未完成</th><th class="num">昨日完成</th><th class="num">累计完成</th><th class="num">作废</th></tr></thead><tbody>${rows || `<tr><td colspan="10" class="empty">该项目暂无工单</td></tr>`}</tbody></table></div>
    </section>`;
  }).join("");

  const ownerRows = allOwners.sort((a, b) => b.ongoing_total - a.ongoing_total).map((o) => {
    return `<tr>
      <td class="owner">${esc(o.name)}<span class="dept-mini">${o.proj.size}项目 / ${o.tags.length}标签</span></td>
      <td class="num ${hot(o.ongoing_total, "ongoing")}">${o.ongoing_total}</td>
      <td class="num ${hot(o.new_today, "new")}">${o.new_today}</td>
      <td class="num">${o.unfinished_total}</td>
      <td class="num ${hot(o.new_today_unfinished, "new")}">${o.new_today_unfinished}</td>
      <td class="num ${hot(o.finished_today, "finish")}">${o.finished_today}</td>
      <td class="num mut">${o.all_total}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>昨日工单分析晨报 · ${date}</title>
<style>
  :root{--brand:#1456f0;--brand-hover:#2563eb;--brand-bg:#eff6ff;--ink:#222222;--dark:#18181b;--charcoal:#181e25;--text-sec:#45515e;--text-mut:#8e8e93;--bg:#ffffff;--bg-sec:#f0f0f0;--border:#e5e7eb;--border-light:#f2f3f5;--hot:#dc2626;--warm:#d97706;--good:#059669;--shadow-card:rgba(0,0,0,.08) 0 4px 6px;--shadow-elevated:rgba(36,36,36,.08) 0 12px 16px -4px}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 "DM Sans","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
  .topbar{background:var(--bg);border-bottom:1px solid var(--border);padding:0 24px;position:sticky;top:0;z-index:10}
  .topbar-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:56px}
  .back-link{display:inline-flex;align-items:center;gap:6px;color:var(--text-sec);text-decoration:none;font-size:14px;font-weight:500;padding:8px 18px;border-radius:9999px;background:rgba(0,0,0,.05);transition:background .15s,color .15s}
  .back-link:hover{background:rgba(0,0,0,.08);color:var(--dark)}
  .export-btn{display:inline-flex;align-items:center;gap:6px;background:var(--charcoal);color:#fff;border:none;padding:8px 22px;border-radius:9999px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;transition:opacity .15s;text-decoration:none}
  .export-btn:hover{opacity:.85}
  .title-section{max-width:1200px;margin:0 auto;padding:32px 24px 0}
  .title-section h1{margin:0;font-size:24px;font-weight:600;color:var(--ink);line-height:1.5}
  .title-section .subtitle{margin-top:4px;font-size:14px;color:var(--text-sec);line-height:1.5}
  .title-section .meta{margin-top:12px;font-size:13px;color:var(--text-mut);display:flex;gap:24px;flex-wrap:wrap}
  .title-section .meta span{white-space:nowrap}
  .kpis{max-width:1200px;margin:24px auto 0;padding:0 24px;display:flex;gap:16px;flex-wrap:wrap}
  .kpi{flex:1;min-width:160px;background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:20px 24px;box-shadow:var(--shadow-card)}
  .kpi .v{font-size:28px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--ink)}
  .kpi .k{font-size:13px;color:var(--text-mut);margin-top:6px;font-weight:500}
  .kpi.hot .v{color:var(--hot)} .kpi.warm .v{color:var(--warm)} .kpi.good .v{color:var(--good)}
  main{max-width:1200px;margin:0 auto;padding:24px 24px 48px}
  section.proj{background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:24px;margin:16px 0;box-shadow:var(--shadow-card)}
  section.proj h2{margin:0 0 4px;font-size:18px;font-weight:600;color:var(--ink);line-height:1.5}
  .muted{color:var(--text-mut);font-weight:400;font-size:13px}
  section.proj .kpis{margin:16px 0 4px;padding:0;max-width:none}
  section.proj .kpi{box-shadow:none;border-radius:12px;padding:16px 20px}
  .tbl-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;margin-top:16px}
  table{width:100%;border-collapse:collapse;min-width:880px}
  th,td{padding:10px 16px;text-align:left;border-bottom:1px solid var(--border-light)}
  th{font-size:13px;color:var(--text-mut);font-weight:500;background:#fafbfc;border-bottom:1px solid var(--border);white-space:nowrap}
  tbody tr:nth-child(even){background:#fafbfc}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:var(--brand-bg)}
  th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.num{font-weight:600;color:var(--ink)}
  td.num.hot{color:var(--hot)} td.num.warm{color:var(--warm)} td.num.good{color:var(--good)} td.mut{color:var(--text-mut);font-weight:400}
  .tag{font-weight:600}
  .tagcode{display:block;font-size:11px;color:var(--text-mut);font-family:Consolas,"Courier New",monospace;margin-top:2px}
  .owner{display:inline-block;background:var(--brand-bg);color:#1e40af;border-radius:9999px;padding:3px 12px;font-size:13px;font-weight:600}
  .dept{display:block;font-size:12px;color:var(--text-mut);margin-top:4px}
  .dept-mini{display:block;font-size:12px;color:var(--text-mut);font-weight:400}
  .no-owner{display:inline-block;background:#fef2f2;color:var(--hot);border-radius:9999px;padding:3px 12px;font-size:13px;font-weight:600}
  .empty{text-align:center;color:var(--text-mut);padding:32px}
  .suggestions{max-width:1200px;margin:20px auto 0;padding:0 24px;display:flex;gap:16px;flex-wrap:wrap}
  .sug{flex:1;min-width:340px;background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:20px 24px;box-shadow:var(--shadow-card)}
  .sug.today{border-left:3px solid var(--brand)} .sug.improve{border-left:3px solid var(--warm)}
  .sug-h{font-size:16px;font-weight:600;margin-bottom:12px;color:var(--ink)}
  .sug ul{margin:0;padding:0;list-style:none}
  .sug li{position:relative;margin:8px 0;padding-left:16px;font-size:14px;line-height:1.7;color:var(--text-sec)}
  .sug li::before{content:"";position:absolute;left:0;top:10px;width:5px;height:5px;border-radius:50%;background:var(--text-mut)}
  .sug li b{color:var(--hot)}
  h1.sec{margin:32px 0 8px;font-size:18px;font-weight:600;color:var(--ink)}
  footer{max-width:1200px;margin:16px auto 0;padding:0 24px 48px}
  footer .foot-card{background:var(--charcoal);border-radius:12px;padding:20px 24px;color:rgba(255,255,255,.7);font-size:13px;line-height:1.8}
  footer .foot-card a{color:rgba(255,255,255,.9)}
  .efficiency{max-width:1200px;margin:16px auto 0;padding:0 24px;display:flex;gap:12px;flex-wrap:wrap}
  .eff-card{flex:1;min-width:140px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:14px 18px}
  .eff-card .v{font-size:22px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--ink)}
  .eff-card .k{font-size:12px;color:var(--text-mut);margin-top:4px}
  .eff-card.up .v{color:var(--hot)} .eff-card.down .v{color:var(--good)} .eff-card.neutral .v{color:var(--text-sec)}
  .trend-section{max-width:1200px;margin:16px auto 0;padding:0 24px}
  .trend-section h3{font-size:16px;font-weight:600;color:var(--ink);margin:0 0 8px}
  .trend-table{width:100%;border-collapse:collapse;border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .trend-table th,.trend-table td{padding:8px 14px;text-align:right;border-bottom:1px solid var(--border-light);font-variant-numeric:tabular-nums;font-size:13px}
  .trend-table th{font-size:12px;color:var(--text-mut);font-weight:500;background:#fafbfc}
  .trend-table th:first-child,.trend-table td:first-child{text-align:left}
  .trend-table tr:last-child td{border-bottom:none}
  .dir{font-size:12px;font-weight:600;margin-left:4px}
  .dir.up{color:var(--hot)} .dir.down{color:var(--good)} .dir.flat{color:var(--text-mut)}
  .ai-section{max-width:1200px;margin:20px auto 0;padding:0 24px}
  .ai-overall{background:var(--brand-bg);border:1px solid #dbeafe;border-radius:12px;padding:16px 20px;font-size:15px;font-weight:500;color:#1e3a5f;line-height:1.6;margin-bottom:16px}
  .ai-grid{display:flex;gap:16px;flex-wrap:wrap}
  .ai-card{flex:1;min-width:320px;background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:20px 24px;box-shadow:var(--shadow-card)}
  .ai-card h4{margin:0 0 12px;font-size:16px;font-weight:600;color:var(--ink)}
  .ai-card.risks{border-left:3px solid var(--hot)}
  .ai-card.insights-card{border-left:3px solid var(--brand)}
  .ai-card.recommendations{border-left:3px solid var(--warm)}
  .ai-item{margin:10px 0;padding:10px 14px;background:#fafbfc;border-radius:8px;font-size:14px;line-height:1.6;color:var(--text-sec)}
  .ai-item .ai-title{font-weight:600;color:var(--ink);margin-bottom:2px}
  .level{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;margin-right:8px;vertical-align:middle}
  .level-high{background:#fef2f2;color:var(--hot)} .level-medium{background:#fff7ed;color:var(--warm)} .level-low{background:#f0fdf4;color:var(--good)}
  @media (max-width:768px){
    .topbar{padding:0 16px}
    .title-section,.kpis,.efficiency,.trend-section,.ai-section,.suggestions,main,footer{padding-left:16px;padding-right:16px}
    .kpi{min-width:calc(50% - 8px)}
    section.proj{padding:16px}
    .title-section .meta{flex-direction:column;gap:4px}
  }
  @media print{
    @page{size:A4;margin:12mm}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{background:#fff;font-size:12px}
    .topbar{display:none}
    .title-section{padding-top:0}
    .kpi,.eff-card,.ai-card,.sug{break-inside:avoid;page-break-inside:avoid;box-shadow:none}
    section.proj{box-shadow:none}
    .tbl-wrap{overflow:visible;border:none}
    table{width:100%;min-width:0;table-layout:fixed}
    thead{display:table-header-group}
    tr{break-inside:avoid;page-break-inside:avoid}
    th,td{white-space:normal;word-break:break-word;padding:6px 8px}
    h1.sec{break-after:avoid;page-break-after:avoid}
    footer .foot-card{background:#fff;color:var(--text-mut);border:1px solid var(--border)}
  }

</style></head><body>
<div class="topbar"><div class="topbar-inner">
  <a class="back-link" href="/">返回配置页</a>
  <a class="export-btn" href="/api/report/pdf" download>导出 PDF</a>
</div></div>
<div class="title-section">
  <h1>${REPORT_TITLE}</h1>
  <div class="subtitle">昨日数据，按技能标签分类，落实到负责人</div>
  <div class="meta">
    <span>报告日期 ${date}（昨日）</span>
    <span>覆盖：${want.map((p) => p.name).join(" / ") || "全部项目"}</span>
    <span>生成于 ${new Date().toLocaleString("zh-CN")}</span>
  </div>
</div>
<div class="kpis">${kpiCard("进行中(截至昨日)", grand.ongoing_total, hot(grand.ongoing_total, "ongoing"), KPI_ICONS.ongoing)}${kpiCard("昨日新增", grand.new_today, "", KPI_ICONS.new)}${kpiCard("未完成(截至昨日)", grand.unfinished_total, "", KPI_ICONS.unfinished)}${kpiCard("昨日新增未完成", grand.new_today_unfinished, "warm", KPI_ICONS.newUnfin)}${kpiCard("昨日完成", grand.finished_today, "good", KPI_ICONS.finished)}</div>
${efficiencyHTML(analysis)}${trendHTML(analysis)}${aiInsightsHTML(analysis, suggestions)}
<main>${projectHTML}
<h1 class="sec">负责人汇总（跨项目，按进行中排序）</h1>
<section class="proj"><div class="tbl-wrap"><table><thead><tr><th>负责人</th><th class="num">进行中</th><th class="num">昨日新增</th><th class="num">未完成</th><th class="num">昨日新增未完成</th><th class="num">昨日完成</th><th class="num">总单数</th></tr></thead><tbody>${ownerRows || `<tr><td colspan="7" class="empty">暂无已配置负责人</td></tr>`}</tbody></table></div></section>
</main>
<footer><div class="foot-card">数据来源：${PLATFORM_NAME}-任务报表（接口 ${config.apiPrefix || "/prod-api"}/task/request/list?searchType=10，全量 ${stats.workorderTotal} 单，已筛至目标项目）。<br>口径（昨日晨报）：进行中/未完成/累计完成/总单数均按 createTime≤昨日 截止；昨日新增 = createTime 为昨日；昨日新增未完成 = 昨日创建且当前状态仍为进行中；昨日完成 = taskStatus=2(归档) 且 finishTime 为昨日；作废(4) 不计入未完成/完成。<br>提示：未配置负责人的标签请在 http://127.0.0.1:${CONFIG_PORT} 配置后次日生效。</div></footer>
</body></html>`;
}

const stats = await runStats({ date, asOf });
const want = (stats.projects || []).filter(matchProject);
log(`统计完成 全量 ${stats.workorderTotal} 单, 命中项目 ${want.map((p) => p.name).join(" / ") || "(无)"}`);
const analysis = await runAnalysis(stats, want, ownerOf);
await mkdir(join(__dirname, "data"), { recursive: true });
const html = render(stats, analysis);
await writeFile(join(__dirname, "data", `report-${date}.html`), html, "utf8");
await writeFile(join(__dirname, "data", "report-latest.html"), html, "utf8");
const configuredOwners = new Set();
for (const p of want) for (const t of p.tags) { const o = ownerOf(p.id, t.value); if (o) configuredOwners.add(o.name); }
console.log(JSON.stringify({ ok: true, date, file: `data/report-${date}.html`, projects: want.map((p) => ({ id: p.id, name: p.name, total: p.totals.all_total, ongoing: p.totals.ongoing_total, newToday: p.totals.new_today, finishedToday: p.totals.finished_today })), owners: [...configuredOwners] }));
