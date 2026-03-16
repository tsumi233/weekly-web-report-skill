#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const SKILL_NAME = "weekly-web-report";
const DEFAULT_CONFIG_ENV = "WEEKLY_WEB_REPORT_CONFIG";
const STATE_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "skills",
  SKILL_NAME,
  "state",
);
const BUILTIN_CONFIG = {
  timezone: "Asia/Shanghai",
  browserPathEnv: "WEEKLY_REPORT_BROWSER_PATH",
  defaultBrowserPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  defaultTimeoutMs: 45000,
  missingValueText: "未抓取到",
  systems: {
    demo: {
      adapter: "generic-form",
      dashboardUrl: "https://dashboard.example.com/overview",
      loginUrl: "https://dashboard.example.com/login",
      usernameEnv: "REPORT_USERNAME",
      passwordEnv: "REPORT_PASSWORD",
      presetTextEnv: "REPORT_DATE_PRESET_TEXT",
      loggedOutUrlIncludes: ["/login"],
      loginSelectors: {
        username: "input[name=email]",
        password: "input[name=password]",
        submitText: "Sign in",
      },
    },
  },
  pages: {
    demoOverview: {
      system: "demo",
      url: "https://dashboard.example.com/overview",
      collector: "labelMetrics",
      contextLabel: "demo-overview",
      applyPreset: false,
      metrics: [
        { key: "orders", label: "Orders", type: "count" },
        { key: "conversionRate", label: "Conversion Rate", type: "rate" },
      ],
    },
    demoEngagement: {
      system: "demo",
      url: "https://dashboard.example.com/engagement",
      collector: "dimensionSingleValue",
      contextLabel: "demo-engagement",
      applyPreset: false,
      dimensions: [
        { toggle: "Count", key: "activeCount", label: "Active Count" },
        { toggle: "Users", key: "activeUsers", label: "Active Users" },
      ],
      noteOnMissing: "demo-engagement: Missing count or user metrics.",
    },
  },
  collectOrder: ["demoOverview", "demoEngagement"],
  output: {
    titleTemplate: "Weekly report ({weekRange.label})",
    lines: [
      { template: "Orders: {metrics.demo.orders|or:n/a}" },
      { template: "Conversion rate: {metrics.demo.conversionRate|or:n/a}" },
      { template: "Engagement: count {metrics.demo.activeCount|or:n/a} / users {metrics.demo.activeUsers|or:n/a}" },
    ],
  },
};

let ACTIVE_CONFIG = BUILTIN_CONFIG;
let ACTIVE_CONFIG_PATH = null;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }

    const trimmed = current.slice(2);
    if (trimmed.includes("=")) {
      const [key, ...parts] = trimmed.split("=");
      flags[key] = parts.join("=");
      continue;
    }

    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[trimmed] = "true";
      continue;
    }

    flags[trimmed] = next;
    index += 1;
  }

  return { command, flags, positionals };
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/weekly-web-report.mjs login --system <system-key> [--config ./report-config.json] [--show-browser true|false]",
      "  node scripts/weekly-web-report.mjs inspect --system <system-key> --label <metric-label> [--config ./report-config.json] [--url <page-url>]",
      "  node scripts/weekly-web-report.mjs collect [--config ./report-config.json]",
      "  node scripts/weekly-web-report.mjs validate-config [--config ./report-config.json]",
    ].join("\n"),
  );
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return deepClone(override);
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      merged[key] = deepClone(value);
      continue;
    }
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = deepMerge(base[key], value);
      continue;
    }
    merged[key] = deepClone(value);
  }
  return merged;
}

function configPathFromFlags(flags) {
  return flags.config || process.env[DEFAULT_CONFIG_ENV] || null;
}

async function readJsonFile(filePath) {
  const content = await fsp.readFile(filePath, "utf8");
  return JSON.parse(content);
}

