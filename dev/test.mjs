#!/usr/bin/env node
/**
 * 主题自测。没有测试框架，Node 直接跑，失败时退出码非零。
 *
 *   node dev/test.mjs
 *
 * 覆盖三类容易出错、且不依赖浏览器渲染的逻辑：
 *   1. 数字格式化与时长换算的边界（0、负数、小数、NaN、缺字段）
 *   2. 费用折算与多币种分组（hub 不提供汇率，合并就是错的）
 *   3. 坏数据降级（一个节点的畸形指标不能拖垮整页）
 *
 * 做法：给主题脚本喂一个最小 DOM 桩后整体求值。脚本是普通 script 而非模块，
 * 顶层 function 声明会挂到 vm 的全局对象上，于是可以直接取来调用。boot() 会立刻
 * 请求 /api/me，这里让 fetch 永远 pending，脚本就停在「等首屏数据」，不会继续渲染。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "minimal", "dist", "index.html");

const html = fs.readFileSync(ENTRY, "utf8");
const found = html.match(/<script>([\s\S]*)<\/script>/);
if (!found) {
  console.error("在 " + ENTRY + " 里找不到主题脚本");
  process.exit(1);
}

function stubEl() {
  return {
    innerHTML: "", outerHTML: "", textContent: "", style: {}, dataset: {}, children: [], title: "",
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0 }),
  };
}

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, Intl, RegExp, Error, isFinite, isNaN,
  fetch: () => new Promise(() => {}),
  location: { protocol: "http:", host: "127.0.0.1:9911", pathname: "/", href: "/" },
  history: { pushState() {} },
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  WebSocket: function WebSocket() { this.close = () => {}; },
  document: {
    documentElement: stubEl(),
    body: stubEl(),
    title: "",
    visibilityState: "visible",
    getElementById: () => stubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => stubEl(),
    addEventListener() {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(found[1], sandbox, { filename: "minimal/dist/index.html" });

const T = sandbox;

/* ------------------------------------------------------------------ 断言 */
let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual) ?? String(actual);
  const e = JSON.stringify(expected) ?? String(expected);
  if (a === e) pass++;
  else failures.push(label + "\n      期望 " + e + "\n      实际 " + a);
}
function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label + "\n      期望 真值，实际为假");
}

/* ------------------------------------------------------- 1. 格式化边界 */
eq(T.bytes(0), "0 B", "bytes(0)：零必须是 0 B");
eq(T.bytes(-5), "0 B", "bytes(-5)：负数不能算出负的指数");
eq(T.bytes(0.5), "0 B", "bytes(0.5)：不足 1 字节时 log 为负，unitOf 会取到 -1");
eq(T.bytes(NaN), "0 B", "bytes(NaN)");
eq(T.bytes(undefined), "0 B", "bytes(undefined)：字段可能不存在");
eq(T.bytes(1024), "1.00 KB", "bytes(1024)");
eq(T.bytes(1024 ** 3), "1.00 GB", "bytes(1 GiB)");
eq(T.bytes(1500 * 1024 ** 4), "1.46 PB", "bytes(1500 TiB)：跨到 PB 仍保留两位");

eq(T.pair(0, 1024), "0 B / 1.00 KB", "pair：used 为 0 时单位无法共享，退回 bytes()");
eq(T.pair(1024, 2048), "1.00 / 2.00 KB", "pair：同单位时只写一次单位");
eq(T.pairShort(793 * 1024 ** 2, 2 * 1024 ** 3), "0.77 / 2.00 GB",
  "pairShort：跨单位时把已用换算到总量的单位上，卡片上才放得下");
eq(T.pairShort(11.6 * 1024 ** 3, 40 * 1024 ** 3), "11.60 / 40.00 GB", "pairShort：同单位");
eq(T.pairShort(0, 1024), "0.00 / 1.00 KB",
  "pairShort：已用为 0 仍用总量的单位——0 在这个格式里表示得出来，不必像 pair() 那样退回");
eq(T.pairShort(5, 0), "5 B / 0 B", "pairShort：总量为 0 时退回 pair()");
eq(T.pairShort(NaN, 1024), "0 B / 1.00 KB", "pairShort：已用缺失时退回 pair()");

