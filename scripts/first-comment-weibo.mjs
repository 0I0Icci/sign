import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const TARGET_URL = process.env.FIRST_COMMENT_SUPERTOPIC_URL || "https://weibo.com/p/1008088398ba44a36be9098c12fb747c01bf52/super_index";
const TARGET_TOPIC = process.env.FIRST_COMMENT_TOPIC_NAME || "华晨宇超话";
const MAX_COMMENTS = Number(process.env.FIRST_COMMENT_MAX || "4");
const POLL_SECONDS = Number(process.env.FIRST_COMMENT_POLL_SECONDS || "3");
const MAX_ATTEMPTS_PER_POST = Number(process.env.FIRST_COMMENT_MAX_ATTEMPTS_PER_POST || "2");
const USE_AI_COMMENTS = process.env.DEEPSEEK_API_KEY ? true : false;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const SAMPLE_COMMENTS = [
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
    page.setDefaultTimeout(18000);

    const completed = new Set();
    const attempts = new Map();
    let successCount = 0;

    while (successCount < MAX_COMMENTS) {
      console.log(`Scanning target super topic: ${TARGET_URL}`);
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);

      if (await isLoginPage(page)) {
        await saveDebug(page, "login-required");
        throw new Error("Login is not valid. Update WEIBO_COOKIE.");
      }

      const candidates = await collectCurrentTopicCandidates(page);
      console.log(`Found ${candidates.length} current-topic zero-comment candidates.`);

      for (const candidate of candidates) {
        if (successCount >= MAX_COMMENTS) {
          break;
        }

        const href = candidate.href;
        if (completed.has(href)) {
          continue;
        }

        const attemptCount = attempts.get(href) || 0;
        if (attemptCount >= MAX_ATTEMPTS_PER_POST) {
          continue;
        }
        attempts.set(href, attemptCount + 1);

        const ok = await tryCommentPost(context, candidate, successCount + 1);
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

async function collectCurrentTopicCandidates(page) {
  return page.evaluate((targetTopic) => {
    const candidates = [];
    const seen = new Set();
    const roots = Array.from(document.querySelectorAll("article, div"));

    function normalizePostUrl(href) {
      const clean = String(href || "").split("?")[0];
      if (/\/(status|detail)\//.test(clean)) return clean;
      if (/weibo\.com\/\d+\/[A-Za-z0-9]+$/.test(clean)) return clean;
      return "";
    }

    function textOf(node) {
      return (node?.innerText || "").replace(/\s+/g, " ").trim();
    }

    function hasCurrentTopicMarker(root) {
      const text = textOf(root);
      return text.includes(targetTopic) || /来自\s*华晨宇超话/.test(text);
    }

    function hasFreshTime(root) {
      const text = textOf(root);
      return /刚刚|秒前|[1-9]\s*分钟前|10\s*分钟前/.test(text);
    }

    function hasToolbar(root) {
      const text = textOf(root);
      return text.includes("转发") && text.includes("评论") && text.includes("赞");
    }

    function currentToolbarHasCommentNumber(root) {
      const text = textOf(root);
      const lines = text.split(/\s+/).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] !== "评论") continue;
        const next = lines[i + 1] || "";
        if (/^\d+$/.test(next)) return true;
      }

      const commentNodes = Array.from(root.querySelectorAll("a, button, span, div"))
        .filter((node) => /评论/.test(`${node.innerText || ""} ${node.getAttribute("aria-label") || ""}`));

      for (const node of commentNodes) {
        const local = textOf(node.parentElement || node);
        if (/评论\s*\d+|\d+\s*评论/.test(local)) return true;
        let next = node.nextElementSibling;
        for (let step = 0; next && step < 3; step += 1) {
          if (/^\d+$/.test(textOf(next))) return true;
          next = next.nextElementSibling;
        }
      }

      return false;
    }

    function postLink(root) {
      const links = Array.from(root.querySelectorAll("a[href]"))
        .map((anchor) => normalizePostUrl(anchor.href))
        .filter(Boolean);
      return links[0] || "";
    }

    for (const root of roots) {
      const rect = root.getBoundingClientRect();
      if (rect.width < 360 || rect.height < 120 || rect.top < -50 || rect.top > window.innerHeight * 1.3) {
        continue;
      }
      if (!hasToolbar(root) || !hasCurrentTopicMarker(root) || !hasFreshTime(root)) {
        continue;
      }
      if (currentToolbarHasCommentNumber(root)) {
        continue;
      }

      const href = postLink(root);
      if (!href || seen.has(href)) {
        continue;
      }

      seen.add(href);
      candidates.push({
        href,
        text: textOf(root).slice(0, 800)
      });

      if (candidates.length >= 8) {
        break;
      }
    }

    return candidates;
  }, TARGET_TOPIC).catch(() => []);
}