function validateConfig(config) {
  if (!isPlainObject(config)) {
    throw new Error("Config must be a JSON object.");
  }
  if (!isPlainObject(config.systems) || Object.keys(config.systems).length === 0) {
    throw new Error("Config must define at least one system under systems.");
  }
  if (!isPlainObject(config.pages) || Object.keys(config.pages).length === 0) {
    throw new Error("Config must define at least one page under pages.");
  }
  if (!Array.isArray(config.collectOrder) || config.collectOrder.length === 0) {
    throw new Error("Config must define collectOrder as a non-empty array.");
  }

  for (const [systemKey, system] of Object.entries(config.systems)) {
    if (!system.adapter) {
      throw new Error(`System ${systemKey} is missing adapter.`);
    }
    if (!system.dashboardUrl) {
      throw new Error(`System ${systemKey} is missing dashboardUrl.`);
    }
    if (!system.usernameEnv || !system.passwordEnv) {
      throw new Error(`System ${systemKey} must define usernameEnv and passwordEnv.`);
    }
  }

  for (const pageKey of config.collectOrder) {
    const page = config.pages[pageKey];
    if (!page) {
      throw new Error(`collectOrder references unknown page: ${pageKey}`);
    }
    if (!page.system || !config.systems[page.system]) {
      throw new Error(`Page ${pageKey} references unknown system: ${page.system}`);
    }
    if (!page.url || !page.collector) {
      throw new Error(`Page ${pageKey} must define url and collector.`);
    }
  }

  if (!config.output || !Array.isArray(config.output.lines)) {
    throw new Error("Config must define output.lines as an array.");
  }
}

async function loadActiveConfig(flags = {}) {
  const requestedPath = configPathFromFlags(flags);
  let loaded = deepClone(BUILTIN_CONFIG);

  if (requestedPath) {
    const external = await readJsonFile(requestedPath);
    loaded =
      external.replaceBuiltin === true
        ? external
        : deepMerge(loaded, external);
    ACTIVE_CONFIG_PATH = requestedPath;
  } else {
    ACTIVE_CONFIG_PATH = null;
  }

  validateConfig(loaded);
  ACTIVE_CONFIG = loaded;
  return loaded;
}

function asBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function latestOpenClawRuntime() {
  const runtimeRoot = path.join(os.homedir(), ".openclaw", "runtime");
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`OpenClaw runtime not found: ${runtimeRoot}`);
  }

  const runtimes = fs
    .readdirSync(runtimeRoot)
    .filter((entry) => {
      if (!entry.startsWith("openclaw-")) {
        return false;
      }

      const fullPath = path.join(runtimeRoot, entry);
      if (!fs.statSync(fullPath).isDirectory()) {
        return false;
      }

      return fs.existsSync(path.join(fullPath, "package.json"));
    })
    .sort();

  if (runtimes.length === 0) {
    throw new Error(`No OpenClaw runtime found under ${runtimeRoot}`);
  }

  return path.join(runtimeRoot, runtimes[runtimes.length - 1]);
}