eq(T.percent(0, 0), 0, "percent(0,0)：不能是 NaN");
eq(T.percent(50, 100), 50, "percent(50,100)");
eq(T.percent(200, 100), 100, "percent：上限 100");
eq(T.percent(10, undefined), 0, "percent：分母缺失时为 0");

eq(T.uptime(0), "—", "uptime(0)");
eq(T.uptime(-1), "—", "uptime(-1)");
eq(T.uptime(90), "1 分", "uptime(90s)");
eq(T.uptime(3661), "1 小时 1 分", "uptime(3661s)");
eq(T.uptime(86400), "1 天 0 小时", "uptime(1d)");

eq(T.uptimeShort(0), "", "uptimeShort(0)：徽标里不显示空时长");
eq(T.uptimeShort(60), "1 分", "uptimeShort(60s)");
eq(T.uptimeShort(3600), "1 小时", "uptimeShort(1h)");
eq(T.uptimeShort(86400 * 3 + 7200), "3 天", "uptimeShort：只留最大一档");

eq(T.daysUntil(null), null, "daysUntil(null)");
eq(T.daysUntil(""), null, "daysUntil('')");
eq(T.daysUntil("不是日期"), null, "daysUntil：非法日期不能算出 NaN 天");
{
  const d = new Date(Date.now() + 3 * 86400000);
  const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  eq(T.daysUntil(iso), 3, "daysUntil：3 天后");
}

eq(T.money(6, "CNY"), "¥6.00", "money：已知币种用符号");
eq(T.money(6, "XYZ"), "6.00 XYZ", "money：未知币种退回代码");
eq(T.money(undefined, "CNY"), "—", "money(undefined)");
eq(T.money(NaN, "CNY"), "—", "money(NaN)");

/* 到期提示分级：过期红 / ≤7 橙 / 8–30 浅橙 / >30 中性。
   四种状态**一律是胶囊**，只换颜色不换形状——否则同一列里一有一无、一高一矮，看着就是错位。
   阈值放 30 天是刻意的：只标 7 天的话，半个月后到期在列表里几乎看不见。 */
eq(T.expiryHTML(null, true), "", "expiryHTML：无到期日不渲染");
eq(T.expiryHTML(-3, true), '<span class="exp pill bad">已过期 3 天</span>', "expiryHTML：过期走红色胶囊");
eq(T.expiryHTML(0, true), '<span class="exp pill warn">仅剩 0 天</span>', "expiryHTML：当天算橙色胶囊");
eq(T.expiryHTML(7, true), '<span class="exp pill warn">仅剩 7 天</span>', "expiryHTML：第 7 天仍是橙色");
eq(T.expiryHTML(8, true), '<span class="exp pill soon">8 天后到期</span>', "expiryHTML：第 8 天降为浅橙");
eq(T.expiryHTML(30, true), '<span class="exp pill soon">30 天后到期</span>', "expiryHTML：第 30 天仍是浅橙");
eq(T.expiryHTML(31, true), '<span class="exp pill calm">31 天后到期</span>', "expiryHTML：第 31 天起转中性胶囊（形状不变）");
eq(T.expiryHTML(31, false), '<span class="exp pill calm">31 天后</span>', "expiryHTML：短版不带「到期」二字");
ok(/pill/.test(T.expiryHTML(365, true)), "expiryHTML：远期也必须带 pill——统一形状是对齐的前提");
eq(T.expiryText({ expires_at: null }), '<span class="exp pill calm" title="永不到期">∞</span>', "expiryText：无到期日也是胶囊，保持右列整齐");

eq(T.esc('<b a="1">&</b>'), "&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;", "esc：转义尖括号、引号与 &");
eq(T.esc(null), "", "esc(null)");
eq(T.esc(undefined), "", "esc(undefined)");

/* ------------------------------------------------------- 2. 费用与流量 */
eq(T.monthUsage({ traffic_mode: "up", month_rx: 10, month_tx: 3 }), 3, "monthUsage：仅上行");
eq(T.monthUsage({ traffic_mode: "down", month_rx: 10, month_tx: 3 }), 10, "monthUsage：仅下行");
eq(T.monthUsage({ traffic_mode: "max", month_rx: 10, month_tx: 3 }), 10, "monthUsage：取较大");
eq(T.monthUsage({ traffic_mode: "sum", month_rx: 10, month_tx: 3 }), 13, "monthUsage：双向合计");
eq(T.monthUsage({ month_rx: 10, month_tx: 3 }), 13, "monthUsage：模式缺失时按双向");
eq(T.monthUsage({ traffic_mode: "sum" }), 0, "monthUsage：字段缺失不能是 NaN");

