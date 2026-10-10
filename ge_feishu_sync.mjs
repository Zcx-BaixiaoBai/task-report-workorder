// 飞书联系人同步: 枚举当前用户的全部会话(群聊+单聊)成员, 汇总成联系人库
// 权限说明: 应用仅有 contact:user:search(可见范围=本部门), 无法全租户枚举通讯录;
//           im:chat.members:read 可枚举自己所在会话的成员, 这是当前授权下的最大可达集合。
// 用法: node ge_feishu_sync.mjs  → 写 feishu_contacts.json, stdout 输出 JSON 摘要
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "feishu_contacts.json");

function extractJson(stdout) {
  const i = stdout.indexOf("{");
  if (i < 0) throw new Error("输出中无 JSON: " + stdout.slice(0, 120));
  return JSON.parse(stdout.slice(i));
}

async function lark(args, timeout = 60000) {
  const { stdout } = await run("lark-cli", [...args, "--as", "user", "--format", "json"], { shell: true, timeout });
  return extractJson(stdout);
}

const log = (...a) => console.error("[feishu-sync]", ...a);

const chatList = await lark(["im", "+chat-list", "--types", "p2p,group", "--page-all"]);
const chats = chatList.data?.items || chatList.data?.chats || [];
log(`会话数: ${chats.length}`);

const byOpenId = new Map();
let prev = {};
try {
  const old = JSON.parse(await readFile(OUT, "utf8"));
  for (const c of old.contacts || []) byOpenId.set(c.openId, c);
  prev = { syncedAt: old.syncedAt, count: (old.contacts || []).length };
} catch {}

for (const c of chats) {
  const chatName = c.name || "(单聊)";
  try {
    const m = await lark(["im", "+chat-members-list", "--chat-id", c.chat_id, "--page-all"], 90000);
    const users = m.data?.users || [];
    for (const u of users) {
      if (!u.member_id || !u.member_id.startsWith("ou_")) continue;
      const exist = byOpenId.get(u.member_id);
      if (exist) {
        if (!exist.sources.includes(chatName)) exist.sources.push(chatName);
        if (u.name) exist.name = u.name;
      } else {
        byOpenId.set(u.member_id, { name: u.name || "", openId: u.member_id, dept: "", sources: [chatName] });
      }
    }
    log(`  ${chatName}: +${users.length} 人`);
  } catch (e) {
    log(`  ${chatName}: 成员获取失败 ${String(e.message || e).slice(0, 80)}`);
  }
}

// 尽力补充部门信息(按 open_id 批量反查, 可见范围外会失败, 忽略)
const needDept = [...byOpenId.values()].filter((c) => !c.dept);
for (let i = 0; i < needDept.length; i += 20) {
  const batch = needDept.slice(i, i + 20);
  try {
    const r = await lark(["contact", "+search-user", "--user-ids", batch.map((b) => b.openId).join(",")]);
    for (const u of r.data?.users || []) {
      const hit = byOpenId.get(u.open_id);
      if (hit) { hit.dept = u.department || ""; if (u.localized_name) hit.name = u.localized_name; }
    }
  } catch {}
}

const contacts = [...byOpenId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
await writeFile(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), count: contacts.length, contacts }, null, 2));
log(`完成: 共 ${contacts.length} 人 (上次 ${prev.count ?? 0} 人)`);
console.log(JSON.stringify({ ok: true, count: contacts.length, withDept: contacts.filter((c) => c.dept).length, prev: prev.count ?? 0 }));
