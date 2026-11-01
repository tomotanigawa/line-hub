#!/usr/bin/env node
// 予定・Todo エージェントが MulmoClaude のコレクション「仕事のやること」(shigoto-todo) を読み書きするときに使う。
//   node hub/todo.mjs add <JSONファイル> [受付スレッドts]  … 1件足す（JSONは1件か配列）。作ったIDを表示
//   node hub/todo.mjs open [取引先]                       … 未完了の一覧（重複を避けるために先に見る）
//   node hub/todo.mjs note <ID> <追記する1行>              … 既存レコードのメモに追記
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ITEMS = join(homedir(), "mulmoclaude", "data", "shigoto-todo", "items");
const HUB = dirname(fileURLToPath(import.meta.url));
const KINDS = ["Todo", "予定"];
const STATUSES = ["未着手", "対応中", "先方待ち", "完了", "見送り"];
const PRIORITIES = ["高", "中", "低"];
const SOURCES = ["LINE", "Slack", "Gmail", "電話", "その他"];
const DONE = ["完了", "見送り"];

const [cmd, ...args] = process.argv.slice(2);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const readAll = () =>
  existsSync(ITEMS) ? readdirSync(ITEMS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(ITEMS, f), "utf8"))) : [];

// 受付スレッドの ts から Slack のリンクを作る（元のやりとりに戻れるように）
async function permalink(ts) {
  const config = JSON.parse(readFileSync(join(HUB, "config.json"), "utf8"));
  const token = readFileSync(join(homedir(), ".credentials", "slack_hub_token.txt"), "utf8").trim();
  const res = await fetch("https://slack.com/api/chat.getPermalink", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams({ channel: config.deskChannel, message_ts: ts }),
  });
  const data = await res.json();
  return data.ok ? data.permalink : null;
}

function newId(n) {
  const d = new Date();
  const p = (v) => String(v).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `todo-${stamp}-${String(Math.floor(Math.random() * 9000) + 1000 + n)}`;
}

function validate(r) {
  if (!r.title) return "title がありません";
  if (r.kind && !KINDS.includes(r.kind)) return `kind は ${KINDS.join("/")}`;
  if (r.status && !STATUSES.includes(r.status)) return `status は ${STATUSES.join("/")}`;
  if (r.priority && !PRIORITIES.includes(r.priority)) return `priority は ${PRIORITIES.join("/")}`;
  if (r.source && !SOURCES.includes(r.source)) return `source は ${SOURCES.join("/")}`;
  if (r.due && !/^\d{4}-\d{2}-\d{2}$/.test(r.due)) return "due は YYYY-MM-DD";
  return null;
}

if (cmd === "add" && args[0]) {
  const input = JSON.parse(readFileSync(args[0], "utf8"));
  const rows = Array.isArray(input) ? input : [input];
  const link = args[1] ? await permalink(args[1]) : null;
  rows.forEach((r, i) => {
    const err = validate(r);
    if (err) fail(`${i + 1}件目: ${err}`);
  });
  rows.forEach((r, i) => {
    const rec = { kind: "Todo", status: "未着手", priority: "中", ...r, id: newId(i) };
    if (link && !rec.link) rec.link = link;
    for (const k of Object.keys(rec)) if (rec[k] === null || rec[k] === "") delete rec[k];
    writeFileSync(join(ITEMS, `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n");
    console.log(`${rec.id}  ${rec.client ?? ""} ${rec.title}`);
  });
} else if (cmd === "open") {
  const client = args[0];
  for (const r of readAll()) {
    if (DONE.includes(r.status) || (client && r.client !== client)) continue;
    console.log(`${r.id}  [${r.status}] ${r.client ?? ""} ${r.title}${r.due ? `（${r.due}${r.time ? ` ${r.time}` : ""}）` : ""}`);
  }
} else if (cmd === "note" && args[0] && args[1]) {
  const path = join(ITEMS, `${args[0]}.json`);
  if (!existsSync(path)) fail(`${args[0]} がありません`);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  const today = new Date().toLocaleDateString("sv-SE");
  rec.memo = `${rec.memo ? `${rec.memo}\n` : ""}- ${today} ${args.slice(1).join(" ")}`;
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  console.log(`${rec.id} に追記しました`);
} else {
  fail("使いかた: node hub/todo.mjs add <JSONファイル> [受付スレッドts] | open [取引先] | note <ID> <追記>");
}