eq(T.monthlyCost({ billing_cycle: "monthly", price: 6 }), 6, "monthlyCost：月付");
eq(T.monthlyCost({ billing_cycle: "quarterly", price: 45 }), 15, "monthlyCost：季付折月");
eq(T.monthlyCost({ billing_cycle: "yearly", price: 120 }), 10, "monthlyCost：年付折月");
eq(T.monthlyCost({ billing_cycle: "triennial", price: 360 }), 10, "monthlyCost：三年付折月");
eq(T.monthlyCost({ billing_cycle: "once", price: 50 }), null, "monthlyCost：一次性无法折月");
eq(T.monthlyCost({ price: 6 }), null, "monthlyCost：周期缺失");
eq(T.monthlyCost({ billing_cycle: "monthly", price: 0 }), null, "monthlyCost：未计费");

{
  const totals = T.costTotals([
    { billing_cycle: "monthly", price: 6, currency: "CNY" },
    { billing_cycle: "monthly", price: 3, currency: "CNY" },
    { billing_cycle: "yearly", price: 12, currency: "USD" },
    { billing_cycle: "once", price: 99, currency: "CNY" },
  ]);
  eq(totals, ["¥9.00", "$1.00"], "costTotals：按币种分组，不做汇率换算");
  eq(T.costTotals([]), [], "costTotals：空列表");
  eq(T.costTotals([{ billing_cycle: "monthly", price: 5 }]), ["¥5.00"], "costTotals：币种缺失时按 CNY");
}

/* --------------------------------------------------- 3. 坏数据降级 */
const good = {
  id: 1, name: "好节点", online: true,
  metrics: {
    uptime: 100, cpu: 10, load: [0.1, 0.2, 0.3],
    mem_total: 100, mem_used: 50, swap_total: 0, swap_used: 0,
    disk_total: 100, disk_used: 20, net_rx: 1, net_tx: 1,
    total_rx: 1, total_tx: 1, month_rx: 1, month_tx: 1, tcp: 1, udp: 1, procs: 1,
  },
};
ok(T.validMetrics(good.metrics), "validMetrics：完整指标通过");
ok(!T.validMetrics(null), "validMetrics：null 不通过");
ok(!T.validMetrics({}), "validMetrics：空对象不通过");
ok(!T.validMetrics(Object.assign({}, good.metrics, { procs: undefined })), "validMetrics：字段缺失不通过");
ok(!T.validMetrics(Object.assign({}, good.metrics, { cpu: -1 })), "validMetrics：负值不通过");
ok(!T.validMetrics(Object.assign({}, good.metrics, { cpu: "10" })), "validMetrics：字符串不通过");
ok(!T.validMetrics(Object.assign({}, good.metrics, { load: [1, 2] })), "validMetrics：load 长度不为 3 不通过");
ok(!T.validMetrics(Object.assign({}, good.metrics, { load: [1, 2, null] })), "validMetrics：load 含非数字不通过");

eq(T.safeNodes("不是数组"), [], "safeNodes：非数组输入");
eq(T.safeNodes(null), [], "safeNodes：null 输入");
{
  const bad = { id: 2, name: "坏节点", online: true, metrics: { cpu: "坏了" } };
  const offline = { id: 3, name: "离线节点", online: false, metrics: null };
  const out = T.safeNodes([good, bad, offline, null]);
  eq(out.length, 3, "safeNodes：丢弃非对象元素，保留其余");
  ok(out[0].metrics !== null, "safeNodes：好节点指标原样保留");
  eq(out[1].metrics, null, "safeNodes：坏数据只把该节点的 metrics 置空");
  eq(out[1].name, "坏节点", "safeNodes：置空指标不影响其它字段");
  eq(out[2].metrics, null, "safeNodes：离线节点保持 null");
}

eq(T.nodeState({ online: false }), "offline", "nodeState：离线");
eq(T.nodeState({ online: true, metrics: null }), "pending", "nodeState：已连接未上报");
eq(T.nodeState({ online: true, metrics: good.metrics }), "online", "nodeState：在线");

