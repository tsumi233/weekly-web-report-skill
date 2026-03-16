---
name: weekly-web-report
description: Collect weekly metrics from password-protected web dashboards with Playwright and output a chat-ready summary. Use when OpenClaw needs to log into browser-only systems, reuse saved sessions, extract configured metrics, and send a concise weekly report.
---

# Weekly Web Report

Use the bundled script:

- `scripts/weekly-web-report.mjs`

## When To Use

- The data source is a web dashboard, not an API
- Login requires username/password
- The report structure repeats weekly
- The user wants a short summary for chat, Feishu, or copy/paste reporting

Typical requests:

- `生成上周周报`
- `拉一下上周各系统数据`
- `汇总成一段可直接发消息的周报`

## Public Version Note

This public repository intentionally contains only:

- a mock built-in config
- one mock example config
- generic instructions

It does **not** include any real business system URLs, field labels, credentials, or internal adapter names.

## Config

Pass a config file with either:

- `--config /path/to/report-config.json`
- or env `WEEKLY_WEB_REPORT_CONFIG=/path/to/report-config.json`

Read [configuration.md](references/configuration.md) when:

- creating a new report config
- changing login selectors
- adding or removing fields
- changing the final output message

Useful example:

- [assets/mock-report.example.json](assets/mock-report.example.json)

## Supported Public Adapter

- `generic-form`

## Supported Collectors

- `labelMetrics`
- `dimensionSingleValue`
- `groupedOrderSummary`
- `dimensionLabelMap`

## Commands

### Validate Config

```bash
node scripts/weekly-web-report.mjs validate-config --config ./report-config.json
```

### Login And Save Session

```bash
node scripts/weekly-web-report.mjs login --system demo --config ./report-config.json
```

Add `--show-browser true` if manual login inspection is needed.

### Inspect A Metric Label

```bash
node scripts/weekly-web-report.mjs inspect --system demo --label 'Orders' --config ./report-config.json
```

Use this only when a metric is missing or obviously wrong.

### Collect Report

```bash
node scripts/weekly-web-report.mjs collect --config ./report-config.json
```

The script prints JSON with:

- `ok`
- `configPath`
- `weekRange`
- `metrics`
- `feishuMessage`
- `notes`

## Agent Rules

- For a clear report request, run `collect` directly.
- `collect` is a long-running browser task. Prefer a single foreground exec with:
  - `yieldMs >= 180000`
  - `timeout >= 600`
- If `ok: true`, reply with the exact `feishuMessage`.
- If `ok: false`, briefly explain which fields were missing using `notes`.
- Do not mention credentials, cookies, or storage files in normal user-facing replies.

## Secrets

Never put passwords into chat history or config files. Use environment variables only.

Example env names:

- `REPORT_USERNAME`
- `REPORT_PASSWORD`

## Storage

Saved sessions live under:

- `~/.openclaw/skills/weekly-web-report/state/`

Do not commit or share that directory.
