import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const TARGET_URL = process.env.FIRST_COMMENT_SUPERTOPIC_URL || "https://weibo.com/p/1008088398ba44a36be9098c12fb747c01bf52/super_index";
const MAX_COMMENTS = Number(process.env.FIRST_COMMENT_MAX || "4");
const POLL_SECONDS = Number(process.env.FIRST_COMMENT_POLL_SECONDS || "5");
const MAX_ATTEMPTS_PER_POST = Number(process.env.FIRST_COMMENT_MAX_ATTEMPTS_PER_POST || "3");
const COMMENTS = [
  "小时候听老人常说“冬做超like夏不伤，演唱会有票我不慌”，所有title中超like最为正宗。我们的老祖宗认为冬季是个寒冷的季节，所以要在家里多做@华晨宇yu 超like为未来一年的生活打下好基础",
  "你好，我是火星的公主，不知为何流落到地球，点亮你的超like头衔，就可以助我一臂之力，等我成功返回火星，就让我的爸比火星国王封你为火星第一护法@华晨宇yu",
  "玩微博不做超辣，就如同四大名著不看红楼梦，听古典不听贝多芬，看画画不看达芬奇，说明这个人品味鉴赏和自我修养不足，他整个人的层次就卡在这里了，只能度过一个相对失败的人生。做了超辣，我的演唱会🎫自动飞到了我的手上，红酒杯也开始自己摇晃，黑胶唱片也发出了声音@华晨宇yu",
  "我们是一个健康的演唱会超辣你们没开玩笑吧好几万超辣啊算了吧你们都有好几个超辣啦少骗我我不信啊如果你们是从初中喜欢我那现在也该超辣了吧如果你们是从小学喜欢我那现在也该超辣了吧难道上大学还没做一个超辣吗你们太可怜啦还不超辣呐我要嘲笑你们啦哈哈哈哈没关系我会送你们最后一个超辣@华晨宇yu"
];

const results = [];

await main();

async function main() {
  await mkdir("artifacts", { recursive: true });

  const cookieText = process.env.WEIBO_COOKIE || "";
  if (!cookieText) {
    throw new Error("Missing secret: WEIBO_COOKIE");
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

    const completed = new Set();
    const attempts = new Map();
    let successCount = 0;

    while (successCount < MAX_COMMENTS) {
      console.log(`Opening target super topic: ${TARGET_URL}`);
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2000);

      if (await isLoginPage(page)) {
        await saveDebug(page, "login-required");
        throw new Error("Login is not valid. Update WEIBO_COOKIE.");
      }

      const links = await collectPostLinks(page);
      console.log(`Found ${links.length} candidate posts.`);

      for (const href of links) {
        if (successCount >= MAX_COMMENTS) {
          break;
        }
        if (completed.has(href)) {
          continue;
        }

        const attemptCount = attempts.get(href) || 0;
        if (attemptCount >= MAX_ATTEMPTS_PER_POST) {
          continue;
        }

        attempts.set(href, attemptCount + 1);
        const comment = pickComment(successCount);
        const ok = await tryCommentPost(context, href, comment, successCount + 1);
        if (ok) {
          completed.add(href);
          successCount += 1;
          console.log(`Commented ${successCount}/${MAX_COMMENTS}`);
        }
      }

      if (successCount < MAX_COMMENTS) {
        console.log(`Waiting ${POLL_SECONDS}s before next scan.`);
        await page.waitForTimeout(POLL_SECONDS * 1000);
      }
    }

    console.log("Finished all first-comment attempts.");
  } finally {
    await writeVisualIndex();
    await browser.close();
  }
}