/* ------------------------------------------- 4. 延迟样本与迷你曲线 */
{
  const resp = {
    ping: [
      { task_id: 1, ts: 100, latency: 10 },
      { task_id: 2, ts: 100, latency: 100 },
      { task_id: 1, ts: 200, latency: null, loss: 100 },
      { task_id: 2, ts: 200, latency: 110 },
      { task_id: 1, ts: 300, latency: 12 },
      { task_id: 2, ts: 300, latency: 120 },
    ],
    probes: { 1: "电信 163", 2: "联通 4837" },
    loss: { 1: 4.5 },
  };
  const s = T.pingSummary(resp);
  eq(s.probes.length, 2, "pingSummary：按 task_id 分组");
  eq(s.probes[0].name, "电信 163", "pingSummary：名字取自响应的 probes");
  eq(s.probes[1].name, "联通 4837", "pingSummary：第二路");
  eq(s.probes[0].last, 12, "pingSummary：last 取最后一个非空样本，跳过超时");
  eq(s.probes[0].min, 10, "pingSummary：min 忽略 null");
  eq(s.probes[0].max, 12, "pingSummary：max 忽略 null");
  eq(s.probes[0].avg, 11, "pingSummary：avg 只对非空样本求平均");
  eq(s.probes[0].loss, 4.5, "pingSummary：loss 取自响应的 loss");
  eq(s.probes[1].loss, 0, "pingSummary：未丢包的探测 loss 为 0");
  eq(s.probes[0].points.length, 3, "pingSummary：点数与样本一致");
  eq(s.probes[0].points[0], { x: 100000, y: 10 }, "pingSummary：x 换算成毫秒");
  eq(s.probes[0].points[1], { x: 200000, y: null }, "pingSummary：超时样本留成 null，曲线在那里断开");
}
eq(T.pingSummary(null), null, "pingSummary：没有响应");
eq(T.pingSummary({}), null, "pingSummary：响应里没有 ping 字段");
eq(T.pingSummary({ ping: [] }).probes, [], "pingSummary：空样本");
{
  const s = T.pingSummary({ ping: [{ task_id: 9, ts: 1, latency: 5 }] });
  eq(s.probes[0].name, "探测 9", "pingSummary：名字缺失时回退");
  eq(s.probes[0].last, 5, "pingSummary：单点也有 last");
  eq(s.probes[0].avg, 5, "pingSummary：单点也能求平均");
}
{
  const s = T.pingSummary({ ping: [{ task_id: 1, ts: 1, latency: null }] });
  eq(s.probes[0].last, null, "pingSummary：全部超时时 last 为 null");
  eq(s.probes[0].min, null, "pingSummary：全部超时时 min 为 null");
  eq(s.probes[0].avg, null, "pingSummary：全部超时时 avg 为 null");
}

{
  const low = [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 15 }];
  const high = [{ x: 1, y: 110 }, { x: 2, y: 120 }, { x: 3, y: 115 }];
  eq(T.spark(low) === T.spark(high), true,
    "spark：各自归一化时，形状相同、量级差十倍的两条曲线画出来一模一样——并排看就会误导");
  eq(T.spark(low, 10, 120) === T.spark(high, 10, 120), false,
    "spark：三网共用纵轴后，两条曲线不再重合");
  ok(T.spark(low, 10, 120).indexOf('viewBox="0 0 96 20"') > -1, "spark：输出的是 svg");
  eq(T.spark([{ x: 1, y: 1 }]), "", "spark：不足两个有效点不画");
  eq(T.spark([{ x: 1, y: null }, { x: 2, y: null }]), "", "spark：全为 null 不画");
  eq(T.spark([]), "", "spark：空数组");
  ok(T.spark([{ x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }]).length > 0,
    "spark：全等值时量程为 0，要兜底而不是除零");
}

