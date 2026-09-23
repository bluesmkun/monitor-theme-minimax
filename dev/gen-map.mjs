#!/usr/bin/env node
/**
 * 生成世界地图数据，供主题内嵌。
 *
 *   node dev/gen-map.mjs [--cols 120] [--rows 60] [--out dev/map-data.json]
 *
 * 数据源是 Natural Earth 的 110m 简化版（公有领域，无使用限制）：
 *   ne_110m_land.geojson             陆地面
 *   ne_110m_admin_0_countries.geojson 国家边界与 ISO_A2
 * 首次运行会下载到 /tmp/ne/ 缓存。
 *
 * 产出两样东西：
 *   1. 陆地点阵掩膜 —— 一个等距圆柱投影下的 W×H 网格，标出哪些格子落在陆地上。
 *      编码成每行 ceil(W/4) 个十六进制字符（4 格/字符），比存路径小两个数量级，
 *      运行时再展开成 SVG。点阵比矢量轮廓更贴合这套极简配色。
 *   2. 国家码 → 代表点经纬度 —— 取该国**面积最大的那个多边形**的质心。
 *      不用整体质心：美国会把阿拉斯加算进去、法国会把海外省算进去，落点会偏到海里。
 *
 * 为什么需要代表点：hub 只给 `country` 一个 ISO 3166-1 alpha-2 码，没有经纬度，
 * 所以地图只能按国家定位，同一国家的多个节点合并成一个亮点。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = "/tmp/ne";

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
const argStr = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
};

const COLS = arg("cols", 120);
const ROWS = arg("rows", 48);
// 只画有人放机器的那段纬度。南极洲占了底部一大片却不可能有节点，
// 北极圈以上全是海，裁掉之后数据更小、DOM 也更轻。
const LAT_MAX = arg("latMax", 84);
const LAT_MIN = arg("latMin", -58);
const OUT = path.resolve(ROOT, argStr("out", "dev/map-data.json"));

const SOURCES = {
  land: "ne_110m_land.geojson",
  countries: "ne_110m_admin_0_countries.geojson",
};

/**
 * 取数据文件。缓存存在且能解析就直接用；否则下载并**校验能解析**——
 * 下载被中途截断时文件看起来「存在且非空」，只有解析才会暴露，重试即可。
 */
async function ensure(file) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) {
    try { return JSON.parse(fs.readFileSync(dest, "utf8")); } catch { fs.rmSync(dest, { force: true }); }
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const url = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/" + file;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log("下载 " + file + "（第 " + attempt + " 次）");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      const parsed = JSON.parse(text);          // 截断的响应在这里就会抛
      fs.writeFileSync(dest, text);
      return parsed;
    } catch (e) {
      console.log("  失败：" + e.message.slice(0, 80));
      if (attempt === 5) throw new Error("下载 " + file + " 五次均失败");
    }
  }
}

/* ------------------------------------------------------------ 几何工具 */
const rings = (geom) => {
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
};
const bbox = (ring) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};
/** 射线法。环是 [lon,lat] 数组。 */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 多边形面积（经纬度平面上的近似，仅用于挑最大块，不要求精确）。 */
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}
/** 多边形质心（顶点平均，够用；不追求几何精确）。 */
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

/* ------------------------------------------------------- 1. 陆地点阵 */
const land = await ensure(SOURCES.land);
const landPolys = [];
for (const f of land.features) {
  for (const ring of rings(f.geometry)) {
    if (ring.length < 4) continue;
    landPolys.push({ ring, bb: bbox(ring) });
  }
}
console.log("陆地面 " + landPolys.length + " 个环");

const stepLon = 360 / COLS;
const stepLat = (LAT_MAX - LAT_MIN) / ROWS;
const rowsHex = [];
let landCells = 0;
for (let r = 0; r < ROWS; r++) {
  const lat = LAT_MAX - stepLat * (r + 0.5);
  let bits = 0, chars = "";
  for (let c = 0; c < COLS; c++) {
    const lon = -180 + stepLon * (c + 0.5);
    let on = false;
    for (const p of landPolys) {
      const [x0, y0, x1, y1] = p.bb;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (inRing(lon, lat, p.ring)) { on = true; break; }
    }
    if (on) landCells++;
    bits = (bits << 1) | (on ? 1 : 0);
    if (c % 4 === 3) { chars += bits.toString(16); bits = 0; }   // 每 4 格一个十六进制字符
  }
  if (COLS % 4) chars += bits.toString(16);   // 补齐余数格
  rowsHex.push(chars);
}
console.log("网格 " + COLS + "×" + ROWS + "，陆地格 " + landCells + "（" + (landCells / (COLS * ROWS) * 100).toFixed(1) + "%）");

/* --------------------------------------------- 2. 国家码 → 代表点 */
/**
 * 110m 精度下缺失的小型地区，手工补代表点。
 * 这些地方恰恰是 VPS 的高频落点，缺了地图就少一大块。
 * 其余任何不在表里的国家码都不会被画到地图上，界面会提示「N 个节点未标注地区」。
 */