async function tryCommentPost(context, candidate, index) {
  const page = await context.newPage();
  page.setDefaultTimeout(18000);

  try {
    console.log(`Opening post ${index}: ${candidate.href}`);
    await page.goto(candidate.href, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1800);

    if (!(await isCurrentTopicDetail(page))) {
      console.log(`Post ${index}: not current target super topic detail, skipped.`);
      return false;
    }

    const detailCommentCount = await getDetailCommentCount(page);
    console.log(`Post ${index}: detail comment count: ${detailCommentCount ?? "none"}`);
    if (detailCommentCount !== null && detailCommentCount > 0) {
      console.log(`Post ${index}: already shows ${detailCommentCount} comments, skipped.`);
      return false;
    }

    const empty = await isCommentAreaEmpty(page);
    console.log(`Post ${index}: comment area empty: ${empty}`);
    if (!empty) {
      console.log(`Post ${index}: already has comments, skipped.`);
      return false;
    }

    const postText = await extractPostText(page, candidate.text);
    const comment = await makeComment(postText, index);
    const input = await openCommentInput(page);
    if (!input) {
      await saveDebug(page, `post-${index}-no-input`);
      return false;
    }

    await input.fill(comment).catch(async () => {
      await input.click();
      await page.keyboard.type(comment);
    });

    if (!(await clickSend(page))) {
      await saveDebug(page, `post-${index}-no-send`);
      return false;
    }

    await page.waitForTimeout(3200);
    await captureResult(page, candidate.href, comment, index);
    console.log(`Post ${index}: comment submitted and captured.`);
    return true;
  } catch (error) {
    await saveDebug(page, `post-${index}-error`);
    console.log(`Post ${index}: ${error.stack || error.message}`);
    return false;
  } finally {
    await page.close();
  }
}

async function isCurrentTopicDetail(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return bodyText.includes(TARGET_TOPIC) || /来自\s*华晨宇超话/.test(bodyText);
}

async function getDetailCommentCount(page) {
  return page.evaluate(() => {
    function textOf(node) {
      return (node?.innerText || "").replace(/\s+/g, " ").trim();
    }

    function numeric(text) {
      const value = String(text || "").replace(/,/g, "").trim();
      return /^\d+$/.test(value) ? Number(value) : null;
    }

    const toolbars = Array.from(document.querySelectorAll("div, article, section"))
      .filter((node) => {
        const text = textOf(node);
        return text.includes("转发") && text.includes("赞") && node.querySelectorAll("a, button, span, svg, i").length >= 3;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    for (const toolbar of toolbars) {
      const text = textOf(toolbar);
      const tokens = text.split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] === "评论") {
          const next = numeric(tokens[i + 1]);
          if (next !== null) return next;
        }
      }

      const numbers = tokens.map(numeric).filter((value) => value !== null);
      if (numbers.length >= 3 && /分享这条博文|转发|赞/.test(text)) {
        return numbers[1];
      }

      const commentNodes = Array.from(toolbar.querySelectorAll("a, button, span, div"))
        .filter((node) => /评论|comment|pinglun/i.test(`${textOf(node)} ${node.getAttribute("aria-label") || ""}`));

      for (const node of commentNodes) {
        let next = node.nextElementSibling;
        for (let step = 0; next && step < 4; step += 1) {
          const value = numeric(textOf(next));
          if (value !== null) return value;
          next = next.nextElementSibling;
        }
      }

      if (text.includes("评论") && !/\d/.test(text)) {
        return 0;
      }
    }

    return null;
  }).catch(() => null);
}

