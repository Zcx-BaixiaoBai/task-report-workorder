---
name: task-report-workorder
description: 金鹰智慧物业运营平台（任务/工单系统）的每日工单统计与推送智能体。自动登录(算术验证码 OCR)、拉全量工单、按项目×技能标签聚合五指标(进行中/今日新增/未完成/今日新增未完成/今日完成)、生成飞书日报(可只发本人或群发负责人)与 HTML 可视化晨报。当用户要给这套工单系统做"每日工单统计+推送"时使用。
---

# 工单日报智能体 (task-report-workorder)

针对**金鹰智慧物业运营平台**这一套固定的任务/工单系统，把它变成一个每天自动统计并推送的日报智能体。

> 系统是固定的（接口、地址、状态枚举都已适配好，无需改代码）。**使用者只需要三件事**：填自己的账号密码、填自己的飞书接收人 open_id、选择要统计哪些项目。

## 它能做什么

1. **自动登录**：取算术验证码（如 `3+5=?`）→ 视觉模型识别算式 → 本地计算答案 → 提交登录；失败自动重试，token 过期自动重登。
2. **拉全量工单**：分页拉取工单，按 **项目 × 技能标签(业务子类)** 聚合五个指标：进行中累计 / 今日新增 / 未完成累计 / 今日新增未完成 / 今日完成。
3. **推送**：飞书私信（机器人或个人身份）+ 邮件双通道；支持"只发本人"或"按负责人群发"。
4. **HTML 晨报**：美观的可视化分析报告（KPI 卡 + 按项目/标签明细 + 负责人落实 + 建议），可选 AI 洞察与 PDF 导出。
5. **配置前端**：本地网页，选项目、维护"项目→技能标签→负责人"映射。

## 前置条件

- **Node.js ≥ 18**。
- **lark-cli**（飞书 CLI）、**agently-cli**（邮件）——各自 `auth login` 一次。
- **验证码识别（多模态视觉）**：推荐配置任意 **OpenAI 兼容视觉 API**（见下"验证码 OCR 配置"）；未配置时自动回退 `mmx` CLI（MiniMax）。
- 使用者需有该工单系统的账号，以及一个能收飞书私信的飞书账号。

### 验证码 OCR 配置（普适多模态 API）

登录的算术验证码靠视觉模型识别。默认走**任意 OpenAI 兼容的 `/chat/completions` 视觉接口**（OpenAI gpt-4o / MiniMax-VL / Kimi / Qwen-VL / DeepSeek-VL 等皆可），用 `config.json` 的 `ocr` 段或环境变量配置：

| 配置项 | 环境变量 | 说明 |
|---|---|---|
| `ocr.apiBase` | `OCR_API_BASE` | 如 `https://api.openai.com/v1`、`https://api.minimax.chat/v1` |
| `ocr.apiKey` | `OCR_API_KEY` | 你的视觉模型 API key |
| `ocr.model` | `OCR_MODEL` | 视觉模型名，如 `gpt-4o-mini`、`MiniMax-VL-01` |

未配 `apiKey` 时回退 `mmx vision describe`（需已装 mmx CLI）。建议配 API 以彻底脱离 mmx 依赖。

**为什么不用免费的百度飞桨 PaddleOCR 识验证码（已实测）**：本系统的验证码是"带干扰线/彩色扭曲的算术式"（如 `3+5=?`），飞桨不适合：
- `PaddleOCR-VL-1.6`（视觉布局解析）对验证码只返回图片嵌入 `<img …>`，不出文字；
- `PP-OCRv5`（通用文字 OCR）实测 4 个样本识别为乱码：`=LD`、`2=0*6`、`γ*4≈?`、`M`（置信度约 0.5），无法解析成算式。
飞桨擅长**干净的文档/票据文字**（表格、扫描件），不擅长噪声验证码。算术验证码需要"读出算式并理解语义"的多模态视觉模型，故本 skill 用 OpenAI 兼容视觉 API（mmx 兜底）。若你的目标系统验证码是清晰纯文本，可另接飞桨。

**实测推荐后端**：阿里云百炼/MaaS 的 OpenAI 兼容端点 + **`qwen3.8-flash`**（视觉）——识别算术验证码 **3/3 首次即成功**（`9-4=?→5`、`6*4=?→24`、`7-6=?→1`），且比 max 更便宜更快，为首选；`qwen3.8-max` 同样首次即成功（`8*2=?→16`、`5*0=?→0`）可作备选。两者都明显优于 mmx（常需 2-3 次重试）。配置示例：
```json
"ocr": { "apiBase": "https://<你的ws-xxx>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "apiKey": "<你的key>", "model": "qwen3.8-flash" }
```
注：同一 key 下 `qwen3.8-27b` 返回 403（无该模型权限）。若你的 key 无 qwen 视觉权限，换任意 OpenAI 兼容视觉模型（gpt-4o / MiniMax-VL / Kimi / Qwen-VL）即可。

