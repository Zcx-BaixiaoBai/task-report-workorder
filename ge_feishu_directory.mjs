// 飞书全量通讯录枚举(需应用通讯录权限范围已扩大): 从根部门递归拉取部门树+成员
// 用法: MSYS_NO_PATHCONV=1 node ge_feishu_directory.mjs  → 合并写入 feishu_contacts.json
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "feishu_contacts.json");
const tmpDir = await mkdtemp(join(tmpdir(), "feishu-"));
const log = (...a) => console.error("[feishu-dir]", ...a);

async function api(method, path, params) {
  const args = ["api", method, path, "--as", "bot", "--format", "json"];
  if (params) {
    const f = join(tmpDir, "p.json");
    await writeFile(f, JSON.stringify(params));
    args.push("--params", "@" + f);
  }
  const { stdout } = await run("lark-cli", args, { shell: true, timeout: 60000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  const i = stdout.indexOf("{");
  const j = JSON.parse(stdout.slice(i));
  if (!j.ok) throw new Error(`${path}: ${j.error?.message || JSON.stringify(j).slice(0, 120)}`);
  return j;
}

const byOpenId = new Map();
try {
  const old = JSON.parse(await readFile(OUT, "utf8"));
  for (const c of old.contacts || []) byOpenId.set(c.openId, c);
} catch {}
const before = byOpenId.size;

async function enumDept(deptId, deptPath, depth = 0) {
  if (depth > 12) return;
  // 该部门直属成员
  let token = "";
  let r;
  do {
    r = await api("GET", "/open-apis/contact/v3/users/find_by_department", { department_id: deptId, page_size: 50, user_id_type: "open_id", page_token: token });
    for (const u of r.data?.items || []) {
      if (!u.open_id) continue;
      const exist = byOpenId.get(u.open_id);
      if (exist) { if (deptPath) exist.dept = exist.dept || deptPath; }
      else byOpenId.set(u.open_id, { name: u.name || "", openId: u.open_id, dept: deptPath, sources: ["通讯录"] });
    }
    token = r.data?.page_token || "";
  } while (r.data?.has_more && token);
  // 子部门
  let ctoken = "";
  let cr;
  do {
    cr = await api("GET", `/open-apis/contact/v3/departments/${deptId}/children`, { page_size: 50, page_token: ctoken, user_id_type: "open_id" });
    for (const d of cr.data?.items || []) {
      const cid = d.open_department_id || d.department_id;
      const cname = d.name || "";
      await enumDept(cid, deptPath ? `${deptPath}-${cname}` : cname, depth + 1);
    }
    ctoken = cr.data?.page_token || "";
  } while (cr.data?.has_more && ctoken);
}

await enumDept("0", "");
const contacts = [...byOpenId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
await writeFile(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), count: contacts.length, contacts }, null, 2));
log(`完成: 通讯录共 ${contacts.length} 人 (原有 ${before} 人, 新增 ${contacts.length - before} 人)`);
console.log(JSON.stringify({ ok: true, count: contacts.length, before, added: contacts.length - before }));