async function isCommentAreaEmpty(page) {
  await openCommentTab(page);
  await page.waitForTimeout(2500);

  const detailCount = await getDetailCommentCount(page);
  if (detailCount !== null && detailCount > 0) {
    return false;
  }

  return page.evaluate(() => {
    const text = document.body.innerText || "";
    if (/共\s*\d+\s*条评论|全部评论\s*\d+|评论\s*\d+/.test(text)) {
      return false;
    }

    const rows = Array.from(document.querySelectorAll("div, li, article")).filter((node) => {
      const row = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (row.length < 12 || row.length > 360) return false;
      const hasUserTime = /\d{1,2}-\d{1,2}|\d+\s*分钟前|\d+\s*小时前|来自/.test(row);
      const hasAction = /回复|赞|举报/.test(row);
      const isToolbar = row.includes("收藏") && row.includes("转发") && row.includes("评论") && row.includes("赞");
      return hasUserTime && hasAction && !isToolbar;
    });

    return rows.length === 0;
  }).catch(() => false);
}

async function extractPostText(page, fallback) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => fallback || "");
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .join("\n")
    .slice(0, 1200);
}

function classifyPost(text) {
  if (/生日|生快|生日快乐/.test(text)) return "birthday";
  if (/演唱会|票|场馆|舞台|巡演/.test(text)) return "concert";
  if (/超like|超辣|title|头衔|签到|任务/.test(text)) return "supertopic";
  if (/图|照片|美图|视频|LIVE|物料|造型/.test(text)) return "visual";
  return "daily";
}

async function makeComment(postText, index) {
  if (!USE_AI_COMMENTS) {
    return SAMPLE_COMMENTS[(index - 1) % SAMPLE_COMMENTS.length];
  }

  const category = classifyPost(postText);
  const prompt = [
    "你要为华晨宇粉丝超话生成一条微博评论。",
    `轻量分类结果：${category}`,
    "要求：评论必须和帖子内容相关；学习样本的荒诞民俗感、火星人设、超话黑话、夸张类比；必须原创，不要复制样本原句，不要引用歌词；80到180个中文字符；可以自然包含@华晨宇yu。",
    "优质样本：",
    ...SAMPLE_COMMENTS.map((item, idx) => `样本${idx + 1}：${item}`),
    "帖子内容：",
    postText,
    '只返回 JSON，例如 {"comment":"..."}。'
  ].join("\n");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: "system",
          content: "你是一个会写微博粉丝超话评论的中文文案助手。只输出用户要求的 JSON。"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.9,
      max_tokens: 500,
      response_format: { type: "json_object" }
    })
  });

  const body = await response.text();
  if (!response.ok) {
    console.log(`DeepSeek generation failed: ${response.status} ${body}`);
    return SAMPLE_COMMENTS[(index - 1) % SAMPLE_COMMENTS.length];
  }

  const outputText = JSON.parse(body)?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObject(outputText);
  const comment = String(parsed.comment || "").trim();
  if (comment.length < 10 || comment.length > 240 || tooSimilarToSample(comment)) {
    return SAMPLE_COMMENTS[(index - 1) % SAMPLE_COMMENTS.length];
  }

  return comment;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return {};
}

function tooSimilarToSample(comment) {
  return SAMPLE_COMMENTS.some((sample) => sample.includes(comment.slice(0, 20)) || comment.includes(sample.slice(0, 20)));
}