function getChromium() {
  const runtimeDir = latestOpenClawRuntime();
  const requireFromRuntime = createRequire(path.join(runtimeDir, "package.json"));
  const { chromium } = requireFromRuntime("playwright-core");
  return chromium;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function statePathFor(system) {
  return path.join(STATE_DIR, `${system}.json`);
}

function systemConfig(system) {
  const config = ACTIVE_CONFIG.systems[system];
  if (!config) {
    throw new Error(`Unsupported system: ${system}`);
  }
  return config;
}

function pageConfig(pageKey) {
  const config = ACTIVE_CONFIG.pages[pageKey];
  if (!config) {
    throw new Error(`Unsupported page: ${pageKey}`);
  }
  return config;
}

function defaultBrowserPath() {
  const envKey = ACTIVE_CONFIG.browserPathEnv || BUILTIN_CONFIG.browserPathEnv;
  return process.env[envKey] || ACTIVE_CONFIG.defaultBrowserPath || BUILTIN_CONFIG.defaultBrowserPath;
}

function defaultTimeoutMs() {
  return Number(process.env.WEEKLY_REPORT_TIMEOUT_MS || ACTIVE_CONFIG.defaultTimeoutMs || 45000);
}

function systemIsLoggedInUrl(system, url) {
  const config = systemConfig(system);
  const patterns = config.loggedOutUrlIncludes || [];
  return !patterns.some((pattern) => url.includes(pattern));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMetricValue(value) {
  return normalizeText(value).replace(/^[：:]/, "").trim();
}

function numericValue(value) {
  const normalized = normalizeMetricValue(value).replace(/,/g, "");
  if (!normalized) {
    return null;
  }

  if (normalized.endsWith("%")) {
    const parsedRate = Number.parseFloat(normalized.slice(0, -1));
    return Number.isFinite(parsedRate) ? parsedRate : null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value) {
  const parsed = numericValue(value);
  if (parsed === null) {
    return null;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(parsed);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looseTextPattern(value) {
  const chars = String(value || "")
    .trim()
    .split("")
    .filter(Boolean)
    .map((char) => escapeRegExp(char));

  if (chars.length === 0) {
    return /.^/;
  }

  return new RegExp(chars.join("\\s*"), "i");
}

function shortDelay(ms = 800) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shanghaiNowBase() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function formatShanghaiDate(date) {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function previousWeekRange() {
  const today = shanghaiNowBase();
  const startOfToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const weekday = startOfToday.getUTCDay() || 7;
  const currentMonday = new Date(startOfToday);
  currentMonday.setUTCDate(currentMonday.getUTCDate() - (weekday - 1));

  const previousMonday = new Date(currentMonday);
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);

  const previousSunday = new Date(currentMonday);
  previousSunday.setUTCDate(previousSunday.getUTCDate() - 1);

  return {
    start: formatShanghaiDate(previousMonday),
    end: formatShanghaiDate(previousSunday),
    label: `${formatShanghaiDate(previousMonday)} 至 ${formatShanghaiDate(previousSunday)}`,
  };
}

async function waitForStablePage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: defaultTimeoutMs() });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    // Some dashboards keep open requests alive; DOM ready is enough for the POC.
  }
}

async function launchContext({ system, headless, storageStatePath }) {
  const chromium = getChromium();
  const launchOptions = {
    headless,
    args: ["--ignore-certificate-errors"],
  };

  const browserPath = defaultBrowserPath();
  if (browserPath && fs.existsSync(browserPath)) {
    launchOptions.executablePath = browserPath;
  }

  const browser = await chromium.launch(launchOptions);
  const contextOptions = {
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  };

  if (storageStatePath && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(defaultTimeoutMs());
  page.setDefaultNavigationTimeout(defaultTimeoutMs());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get() {
        return undefined;
      },
    });
  });
  return { browser, context, page, system };
}

async function clickFirstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }
  return false;
}

async function clickVisibleText(page, text) {
  const exact = page.getByText(text, { exact: true });
  if (await clickFirstVisible(exact)) {
    return true;
  }

  const partial = page.getByText(text);
  if (await clickFirstVisible(partial)) {
    return true;
  }

  const xpath = page.locator(
    `xpath=//*[normalize-space(text())="${text}" or contains(normalize-space(.), "${text}")]`,
  );
  return clickFirstVisible(xpath);
}

async function saveStorageState(context, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await context.storageState({ path: targetPath });
}

function requireCredential(system, key) {
  const envKey = systemConfig(system)[`${key}Env`];
  const value = process.env[envKey];
  if (!value) {
    throw new Error(`Missing ${envKey}. Set it in the environment before running this skill.`);
  }
  return value;
}

async function loginGenericForm(system, page) {
  const config = systemConfig(system);
  await page.goto(config.dashboardUrl, { waitUntil: "domcontentloaded" });
  await waitForStablePage(page);

  if (systemIsLoggedInUrl(system, page.url())) {
    return { reused: true, url: page.url() };
  }

  if (config.loginUrl) {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
    await waitForStablePage(page);
  }

  const selectors = config.loginSelectors || {};
  if (!selectors.username || !selectors.password) {
    throw new Error(`System ${system} uses generic-form but is missing loginSelectors.username/password.`);
  }

  await page.locator(selectors.username).fill(requireCredential(system, "username"));
  await page.locator(selectors.password).fill(requireCredential(system, "password"));

  if (selectors.submit) {
    await page.locator(selectors.submit).first().click();
  } else if (selectors.submitText) {
    const button = page
      .locator('button, [role="button"], input[type="submit"]')
      .filter({ hasText: looseTextPattern(selectors.submitText) })
      .first();
    if ((await button.count()) > 0) {
      await button.click();
    } else {
      await page.locator(selectors.password).press("Enter");
    }
  } else {
    await page.locator(selectors.password).press("Enter");
  }

  await page.waitForURL((url) => systemIsLoggedInUrl(system, url.toString()), {
    timeout: defaultTimeoutMs(),
  });
  await waitForStablePage(page);
  return { reused: false, url: page.url() };
}

