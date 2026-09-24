#!/usr/bin/env node
/**
 * 用 CDP 截图，并且能**强制元素的伪类状态**（:hover / :focus 等）。
 *
 * 为什么不用 `Edge --screenshot`：命令行只能截静置态。主题里卡片、按钮、地图亮点
 * 都有悬停态，想核对这些态的样子——尤其是「深色下悬停阴影还看不看得见」——
 * 只能靠 CDP 的 CSS.forcePseudoState。
 *
 *   node dev/cdp-shot.mjs <url> <out.png> [--hover <选择器>] [--wait <ms>] [--size 1400x760]
 *                                          [--clip <选择器|x,y,w,h>] [--pad 24] [--scale 2]
 *
 * 例：
 *   node dev/cdp-shot.mjs "http://127.0.0.1:9920/?dark=1" /tmp/hover.png --hover ".card" --clip ".card"
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error("用法: node dev/cdp-shot.mjs <url> <out.png> [--hover 选择器] [--wait ms] [--size 1400x760]");
  process.exit(2);
}
const opt = (name, dflt) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : dflt; };
const hoverSel = opt("--hover", null);
const waitMs = Number(opt("--wait", 4000));
const [W, H] = opt("--size", "1400x760").split("x").map(Number);
// --clip 既接受选择器（裁到该元素四周留 --pad 像素），也接受 x,y,w,h。
// 裁到卡片级别才看得清阴影这种几像素的差别。
const clipArg = opt("--clip", null);
const pad = Number(opt("--pad", 24));
const scale = Number(opt("--scale", 2));
// --css <文本>：注入一段样式。做「改前 / 改后」对照时不必来回改源文件，
// 直接在页面上把变量覆盖成旧值就能截到改前的样子。
const cssArg = opt("--css", null);

const EDGE = process.env.EDGE_BIN || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = Number(opt("--port", 9333));
const profile = "/tmp/edge-cdp-" + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-proxy-server",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--window-size=" + W + "," + H, "about:blank",
], { stdio: "ignore" });

async function devtoolsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + PORT + "/json/version");
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error("DevTools 未就绪");
}

function makeSend(ws) {
  const pending = new Map();
  let seq = 0;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  return (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
}

function cleanup(code) {
  try { edge.kill("SIGKILL"); } catch { /* 已退出 */ }
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(code);
}

try {
  const ws = new WebSocket(await devtoolsUrl());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const send = makeSend(ws);

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S("Page.enable");
  await S("DOM.enable");
  await S("CSS.enable");
  await S("Page.navigate", { url });
  await sleep(waitMs);

  if (cssArg) {
    await S("Runtime.evaluate", {
      expression: "(()=>{const s=document.createElement('style');s.textContent=" + JSON.stringify(cssArg) +
        ";document.head.appendChild(s)})()",
    });
    await sleep(250);
  }

  if (hoverSel) {
    const { root } = await S("DOM.getDocument", { depth: -1 });
    const { nodeId } = await S("DOM.querySelector", { nodeId: root.nodeId, selector: hoverSel });
    if (!nodeId) throw new Error("找不到选择器：" + hoverSel);
    await S("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    await sleep(500);   // 等 transition（卡片是 .18s）走完再截
  }

  const shot = { format: "png" };
  if (clipArg) {
    let box;
    if (/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(clipArg)) {
      const [x, y, w, h] = clipArg.split(",").map(Number);
      box = { x, y, w, h };
    } else {
      const { result } = await S("Runtime.evaluate", {
        expression: "(()=>{const e=document.querySelector(" + JSON.stringify(clipArg) +
          ");if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()",
        returnByValue: true,
      });
      if (!result.value) throw new Error("裁剪目标找不到：" + clipArg);
      box = JSON.parse(result.value);
    }
    shot.clip = {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: box.w + pad * 2, height: box.h + pad * 2, scale,
    };
  }

  const { data } = await S("Page.captureScreenshot", shot);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log("已保存 " + out + (hoverSel ? "（强制 :hover 于 " + hoverSel + "）" : ""));
  ws.close();
  cleanup(0);
} catch (e) {
  console.error("失败: " + e.message);
  cleanup(1);
}
