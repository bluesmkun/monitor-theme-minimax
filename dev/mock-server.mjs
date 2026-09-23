#!/usr/bin/env node
/**
 * 本地预览服务器 —— 模拟 monitor hub 的四个同源接口，用来在没有真实 hub 的情况下
 * 预览 / 调试 minimal 主题。
 *
 *   GET /api/me                        站点名、登录状态、公开页开关
 *   GET /api/nodes                     节点列表 + 实时指标
 *   GET /api/nodes/{id}/metrics        历史指标与延迟记录
 *   GET /api/ws                        每 2 秒推送一次节点快照（纯 Node 手写握手 + 文本帧）
 *
 * 其余路径一律回落到主题的 dist/index.html，与 hub 的行为一致。
 *
 *   node dev/mock-server.mjs [--port 9911]
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// --root 指向一个主题目录（含 dist/index.html），默认用仓库里的 minimal/。
// 用来验证「打包产物解开之后」能不能跑，而不只是源码目录。
const argRoot = process.argv.indexOf("--root");
const THEME_DIR = argRoot > -1 ? path.resolve(process.argv[argRoot + 1]) : path.join(ROOT, "minimal");
const INDEX = path.join(THEME_DIR, "dist", "index.html");

const argPort = process.argv.indexOf("--port");
const PORT = argPort > -1 ? Number(process.argv[argPort + 1]) : 9911;
// --freeze：WS 只推一次就保持静默。无头浏览器截图时页面必须能进入空闲，
// 否则持续的 2 秒推送会让 --virtual-time-budget 永远走不完。
const FREEZE = process.argv.includes("--freeze");
// --nows：拒绝 WebSocket 升级，主题回落到 5 秒轮询。用于让无头浏览器能进入空闲。
const NOWS = process.argv.includes("--nows");
// --closed：模拟「公开页在标签页打开期间被关掉」。首次 /api/me 仍说公开，之后
// /api/nodes 一律 401、/api/me 改口 public_page=false，用来验证主题会重查 /me 并
// 把访客送去后台，而不是停在一个不再更新的列表上。/admin/ 给一个可辨认的占位页。
const CLOSED = process.argv.includes("--closed");
// 用时间而不是调用次数翻转：次数会被任何一次 curl 消耗掉，结果不可复现。
const startedMs = Date.now();

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/* ------------------------------------------------------------------ 节点定义 */
const SPECS = [
  {
    id: 1, name: "香港 · CN2 GIA", sort: 1, country: "HK", online: true,
    os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.1.0-23-amd64", arch: "x86_64", virt: "kvm",
    cpu_name: "Intel(R) Xeon(R) Gold 6133 CPU @ 2.50GHz", cpu_cores: 2,
    mem_total: 2 * GB, swap_total: 1 * GB, disk_total: 40 * GB,
    agent_version: "0.9.4", price: 68, currency: "CNY", billing_cycle: "monthly",
    expires_at: "2027-03-01", traffic_limit: 500 * GB, traffic_mode: "sum", traffic_reset_day: 1,
    latency: [42, 36, 55], loss: [0, 0.3, 0.9]
  },
  {
    id: 2, name: "日本 · 东京 BGP", sort: 2, country: "JP", online: true,
    os: "Ubuntu 22.04.4 LTS", kernel: "5.15.0-105-generic", arch: "x86_64", virt: "kvm",
    cpu_name: "AMD EPYC 7763 64-Core Processor", cpu_cores: 4,
    mem_total: 8 * GB, swap_total: 2 * GB, disk_total: 80 * GB,
    agent_version: "0.9.4", price: 15.5, currency: "USD", billing_cycle: "yearly",
    expires_at: "2026-11-20", traffic_limit: 1 * 1024 * GB, traffic_mode: "max", traffic_reset_day: 15,
    latency: [68, 61, 82], loss: [0, 0, 0.4]
  },
  {
    id: 3, name: "新加坡 · 优化线路", sort: 3, country: "SG", online: true,
    os: "Alpine Linux 3.20", kernel: "6.6.32-0-lts", arch: "aarch64", virt: "lxc",
    cpu_name: "Ampere Altra Q80-30", cpu_cores: 1,
    mem_total: 1 * GB, swap_total: 0, disk_total: 20 * GB,
    agent_version: "0.9.3", price: 45, currency: "CNY", billing_cycle: "quarterly",
    expires_at: "2026-09-27", traffic_limit: 200 * GB, traffic_mode: "down", traffic_reset_day: 5,
    // 只有一路探测的机器：用来验证「没有可隔离的对象时」不出现图例、表格也只有一行
    probeIds: [1],
    latency: [96, 88, 118], loss: [0.8, 1.2, 2.1]
  },
  {
    id: 4, name: "美国 · 洛杉矶 CN2", sort: 4, country: "US", online: true,
    os: "Rocky Linux 9.4", kernel: "5.14.0-427.el9.x86_64", arch: "x86_64", virt: "kvm",
    cpu_name: "Intel(R) Xeon(R) E5-2696 v4 CPU @ 2.20GHz", cpu_cores: 2,
    mem_total: 4 * GB, swap_total: 1 * GB, disk_total: 60 * GB,
    agent_version: "0.9.4", price: 26, currency: "USD", billing_cycle: "semiannual",
    // 临近到期：用来验证「仅剩 N 天」的橙色胶囊（相对今天的几天后）
    expires_at: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    traffic_limit: 2 * 1024 * GB, traffic_mode: "sum", traffic_reset_day: 1,
    latency: [158, 172, 205], loss: [1.6, 2.4, 3.2]
  },
  {
    id: 5, name: "德国 · 法兰克福", sort: 5, country: "DE", online: false,
    os: "Debian GNU/Linux 11 (bullseye)", kernel: "5.10.0-30-amd64", arch: "x86_64", virt: "kvm",
    cpu_name: "Intel(R) Xeon(R) Silver 4210 CPU @ 2.20GHz", cpu_cores: 2,
    mem_total: 2 * GB, swap_total: 512 * MB, disk_total: 40 * GB,
    agent_version: "0.9.2", price: 5.9, currency: "EUR", billing_cycle: "monthly",
    expires_at: "2026-10-02", traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 0,
    latency: [0, 0, 0], loss: [0, 0, 0]
  },
  {
    id: 6, name: "韩国 · 首尔", sort: 6, country: "KR", online: true, fresh: true,
    os: "", kernel: "", arch: "", virt: "",
    cpu_name: "", cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0,
    agent_version: "", price: 0, currency: "CNY", billing_cycle: "",
    expires_at: null, traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 0,
    latency: [0, 0, 0], loss: [0, 0, 0]
  },
  {
    // 免费机：价格留空但已经接入，用来验证卡片和详情页把它显示成「免费」
    id: 7, name: "免费 · 甲骨文东京", sort: 7, country: "JP", online: true,
    os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0-45-generic", arch: "aarch64", virt: "kvm",
    cpu_name: "Ampere(R) Altra(R) Processor", cpu_cores: 4,
    mem_total: 24 * GB, swap_total: 4 * GB, disk_total: 200 * GB,
    agent_version: "0.9.4", price: 0, currency: "CNY", billing_cycle: "",
    expires_at: null, traffic_limit: 10 * 1024 * GB, traffic_mode: "sum", traffic_reset_day: 0,
    latency: [82, 76, 95], loss: [0.2, 0, 0.6]
  },
  {
    // 与 id=2 同在日本：用来验证「同一地区合并成一个亮点」以及
    // 「部分离线 = 橙色」（JP 两个节点，一个在线一个离线）
    id: 8, name: "日本 · 大阪", sort: 8, country: "JP", online: false,
    os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.1.0-23-amd64", arch: "x86_64", virt: "kvm",
    cpu_name: "Intel(R) Xeon(R) E5-2680 v4 CPU @ 2.40GHz", cpu_cores: 2,
    mem_total: 2 * GB, swap_total: 1 * GB, disk_total: 40 * GB,
    agent_version: "0.9.1", price: 30, currency: "CNY", billing_cycle: "monthly",
    // 已过期：用来验证「已过期 N 天」的红色胶囊
    expires_at: new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10),
    traffic_limit: 300 * GB, traffic_mode: "sum", traffic_reset_day: 1,
    latency: [0, 0, 0], loss: [0, 0, 0]
  }
];

