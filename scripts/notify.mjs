import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MODE = process.env.NOTIFY_MODE || "auto";
const TO = process.env.NOTIFY_EMAIL_TO || "2948408582@qq.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "465");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

await main();

async function main() {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log("SMTP_USER or SMTP_PASS is missing; skip email notification.");
    return;
  }

  const report = await buildReport();
  const html = renderHtml(report);
  await sendMail({
    to: TO,
    subject: report.subject,
    html,
    images: report.images
  });
}

async function buildReport() {
  if (MODE === "sign") {
    return buildSignReport();
  }
  if (MODE === "first-comment") {
    return buildFirstCommentReport();
  }

  const hasFirstComment = await exists("artifacts/first-comment-report.json");
  return hasFirstComment ? buildFirstCommentReport() : buildSignReport();
}

async function buildSignReport() {
  const report = await readJson("artifacts/sign-report.json", { results: [] });
  const rows = report.results || [];
  return {
    subject: `微博签到汇报 ${formatShanghai(new Date())}`,
    title: "微博签到汇报",
    summary: rows.length ? `本次记录 ${rows.length} 个超话签到结果。` : "本次没有记录到签到结果。",
    rows: rows.map((item) => ({
      label: item.status === "signed" ? "签到成功" : "已签到",
      time: formatShanghai(new Date(item.signedAt || report.generatedAt || Date.now())),
      url: item.url,
      detail: item.method || ""
    })),
    images: []
  };
}

async function buildFirstCommentReport() {
  const report = await readJson("artifacts/first-comment-report.json", { comments: [] });
  const comments = report.comments || [];
  const images = [];

  const rows = [];
  for (const item of comments) {
    const cid = `comment-${item.index}`;
    if (item.squareScreenshot) {
      images.push({
        cid,
        path: path.join("artifacts", item.squareScreenshot)
      });
    }

    rows.push({
      label: `首评 ${item.index}`,
      time: formatShanghai(new Date(item.capturedAt || report.generatedAt || Date.now())),
      url: item.href,
      detail: item.comment,
      cid: item.squareScreenshot ? cid : ""
    });
  }

  return {
    subject: `微博抢首评汇报 ${comments.length}条 ${formatShanghai(new Date())}`,
    title: "微博抢首评汇报",
    summary: comments.length ? `本次成功评论 ${comments.length} 条。` : "本次没有成功评论。",
    rows,
    images
  };
}

function renderHtml(report) {
  const rows = report.rows.map((item) => {
    const image = item.cid ? `<p><img src="cid:${escapeHtml(item.cid)}" style="display:block;width:320px;height:320px;object-fit:cover;border:1px solid #ddd;border-radius:8px;" /></p>` : "";
    return `
      <section style="padding:14px 0;border-top:1px solid #eee;">
        <h2 style="font-size:16px;margin:0 0 8px;">${escapeHtml(item.label)}</h2>
        <p style="margin:4px 0;color:#555;">时间：${escapeHtml(item.time)}</p>
        <p style="margin:4px 0;"><a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></p>
        <p style="margin:8px 0;line-height:1.6;">${escapeHtml(item.detail)}</p>
        ${image}
      </section>
    `;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#222;">
  <main style="max-width:720px;margin:0 auto;padding:20px;">
    <h1 style="font-size:22px;margin:0 0 8px;">${escapeHtml(report.title)}</h1>
    <p style="color:#555;margin:0 0 16px;">${escapeHtml(report.summary)}</p>
    ${rows || '<p style="color:#555;">暂无明细。</p>'}
  </main>
</body>
</html>`;
}

async function sendMail({ to, subject, html, images }) {
  const boundary = `mixed-${Date.now()}`;
  const relatedBoundary = `related-${Date.now()}`;
  const chunks = [
    `From: ${SMTP_FROM}`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
    "",
    `--${relatedBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(html)
  ];

  for (const image of images) {
    const bytes = await readFile(image.path).catch(() => null);
    if (!bytes) {
      continue;
    }
    chunks.push(
      `--${relatedBoundary}`,
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${image.cid}>`,
      "Content-Disposition: inline",
      "",
      bytes.toString("base64").replace(/(.{76})/g, "$1\r\n")
    );
  }

  chunks.push(`--${relatedBoundary}--`, "");
  await smtpSend(chunks.join("\r\n"));
  console.log(`Notification email sent to ${to}.`);
}

async function smtpSend(message) {
  const tls = await import("node:tls");
  const socket = tls.connect(SMTP_PORT, SMTP_HOST, { servername: SMTP_HOST });

  await expect(socket, 220);
  await command(socket, `EHLO github-actions`, 250);
  await command(socket, "AUTH LOGIN", 334);
  await command(socket, Buffer.from(SMTP_USER).toString("base64"), 334);
  await command(socket, Buffer.from(SMTP_PASS).toString("base64"), 235);
  await command(socket, `MAIL FROM:<${SMTP_FROM}>`, 250);
  await command(socket, `RCPT TO:<${TO}>`, 250);
  await command(socket, "DATA", 354);
  socket.write(`${message}\r\n.\r\n`);
  await expect(socket, 250);
  await command(socket, "QUIT", 221);
  socket.end();
}

function command(socket, text, code) {
  socket.write(`${text}\r\n`);
  return expect(socket, code);
}

function expect(socket, code) {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk) => {
      data += chunk.toString("utf8");
      const lines = data.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        socket.off("data", onData);
        if (last.startsWith(String(code))) {
          resolve(data);
        } else {
          reject(new Error(`SMTP expected ${code}, got ${data}`));
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function formatShanghai(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "medium"
  }).format(date);
}

function encodeMimeWord(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function toBase64(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
