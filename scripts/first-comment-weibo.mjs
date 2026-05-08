import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const TARGET_URL = process.env.FIRST_COMMENT_SUPERTOPIC_URL || "https://weibo.com/p/1008088398ba44a36be9098c12fb747c01bf52/super_index";
const MAX_COMMENTS = Number(process.env.FIRST_COMMENT_MAX || "4");
const POLL_SECONDS = Number(process.env.FIRST_COMMENT_POLL_SECONDS || "60");
const COMMENTS = [
  "小时候听老人常说“冬做超like夏不伤，演唱会有票我不慌”，所有title中超like最为正宗。我们的老祖宗认为冬季是个寒冷的季节，所以要在家里多做@华晨宇yu 超like为未来一年的生活打下好基础",
  "你好，我是火星的公主，不知为何流落到地球，点亮你的超like头衔，就可以助我一臂之力，等我成功返回火星，就让我的爸比火星国王封你为火星第一护法@华晨宇yu",
  "玩微博不做超辣，就如同四大名著不看红楼梦，听古典不听贝多芬，看画画不看达芬奇，说明这个人品味鉴赏和自我修养不足，他整个人的层次就卡在这里了，只能度过一个相对失败的人生。做了超辣，我的演唱会🎫自动飞到了我的手上，红酒杯也开始自己摇晃，黑胶唱片也发出了声音@华晨宇yu",
  "我们是一个健康的演唱会超辣你们没开玩笑吧好几万超辣啊算了吧你们都有好几个超辣啦少骗我我不信啊如果你们是从初中喜欢我那现在也该超辣了吧如果你们是从小学喜欢我那现在也该超辣了吧难道上大学还没做一个超辣吗你们太可怜啦还不超辣呐我要嘲笑你们啦哈哈哈哈没关系我会送你们最后一个超辣@华晨宇yu"
];

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

    const commented = new Set();
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
        if (commented.has(href)) {
          continue;
        }

        commented.add(href);
        const comment = pickComment(successCount);
        const ok = await tryCommentPost(context, href, comment, successCount + 1);
        if (ok) {
          successCount += 1;
          console.log(`Commented ${successCount}/${MAX_COMMENTS}`);
        }
      }

      if (successCount < MAX_COMMENTS) {
        console.log(`Waiting ${POLL_SECONDS}s before next scan.`);
        await page.waitForTimeout(POLL_SECONDS * 1000);
      }
    }

    if (successCount < MAX_COMMENTS) {
      console.log(`Finished with ${successCount}/${MAX_COMMENTS} comments.`);
    } else {
      console.log("Finished all first-comment attempts.");
    }
  } finally {
    await browser.close();
  }
}

async function collectPostLinks(page) {
  const seen = new Set();

  for (let round = 0; round < 4 && seen.size < 16; round += 1) {
    const links = await page.locator('a[href*="/status/"], a[href*="/detail/"]').evaluateAll((anchors) => {
      return anchors
        .map((anchor) => anchor.href)
        .filter(Boolean);
    }).catch(() => []);

    for (const href of links) {
      const clean = href.split("?")[0];
      if (/\/(status|detail)\//.test(clean)) {
        seen.add(clean);
      }
    }

    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1200);
  }

  return Array.from(seen);
}

async function tryCommentPost(context, href, comment, index) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    console.log(`Opening post ${index}: ${href}`);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const firstCommentHint = page.getByText(/抢首评|快来抢首评|还没有评论|暂无评论|0/).first();
    console.log(`First-comment hint visible: ${await visible(firstCommentHint)}`);

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

    await page.waitForTimeout(2500);
    console.log(`Post ${index}: comment submitted.`);
    return true;
  } catch (error) {
    await saveDebug(page, `post-${index}-error`);
    console.log(`Post ${index}: ${error.message}`);
    return false;
  } finally {
    await page.close();
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
    'textarea',
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

function pickComment(index) {
  const shuffled = [...COMMENTS].sort(() => Math.random() - 0.5);
  return shuffled[index % shuffled.length];
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