const MONTH_START = "2026-09-01";

/** 累计流量在进程启动时固定，之后随时间缓慢增长，避免每次刷新都跳变。 */
const startedAt = Date.now();
const seed = {};
for (const s of SPECS) {
  const months = s.online ? 1.4 : 0.9;
  seed[s.id] = {
    total_rx: Math.round(s.mem_total * months * 3.1 + s.id * 137 * GB),
    total_tx: Math.round(s.mem_total * months * 0.9 + s.id * 41 * GB),
    month_rx: Math.round(s.mem_total * 0.62 * (s.id % 3 + 1)),
    month_tx: Math.round(s.mem_total * 0.21 * (s.id % 3 + 1)),
    day_rx: Math.round(s.mem_total * 0.05 * (s.id % 4 + 1)),
    day_tx: Math.round(s.mem_total * 0.017 * (s.id % 4 + 1))
  };
}

const wave = (t, period, amp, phase = 0) => (Math.sin(t / period + phase) + 1) / 2 * amp;
const jitter = (n) => (Math.random() - 0.5) * n;

/** 每个节点在进程启动时就已经开机了一段时间，uptime 由开机时刻推得。 */
const BOOT = {};
for (const s of SPECS) BOOT[s.id] = Date.now() - Math.round(86400 * (11 + s.id * 3) * 1000);

