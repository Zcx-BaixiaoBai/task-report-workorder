// 金鹰智慧物业运营平台 自动登录模块
// 流程: GET /prod-api/code 取算术验证码 -> mmx vision 识别算式 -> 本地计算答案 -> POST /prod-api/auth/login
// 用法: node ge_login.mjs  (成功后 token 写入 config.tokenFile, stdout 输出 JSON)
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(__dirname, "config.json"), "utf8"));
// 凭据可用环境变量覆盖(TRW_USERNAME/TRW_PASSWORD/TRW_BASE_URL), 便于不写入明文配置或 CI 场景
if (process.env.TRW_USERNAME) config.username = process.env.TRW_USERNAME;
if (process.env.TRW_PASSWORD) config.password = process.env.TRW_PASSWORD;
if (process.env.TRW_BASE_URL) config.baseUrl = process.env.TRW_BASE_URL;

// --- SSRF 防护: 仅允许 http/https, 拒绝环回/私有/保留地址 ---
function assertSafeUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`仅允许 http/https 协议: ${raw}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|127\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)
    || host === "::1" || host.toLowerCase().startsWith("fe80:") || host.toLowerCase().startsWith("fc") || host.toLowerCase().startsWith("fd")) {
    throw new Error(`拒绝访问环回/私有/保留地址: ${host}`);
  }
  return u;
}
const base = assertSafeUrl(config.baseUrl);
const resolved = await lookup(base.hostname);
assertSafeUrl(`${base.protocol}//${resolved.address}`);

const api = (p) => `${config.baseUrl}${config.apiPrefix}${p}`;
const ocrPrompt = "这是算术验证码图片,形如 3+5=? 或 2*4=? ,由数字和 + - * = ? 符号组成。请仔细读出图中算式,输出算式和计算结果。";
// 验证码识别后端: 优先普适多模态(OpenAI 兼容视觉)API, 可用 config.ocr 或环境变量配置; 未配 key 时回退 mmx CLI
const ocrCfg = config.ocr || {};
const OCR_API_BASE = String(process.env.OCR_API_BASE || ocrCfg.apiBase || "").replace(/\/+$/, "");
const OCR_API_KEY = process.env.OCR_API_KEY || ocrCfg.apiKey || "";
const OCR_MODEL = process.env.OCR_MODEL || ocrCfg.model || "";

function solveAnswer(text) {
  const m = text.match(/(\d+)\s*([+\-*×xX])\s*(\d+)/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[3], 10);
    const op = m[2];
    if (op === "+") return String(a + b);
    if (op === "-") return String(a - b);
    return String(a * b);
  }
  const m2 = text.match(/(?:答案|结果)[是为：:\s]*\**\s*(-?\d+)/);
  if (m2) return m2[1];
  const nums = text.match(/-?\d+/g);
  if (nums && nums.length === 1) return nums[0];
  return null;
}

// 普适多模态 API(OpenAI 兼容 /chat/completions + image_url), 适配 OpenAI/MiniMax/Kimi/Qwen/DeepSeek 等
async function ocrViaApi(imgB64) {
  const base = OCR_API_BASE || "https://api.openai.com/v1";
  const model = OCR_MODEL || "gpt-4o-mini";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OCR_API_KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 120,
      messages: [{ role: "user", content: [
        { type: "text", text: ocrPrompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imgB64}` } },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`OCR API ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || "");
}

async function ocrViaMmx(imgPath) {
  const { stdout } = await run("mmx", ["vision", "describe", "--image", imgPath, "--prompt", ocrPrompt], { shell: true, timeout: 45000 });
  return String(JSON.parse(stdout).content || "");
}

async function ocrCaptcha(imgPath) {
  if (OCR_API_KEY) {
    if (!globalThis.__ocrBackend) { globalThis.__ocrBackend = 1; console.error(`[login] OCR 后端: 多模态API ${OCR_API_BASE || "(默认openai)"} / ${OCR_MODEL || "(默认)"}`); }
    return ocrViaApi((await readFile(imgPath)).toString("base64"));
  }
  if (!globalThis.__ocrBackend) { globalThis.__ocrBackend = 1; console.error("[login] OCR 后端: mmx CLI(未配 OCR_API_KEY, 建议配置普适多模态API)"); }
  return ocrViaMmx(imgPath);
}

export async function login({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.error("[login]", ...a); };
  const max = config.maxLoginAttempts || 6;
  const imgPath = resolve(__dirname, ".captcha_attempt.jpg");
  for (let attempt = 1; attempt <= max; attempt++) {
    const capRes = await fetch(api("/code"));
    const cap = await capRes.json();
    if (cap.captchaEnabled === false) {
      const r = await (await fetch(api("/auth/login"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: config.username, password: config.password })
      })).json();
      if (r.token || r.access_token || (r.data && (r.data.access_token || r.data.token))) return finish(r, attempt, log);
      log(`第${attempt}次(无验证码)失败: ${JSON.stringify(r).slice(0, 150)}`);
      continue;
    }
    await writeFile(imgPath, Buffer.from(String(cap.img).replace(/^data:image\/\w+;base64,/, ""), "base64"));
    let answer = null, ocrText = "";
    try {
      ocrText = await ocrCaptcha(imgPath);
      answer = solveAnswer(ocrText);
    } catch (e) {
      log(`第${attempt}次OCR异常: ${String(e).slice(0, 120)}`);
      continue;
    }
    if (answer === null) { log(`第${attempt}次无法解析算式: ${ocrText.slice(0, 100)}`); continue; }
    log(`第${attempt}次: 算式识别="${ocrText.replace(/\s+/g, " ").slice(0, 60)}" -> code=${answer}`);
    const r = await (await fetch(api("/auth/login"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: config.username, password: config.password, code: answer, uuid: cap.uuid })
    })).json();
    if (r.token || r.access_token || (r.data && (r.data.access_token || r.data.token))) return finish(r, attempt, log);
    log(`第${attempt}次登录失败: ${JSON.stringify(r).slice(0, 150)}`);
  }
  throw new Error(`自动登录失败: ${max} 次尝试均未成功`);
}

async function finish(r, attempt, log) {
  const token = r.token || r.access_token || (r.data && (r.data.access_token || r.data.token));
  const expiresIn = r.expires_in || (r.data && r.data.expires_in) || null;
  const payload = { token, expires_in: expiresIn, attempt, ts: Date.now() };
  await writeFile(resolve(__dirname, config.tokenFile || ".ge_token.json"), JSON.stringify(payload, null, 2));
  log(`登录成功(第${attempt}次), token 已保存`);
  return payload;
}

// 获取可用 token: 缓存未过期(留30分钟余量)直接复用, 否则重新自动登录
export async function getToken() {
  try {
    const cached = JSON.parse(await readFile(resolve(__dirname, config.tokenFile || ".ge_token.json"), "utf8"));
    const ttlMin = Number(cached.expires_in) > 0 ? Number(cached.expires_in) : 720; // 分钟
    if (cached.token && Date.now() - cached.ts < (ttlMin - 30) * 60 * 1000) return cached.token;
  } catch {}
  const t = await login({ quiet: true });
  return t.token;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const t = await login();
    console.log(JSON.stringify({ ok: true, token: t.token.slice(0, 20) + "...", expires_in: t.expires_in, attempt: t.attempt }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
}