async function loginSystem(system, page, targetUrl) {
  const adapter = systemConfig(system).adapter;
  if (adapter === "generic-form") {
    return loginGenericForm(system, page);
  }
  throw new Error(`Unsupported system adapter: ${adapter}`);
}

async function openDashboard(page, system) {
  await page.goto(systemConfig(system).dashboardUrl, { waitUntil: "domcontentloaded" });
  await waitForStablePage(page);
  return systemIsLoggedInUrl(system, page.url());
}

async function ensureLoggedIn(system, options = {}) {
  const statePath = statePathFor(system);
  const session = await launchContext({
    system,
    headless: options.headless ?? true,
    storageStatePath: statePath,
  });

  const dashboardReady = await openDashboard(session.page, system);
  if (dashboardReady) {
    return { ...session, reused: true, statePath };
  }

  const loginResult = await loginSystem(system, session.page);
  await saveStorageState(session.context, statePath);
  return { ...session, reused: loginResult.reused, statePath };
}

async function applyPresetIfPresent(page, system, notes, contextLabel = system) {
  const weekRange = previousWeekRange();
  const config = systemConfig(system);
  if (config.dateRangeSelectors?.startInput && config.dateRangeSelectors?.endInput) {
    const selectors = config.dateRangeSelectors || {};
    const startInput = page.locator(selectors.startInput || 'input[placeholder="开始日期"]').first();
    const endInput = page.locator(selectors.endInput || 'input[placeholder="结束日期"]').first();
    const resolveTargetUrl = () => {
      const currentUrl = page.url();
      if (!systemIsLoggedInUrl(system, currentUrl)) {
        try {
          return new URL(currentUrl).searchParams.get("redirect") || config.dashboardUrl;
        } catch {
          return config.dashboardUrl;
        }
      }
      return currentUrl;
    };

    let inputReady = await startInput.waitFor({ state: "visible", timeout: 8000 }).then(
      () => true,
      () => false,
    );

    if (!inputReady) {
      const targetUrl = resolveTargetUrl();
      if (!systemIsLoggedInUrl(system, page.url())) {
        notes.push(`${contextLabel}: 登录态失效，正在自动重登。`);
        await loginSystem(system, page, targetUrl);
      } else {
        notes.push(`${contextLabel}: 日期控件未就绪，正在重试加载页面。`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await waitForStablePage(page);
      }

      inputReady = await startInput.waitFor({ state: "visible", timeout: 8000 }).then(
        () => true,
        () => false,
      );
    }

    if (!inputReady) {
      notes.push(`${contextLabel}: 未找到日期范围控件，跳过上周切换。`);
      return;
    }

    const currentStart = await startInput.inputValue().catch(() => "");
    const currentEnd = await endInput.inputValue().catch(() => "");

    if (currentStart === weekRange.start && currentEnd === weekRange.end) {
      notes.push(`${contextLabel}: 页面已显示上周范围 ${weekRange.label}。`);
      return;
    }

    await startInput.click();
    await page.locator(`td[title="${weekRange.start}"]`).click();
    await page.locator(`td[title="${weekRange.end}"]`).click();
    await shortDelay(1200);
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      // The page may update in-place after the date range changes.
    }

    const updatedStart = await startInput.inputValue().catch(() => "");
    const updatedEnd = await endInput.inputValue().catch(() => "");
    if (updatedStart === weekRange.start && updatedEnd === weekRange.end) {
      notes.push(`${contextLabel}: 已切换到上周范围 ${weekRange.label}。`);
      return;
    }

    notes.push(
      `${contextLabel}: 尝试切换到上周失败，当前仍是 ${updatedStart || "未知"} 至 ${updatedEnd || "未知"}。`,
    );
    return;
  }

  const presetText = process.env[config.presetTextEnv || ""] || "上周";
  const pageHasWeekRange = await page.evaluate(
    ({ start, end }) => {
      const text = String(document.body.innerText || "");
      const variants = [
        start,
        end,
        start.replaceAll("-", "/"),
        end.replaceAll("-", "/"),
      ];
      return variants.every((value) => text.includes(value)) || text.includes("上周");
    },
    { start: weekRange.start, end: weekRange.end },
  );

  if (pageHasWeekRange) {
    notes.push(`${contextLabel}: 页面已显示上周范围 ${weekRange.label}。`);
    return;
  }

  const clicked = await clickVisibleText(page, presetText).catch(() => false);
  if (clicked) {
    await shortDelay(1200);
    try {
      await page.waitForLoadState("networkidle", { timeout: 4000 });
    } catch {
      // Dashboards often update in-place.
    }
  } else {
    notes.push(`${contextLabel}: 未找到日期快捷项「${presetText}」，本次继续按当前页面状态抓取。`);
  }
}