/** 节点实时快照。指标缺失的节点 metrics 为 null（模拟「已连接未上报」）。 */
function liveNode(s, t) {
  const base = {
    id: s.id, name: s.name, sort: s.sort, public: true, online: s.online, country: s.country,
    last_seen: s.online ? Math.round(Date.now() / 1000) : Math.round(Date.now() / 1000) - 3 * 3600 - 137,
    os: s.os, kernel: s.kernel, arch: s.arch, virt: s.virt,
    cpu_name: s.cpu_name, cpu_cores: s.cpu_cores,
    mem_total: s.mem_total, swap_total: s.swap_total, disk_total: s.disk_total,
    agent_version: s.agent_version, price: s.price, currency: s.currency, billing_cycle: s.billing_cycle,
    expires_at: s.expires_at, traffic_limit: s.traffic_limit, traffic_mode: s.traffic_mode,
    traffic_reset_day: s.traffic_reset_day,
    total_rx: seed[s.id].total_rx + Math.round((Date.now() - startedAt) / 1000 * 24000),
    total_tx: seed[s.id].total_tx + Math.round((Date.now() - startedAt) / 1000 * 7000),
    month_rx: seed[s.id].month_rx, month_tx: seed[s.id].month_tx,
    month_start: MONTH_START, day_rx: seed[s.id].day_rx, day_tx: seed[s.id].day_tx,
    metrics: null
  };
  if (!s.online || s.fresh) return base;

  const cpu = s.id === 3 ? 4 + wave(t, 9000, 6) + jitter(1.6)
    : s.id === 2 ? 22 + wave(t, 14000, 26, 1.1) + jitter(4)
    : s.id === 4 ? 12 + wave(t, 11000, 14, 2.2) + jitter(3)
    : 9 + wave(t, 17000, 11, 0.4) + jitter(2.5);
  const memUsed = s.mem_total * (s.id === 2 ? 0.58 : s.id === 4 ? 0.44 : 0.36) + s.mem_total * 0.03 * Math.sin(t / 21000);
  const diskUsed = s.disk_total * (s.id === 2 ? 0.62 : s.id === 4 ? 0.71 : 0.29);
  const rx = (s.id === 3 ? 40 : s.id === 4 ? 1.1e6 : 2.4e6) * (0.6 + wave(t, 7000, 1.6, s.id));
  const tx = rx * (0.22 + wave(t, 9000, 0.3, s.id + 1));
  base.metrics = {
    uptime: Math.round((Date.now() - BOOT[s.id]) / 1000),
    cpu: Math.max(0, Math.min(100, cpu)),
    load: [Math.max(0, cpu / 100 * s.cpu_cores + jitter(0.1)), 0, 0].map((v, i) => +(v * (1 - i * 0.12)).toFixed(2)),
    mem_total: s.mem_total, mem_used: Math.round(memUsed),
    swap_total: s.swap_total, swap_used: Math.round(s.swap_total * 0.06),
    disk_total: s.disk_total, disk_used: Math.round(diskUsed),
    net_rx: Math.round(rx), net_tx: Math.round(tx),
    total_rx: base.total_rx, total_tx: base.total_tx,
    month_rx: base.month_rx, month_tx: base.month_tx,
    tcp: 120 + Math.round(wave(t, 30000, 180, s.id)), udp: 18 + Math.round(wave(t, 20000, 30, s.id)),
    procs: 96 + Math.round(wave(t, 40000, 40, s.id))
  };
  return base;
}

