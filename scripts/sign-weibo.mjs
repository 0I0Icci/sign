import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

await main();

async function main() {
  await mkdir("artifacts", { recursive: true });

  const cookieText = process.env.WEIBO_COOKIE || "";
  const urls = (process.env.WEIBO_SUPERTOPIC_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!cookieText) {
    throw new Error("Missing secret: WEIBO_COOKIE");
  }
  if (!urls.length) {
    throw new Error("Missing secret: WEIBO_SUPERTOPIC_URLS");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1365, height: 900 }
  });

  try {
    await context.addCookies(parseCookies(cookieText));
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    for (let index = 0; index < urls.length; index += 1) {
      await signTopic(page, urls[index], index + 1);
    }
  } finally {
    await browser.close();
  }
}

async function signTopic(page, url, index) {
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);

  console.log(`Page title: ${await page.title().catch(() => "")}`);
  console.log(`Current URL: ${page.url()}`);

  if (await isLoginPage(page)) {
    await saveDebug(page, index, "login-required");
    throw new Error(`${url}: login is not valid. Update WEIBO_COOKIE.`);
  }

  const topButtonText = await getTopSignButtonText(page);
  console.log(`${url}: top sign button text: ${topButtonText || "(not found)"}`);
  if (isSignedButtonText(topButtonText)) {
    console.log(`${url}: already signed by top button state`);
    return;
  }

  if (await clickTopSignButton(page, url)) {
    const afterClickText = await getTopSignButtonText(page);
    console.log(`${url}: top sign button text after click: ${afterClickText || "(not found)"}`);
    if (isSignedButtonText(afterClickText) || await hasSignedState(page)) {
      console.log(`${url}: signed successfully by top sign button`);
      return;
    }
    console.log(`${url}: top sign button was clicked, but signed state was not confirmed`);
  }

  const topicId = extractSuperTopicId(url) || extractSuperTopicId(page.url());
  if (topicId) {
    console.log(`${url}: extracted super topic id ${topicId}`);
    const apiResult = await signByApi(page, url, topicId);
    if (apiResult.ok) {
      console.log(`${url}: ${apiResult.message}`);
      return;
    }
    console.log(`${url}: API sign did not complete: ${apiResult.message}`);
  } else {
    console.log(`${url}: could not extract super topic id; trying page click fallback`);
  }

  await page.mouse.wheel(0, -1200).catch(() => {});
  await page.waitForTimeout(800);

  const signInText = "\u7b7e\u5230";
  const candidates = [
    page.getByRole("button", { name: /\u7b7e\u5230/ }).first(),
    page.getByRole("link", { name: /\u7b7e\u5230/ }).first(),
    page.locator(`[aria-label*="${signInText}"]`).first(),
    page.locator(`button:has-text("${signInText}")`).first(),
    page.locator(`a:has-text("${signInText}")`).first(),
    page.locator(`span:has-text("${signInText}")`).first(),
    page.locator(`div:has-text("${signInText}")`).first()
  ];

  for (const candidate of candidates) {
    if (!(await visible(candidate))) {
      continue;
    }

    console.log(`${url}: clicking visible sign candidate`);
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    await candidate.click({ timeout: 5000 }).catch(async () => {
      await candidate.click({ force: true, timeout: 5000 });
    });
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle").catch(() => {});

    if (await hasSignedState(page)) {
      console.log(`${url}: signed successfully`);
      return;
    }
  }

  await saveDebug(page, index, "sign-not-confirmed");
  throw new Error(`${url}: sign action was not completed or could not be confirmed.`);
}

async function clickTopSignButton(page, url) {
  const signInText = "\u7b7e\u5230";
  const followedText = "\u5df2\u5173\u6ce8";
  const selectors = [
    `xpath=//*[contains(normalize-space(.), "${followedText}")]/following::*[(self::button or self::a or @role="button" or contains(@class, "woo-button")) and contains(normalize-space(.), "${signInText}")][1]`,
    `xpath=//*[normalize-space(.)="${signInText}" and (self::button or self::a or @role="button" or contains(@class, "woo-button"))][1]`,
    `xpath=//*[normalize-space(.)="${signInText}"]/ancestor::*[self::button or self::a or @role="button" or contains(@class, "woo-button")][1]`,
    `button:has-text("${signInText}")`,
    `[role="button"]:has-text("${signInText}")`,
    `a:has-text("${signInText}")`
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (!(await visible(button))) {
      continue;
    }

    console.log(`${url}: clicking top sign button with selector ${selector}`);
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 5000 }).catch(async () => {
      await button.click({ force: true, timeout: 5000 });
    });
    await page.waitForTimeout(5000);
    await page.waitForLoadState("networkidle").catch(() => {});
    return true;
  }

  return false;
}