const SUPPLEMENT = {
  HK: [114.1, 22.3], MO: [113.5, 22.2], TW: [121.0, 23.7], SG: [103.8, 1.35],
  BH: [50.6, 26.0], MT: [14.4, 35.9], MU: [57.6, -20.3], SC: [55.5, -4.6],
  LU: [6.1, 49.8], CY: [33.2, 35.1], IS: [18.6, 64.9], VU: [166.9, -15.4],
  BN: [114.7, 4.5], MV: [73.5, 3.2], LI: [9.5, 47.1], MC: [7.4, 43.7],
  SM: [12.5, 43.9], AD: [1.6, 42.5], GI: [5.35, 36.14], BM: [-64.8, 32.3],
  KY: [-81.3, 19.3], VG: [-64.6, 18.4], CW: [-68.9, 12.2], AW: [-70.0, 12.5],
  PR: [-66.5, 18.2], GU: [144.8, 13.4], MP: [145.7, 15.1], AS: [-170.7, -14.3],
  NC: [165.5, -21.3], PF: [-149.5, -17.7], FJ: [178.1, -17.8], WS: [-172.1, -13.8],
  TO: [-175.2, -21.2], CK: [-159.8, -21.2], NU: [-169.9, -19.1], TK: [-171.8, -9.2],
  WF: [-176.2, -13.3], PW: [134.6, 7.4], FM: [158.2, 6.9], MH: [171.2, 7.1],
};
const countries = await ensure(SOURCES.countries);
const cc = {};
let picked = 0, skipped = 0, fixed = 0;
for (const f of countries.features) {
  const p = f.properties;
  // Natural Earth 把法国、挪威等国的 ISO_A2 写成 -99，正确值在 ISO_A2_EH
  let code = (p.ISO_A2 || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "-99") code = (p.ISO_A2_EH || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "-99") { skipped++; continue; }
  if ((p.ISO_A2 || "").toUpperCase() === "-99") fixed++;
  const polys = [];
  for (const ring of rings(f.geometry)) if (ring.length >= 4) polys.push(ring);
  if (!polys.length) { skipped++; continue; }
  let best = polys[0], bestArea = ringArea(polys[0]);
  for (const ring of polys.slice(1)) {
    const a = ringArea(ring);
    if (a > bestArea) { best = ring; bestArea = a; }
  }
  const [lon, lat] = ringCentroid(best);
  cc[code] = [Math.round(lon * 10) / 10, Math.round(lat * 10) / 10];
  picked++;
}
console.log("国家代表点 " + picked + " 个（其中 " + fixed + " 个取自 ISO_A2_EH），跳过 " + skipped);

let added = 0;
for (const [code, pt] of Object.entries(SUPPLEMENT)) {
  if (!cc[code]) { cc[code] = pt; added++; }
}
console.log("补充小型地区 " + added + " 个（110m 精度下不存在）");

const out = {
  _: "由 dev/gen-map.mjs 生成，数据源 Natural Earth 110m（公有领域）。勿手改。",
  cols: COLS,
  rows: ROWS,
  latMax: LAT_MAX,
  latMin: LAT_MIN,
  land: rowsHex,
  cc,
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log("已写出 " + path.relative(ROOT, OUT) + "  " + (fs.statSync(OUT).size / 1024).toFixed(1) + " KB");

/* --------------------------------------- 3. 注入主题（可选） */
const inject = argStr("inject", "");
if (inject) {
  const themePath = path.resolve(ROOT, inject);
  const theme = fs.readFileSync(themePath, "utf8");
  const MARK = "/* @MAPDATA@ */";
  const snippet = "var MAPDATA=" + JSON.stringify(out) + ";";
  // 幂等：首次注入替占位标记，之后替已有的那一行。数据是单行的，按行匹配即可。
  // 只认占位标记的话，第二次执行就会报「找不到标记」，没法改网格参数重生成。
  if (theme.includes(MARK)) {
    fs.writeFileSync(themePath, theme.replace(MARK, snippet));
    console.log("已注入 " + path.relative(ROOT, themePath) + "（" + (snippet.length / 1024).toFixed(1) + " KB）");
  } else if (/^var MAPDATA=.*$/m.test(theme)) {
    fs.writeFileSync(themePath, theme.replace(/^var MAPDATA=.*$/m, snippet));
    console.log("已更新 " + path.relative(ROOT, themePath) + "（" + (snippet.length / 1024).toFixed(1) + " KB）");
  } else {
    throw new Error(themePath + " 里既没有 " + MARK + " 也没有 var MAPDATA=，无从注入");
  }
}

console.log("抽查：HK=" + JSON.stringify(cc.HK) + " SG=" + JSON.stringify(cc.SG) + " US=" + JSON.stringify(cc.US) + " JP=" + JSON.stringify(cc.JP));