async function collectPostLinks(page) {
  return page.evaluate(() => {
    const candidates = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/status/"], a[href*="/detail/"], a[href]'));

    function normalizePostUrl(href) {
      const clean = String(href || "").split("?")[0];
      if (/\/(status|detail)\//.test(clean)) {
        return clean;
      }
      if (/weibo\.com\/\d+\/[A-Za-z0-9]+$/.test(clean)) {
        return clean;
      }
      return "";
    }

    function postRootFrom(anchor) {
      let node = anchor;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const text = node.innerText || "";
        if (/收藏/.test(text) && /转发/.test(text) && /赞/.test(text)) {
          return node;
        }
        node = node.parentElement;
      }
      return anchor.closest("article") || anchor.closest('[class*="card"]') || anchor.parentElement;
    }

    function currentPostHasCommentNumber(root) {
      if (!root) {
        return true;
      }

      const text = root.innerText || "";
      const lines = text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (!/评论/.test(line)) {
          continue;
        }
        const compact = line.replace(/\s+/g, "");
        if (/评论\d+/.test(compact) || /\d+评论/.test(compact)) {
          return true;
        }
      }

      const commentLike = Array.from(root.querySelectorAll("a, button, span, div"))
        .filter((node) => /评论/.test(node.innerText || node.getAttribute("aria-label") || ""));

      for (const node of commentLike) {
        const text = `${node.innerText || ""} ${node.getAttribute("aria-label") || ""}`.replace(/\s+/g, "");
        if (/评论\d+/.test(text) || /\d+评论/.test(text)) {
          return true;
        }
      }

      return false;
    }

    for (const anchor of anchors) {
      const href = normalizePostUrl(anchor.href);
      if (!href || seen.has(href)) {
        continue;
      }

      const root = postRootFrom(anchor);
      if (currentPostHasCommentNumber(root)) {
        continue;
      }

      seen.add(href);
      candidates.push(href);
      if (candidates.length >= 12) {
        break;
      }
    }

    return candidates;
  }).catch(() => []);
}

function normalizePostUrl(href) {
  const clean = String(href || "").split("?")[0];
  if (/\/(status|detail)\//.test(clean)) {
    return clean;
  }
  if (/weibo\.com\/\d+\/[A-Za-z0-9]+$/.test(clean)) {
    return clean;
  }
  return "";
}

async function tryCommentPost(context, href, comment, index) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    console.log(`Opening post ${index}: ${href}`);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const empty = await isCommentAreaEmpty(page);
    console.log(`Post ${index}: comment area empty: ${empty}`);
    if (!empty) {
      console.log(`Post ${index}: already has comments, skipped.`);
      return false;
    }

    const commentInput = await openCommentInput(page);
    if (!commentInput) {
      await saveDebug(page, `post-${index}-no-input`);
      console.log(`Post ${index}: comment input not found.`);
      return false;
    }

    await commentInput.fill(comment).catch(async () => {
      await commentInput.click();
      await page.keyboard.type(comment);
    });

    const sent = await clickSend(page);
    if (!sent) {
      await saveDebug(page, `post-${index}-no-send`);
      console.log(`Post ${index}: send button not found.`);
      return false;
    }

    await page.waitForTimeout(3500);
    await captureResult(page, href, comment, index);
    console.log(`Post ${index}: comment submitted and captured.`);
    return true;
  } catch (error) {
    await saveDebug(page, `post-${index}-error`);
    console.log(`Post ${index}: ${error.message}`);
    return false;
  } finally {
    await page.close();
  }
}

async function isCommentAreaEmpty(page) {
  await openCommentTab(page);
  await page.waitForTimeout(1200);

  const nonEmptyLocators = [
    page.getByText(/共\s*\d+\s*条评论/).first(),
    page.getByText(/全部评论\s*\d+/).first(),
    page.getByText(/评论\s*\d+/).first(),
    page.locator('[class*="comment"] [class*="item"]').first(),
    page.locator('[class*="Comment"] [class*="item"]').first()
  ];

  for (const locator of nonEmptyLocators) {
    if (await visible(locator)) {
      return false;
    }
  }

  const hasCommentRows = await page.evaluate(() => {
    const commentKeywords = ["回复", "点赞", "来自", "分钟前", "小时前"];
    const nodes = Array.from(document.querySelectorAll("div, li, article"));
    return nodes.some((node) => {
      const text = (node.innerText || "").trim();
      if (text.length < 8 || text.length > 500) {
        return false;
      }
      const keywordHits = commentKeywords.filter((keyword) => text.includes(keyword)).length;
      const looksLikeToolbar = /收藏/.test(text) && /转发/.test(text) && /评论/.test(text) && /赞/.test(text);
      return keywordHits >= 2 && !looksLikeToolbar;
    });
  }).catch(() => false);

  if (hasCommentRows) {
    return false;
  }

  return true;
}

async function openCommentTab(page) {
  const commentText = "\u8bc4\u8bba";
  const entries = [
    page.getByRole("tab", { name: /\u8bc4\u8bba/ }).first(),
    page.getByRole("button", { name: /\u8bc4\u8bba/ }).first(),
    page.locator(`[aria-label*="${commentText}"]`).first(),
    page.locator(`text=${commentText}`).first()
  ];

  for (const entry of entries) {
    if (await visible(entry)) {
      await entry.click().catch(() => {});
      return;
    }
  }
}