{
  // 平滑曲线（本次改动）：穿过每个采样点、只在拐角抹圆，不再输出折线段。
  const d = T.smoothPath([[0, 10], [10, 10], [20, 10]]);
  eq(d.indexOf("L"), -1, "smoothPath：全是贝塞尔，没有折线段");
  eq((d.match(/C/g) || []).length, 2, "smoothPath：n 个点连成 n-1 段三次贝塞尔");
  eq(T.smoothPath([[0, 1]]), "M0.0 1.0", "smoothPath：单点只落一个 M");
  eq(T.smoothPath([]), "", "smoothPath：空数组返回空串");
  eq((T.smoothPath([[0, 1], [1, 2], null, [3, 4], [4, 5]]).match(/M/g) || []).length, 2,
    "smoothPath：null 是断点，两侧各自成段");
  // M/C 的参数都是成对的 (x,y)，所以奇数位就是 y。共线的三点不该被抹出上下摆动。
  const nums = T.smoothPath([[0, 0], [10, 0], [20, 0]]).match(/-?\d+\.\d+/g).map(Number);
  eq(nums.filter((_, i) => i % 2 === 1).every((v) => v === 0), true,
    "smoothPath：水平直线仍是直线，控制点不引入起伏");
}

{
  // 延迟检测块的行区（本次改动）：不管有没有数据都保持同一高度——
  // 没数据铺满 CARD_PROBES 行骨架，终态给一行提示，两者都放进固定高度的 .latrows。
  const on = { id: 1, name: "n", online: true, metrics: {}, cpu_cores: 2, mem_total: 1 };
  const skel = T.latencyBlock(on);
  eq((skel.match(/latrow sk/g) || []).length, 3, "latencyBlock：数据未到时骨架行数 = CARD_PROBES");
  eq(skel.indexOf('class="latrows"') > -1, true, "latencyBlock：骨架也放进固定行区");
  const off = T.latencyBlock({ id: 2, name: "m", online: false, metrics: null, cpu_cores: 2, mem_total: 1 });
  eq(off.indexOf("latrow solo") > -1, true, "latencyBlock：离线时给一行提示");
  eq(off.indexOf('class="latrows"') > -1, true, "latencyBlock：单行提示同样在固定行区里，高度不跳");
  const blank = T.latencyBlock({ id: 3, name: "p", online: true, metrics: null, cpu_cores: 2, mem_total: 1 });
  eq(blank.indexOf('class="latrows"') > -1, true, "latencyBlock：等待上报时也在固定行区里");
}

/* ------------------------------------- 5. 曲线处理：削峰 / 平滑 / 相对基准 */
eq(T.median([]), null, "median：空数组");
eq(T.median([7]), 7, "median：单元素");
eq(T.median([3, 1, 2]), 2, "median：奇数个取中间");
eq(T.median([4, 1, 3, 2]), 2.5, "median：偶数个取两中点的平均");
{
  const src = [3, 1, 2];
  T.median(src);
  eq(src, [3, 1, 2], "median：不得改动传入的数组");
}

{
  // 平稳序列里插一个尖峰。注意中位绝对偏差为 0 时滤波不做判定——
  // 窗口内绝大多数取值相同就无从区分离群点，这是 Hampel 的固有边界。
  const clean = [50, 52, 49, 51, 53, 48, 50, 52, 51, 49, 50, 52];
  const pts = clean.map((v, i) => ({ x: i, y: v }));
  eq(T.despike(pts), pts, "despike：没有离群点时逐点原样通过，不做任何平滑");

  const spiked = pts.map((p) => ({ ...p }));
  spiked[5] = { x: 5, y: 300 };
  const fixed = T.despike(spiked);
  ok(fixed[5].y < 60, "despike：尖峰被换成窗口中位数");
  eq(fixed[5].x, 5, "despike：替换只改数值，不动时间戳");
  eq(spiked[5].y, 300, "despike：不得改动传入的数组");
  ok(fixed.filter((p, i) => i !== 5).every((p, i) => p.y === pts[i === 0 ? 0 : i + (i >= 5 ? 1 : 0)].y),
    "despike：非离群点一律保持原值——这正是它区别于滑动平均的地方");

  const withNull = T.despike([{ x: 0, y: 50 }, { x: 1, y: null }, { x: 2, y: 52 }, { x: 3, y: 51 }]);
  eq(withNull[1].y, null, "despike：超时是断点，原样保留");
  eq(withNull[0].y, 50, "despike：超时不参与邻域中位数的计算");
}

