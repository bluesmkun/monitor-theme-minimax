#!/usr/bin/env node
/**
 * 构建可安装主题包。没有构建步骤——主题本体就是 dist/index.html——这里做的是
 * 校验加打包：
 *
 *   node dev/package.mjs
 *
 * 产出的 theme.tar.gz，**归档根目录就是主题目录的内容**（dist/、theme.json、
 * preview.png 平铺在根上），不含外层目录。hub 把它解到 <themes-dir>/<short>/，
 * 所以多套一层目录会让安装后的主题缺 theme.json。
 *
 * 同时校验主题契约里的几条硬约束，不合规就直接失败：
 *   - 目录名必须等于 theme.json 的 short
 *   - short 只允许字母、数字、- 和 _
 *   - 整包 <= 32 MiB，解压总量 <= 64 MiB，单文件 <= 8 MiB
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARCHIVE = path.join(ROOT, "theme.tar.gz");

const LIMITS = { archive: 32 * 1024 ** 2, unpacked: 64 * 1024 ** 2, file: 8 * 1024 ** 2 };
const MIB = (n) => (n / 1024 ** 2).toFixed(2) + " MiB";

const fail = (msg) => { console.error("打包失败：" + msg); process.exit(1); };

/* ------------------------------------------------------------ 1. theme.json */
// 主题目录要先从 theme.json 读出来，因为目录名必须等于 short。
const candidates = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, "theme.json")))
  .map((e) => e.name);
if (candidates.length !== 1) {
  fail("在 " + ROOT + " 下期望恰好一个含 theme.json 的主题目录，实际找到 " + candidates.length + " 个：" + candidates.join(", "));
}
const THEME_DIR_NAME = candidates[0];
const THEME_DIR = path.join(ROOT, THEME_DIR_NAME);

let meta;
try {
  meta = JSON.parse(fs.readFileSync(path.join(THEME_DIR, "theme.json"), "utf8"));
} catch (e) {
  fail("theme.json 不是合法 JSON：" + e.message);
}
if (!meta.name) fail("theme.json 缺少 name");
if (!meta.short) fail("theme.json 缺少 short");
if (!/^[A-Za-z0-9_-]+$/.test(meta.short)) fail("short 只允许字母、数字、- 和 _，实际为 " + JSON.stringify(meta.short));
if (meta.short !== THEME_DIR_NAME) fail("目录名必须等于 short：目录 " + THEME_DIR_NAME + "，short " + meta.short);

const ENTRY = path.join(THEME_DIR, "dist", "index.html");
if (!fs.existsSync(ENTRY)) fail("缺少 dist/index.html");

/* --------------------------------------------------------------- 2. 打包 */
const MEMBERS = ["dist", "theme.json"];
if (fs.existsSync(path.join(THEME_DIR, "preview.png"))) MEMBERS.push("preview.png");
fs.rmSync(ARCHIVE, { force: true });
// -C 是关键：切进主题目录再打包，归档根才是主题目录的内容。
execFileSync("tar", ["czf", ARCHIVE, "-C", THEME_DIR, ...MEMBERS], { stdio: "inherit" });

/* ----------------------------------------------------------- 3. 校验归档 */
const entries = execFileSync("tar", ["tzf", ARCHIVE], { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const topLevel = new Set(entries.map((e) => e.split("/")[0]));
if (!topLevel.has("theme.json")) fail("归档根目录缺少 theme.json（多套了一层目录？）");
if (!topLevel.has("dist")) fail("归档根目录缺少 dist/");
if (entries.some((e) => e.split("/").length > 3)) fail("归档里出现了过深的路径");

const archiveSize = fs.statSync(ARCHIVE).size;
if (archiveSize > LIMITS.archive) fail("整包 " + MIB(archiveSize) + " 超过 32 MiB");

let unpacked = 0;
for (const rel of entries) {
  if (rel.endsWith("/")) continue;
  const size = fs.statSync(path.join(THEME_DIR, rel)).size;
  unpacked += size;
  if (size > LIMITS.file) fail(rel + " 单个文件 " + MIB(size) + " 超过 8 MiB");
}
if (unpacked > LIMITS.unpacked) fail("解压总量 " + MIB(unpacked) + " 超过 64 MiB");

const sha = crypto.createHash("sha256").update(fs.readFileSync(ARCHIVE)).digest("hex");
fs.writeFileSync(ARCHIVE + ".sha256", sha + "\n");

/* --------------------------------------------------------------- 4. 汇报 */
console.log("主题      " + meta.name + "（short=" + meta.short + (meta.version ? ", v" + meta.version : "") + "）");
console.log("归档      " + path.relative(ROOT, ARCHIVE) + "  " + MIB(archiveSize));
console.log("解压      " + MIB(unpacked));
console.log("sha256    " + sha);
console.log("成员      " + entries.filter((e) => !e.endsWith("/")).join("  "));