function findMetricTokens(text, type) {
  const cleaned = normalizeText(text);
  if (!cleaned) {
    return [];
  }

  if (type === "rate") {
    const rates = cleaned.match(/\d[\d,.]*\s*%/g) || [];
    return rates.map(normalizeMetricValue);
  }

  const counts = cleaned.match(/\d[\d,.]*(?:万|亿)?/g) || [];
  return counts
    .map(normalizeMetricValue)
    .filter((value) => !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value));
}

function bestTokenFromSnippet(label, snippet, type) {
  const cleaned = normalizeText(snippet);
  if (!cleaned) {
    return null;
  }

  const labelPattern = new RegExp(`${escapeRegExp(label)}[^\\d%]{0,12}([\\d,.]+\\s*%?)`);
  const match = cleaned.match(labelPattern);
  if (match?.[1]) {
    if (type === "rate" && !match[1].includes("%")) {
      return null;
    }
    return normalizeMetricValue(match[1]);
  }

  const tokens = findMetricTokens(cleaned, type);
  if (tokens.length === 0) {
    return null;
  }

  if (type === "rate") {
    return tokens[0];
  }

  const likelyCount = tokens.find((token) => !token.includes("%"));
  return likelyCount || tokens[0];
}

async function selectorValue(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 5000 });
  const text = await locator.innerText();
  return normalizeMetricValue(text);
}

async function rawCandidatesForLabel(page, label) {
  return page.evaluate((targetLabel) => {
    const clean = (value) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const collectTexts = (node) => {
      if (!node) {
        return [];
      }

      const seen = new Set();
      const results = [];
      const push = (value) => {
        const cleaned = clean(value);
        if (!cleaned || cleaned.length > 120 || seen.has(cleaned)) {
          return;
        }
        if (!/\d/.test(cleaned) && !cleaned.includes("%")) {
          return;
        }
        seen.add(cleaned);
        results.push(cleaned);
      };

      if (node instanceof Element) {
        push(node.innerText);
        const descendants = Array.from(node.querySelectorAll("*"));
        for (const element of descendants) {
          push(element.innerText);
          if (results.length >= 12) {
            break;
          }
        }
      }

      return results.slice(0, 12);
    };

    const elements = Array.from(document.querySelectorAll("body *")).filter((element) => {
      const text = clean(element.textContent);
      if (!text || text.length > 80) {
        return false;
      }
      return text.includes(targetLabel);
    });

    return elements.slice(0, 12).map((element, index) => ({
      index,
      labelText: clean(element.textContent),
      self: collectTexts(element),
      next: collectTexts(element.nextElementSibling),
      previous: collectTexts(element.previousElementSibling),
      parent: collectTexts(element.parentElement),
      grand: collectTexts(element.parentElement?.parentElement),
      pageUrl: window.location.href,
    }));
  }, label);
}

