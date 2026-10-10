# task-report-workorder · 工单日报智能体（ZCode Skill）

针对**金鹰智慧物业运营平台**（任务/工单系统）的每日工单统计与推送智能体。

自动登录（算术验证码 OCR）→ 拉全量工单 → 按 **项目 × 技能标签** 聚合五指标 → 飞书/邮件推送 + HTML 可视化晨报。

> 系统是固定的一套（接口/地址/状态枚举已适配好）。使用者只需：**填自己的账号密码、填自己的飞书接收人、选择要统计的项目**。

## 功能

- **自动登录**：算术验证码（如 `3+5=?`）视觉识别 + 本地计算 + 失败重试；token 过期自动重登。
- **统计**：按项目×技能标签聚合：进行中累计 / 今日新增 / 未完成累计 / 今日新增未完成 / 今日完成。
- **推送**：飞书私信（机器人或个人身份）+ 邮件；`只发本人` 或 `按负责人群发` 两种模式。
- **HTML 晨报**：KPI 卡 + 项目/标签明细 + 负责人落实 + 建议，可选 AI 洞察与 PDF 导出。
- **配置前端**：本地网页维护"项目→技能标签→负责人"。

## 快速开始

```bash
cp config.example.json config.json     # 生成真实配置(勿提交)
# 编辑 config.json: username / password(或用环境变量 TRW_PASSWORD) / notify.selfFeishuId / report.projectIds
lark-cli auth login && agently-cli auth login   # 首次授权
node ge_report.mjs --dry-run           # 预览
node ge_report.mjs                     # 推送
node ge_server.mjs                     # 配置前端 http://127.0.0.1:8790
node ge_report_html.mjs                # 昨日 HTML 晨报
```

依赖：Node ≥ 18、lark-cli、agently-cli、mmx（验证码 OCR）。详见 [SKILL.md](./SKILL.md)。

## 定时

- 日报（今日数据）：每天 18:00 `node ge_report.mjs`
- 晨报（昨日 HTML）：每天 08:00 `node ge_report_html.mjs`

## 注意

- 完成判定只认 `taskStatus==2`（归档）；`finishTime` 实为更新时间，不能单独判完成。
- 飞书机器人受"应用可用范围"限制；默认 `sendTo=self` 只发本人不受限。
- 密码不要写进提交；用环境变量或本地 `config.json`（已 gitignore）。