## 安装与配置

```bash
# 1) 生成真实配置(勿提交, 已在 .gitignore)
cp config.example.json config.json
# 2) 只需改这几项(config.json):
#    username            你的工单系统账号
#    password            你的密码(或留空, 改用环境变量 TRW_PASSWORD)
#    notify.selfFeishuId 你的飞书 open_id
#    report.projectIds   你要统计的项目ID(见下"选项目")
# 3) 首次授权各 CLI:
lark-cli auth login && agently-cli auth login
```

`baseUrl`、`apiPrefix`、接口路径、状态枚举都已按金鹰系统配好，**一般不用动**。密码支持环境变量 `TRW_USERNAME`/`TRW_PASSWORD`/`TRW_BASE_URL` 覆盖（便于不写进文件或 CI）。

### 选项目（使用者自己选）

系统里有多个项目（如 南京金鹰世界-商业、写字楼、大物业…）。用哪种方式选都行：
- **配置前端**（推荐）：`node ge_server.mjs` 打开 http://127.0.0.1:8790，顶部"项目"下拉切换，给每个项目的技能标签配负责人；日报/晨报会覆盖你配置过的项目。
- **config.json**：`report.projectIds` 填项目 ID 数组（如 `["18","19"]`）或 `report.projectNameRegex`（如 `"南京金鹰世界"`）来限定晨报范围；留空则统计全部项目。
- 项目 ID 怎么查：配置前端下拉里就是，或 `curl` 系统 `GET /prod-api/system/sysproject/listAll`。

## 用法

```bash
node ge_report.mjs                 # 每日日报推送(按 config.notify.sendTo: self/owners)
node ge_report.mjs --dry-run       # 只看将发送的内容, 不实际发送
node ge_report.mjs --date=YYYY-MM-DD
node ge_report.mjs --no-email      # 只飞书 / --no-feishu 只邮件

node ge_server.mjs                 # 配置前端 → http://127.0.0.1:8790 (PORT 可改)
node ge_report_html.mjs            # 生成昨日 HTML 晨报 → data/report-latest.html
node ge_feishu_directory.mjs       # 拉飞书全量通讯录(需应用通讯录权限范围已放开)
```

令牌缓存在 `.ge_token.json`；每日快照/日志在 `data/`。

## 定时

用 cron / 计划任务 / ZCode 定时任务：日报（今日数据）建议 18:00 跑 `node ge_report.mjs`；晨报（昨日 HTML）建议 08:00 跑 `node ge_report_html.mjs`。

## 实现要点（改代码前务必读）

- **完成判定**：只认 `taskStatus==2`(归档)。系统里工单的 `finishTime` 实为"更新时间"（进行中工单也有值），**不能单看时间字段判完成**——"今日完成" = `taskStatus==2` 且 finishTime 落在当天。作废(4) 不计入未完成/完成。枚举见 `ge_stats.mjs` 的 `accumulate()`。
- **全量查询**：工单列表默认只返回未完成单，必须带 `searchType=10` 才含已完成/归档（已内置）。
- **跨平台发送**：Windows 的 cmd.exe 会在第一个换行处截断多行命令行参数——本 skill 在 Windows 用 `node` 直跑 lark-cli 的 `run.js`、非 Windows 直接 `execFile("lark-cli",…,{shell:false})` 规避。改脚本别退回 `shell:true` 直传多行正文。
- **飞书可用范围**：机器人只能给"应用可用范围"内的用户发私信（否则报 230013 `Bot has NO availability`）。负责人收不到时：去飞书开放平台把应用可用范围改"全部成员"并发布，或授权 `im:message.send_as_user` 用个人身份发。默认 `sendTo=self` 只发你本人，不受此限。
- **SSRF 防护**：`ge_login.mjs` 校验 baseUrl 仅 http/https 且非环回/私有/保留地址。

## 文件清单

| 文件 | 作用 |
|---|---|
| `ge_login.mjs` | 自动登录(验证码 OCR + 重试)，导出 `login()/getToken()` |
| `ge_stats.mjs` | 拉全量工单 + 字典 + 项目，按项目×标签聚合，导出 `runStats()` |
| `ge_report.mjs` | 日报推送主脚本(self/owners 两模式 + 兜底) |
| `ge_report_html.mjs` | 昨日 HTML 晨报生成器 |
| `ge_server.mjs` | 本地配置前端服务(仅监听 127.0.0.1) |
| `ge_feishu_directory.mjs` | 飞书全量通讯录枚举 |
| `ge_feishu_sync.mjs` | 飞书联系人(会话成员)同步 |
| `public/index.html` | 配置前端页面 |
| `config.example.json` | 配置模板(无密钥) |
