#!/usr/bin/env node
// エージェントが受付ワークスペースの Slack を読み書きするときに使う（アプリのトークンで動く）。
//   node hub/slack.mjs post <チャンネルID> <本文ファイル> [スレッドts]   … 投稿して ts を表示
//   node hub/slack.mjs read <チャンネルID> [件数]                      … 新しい順に表示
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = readFileSync(join(homedir(), ".credentials", "slack_hub_token.txt"), "utf8").trim();
const [cmd, channel, arg, threadTs] = process.argv.slice(2);

async function slack(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Slack ${method}: ${data.error}`);
    process.exit(1);
  }
  return data;
}

if (cmd === "post" && channel && arg) {
  // 先方が見るチャンネルに書けないよう、投稿は受付チャンネルだけに限る
  const { deskChannel } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config.json"), "utf8"));
  if (channel !== deskChannel) {
    console.error(`投稿できるのは受付チャンネル（${deskChannel}）だけです`);
    process.exit(1);
  }
  const params = { channel, text: readFileSync(arg, "utf8"), unfurl_links: "false" };
  if (threadTs) params.thread_ts = threadTs;
  const { ts } = await slack("chat.postMessage", params);
  console.log(ts);
} else if (cmd === "read" && channel) {
  const { messages } = await slack("conversations.history", { channel, limit: arg ?? "20" });
  for (const m of messages) console.log(`[ts=${m.ts}] ${m.user ?? "bot"}: ${m.text}`);
} else {
  console.error("使いかた: node hub/slack.mjs post <チャンネルID> <本文ファイル> [スレッドts] | read <チャンネルID> [件数]");
  process.exit(2);
}