async function extractMetric(page, system, metric) {
  const selectorEnv = systemConfig(system).selectorEnvs?.[metric.key];
  if (selectorEnv && process.env[selectorEnv]) {
    const value = await selectorValue(page, process.env[selectorEnv]);
    return {
      key: metric.key,
      label: metric.label,
      value,
      source: `selector:${selectorEnv}`,
    };
  }

  const labels = [metric.label, ...(metric.aliases || [])];
  const relationOrder = ["self", "next", "parent", "grand", "previous"];
  const allCandidates = [];

  for (const label of labels) {
    const candidates = await rawCandidatesForLabel(page, label);
    allCandidates.push(...candidates);
    for (const candidate of candidates) {
      for (const relation of relationOrder) {
        const snippets = candidate[relation] || [];
        for (const snippet of snippets) {
          const value = bestTokenFromSnippet(label, snippet, metric.type);
          if (value) {
            return {
              key: metric.key,
              label: metric.label,
              value,
              source: `label:${relation}`,
              debug: { label, snippet },
            };
          }
        }
      }
    }
  }

  return {
    key: metric.key,
    label: metric.label,
    value: null,
    source: "missing",
    debug: { candidates: allCandidates.slice(0, 3) },
  };
}

async function gotoReportPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForStablePage(page);
}

async function readFirstTableRows(page) {
  const table = page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 10000 });
  return page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return Array.from(document.querySelectorAll("table tr"))
      .map((row) =>
        Array.from(row.querySelectorAll("th,td"))
          .map((cell) => clean(cell.textContent))
          .filter(Boolean),
      )
      .filter((row) => row.length);
  });
}

function rowsToObjects(rows) {
  if (!rows?.length || rows.length < 2) {
    return [];
  }
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] ?? "";
    });
    return item;
  });
}

async function setGioDimension(page, dimension) {
  const button = page.getByText(dimension, { exact: true }).first();
  await button.click();
  await shortDelay(1200);
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    // Some dashboards update in-place without a fully idle network.
  }
}

function singleValueFromRows(rows) {
  if (!rows?.length || rows.length < 2 || rows[1].length < 2) {
    return null;
  }
  return normalizeMetricValue(rows[1][1]);
}

function rowsToSimpleMap(rows) {
  const map = {};
  for (const row of rows.slice(1)) {
    if (row.length >= 2) {
      map[row[0]] = normalizeMetricValue(row[1]);
    }
  }
  return map;
}

function groupedOrderSummary(rows, sourceName) {
  const objects = rowsToObjects(rows);
  const headers = rows[0] || [];
  const sourceHeader = headers[0];
  const skuHeader = headers[1];
  const valueHeader = headers[headers.length - 1];

  const matched = objects.filter((item) => item[sourceHeader] === sourceName);
  const total = matched.reduce((sum, item) => sum + (numericValue(item[valueHeader]) || 0), 0);
  const skuNames = Array.from(
    new Set(matched.map((item) => normalizeMetricValue(item[skuHeader])).filter(Boolean)),
  );

  return {
    total: formatCount(String(total)) || "0",
    skuNames,
  };
}

function contextWithWeekRange(result) {
  return {
    ...result,
    missingValueText: ACTIVE_CONFIG.missingValueText || BUILTIN_CONFIG.missingValueText,
  };
}

function valueAtPath(input, dottedPath) {
  return String(dottedPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => (current == null ? undefined : current[part]), input);
}

function renderPlaceholder(expression, context) {
  const [rawPath, ...pipes] = expression.split("|").map((item) => item.trim());
  let value = valueAtPath(context, rawPath);
  let fallback = context.missingValueText;

  for (const pipe of pipes) {
    if (pipe.startsWith("or:")) {
      fallback = pipe.slice(3);
      continue;
    }
    if (pipe.startsWith("join:")) {
      const separator = pipe.slice(5);
      if (Array.isArray(value)) {
        value = value.filter(Boolean).join(separator);
      }
      continue;
    }
  }

  if (Array.isArray(value)) {
    value = value.filter(Boolean).join("、");
  }

  if (value == null || value === "") {
    return fallback;
  }
  return String(value);
}

function renderTemplate(template, context) {
  return template.replace(/\{([^}]+)\}/g, (_, expression) =>
    renderPlaceholder(expression, context),
  );
}