function allNodes() {
  const t = Date.now();
  return SPECS.map((s) => liveNode(s, t));
}

/* --------------------------------------------------------------- 历史数据 */
// 三网探测 + 一路教育网。hub 的探测名字随样本下发（响应里的 probes），主题按 id 分组画线。
const PROBES = { 1: "电信 163", 2: "联通 4837", 3: "移动 CMIN2", 4: "教育网 CERNET" };

/** 历史指标点。按 hours 与 points 生成，points 只会让曲线更稀。 */
function historyMetrics(id, hours, points) {
  const s = SPECS.find((x) => x.id === id);
  if (!s || !s.online || s.fresh) return [];
  const stepMs = Math.max(60_000, Math.min(5 * 60_000, (hours * 3600_000) / Math.max(1, points)));
  const now = Date.now();
  const from = now - hours * 3600_000;
  const out = [];
  for (let ts = from; ts <= now; ts += stepMs) {
    const t = ts - from;
    const cpu = s.id === 2 ? 22 + wave(t, 14000, 26, 1.1) + jitter(4)
      : s.id === 4 ? 12 + wave(t, 11000, 14, 2.2) + jitter(3)
      : s.id === 3 ? 4 + wave(t, 9000, 6) + jitter(1.6)
      : 9 + wave(t, 17000, 11, 0.4) + jitter(2.5);
    const rx = (s.id === 3 ? 40 : s.id === 4 ? 1.1e6 : 2.4e6) * (0.6 + wave(t, 7000, 1.6, s.id));
    out.push({
      ts: Math.round(ts / 1000),
      cpu: +Math.max(0, Math.min(100, cpu)).toFixed(2),
      mem_used: Math.round(s.mem_total * (s.id === 2 ? 0.58 : s.id === 4 ? 0.44 : 0.36) + s.mem_total * 0.03 * Math.sin(t / 21000)),
      disk_used: Math.round(s.disk_total * (s.id === 2 ? 0.62 : s.id === 4 ? 0.71 : 0.29)),
      net_rx: Math.round(rx), net_tx: Math.round(rx * (0.22 + wave(t, 9000, 0.3, s.id + 1)))
    });
  }
  return out;
}

/** 延迟记录。latency 为桶中位往返，超时给 null；band 是跨度；loss 是桶内丢包。 */
function historyPing(id, hours, points) {
  const s = SPECS.find((x) => x.id === id);
  if (!s || !s.online || s.fresh) return { ping: [], probes: {}, loss: {} };
  const stepMs = Math.max(60_000, Math.min(5 * 60_000, (hours * 3600_000) / Math.max(1, points)));
  const now = Date.now();
  const from = now - hours * 3600_000;
  const ping = [];
  const loss = {};
  // 按 taskId 取参数，不能用 forEach 的下标——上面 filter 过，下标和探测 id 不再对应
  [1, 2, 3].filter((id) => !s.probeIds || s.probeIds.includes(id)).forEach((taskId) => {
    const k = taskId - 1;
    const baseLat = s.latency[k];
    if (!baseLat) return;
    let dropped = 0, total = 0;
    for (let ts = from; ts <= now; ts += stepMs) {
      const t = ts - from;
      const night = 1 + 0.18 * Math.sin((t / 3600_000) * Math.PI * 2 - 1.2);
      const v = baseLat * night + wave(t, 21000, baseLat * 0.12, taskId) + jitter(baseLat * 0.06);
      const spike = Math.random() < 0.004;
      total++;
      const dead = Math.random() < (s.loss[k] / 100) || (spike && Math.random() < 0.5);
      if (dead) dropped++;
      ping.push({
        task_id: taskId,
        ts: Math.round(ts / 1000),
        latency: dead ? null : +v.toFixed(1),
        ...(dead ? {} : { band: [+(v * 0.94).toFixed(1), +(v * 1.07).toFixed(1)] }),
        ...(dead ? { loss: 100 } : {})
      });
    }
    if (total && dropped) loss[taskId] = +(dropped / total * 100).toFixed(2);
  });
  ping.sort((a, b) => a.ts - b.ts);
  return { ping, probes: PROBES, loss };
}