{
  const step = [0, 0, 0, 10, 10, 10].map((v, i) => ({ x: i, y: v }));
  const avg = T.movingAverage(step, 3);
  eq(avg[0].y, 0, "movingAverage：边界只用窗口内实际存在的样本");
  eq(avg[1].y, 0, "movingAverage：还没到阶跃处仍为 0");
  eq(avg[2].y, 10 / 3, "movingAverage：阶跃前一个点被拉高");
  eq(avg[3].y, 20 / 3, "movingAverage：阶跃后一个点被拉低");
  eq(avg[4].y, 10, "movingAverage：进入平台后恢复原值");
  eq(step[2].y, 0, "movingAverage：不得改动传入的数组");

  const withNull = T.movingAverage([{ x: 0, y: 10 }, { x: 1, y: null }, { x: 2, y: 20 }], 3);
  eq(withNull[1].y, null, "movingAverage：超时保持断点，不被平均填平");
  eq(withNull[0].y, 10, "movingAverage：窗口居中，首点只看得到自己和右边一个（右边是 null，被跳过）");
  eq(withNull[2].y, 20, "movingAverage：末点同理");
  // 补一条能真正体现「跳过 null」的：中间点两侧都有有效样本
  eq(T.movingAverage([{ x: 0, y: 10 }, { x: 1, y: null }, { x: 2, y: 20 }, { x: 3, y: 30 }], 3)[2].y, 25,
    "movingAverage：跳过 null，只对两侧有效样本求平均");
}

{
  const clean = [50, 52, 49, 51, 53, 48, 50, 52, 51, 49, 50, 52];
  const pts = clean.map((v, i) => ({ x: i, y: v }));
  const spiked = pts.map((p) => ({ ...p }));
  spiked[5] = { x: 5, y: 300 };

  ok(T.applyFilters(spiked, {}) === spiked, "applyFilters：两个开关都关时原样返回，不做无谓复制");
  ok(T.applyFilters(spiked, { despike: true })[5].y < 60, "applyFilters：只开削峰时尖峰被换成中位数");
  eq(T.applyFilters(spiked, { smooth: true })[5].y, (51 + 53 + 300 + 50 + 52) / 5,
    "applyFilters：只开平滑时尖峰只是被摊薄，没有被去掉");
  const both = T.applyFilters(spiked, { despike: true, smooth: true });
  eq(both.length, 12, "applyFilters：两个开关可叠加");
  ok(both[5].y < 60, "applyFilters：叠加后尖峰同样被压掉");
}

{
  const probes = [
    { id: 1, name: "电信", loss: 0, points: [{ x: 100, y: 40 }] },
    { id: 2, name: "联通", loss: 1.5, points: [{ x: 100, y: 30 }] },
    { id: 3, name: "移动", loss: 0.4, points: [{ x: 100, y: 55 }] },
  ];
  ok(T.onlyProbe(probes, null) === probes, "onlyProbe：id 为 null 时原样返回全部，不做无谓复制");
  eq(T.onlyProbe(probes, 2).length, 1, "onlyProbe：隔离后只剩一路");
  eq(T.onlyProbe(probes, 2)[0].name, "联通", "onlyProbe：留下的是点中的那一路");
  eq(T.onlyProbe(probes, 2)[0].points, probes[1].points, "onlyProbe：曲线数据原样带出");
  eq(T.onlyProbe(probes, 99), [], "onlyProbe：id 不存在时返回空，而不是退回全部");
  eq(probes.length, 3, "onlyProbe：不得改动传入的数组");

  // 隔离后仍按在完整列表里的位置取色，否则切来切去同一路的颜色会变
  eq(T.probeIndex(probes, 3), 2, "probeIndex：取在完整列表里的位置");
  eq(T.probeIndex(probes, 99), 0, "probeIndex：找不到时不返回 undefined");
}