async function openCommentTab(page) {
  const entries = [
    page.getByRole("tab", { name: /评论/ }).first(),
    page.getByRole("button", { name: /评论/ }).first(),
    page.locator('[aria-label*="评论"]').first(),
    page.locator("text=评论").first()
  ];

  for (const entry of entries) {
    if (await visible(entry)) {
      await entry.click().catch(() => {});
      return;
    }
  }
}

async function openCommentInput(page) {
  await openCommentTab(page);
  await page.waitForTimeout(600);

  const inputSelectors = [
    'textarea[placeholder*="评论"]',
    "textarea",
    '[contenteditable="true"]'
  ];

  for (const selector of inputSelectors) {
    const input = page.locator(selector).first();
    if (await visible(input)) return input;
  }

  return null;
}

async function clickSend(page) {
  const buttons = [
    page.getByRole("button", { name: /发送|评论|发布/ }).first(),
    page.getByText(/^发送$|^评论$|^发布$/).first()
  ];

  for (const button of buttons) {
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
  const squareScreenshot = `${base}-square.png`;
  const html = `${base}.html`;
  const visibleComment = await page.getByText(comment.slice(0, 24)).first().isVisible({ timeout: 1500 }).catch(() => false);

  await page.screenshot({ path: `artifacts/${screenshot}`, fullPage: true }).catch(() => {});
  await screenshotSquare(page, `artifacts/${squareScreenshot}`);
  await writeFile(`artifacts/${html}`, await page.content().catch(() => "")).catch(() => {});

  results.push({
    index,
    href,
    comment,
    screenshot,
    squareScreenshot,
    html,
    visibleComment,
    capturedAt: new Date().toISOString()
  });
}

async function screenshotSquare(page, filePath) {
  const viewport = page.viewportSize() || { width: 900, height: 900 };
  const size = Math.min(viewport.width, viewport.height, 900);
  await page.screenshot({
    path: filePath,
    clip: { x: 0, y: 0, width: size, height: size }
  }).catch(() => {});
}

async function writeVisualIndex() {
  const rows = results.map((item) => `
    <section>
      <h2>Comment ${item.index}</h2>
      <p><a href="${escapeHtml(item.href)}">${escapeHtml(item.href)}</a></p>
      <p><strong>Visible after submit:</strong> ${item.visibleComment ? "yes" : "not confirmed"}</p>
      <p><strong>Comment:</strong> ${escapeHtml(item.comment)}</p>
      <p><strong>Square screenshot:</strong> ${escapeHtml(item.squareScreenshot)}</p>
      <img src="${escapeHtml(item.screenshot)}" alt="comment ${item.index} screenshot">
    </section>
  `).join("\n");

  await writeFile("artifacts/index.html", `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Weibo First Comment Visual Check</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2328; }
    section { border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin: 16px 0; }
    img { display: block; width: min(100%, 1200px); border: 1px solid #d0d7de; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Weibo First Comment Visual Check</h1>
  <p>Captured comments: ${results.length}</p>
  ${rows || "<p>No successful comment screenshots were captured.</p>"}
</body>
</html>`).catch(() => {});

  await writeFile("artifacts/first-comment-report.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    targetUrl: TARGET_URL,
    maxComments: MAX_COMMENTS,
    comments: results
  }, null, 2)).catch(() => {});
}

async function isLoginPage(page) {
  const loginText = page.getByText(/登录|短信登录|扫码登录/).first();
  const passwordInput = page.locator('input[type="password"]').first();
  return (await visible(loginText)) || (await visible(passwordInput));
}

async function saveDebug(page, reason) {
  const safeReason = reason.replace(/[^a-z0-9_-]/gi, "_");
  await page.screenshot({
    path: `artifacts/first-comment-${safeReason}.png`,
    fullPage: true
  }).catch(() => {});

  await writeFile(`artifacts/first-comment-${safeReason}.html`, await page.content().catch(() => "")).catch(() => {});
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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