function hasMetricValue(value) {
  if (value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return true;
  }
  return true;
}

function feishuMessageFromResult(result) {
  const output = ACTIVE_CONFIG.output || {};
  const context = contextWithWeekRange(result);
  const lines = [];

  if (output.titleTemplate) {
    lines.push(renderTemplate(output.titleTemplate, context));
  }

  for (const line of output.lines || []) {
    if (typeof line === "string") {
      lines.push(renderTemplate(line, context));
      continue;
    }
    if (line?.template) {
      lines.push(renderTemplate(line.template, context));
    }
  }

  return lines.filter(Boolean).join("\n");
}

async function preparePage(page, pageDefinition, notes) {
  await gotoReportPage(page, pageDefinition.url);
  if (pageDefinition.applyPreset) {
    await applyPresetIfPresent(
      page,
      pageDefinition.system,
      notes,
      pageDefinition.contextLabel || pageDefinition.system,
    );
  }
  await shortDelay(pageDefinition.postLoadDelayMs || 1000);
}

async function collectLabelMetrics(page, pageDefinition, notes) {
  await preparePage(page, pageDefinition, notes);
  const values = {};

  for (const metric of pageDefinition.metrics || []) {
    const result = await extractMetric(page, pageDefinition.system, metric);
    values[metric.key] = result.value;
    if (!result.value) {
      notes.push(
        `${pageDefinition.contextLabel || pageDefinition.system}: 未抓到「${metric.label}」。`,
      );
    }
  }

  return values;
}

async function collectDimensionSingleValue(page, pageDefinition, notes) {
  await preparePage(page, pageDefinition, notes);
  const values = {};

  for (const dimension of pageDefinition.dimensions || []) {
    await setGioDimension(page, dimension.toggle);
    const rows = await readFirstTableRows(page);
    values[dimension.key] = singleValueFromRows(rows);
  }

  const incomplete = (pageDefinition.dimensions || []).some((dimension) => !values[dimension.key]);
  if (incomplete && pageDefinition.noteOnMissing) {
    notes.push(pageDefinition.noteOnMissing);
  }

  return values;
}

async function collectGroupedOrderSummaryPage(page, pageDefinition, notes) {
  await preparePage(page, pageDefinition, notes);
  if (pageDefinition.dimension) {
    await setGioDimension(page, pageDefinition.dimension);
  }

  const rows = await readFirstTableRows(page);
  const values = {};

  for (const group of pageDefinition.groups || []) {
    const summary = groupedOrderSummary(rows, group.sourceName);
    values[group.countKey] = summary.total;
    values[group.skuKey] = summary.skuNames;
    if (!hasMetricValue(summary.total) && group.label) {
      notes.push(`${pageDefinition.contextLabel}: 未抓到「${group.label}」。`);
    }
  }

  return values;
}

async function collectDimensionLabelMap(page, pageDefinition, notes) {
  await preparePage(page, pageDefinition, notes);

  if (pageDefinition.userDimension) {
    await setGioDimension(page, pageDefinition.userDimension);
  }
  const userRows = await readFirstTableRows(page);
  const userMap = rowsToSimpleMap(userRows);

  if (pageDefinition.countDimension) {
    await setGioDimension(page, pageDefinition.countDimension);
  }
  const countRows = await readFirstTableRows(page);
  const countMap = rowsToSimpleMap(countRows);

  const values = {};
  for (const item of pageDefinition.labels || []) {
    values[item.userKey] = userMap[item.sourceLabel] ?? null;
    values[item.countKey] = countMap[item.sourceLabel] ?? null;
  }

  const incomplete = (pageDefinition.labels || []).some(
    (item) => !hasMetricValue(values[item.userKey]) || !hasMetricValue(values[item.countKey]),
  );
  if (incomplete && pageDefinition.noteOnMissing) {
    notes.push(pageDefinition.noteOnMissing);
  }

  return values;
}

const PAGE_COLLECTORS = {
  labelMetrics: collectLabelMetrics,
  dimensionSingleValue: collectDimensionSingleValue,
  groupedOrderSummary: collectGroupedOrderSummaryPage,
  dimensionLabelMap: collectDimensionLabelMap,
};

