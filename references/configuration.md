# Configuration

Load this reference when you need to create or edit a custom report config for `weekly-web-report`.

The public repository ships with a mock built-in config and one mock example file only.

Use a custom config via:

- `--config /path/to/report-config.json`
- or env: `WEEKLY_WEB_REPORT_CONFIG=/path/to/report-config.json`

## Top-Level Shape

```json
{
  "replaceBuiltin": true,
  "timezone": "Asia/Shanghai",
  "browserPathEnv": "WEEKLY_REPORT_BROWSER_PATH",
  "defaultBrowserPath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "defaultTimeoutMs": 45000,
  "missingValueText": "未抓取到",
  "systems": {},
  "pages": {},
  "collectOrder": [],
  "output": {
    "titleTemplate": "Weekly report ({weekRange.label})",
    "lines": []
  }
}
```

## Systems

Each system defines login and session reuse rules.

Required fields:

- `adapter`
- `dashboardUrl`
- `usernameEnv`
- `passwordEnv`

## Public Adapter

### `generic-form`

Use for a normal username/password login page.

Required:

- `loginUrl`
- `loggedOutUrlIncludes`
- `loginSelectors.username`
- `loginSelectors.password`

Recommended:

- `loginSelectors.submitText`
- `presetTextEnv`

Example:

```json
{
  "systems": {
    "demo": {
      "adapter": "generic-form",
      "dashboardUrl": "https://dashboard.example.com/overview",
      "loginUrl": "https://dashboard.example.com/login",
      "usernameEnv": "REPORT_USERNAME",
      "passwordEnv": "REPORT_PASSWORD",
      "loggedOutUrlIncludes": ["/login"],
      "loginSelectors": {
        "username": "input[name=email]",
        "password": "input[name=password]",
        "submitText": "Sign in"
      }
    }
  }
}
```

If your real login flow is more specialized, fork the skill privately and extend the script there instead of putting private system details into the public repo.

## Pages

Each page entry defines:

- `system`
- `url`
- `collector`

Optional:

- `contextLabel`
- `applyPreset`
- `postLoadDelayMs`
- `dateRangeSelectors`

If `dateRangeSelectors.startInput` and `dateRangeSelectors.endInput` are provided, the script will try a start/end date picker flow before falling back to visible preset text.

## Collectors

### `labelMetrics`

Extract values by finding nearby text around one or more labels.

Required:

- `metrics`: array of `{ key, label, type }`

Optional per metric:

- `aliases`

`type` supports:

- `count`
- `rate`

### `dimensionSingleValue`

For pages where the same metric can be toggled by dimension, such as count vs users.

Required:

- `dimensions`: array of `{ toggle, key, label }`

### `groupedOrderSummary`

For table pages where rows need to be grouped by a source value and related labels should be collected.

Required:

- `groups`: array of
  - `sourceName`
  - `countKey`
  - `skuKey`
  - optional `label`

Optional:

- `dimension`

Assumptions:

- first column = source name
- second column = label or SKU
- last column = numeric value

### `dimensionLabelMap`

For table pages where rows are named metrics and both count and user dimensions need to be read.

Required:

- `countDimension`
- `userDimension`
- `labels`: array of
  - `sourceLabel`
  - `countKey`
  - `userKey`

## Output Templates

`output.titleTemplate` and `output.lines[].template` support placeholders:

- `{weekRange.label}`
- `{metrics.demo.orders}`

Supported filters:

- `|or:fallback text`
- `|join:、`

Example:

```json
{
  "output": {
    "titleTemplate": "Weekly report ({weekRange.label})",
    "lines": [
      { "template": "Orders: {metrics.demo.orders|or:n/a}" },
      { "template": "Segments: {metrics.demo.segmentNames|join:、|or:none}" }
    ]
  }
}
```

## Validation

Validate a config before using it:

```bash
node scripts/weekly-web-report.mjs validate-config --config ./report-config.json
```
