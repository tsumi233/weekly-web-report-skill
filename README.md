# Weekly Web Report Skill

一个可共享的 `OpenClaw` skill，用来从**仅支持网页登录的后台系统**抓取周报数据，并输出一段适合聊天发送的汇总文案。

这个公开仓库经过了收口处理：

- 不包含任何真实业务系统 URL
- 不包含任何真实字段名
- 不包含任何真实账号环境变量名
- 只保留一份模拟示例配置

## 能力概览

- 使用 `Playwright` 无头浏览器采集网页数据
- 支持账号密码登录并保存会话
- 支持配置化系统、页面、字段和输出模板
- 适合做“浏览器后台周报抓取”的通用模板

## 当前公开版适配器

- `generic-form`

## 当前公开版采集器

- `labelMetrics`
- `dimensionSingleValue`
- `groupedOrderSummary`
- `dimensionLabelMap`

## 仓库结构

```text
weekly-web-report-skill/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── assets/
│   └── mock-report.example.json
├── references/
│   └── configuration.md
├── scripts/
│   └── weekly-web-report.mjs
└── install.sh
```

## 安装

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/tsumi233/weekly-web-report-skill/main/install.sh | bash
```

### 固定版本安装

```bash
curl -fsSL https://raw.githubusercontent.com/tsumi233/weekly-web-report-skill/main/install.sh | bash -s -- --ref v0.1.0
```

### 本地安装

```bash
./install.sh --from-local .
```

默认安装到：

```text
~/.openclaw/skills/weekly-web-report
```

## 快速开始

### 1. 复制模拟配置

```bash
cp ./assets/mock-report.example.json ./report-config.json
```

### 2. 按你的系统改配置

你需要替换这些内容：

- 登录页 URL
- 目标页面 URL
- 用户名/密码环境变量名
- 登录表单选择器
- 要抓取的字段标签
- 输出模板

详细字段说明见：

- [references/configuration.md](./references/configuration.md)

### 3. 配置账号密码环境变量

不要把密码写进 JSON，也不要提交到 Git 仓库。

示例：

```bash
export REPORT_USERNAME='your-account'
export REPORT_PASSWORD='your-password'
export WEEKLY_WEB_REPORT_CONFIG="$PWD/report-config.json"
```

### 4. 校验配置

```bash
node ./scripts/weekly-web-report.mjs validate-config --config ./report-config.json
```

### 5. 登录并保存会话

```bash
node ./scripts/weekly-web-report.mjs login --system demo --config ./report-config.json --show-browser true
```

### 6. 采集周报

```bash
node ./scripts/weekly-web-report.mjs collect --config ./report-config.json
```

返回 JSON 里最关键的是：

- `ok`
- `metrics`
- `feishuMessage`
- `notes`

## OpenClaw 里怎么用

适合让 agent 直接调用：

```bash
node ~/.openclaw/skills/weekly-web-report/scripts/weekly-web-report.mjs collect --config /path/to/report-config.json
```

建议长任务参数：

- `yieldMs >= 180000`
- `timeout >= 600`

如果返回 `ok: true`，直接把 `feishuMessage` 发给用户即可。

## 注意事项

- 浏览器登录态保存在：

```text
~/.openclaw/skills/weekly-web-report/state/
```

- 不要提交这个目录
- 不要把真实密码写进配置文件
- 公开仓库只保留模拟示例；如果你有更复杂的私有系统，建议在私有 fork 里扩展

## 开发自检

```bash
node --check ./scripts/weekly-web-report.mjs
node ./scripts/weekly-web-report.mjs validate-config
node ./scripts/weekly-web-report.mjs validate-config --config ./assets/mock-report.example.json
```