/* ------------------------------- 7. 地图分组合并、搜索与分组 */
{
  const n = (over) => Object.assign({ id: 1, name: "香港 · CN2", country: "HK", online: true, os: "Debian GNU/Linux 12 (bookworm)", virt: "kvm", arch: "x86_64", billing_cycle: "monthly", metrics: null }, over);

  eq(T.matchNode(n({}), ""), true, "matchNode：空关键词匹配全部");
  eq(T.matchNode(n({}), "香港"), true, "matchNode：命中节点名");
  eq(T.matchNode(n({}), "中国香港"), true, "matchNode：命中地区中文名");
  eq(T.matchNode(n({}), "hk"), true, "matchNode：命中国家码，且大小写不敏感");
  eq(T.matchNode(n({}), "debian"), true, "matchNode：命中系统名，大小写不敏感");
  eq(T.matchNode(n({}), "kvm"), true, "matchNode：命中虚拟化");
  eq(T.matchNode(n({}), "香港 kvm"), true, "matchNode：空格分词，全部命中才算匹配");
  eq(T.matchNode(n({}), "香港 日本"), false, "matchNode：任一词不命中即不匹配");
  eq(T.matchNode(n({}), "不存在的词"), false, "matchNode：完全不命中");
  eq(T.matchNode(n({ country: "" }), "中国香港"), false, "matchNode：无地区码时不匹配地区名");

  const all = [n({ id: 1, country: "HK" }), n({ id: 2, country: "JP" }), n({ id: 3, country: "JP" })];
  ok(T.filterNodes(all, "") === all, "filterNodes：空关键词原样返回，不做无谓复制");
  eq(T.filterNodes(all, "hk").length, 1, "filterNodes：按关键词筛出 1 个");
  eq(T.filterNodes(all, "jp").length, 2, "filterNodes：按国家码筛出 2 个");

  eq(T.groupNodes(all, "none").length, 1, "groupNodes：不分组时只有一组");
  eq(T.groupNodes(all, "none")[0].count, 3, "groupNodes：不分组时该组含全部");
  eq(T.groupNodes([], "none"), [], "groupNodes：空列表不产出空组");
  const byRegion = T.groupNodes(all, "region");
  eq(byRegion.length, 2, "groupNodes：按地区分成两组");
  eq(byRegion[0].label, "日本", "groupNodes：组间按数量降序（日本 2 个在前）");
  eq(byRegion[0].count, 2, "groupNodes：组内计数正确");
  const byStatus = T.groupNodes([n({ online: true }), n({ id: 2, online: false })], "status");
  eq(byStatus.length, 2, "groupNodes：按状态分成两组");
  ok(byStatus.some((g) => g.label === "离线"), "groupNodes：离线组存在");
  const byCycle = T.groupNodes([n({ billing_cycle: "monthly" }), n({ id: 2, billing_cycle: "" })], "cycle");
  ok(byCycle.some((g) => g.label === "未设置计费周期"), "groupNodes：缺周期归到「未设置计费周期」");
}

{
  const n = (over) => Object.assign({ id: 1, country: "JP", online: true }, over);
  const r = T.regionGroups([n({}), n({ id: 2, online: false }), n({ id: 3, country: "HK" })]);
  eq(r.regions.length, 2, "regionGroups：同一国家合并成一个地区");
  const jp = r.regions.find((x) => x.cc === "JP");
  eq(jp.total, 2, "regionGroups：合并后计数为 2");
  eq(jp.online, 1, "regionGroups：在线计数为 1");
  eq(jp.nodes.length, 2, "regionGroups：保留该地区的节点明细，供弹窗列出");
  ok(Array.isArray(jp.lon) === false && typeof jp.lon === "number", "regionGroups：带出经度");
  eq(r.unmapped, 0, "regionGroups：全部有地区码");

  eq(T.regionTone({ online: 2, total: 2 }), "ok", "regionTone：全部在线为绿");
  eq(T.regionTone({ online: 1, total: 2 }), "warn", "regionTone：部分离线为橙");
  eq(T.regionTone({ online: 0, total: 2 }), "bad", "regionTone：全部离线为红");

  const r2 = T.regionGroups([n({ country: "" }), n({ id: 2, country: "ZZ" }), n({ id: 3, country: "hk" })]);
  eq(r2.regions.length, 1, "regionGroups：无地区码与未知码都不上图");
  eq(r2.unmapped, 2, "regionGroups：未上图的两个被单独计数");
  eq(r2.regions[0].cc, "HK", "regionGroups：小写地区码归一成大写");

  const map = T.MAPDATA;
  eq(map.land.length, map.rows, "MAPDATA：点阵行数与 rows 一致");
  ok(map.land.every((row) => row.length === Math.ceil(map.cols / 4)), "MAPDATA：每行字符数等于 cols/4");
  ok(Object.keys(map.cc).length > 150, "MAPDATA：国家质心表覆盖足够多");
  ok(map.latMin < 0 && map.latMax > 0, "MAPDATA：纬度范围跨赤道");
}

