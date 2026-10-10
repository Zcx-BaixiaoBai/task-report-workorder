// 技能标签负责人配置前端 - 本地服务 (仅监听 127.0.0.1)
// 启动: node ge_server.mjs  → 打开 http://127.0.0.1:8787
import { createServer } from "node:http";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { fetchDicts, fetchUsers, fetchProjects, runStats, todayCN } from "./ge_stats.mjs";

const runCmd = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "config.json");
const PORT = parseInt(process.env.PORT || "8787");
const HOST = process.env.HOST || "127.0.0.1";

async function readConfig() { return JSON.parse(await readFile(configPath, "utf8")); }
async function writeConfig(c) { await writeFile(configPath, JSON.stringify(c, null, 2) + "\n"); }

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return send(res, 200, await readFile(join(__dirname, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && p === "/api/tags") {
      const cfg = await readConfig();
      let tags, users, projects, source = "live";
      try {
        [tags, users, projects] = await Promise.all([fetchDicts(), fetchUsers(), fetchProjects()]);
      } catch (e) {
        source = "cache: " + String(e.message || e).slice(0, 80);
        const d = JSON.parse(await readFile(join(__dirname, "dict_subcategory.json"), "utf8"));
        tags = (d.data || []).map((x) => {
          const catKey = String(x.dictValue).split("_")[0];
          return { value: x.dictValue, label: x.dictLabel, category: catKey, categoryLabel: catKey };
        });
        users = [];
        try {
          const pj = JSON.parse(await readFile(join(__dirname, "projects.json"), "utf8"));
          projects = (pj.data || []).map((x) => ({ id: x.projectId, name: x.projectName }));
        } catch { projects = []; }
      }
      return send(res, 200, { ok: true, source, tags, users, projects, projectOwners: cfg.projectOwners || {} });
    }
    if (req.method === "POST" && p === "/api/owners") {
      const body = JSON.parse(await readBody(req));
      const projectOwners = body.projectOwners;
      if (!projectOwners || typeof projectOwners !== "object" || Array.isArray(projectOwners)) return send(res, 400, { ok: false, error: "projectOwners 必须是对象" });
      let count = 0;
      for (const [pid, tagMap] of Object.entries(projectOwners)) {
        if (!tagMap || typeof tagMap !== "object" || Array.isArray(tagMap)) return send(res, 400, { ok: false, error: `项目 ${pid} 配置非法` });
        for (const [k, v] of Object.entries(tagMap)) {
          if (v && typeof v !== "object") return send(res, 400, { ok: false, error: `非法配置项: ${pid}/${k}` });
          if (v?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return send(res, 400, { ok: false, error: `邮箱格式错误: ${v.email}` });
          if (v?.name) count++;
        }
      }
      const cfg = await readConfig();
      cfg.projectOwners = projectOwners;
      await writeConfig(cfg);
      return send(res, 200, { ok: true, saved: count });
    }
    if (req.method === "POST" && p === "/api/stats/run") {
      const body = await readBody(req).catch(() => "{}");
      const date = (() => { try { return JSON.parse(body || "{}").date; } catch { return null; } })() || todayCN();
      const stats = await runStats({ date });
      await writeFile(join(__dirname, "data", `stats-${date}.json`), JSON.stringify(stats, null, 2)).catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(__dirname, "data"), { recursive: true });
        await writeFile(join(__dirname, "data", `stats-${date}.json`), JSON.stringify(stats, null, 2));
      });
      return send(res, 200, { ok: true, stats });
    }
    if (req.method === "GET" && (p === "/report/today" || p === "/report/today.html")) {
      try { return send(res, 200, await readFile(join(__dirname, "data", "report-latest.html"), "utf8"), "text/html; charset=utf-8"); }
      catch { return send(res, 200, "<p>暂无晨报，请先点「生成昨日晨报」。</p>", "text/html; charset=utf-8"); }
    }
    if (req.method === "GET" && p.startsWith("/report/")) {
      const d = p.replace("/report/", "").replace(/\.html$/, "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 404, { ok: false, error: "非法日期" });
      try { return send(res, 200, await readFile(join(__dirname, "data", `report-${d}.html`), "utf8"), "text/html; charset=utf-8"); }
      catch { return send(res, 404, { ok: false, error: "该日期无报告" }); }
    }
    if (req.method === "GET" && p === "/api/report/pdf") {
      const tmpFile = join(tmpdir(), `ge-report-${Date.now()}.pdf`);
      const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      try {
        const reportFile = join(__dirname, "data", "report-latest.html");
        const fileUrl = "file:///" + reportFile.replace(/\\/g, "/").replace(/^\/+/, "");
        await runCmd(chromePath, [
          "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
          `--print-to-pdf=${tmpFile}`,
          fileUrl
        ], { timeout: 60000, windowsHide: true });
        const pdf = await readFile(tmpFile);
        const fname = encodeURIComponent("工单分析晨报.pdf");
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
          "Content-Length": pdf.length,
        });
        res.end(pdf);
      } catch (e) {
        send(res, 500, { ok: false, error: "PDF 生成失败: " + String(e.message || e).slice(0, 200) });
      } finally {
        await unlink(tmpFile).catch(() => {});
      }
      return;
    }
    if (req.method === "POST" && p === "/api/report/run") {
      try {
        const { stdout } = await runCmd(process.execPath, ["ge_report_html.mjs"], { cwd: __dirname, timeout: 300000 });
        const summary = JSON.parse(stdout.trim().split("\n").pop());
        return send(res, 200, { ok: true, summary });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e.message || e).slice(0, 300) });
      }
    }
    if (req.method === "GET" && p === "/api/feishu/contacts") {
      try {
        const fc = JSON.parse(await readFile(join(__dirname, "feishu_contacts.json"), "utf8"));
        return send(res, 200, { ok: true, syncedAt: fc.syncedAt, contacts: fc.contacts || [] });
      } catch {
        return send(res, 200, { ok: true, syncedAt: null, contacts: [] });
      }
    }
    if (req.method === "POST" && p === "/api/feishu/sync") {
      try {
        const { stdout } = await runCmd(process.execPath, ["ge_feishu_sync.mjs"], { cwd: __dirname, timeout: 300000 });
        const summary = JSON.parse(stdout.trim().split("\n").pop());
        const fc = JSON.parse(await readFile(join(__dirname, "feishu_contacts.json"), "utf8"));
        return send(res, 200, { ok: true, summary, syncedAt: fc.syncedAt, contacts: fc.contacts || [] });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    if (req.method === "GET" && p === "/api/stats/latest") {
      const dir = join(__dirname, "data");
      const files = (await readdir(dir).catch(() => [])).filter((f) => /^stats-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      if (!files.length) return send(res, 200, { ok: true, stats: null });
      return send(res, 200, { ok: true, file: files.at(-1), stats: JSON.parse(await readFile(join(dir, files.at(-1)), "utf8")) });
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    send(res, 500, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`配置前端已启动: http://${HOST}:${PORT}`);
});