/* --------------------------------------------------------------- HTTP 服务 */
const json = (res, body, status = 200) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store" });
  res.end(buf);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/me") {
    // 头 1.5 秒仍说公开，让主题先把列表渲染出来；之后改口，触发运行期关闭的路径。
    const open = !CLOSED || Date.now() - startedMs < 1500;
    return json(res, { authed: false, github: false, site_name: "极简探针 · 演示", public_page: open });
  }
  if (p === "/api/nodes") {
    if (CLOSED) return json(res, { error: "public page closed" }, 401);
    return json(res, { nodes: allNodes() });
  }
  if (CLOSED && p.startsWith("/admin")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><title>ADMIN</title><h1>后台占位页</h1>");
  }
  const m = p.match(/^\/api\/nodes\/(\d+)\/metrics$/);
  if (m) {
    const id = Number(m[1]);
    const hours = Number(url.searchParams.get("hours") || 1);
    const points = Number(url.searchParams.get("points") || 600);
    const series = url.searchParams.get("series") || "metrics";
    const out = {};
    if (series !== "ping") out.metrics = historyMetrics(id, hours, points);
    if (series !== "metrics") Object.assign(out, historyPing(id, hours, points));
    return json(res, out);
  }
  if (p.startsWith("/api/")) return json(res, { error: "not found" }, 404);

  // 与 hub 一致：未知路径回落到主题的 dist/index.html
  fs.readFile(INDEX, (err, buf) => {
    if (err) { res.writeHead(500); return res.end("index.html not found"); }
    let html = buf.toString("utf8");
    // 仅供预览：?dark=1 时先写入 localStorage，让主题按深色启动（无头浏览器
    // 没有可靠的办法去改 prefers-color-scheme）。
    if (url.searchParams.get("dark") === "1") {
      html = html.replace("<head>", '<head><script>try{localStorage.setItem("theme","dark")}catch(e){}</script>');
    }
    // 仅供预览：?q= / ?group= / ?popup= 直接把主界面的状态摆好，
    // 用来在无头环境里截取筛选、分组、地图弹窗的样子。
    // 主题脚本是普通 script，顶层 var 会挂到 window 上，所以这里能直接改。
    const q = url.searchParams.get("q");
    const group = url.searchParams.get("group");
    const pop = url.searchParams.get("popup");
    if (q !== null || group !== null || pop !== null) {
      html = html.replace("</body>", `<script>
setTimeout(function(){
  try {
    if (${JSON.stringify(q)} !== null) { list.q = ${JSON.stringify(q)}; var i = document.getElementById("q"); if (i) i.value = list.q; }
    if (${JSON.stringify(group)} !== null) {
      list.group = ${JSON.stringify(group)};
      var bs = document.querySelectorAll('[data-act="group"]');
      for (var k = 0; k < bs.length; k++) bs[k].classList.toggle("on", bs[k].getAttribute("data-mode") === list.group);
    }
    if (typeof renderListBody === "function") renderListBody();
    var clr = document.querySelector('[data-act="clear-q"]');
    if (clr) clr.hidden = !list.q;
    if (${JSON.stringify(pop)} !== null) openRegionPopup(${JSON.stringify(pop)});
  } catch (e) { document.title = "HOOK ERR " + e.message; }
}, 2000);
</script></body>`);
    }
    // 仅供预览：?probe=tools 报出工具栏里搜索框与分组控件的位置和尺寸，
    // 用来判断「两者是否等高、是否对齐」。
    if (url.searchParams.get("probe") === "tools") {
      html = html.replace("</body>", `<script>
setTimeout(function(){
  var t = document.querySelector(".tools");
  if (!t) { document.title = "NO TOOLS"; return; }
  var out = ["tools w=" + Math.round(t.getBoundingClientRect().width)];
  [".search", ".tools .seg"].forEach(function(sel){
    var el = t.querySelector(sel.replace(".tools ", ""));
    if (!el) { out.push(sel + "=缺失"); return; }
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    out.push(sel + " top=" + Math.round(r.top) + " left=" + Math.round(r.left) + " w=" + Math.round(r.width) +
      " h=" + Math.round(r.height) + " radius=" + cs.borderTopLeftRadius + " right=" + Math.round(r.right));
  });
  var bs = t.querySelectorAll(".seg button");
  if (bs.length) {
    var b0 = bs[0].getBoundingClientRect();
    out.push("首按钮 w=" + Math.round(b0.width) + " h=" + Math.round(b0.height) + " font=" + getComputedStyle(bs[0]).fontSize);
  }
  document.title = out.join(" | ");
}, 1800);
</script></body>`);
    }
    // 仅供预览：?probe=table 报出探测表各单元格的横向位置，用来判断
    // 「某个元素出现后有没有把别的列挤走」。
    if (url.searchParams.get("probe") === "table") {
      html = html.replace("</body>", `<script>
setTimeout(function(){
  var t = document.querySelector("table.probes");
  if (!t) { document.title = "NO TABLE"; return; }
  var out = ["table w=" + Math.round(t.getBoundingClientRect().width) +
    " layout=" + getComputedStyle(t).tableLayout];
  var rows = t.querySelectorAll("tbody tr");
  [].forEach.call(rows, function(tr, ri){
    var cells = [].map.call(tr.children, function(td){
      var r = td.getBoundingClientRect();
      return Math.round(r.left) + "+" + Math.round(r.width);
    });
    out.push("row" + ri + " " + cells.join(" "));
  });
  out.push("tag数=" + t.querySelectorAll(".tag").length);
  document.title = out.join(" | ");
}, 3200);   // 必须晚于 ?click 的点击序列，否则量到的是点击前的状态
</script></body>`);
    }
    // 仅供预览：?probe=geo 把关键元素的几何写进 title，用 --dump-dom 读出来。
    // 判断「有没有对齐」要靠量，不能靠看截图猜。
    if (url.searchParams.get("probe") === "geo") {
      html = html.replace("</body>", `<script>
setTimeout(function(){
  var card = document.querySelector(".card");
  if (!card) { document.title = "NO CARD"; return; }
  var cr = card.getBoundingClientRect();
  var cs = getComputedStyle(card);
  var out = ["card right=" + Math.round(cr.right) + " paddingR=" + cs.paddingRight];
  [".price", ".crow", ".rates", ".crow.small"].forEach(function(sel){
    var el = card.querySelector(sel);
    if (!el) { out.push(sel + "=缺失"); return; }
    var r = el.getBoundingClientRect();
    out.push(sel + " top=" + Math.round(r.top) + " left=" + Math.round(r.left) + " right=" + Math.round(r.right) +
      " w=" + Math.round(r.width) + " display=" + getComputedStyle(el).display +
      " tag=" + el.tagName + " text=" + JSON.stringify((el.textContent || "").trim().slice(0, 14)));
  });
  document.title = out.join(" | ");
}, 1500);
</script></body>`);
    }
    // 仅供预览：?click=smooth,base2 —— 渲染完成后依次点击，用来在无头环境里
    // 截取交互后的状态（按钮、图例选中态），省得为了看一眼去装整套浏览器自动化。
    const clicks = url.searchParams.get("click");
    if (clicks) {
      const steps = clicks.split(",").map((s) => s.trim()).filter(Boolean);
      html = html.replace("</body>", `<script>
(function(){
  var ALIAS = {
    smooth: '[data-act="lat-toggle"][data-mode="smooth"]',
    despike: '[data-act="lat-toggle"][data-mode="despike"]',
    only1: '.legend .leg:nth-child(1)',
    only2: '.legend .leg:nth-child(2)',
    only3: '.legend .leg:nth-child(3)',
    range6: '[data-act="range"][data-kind="latency"][data-h="6"]'
  };
  var steps = ${JSON.stringify(steps)}, i = 0;
  function step(){
    if (i >= steps.length) return;
    var sel = ALIAS[steps[i]] || steps[i];
    i++;
    var el = document.querySelector(sel);
    if (el) el.click();
    setTimeout(step, 700);
  }
  // 首屏要等主题把数据取回来并渲染完，再开始点
  setTimeout(step, 1600);
})();
</script></body>`);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
});

/* --------------------------------------------- 最小 WebSocket（仅服务端文本帧） */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function frame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  return Buffer.concat([head, payload]);
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key || !req.url.startsWith("/api/ws") || NOWS) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const push = () => {
    if (socket.destroyed) return;
    try { socket.write(frame(JSON.stringify({ nodes: allNodes() }))); } catch { /* 客户端已断开 */ }
  };
  push();
  if (FREEZE) return;
  const timer = setInterval(push, 2000);
  const bye = () => { clearInterval(timer); socket.destroy(); };
  socket.on("close", bye);
  socket.on("error", bye);
  socket.on("data", () => {}); // 客户端不会发消息，读掉即可
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("极简探针 · 本地预览  http://127.0.0.1:" + PORT + "/");
  console.log("主题目录 " + THEME_DIR);
});