/* ------------------------------------------------- 8. 地区与坐标轴 */
eq(T.countryName("hk"), "中国香港", "countryName：小写也能认");
eq(T.countryName("TW"), "中国台湾", "countryName：台湾是中国的一部分");
eq(T.countryName("mo"), "中国澳门", "countryName：澳门是中国的一部分");
eq(T.countryName("ZZ"), "ZZ", "countryName：未收录的代码原样显示");
eq(T.countryName(""), "", "countryName：空值");

{
  // 国旗由两个区域指示符拼出，不必维护表
  eq(T.flagOf("HK"), String.fromCodePoint(0x1F1ED, 0x1F1F0), "flagOf：HK 拼成对应区旗");
  eq(T.flagOf("hk"), T.flagOf("HK"), "flagOf：大小写不敏感");
  eq(T.flagOf("JP") === T.flagOf("HK"), false, "flagOf：不同国家旗不同");
  eq(T.flagOf(""), "", "flagOf：空值返回空串");
  eq(T.flagOf("A"), "", "flagOf：单字母不成立");
  eq(T.flagOf("ABC"), "", "flagOf：三字母不成立");
  eq(T.flagOf("1A"), "", "flagOf：非字母不成立");
  ok(T.flagOf("US").length === 4, "flagOf：两个码点各占两个 UTF-16 单元");
}

{
  // 三网并排，前三路的颜色必须互不相同且都不是告警色（绿/红留给在线与告警语义）。
  const five = [0, 1, 2, 3, 4].map(T.probeColor);
  eq(new Set(five).size, 5, "probeColor：前五路各不相同");
  eq(new Set([0, 1, 2].map(T.probeColor)).size, 3, "probeColor：前三路（三网）互不相同");
  eq(T.probeColor(5), T.probeColor(0), "probeColor：超出色板长度后回绕");
  eq(T.probeColor(-1), T.probeColor(4), "probeColor：负数下标不能取到 undefined");
  ok(five.every((c) => /^var\(--c\d\)$/.test(c)), "probeColor：返回的是 CSS 变量引用");
  ok(five.slice(0, 3).every((c) => c !== "var(--c5)"), "probeColor：前三路不占用语义色 c5");
}

eq(T.niceTop(0), 1, "niceTop(0)：不能让轴高为 0");
eq(T.niceTop(-5), 1, "niceTop：负数");
eq(T.niceTop(100), 100, "niceTop：100 正好落在 25 的阶梯上，轴顶就是 100");
eq(T.niceTop(26), 30, "niceTop：26 抬到 7.5 的阶梯，轴顶 30");
eq(T.niceTop(5, 1024), 8, "niceTop：字节轴按 2 的幂取步长");
eq(T.tickNum(0), "0", "tickNum：整数不带小数");
eq(T.tickNum(-7), "-7", "tickNum：负整数");
eq(T.tickNum(-7.5), "-7.5", "tickNum：半步刻度必须如实印出，四舍五入会和网格线对不上");
eq(T.tickNum(22.5), "22.5", "tickNum：正半步");
eq(T.tickNum(20), "20", "tickNum：二十不写成 20.0");[1, 7, 33, 99, 100, 1000, 12345].forEach((v) => {
  ok(T.niceTop(v) >= v, "niceTop(" + v + ") 必须覆盖数据");
});

{
  const from = Date.UTC(2026, 8, 22, 0, 0, 0), to = from + 6 * 3600 * 1000;
  const ticks = T.timeTicks(from, to, 6);
  ok(ticks.length > 0 && ticks.length <= 7, "timeTicks：数量受 count 约束");
  ok(ticks.every((t) => t >= from && t <= to), "timeTicks：刻度都落在窗口内");
  ok(ticks.every((t, i) => i === 0 || t > ticks[i - 1]), "timeTicks：严格递增");
}

/* ------------------------------------------------------------------ 汇总 */
const total = pass + failures.length;
if (failures.length) {
  console.error("\n" + failures.length + " / " + total + " 项未通过：\n");
  failures.forEach((f, i) => console.error("  " + (i + 1) + ". " + f));
  console.error("");
  process.exit(1);
}
console.log("全部通过：" + total + " 项");
