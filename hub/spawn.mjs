#!/usr/bin/env node
// 振り分け役が専門エージェントを起こすときに使う。
//   node hub/spawn.mjs <agent名> <状況を書いたファイル>
// agents/<agent名>.md の指示文のあとに状況ファイルの中身をつないで、MulmoTerminal に1つ起動する。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [agent, contextFile] = process.argv.slice(2);
if (!agent || !contextFile) {
  console.error("使いかた: node hub/spawn.mjs <agent名> <状況ファイル>");
  process.exit(2);
}
const config = JSON.parse(readFileSync(join(ROOT, "hub", "config.json"), "utf8"));
const prompt = readFileSync(join(ROOT, "agents", `${agent}.md`), "utf8")
  .replaceAll("{{ROOT}}", ROOT)
  .replaceAll("{{AGENTS_DIR}}", join(ROOT, "agents"))
  .replaceAll("{{DESK}}", config.deskChannel);
const message = `${prompt}\n\n---\n# 今回の状況\n\n${readFileSync(contextFile, "utf8")}`;

const res = await fetch("http://127.0.0.1:34567/api/plugin/spawnBackgroundChat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message, hidden: true, project: createHash("sha256").update(ROOT).digest("hex").slice(0, 16) }),
});
const data = await res.json();
if (!data.jsonData?.chatId) {
  console.error(data.message ?? "起動に失敗しました");
  process.exit(1);
}
console.log(`${agent} を起動しました: ${data.jsonData.chatId}`);