async function getTopSignButtonText(page) {
  const signInText = "\u7b7e\u5230";
  const followedText = "\u5df2\u5173\u6ce8";
  const selectors = [
    `xpath=//*[contains(normalize-space(.), "${followedText}")]/following::*[(self::button or self::a or @role="button" or contains(@class, "woo-button")) and (contains(normalize-space(.), "${signInText}") or contains(normalize-space(.), "\u5df2\u7b7e"))][1]`,
    `xpath=//*[normalize-space(.)="${signInText}" and (self::button or self::a or @role="button" or contains(@class, "woo-button"))][1]`,
    `button:has-text("${signInText}")`,
    `[role="button"]:has-text("${signInText}")`,
    `a:has-text("${signInText}")`
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visible(locator)) {
      return (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    }
  }

  return "";
}

function isSignedButtonText(text) {
  return /\u5df2\u7b7e\u5230|\u4eca\u65e5\u5df2\u7b7e|\u8fde\u7eed\u7b7e\u5230|\u7b7e\u5230\u6210\u529f/.test(text || "");
}

async function signByApi(page, referer, topicId) {
  const first = await callSignApi(page, referer, topicId);
  console.log(`API response: http=${first.httpStatus} code=${first.code || "unknown"} msg=${first.message}`);

  if (!first.ok) {
    return first;
  }

  await page.waitForTimeout(1500);
  const verify = await callSignApi(page, referer, topicId);
  console.log(`API verify: http=${verify.httpStatus} code=${verify.code || "unknown"} msg=${verify.message}`);

  if (verify.alreadySigned || first.signed) {
    return {
      ok: true,
      message: first.signed ? `signed successfully by API: ${first.message}` : `already signed by API: ${verify.message}`
    };
  }

  return {
    ok: false,
    message: `API returned success-like response but verification did not show signed state: ${verify.message}`
  };
}

async function callSignApi(page, referer, topicId) {
  const response = await page.context().request.get("https://weibo.com/p/aj/general/button", {
    headers: {
      "referer": referer,
      "x-requested-with": "XMLHttpRequest"
    },
    params: {
      ajwvr: "6",
      api: "http://i.huati.weibo.com/aj/super/checkin",
      texta: "\u7b7e\u5230",
      textb: "\u5df2\u7b7e\u5230",
      status: "0",
      id: topicId,
      __rnd: String(Date.now())
    }
  }).catch((error) => {
    return { error };
  });

  if (response.error) {
    return { ok: false, httpStatus: "request-error", message: response.error.message };
  }

  const httpStatus = response.status();
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, httpStatus, message: `non-JSON response: ${text.slice(0, 200)}` };
  }

  const code = String(data.code || data?.data?.code || "");
  const message = data.msg || data?.data?.msg || JSON.stringify(data).slice(0, 200);
  const alertTitle = data?.data?.alert_title || "";
  if (code === "100000") {
    return {
      ok: true,
      signed: true,
      httpStatus,
      code,
      message: `${message}${alertTitle ? ` ${alertTitle}` : ""}`
    };
  }
  if (code === "382004" || /\u5df2\u7b7e\u5230|\u5df2\u7ecf\u7b7e\u5230|\u4eca\u65e5\u5df2\u7b7e/.test(message)) {
    return { ok: true, alreadySigned: true, httpStatus, code, message };
  }

  return { ok: false, httpStatus, code, message };
}

async function hasSignedState(page) {
  const signedText = page.getByText(/\u5df2\u7b7e\u5230|\u8fde\u7eed\u7b7e\u5230|\u4eca\u65e5\u5df2\u7b7e|\u7b7e\u5230\u6210\u529f/).first();
  return visible(signedText);
}

async function isLoginPage(page) {
  const loginText = page.getByText(/\u767b\u5f55|\u77ed\u4fe1\u767b\u5f55|\u626b\u7801\u767b\u5f55/).first();
  const passwordInput = page.locator('input[type="password"]').first();
  return (await visible(loginText)) || (await visible(passwordInput));
}

async function saveDebug(page, index, reason) {
  const safeReason = reason.replace(/[^a-z0-9_-]/gi, "_");
  await page.screenshot({
    path: `artifacts/sign-${index}-${safeReason}.png`,
    fullPage: true
  }).catch(() => {});

  const html = await page.content().catch(() => "");
  await writeFile(`artifacts/sign-${index}-${safeReason}.html`, html).catch(() => {});
}

function parseCookies(text) {
  return text
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      return {
        name: item.slice(0, index),
        value: item.slice(index + 1),
        domain: ".weibo.com",
        path: "/"
      };
    })
    .filter((cookie) => cookie.name && cookie.value);
}

function extractSuperTopicId(value) {
  const match = String(value || "").match(/100808[0-9a-zA-Z]+/);
  return match ? match[0] : "";
}

async function visible(locator) {
  try {
    return await locator.isVisible({ timeout: 1500 });
  } catch {
    return false;
  }
}

