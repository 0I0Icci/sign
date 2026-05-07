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

  if (await hasSignedState(page)) {
    console.log(`${url}: already signed`);
    return;
  }

  const topicId = extractSuperTopicId(url) || extractSuperTopicId(page.url());
  if (topicId) {
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