async function collectPageResult(page, pageKey, notes) {
  const pageDefinition = pageConfig(pageKey);
  const collector = PAGE_COLLECTORS[pageDefinition.collector];
  if (!collector) {
    throw new Error(`Unsupported collector: ${pageDefinition.collector}`);
  }
  return collector(page, pageDefinition, notes);
}

async function runLogin(flags) {
  const system = flags.system;
  if (!system) {
    throw new Error("Missing --system.");
  }

  systemConfig(system);
  const session = await ensureLoggedIn(system, {
    headless: !asBoolean(flags["show-browser"], false),
  });

  try {
    await saveStorageState(session.context, session.statePath);
    const output = {
      ok: true,
      system,
      reused: session.reused,
      statePath: session.statePath,
      currentUrl: session.page.url(),
      message: `${system} 登录成功，登录态已保存。`,
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await session.browser.close();
  }
}

async function runInspect(flags) {
  const system = flags.system;
  const label = flags.label;
  if (!system || !label) {
    throw new Error("inspect requires --system and --label.");
  }

  systemConfig(system);
  const session = await ensureLoggedIn(system, {
    headless: !asBoolean(flags["show-browser"], false),
  });

  try {
    if (flags.url) {
      await gotoReportPage(session.page, flags.url);
    } else {
      await openDashboard(session.page, system);
    }
    const notes = [];
    await applyPresetIfPresent(session.page, system, notes, flags.url || system);
    const candidates = await rawCandidatesForLabel(session.page, label);
    console.log(
      JSON.stringify(
        {
          ok: true,
          system,
          label,
          currentUrl: session.page.url(),
          candidates,
          notes,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.browser.close();
  }
}

async function runCollect() {
  const weekRange = previousWeekRange();
  const notes = [];
  const metrics = {};
  const sessions = new Map();

  try {
    const systems = Array.from(
      new Set((ACTIVE_CONFIG.collectOrder || []).map((pageKey) => pageConfig(pageKey).system)),
    );

    for (const system of systems) {
      sessions.set(system, await ensureLoggedIn(system, { headless: true }));
    }

    for (const pageKey of ACTIVE_CONFIG.collectOrder || []) {
      const pageDefinition = pageConfig(pageKey);
      const session = sessions.get(pageDefinition.system);
      const collected = await collectPageResult(session.page, pageKey, notes);
      metrics[pageDefinition.system] = {
        ...(metrics[pageDefinition.system] || {}),
        ...collected,
      };
    }
  } finally {
    await Promise.all(
      Array.from(sessions.values()).map((session) => session.browser.close()),
    );
  }

  const missingNotes = notes.filter((note) => /未抓到|未完整抓到/.test(note));
  const result = {
    ok: missingNotes.length === 0,
    configPath: ACTIVE_CONFIG_PATH,
    weekRange,
    metrics,
    feishuMessage: "",
    notes,
  };
  result.feishuMessage = feishuMessageFromResult(result);
  console.log(JSON.stringify(result, null, 2));
}

async function runValidateConfig() {
  const summary = {
    ok: true,
    configPath: ACTIVE_CONFIG_PATH,
    systems: Object.entries(ACTIVE_CONFIG.systems).map(([key, system]) => ({
      key,
      adapter: system.adapter,
      dashboardUrl: system.dashboardUrl,
      usernameEnv: system.usernameEnv,
      passwordEnv: system.passwordEnv,
    })),
    pages: (ACTIVE_CONFIG.collectOrder || []).map((pageKey) => {
      const page = pageConfig(pageKey);
      return {
        key: pageKey,
        system: page.system,
        collector: page.collector,
        url: page.url,
      };
    }),
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  await ensureDir(STATE_DIR);
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }

  await loadActiveConfig(flags);

  if (command === "validate-config") {
    await runValidateConfig();
    return;
  }

  if (command === "login") {
    await runLogin(flags);
    return;
  }

  if (command === "inspect") {
    await runInspect(flags);
    return;
  }

  if (command === "collect") {
    await runCollect(flags);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error?.message || String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