async function openCommentInput(page) {
  const commentText = "\u8bc4\u8bba";
  const entrySelectors = [
    `xpath=//*[contains(normalize-space(.), "\u62a2\u9996\u8bc4") or contains(normalize-space(.), "\u5feb\u6765\u62a2\u9996\u8bc4")][1]`,
    `[aria-label*="${commentText}"]`,
    `text=${commentText}`
  ];

  for (const selector of entrySelectors) {
    const entry = page.locator(selector).first();
    if (await visible(entry)) {
      await entry.click().catch(() => {});
      await page.waitForTimeout(800);
      break;
    }
  }

  const inputSelectors = [
    'textarea[placeholder*="\u8bc4\u8bba"]',
    "textarea",
    '[contenteditable="true"]'
  ];

  for (const selector of inputSelectors) {
    const input = page.locator(selector).first();
    if (await visible(input)) {
      return input;
    }
  }

  return null;
}

async function clickSend(page) {
  const sendButtons = [
    page.getByRole("button", { name: /\u53d1\u9001|\u8bc4\u8bba|\u53d1\u5e03/ }).first(),
    page.getByText(/^\u53d1\u9001$|^\u8bc4\u8bba$|^\u53d1\u5e03$/).first()
  ];

  for (const button of sendButtons) {
    if (await visible(button)) {
      await button.click();
      return true;
    }
  }

  return false;
}

async function captureResult(page, href, comment, index) {
  await page.mouse.wheel(0, 900).catch(() => {});
  await page.waitForTimeout(1000);

  const base = `first-comment-${String(index).padStart(2, "0")}`;
  const screenshot = `${base}.png`;
  const html = `${base}.html`;
  const visibleComment = await page.getByText(comment.slice(0, 24)).first().isVisible({ timeout: 1500 }).catch(() => false);

  await page.screenshot({ path: `artifacts/${screenshot}`, fullPage: true }).catch(() => {});
  await writeFile(`artifacts/${html}`, await page.content().catch(() => "")).catch(() => {});

  results.push({
    index,
    href,
    comment,
    screenshot,
    html,
    visibleComment,
    capturedAt: new Date().toISOString()
  });
}

async function writeVisualIndex() {
  const rows = results.map((item) => {
    return `
      <section>
        <h2>Comment ${item.index}</h2>
        <p><a href="${escapeHtml(item.href)}">${escapeHtml(item.href)}</a></p>
        <p><strong>Visible after submit:</strong> ${item.visibleComment ? "yes" : "not confirmed"}</p>
        <p><strong>Comment:</strong> ${escapeHtml(item.comment)}</p>
        <p><a href="${escapeHtml(item.html)}">saved html</a></p>
        <img src="${escapeHtml(item.screenshot)}" alt="comment ${item.index} screenshot">
      </section>
    `;
  }).join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Weibo First Comment Visual Check</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2328; }
    section { border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin: 16px 0; }
    img { display: block; width: min(100%, 1200px); border: 1px solid #d0d7de; border-radius: 6px; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Weibo First Comment Visual Check</h1>
  <p>Captured comments: ${results.length}</p>
  ${rows || "<p>No successful comment screenshots were captured.</p>"}
</body>
</html>`;

  await writeFile("artifacts/index.html", html).catch(() => {});
}

function pickComment(index) {
  const shuffled = [...COMMENTS].sort(() => Math.random() - 0.5);
  return shuffled[index % shuffled.length];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function isLoginPage(page) {
  const loginText = page.getByText(/\u767b\u5f55|\u77ed\u4fe1\u767b\u5f55|\u626b\u7801\u767b\u5f55/).first();
  const passwordInput = page.locator('input[type="password"]').first();
  return (await visible(loginText)) || (await visible(passwordInput));
}

async function saveDebug(page, reason) {
  const safeReason = reason.replace(/[^a-z0-9_-]/gi, "_");
  await page.screenshot({
    path: `artifacts/first-comment-${safeReason}.png`,
    fullPage: true
  }).catch(() => {});

  const html = await page.content().catch(() => "");
  await writeFile(`artifacts/first-comment-${safeReason}.html`, html).catch(() => {});
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

async function visible(locator) {
  try {
    return await locator.isVisible({ timeout: 1200 });
  } catch {
    return false;
  }
}
