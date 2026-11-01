#!/usr/bin/env node
// Slack の見張り役。launchd が2分ごとに1回だけ走らせる（常駐しない）。
// 監視チャンネルに新着があり、そのあと QUIET_MINUTES 静かになったら、
// MulmoTerminal に振り分け役エージェント（agents/router.md）を1つ起動する。
// メール確認の時刻になったら、メール用の振り分け役を起動する。
//
// 使いかた: node hub/poller.mjs            … 通常（launchd から）
//           node hub/poller.mjs --dry-run  … 起動せず、何を起動するかだけ表示
import { readFileSync, writeFileSync, existsSync, mkdirSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HUB);
const CONFIG = JSON.parse(readFileSync(join(HUB, "config.json"), "utf8"));
const STATE_PATH = join(HUB, "state.json");
const TOKEN = readFileSync(join(homedir(), ".credentials", "slack_hub_token.txt"), "utf8").trim();
const MT = "http://127.0.0.1:34567/api/plugin/spawnBackgroundChat";
const DRY = process.argv.includes("--dry-run");
const MAX_FAILURES = 3;
// エージェントはこのフォルダで動かす（.claude/settings.json の「送信系は使わせない」が効くように）。
// MulmoTerminal の登録ディレクトリに入っていないと起動を断られる
const PROJECT = createHash("sha256").update(ROOT).digest("hex").slice(0, 16);

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
state.channels ??= {};
state.users ??= {};
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toLocaleString("ja-JP"), ...a);

async function slack(method, params) {
  const res = await fetch(`${process.env.SLACK_API ?? "https://slack.com/api"}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

async function userName(id) {
  if (!id) return "（Bot）";
  if (!state.users[id]) {
    const { user } = await slack("users.info", { user: id });
    state.users[id] = user.profile?.display_name || user.real_name || user.name;
  }
  return state.users[id];
}

// 写真・動画・資料は控えとして手元にも残す（エージェントが Read で開くのにも使う）
// 置き場所は files/<取引先>/<年-月>/
async function download(ch, m, f) {
  if (!f.url_private_download) return null;
  const month = new Date(Number(m.ts) * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7);
  const folder = ch.client.replace(/（.*$/, "").replace(/[\/:]/g, "_");
  const dir = join(HUB, "files", folder, month);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${f.id}-${f.name}`);
  if (!existsSync(path)) {
    const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) return null;
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return path;
}

// MulmoTerminal が起動していなければ null（課金も失敗回数も発生しない。次の回にまた試す）
async function spawn(message) {
  if (DRY) {
    log("[dry-run] 起動する指示文:\n" + message);
    return "dry-run";
  }
  let res;
  try {
    res = await fetch(MT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, hidden: true, project: PROJECT }),
    });
  } catch {
    return null;
  }
  const data = await res.json();
  if (!data.jsonData?.chatId) throw new Error(data.message ?? "spawn failed");
  return data.jsonData.chatId;
}

function render(name, vars) {
  let text = readFileSync(join(ROOT, "agents", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

const common = { ROOT, AGENTS_DIR: join(ROOT, "agents"), DESK: CONFIG.deskChannel, MT };

async function checkChannel(id, ch) {
  const st = (state.channels[id] ??= { lastTs: String(Date.now() / 1000), failures: 0 });
  const { messages } = await slack("conversations.history", { channel: id, oldest: st.lastTs, limit: "100" });
  const fresh = messages
    .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "file_share")
    .filter((m) => !(m.text ?? "").startsWith("Botがグループ「")) // Worker の参加通知は人が読むだけでよい
    .reverse();
  // LINE転送は「[グループ名] *送り主*: 本文」の形。
  // 受信箱はオーナーが自分で書く電話メモの置き場なので、本人の投稿も「届いた連絡」として扱う
  const isInbox = ch.source === "inbox";
  const fromOwner = (m) =>
    !isInbox &&
    (m.user === CONFIG.owner.slackUserId || (m.text ?? "").replace(/^\[[^\]]*\] /, "").startsWith(`*${CONFIG.owner.lineName}*:`));

  // 返し忘れの見張り。先方の発言からオーナーが何か書くまでを「未返信」とする
  for (const m of fresh.filter((m) => Number(m.ts) > Number(st.scannedTs ?? 0))) {
    if (fromOwner(m)) {
      st.waitingSince = null;
      st.alerted = false;
    } else {
      st.waitingSince ??= m.ts;
    }
    st.scannedTs = m.ts;
  }
  if (!isInbox && st.waitingSince && !st.alerted && Date.now() / 1000 - Number(st.waitingSince) > CONFIG.alertMinutes * 60) {
    // メンション付きなのでスマホに通知が届く
    if (!DRY)
      await slack("chat.postMessage", {
        channel: CONFIG.deskChannel,
        text: `<@${CONFIG.owner.slackUserId}> ⏰ ${ch.client} の連絡から${CONFIG.alertMinutes}分、まだ返信していません → <#${id}>`,
      });
    log(`${ch.client}: 未返信アラート`);
    st.alerted = true;
  }

  if (!fresh.length) return;

  // 控えは、オーナー自身の投稿だけの束でも取っておく
  const saved = new Map();
  for (const m of fresh)
    for (const f of m.files ?? []) saved.set(f.id, await download(ch, m, f).catch(() => null));

  const newest = Number(fresh.at(-1).ts);
  if (Date.now() / 1000 - newest < CONFIG.quietMinutes * 60) return; // まだ送ってきている途中

  // オーナー自身の発言だけなら、エージェントは起こさず読み進めるだけ
  if (fresh.every(fromOwner)) {
    st.lastTs = fresh.at(-1).ts;
    return;
  }

  const lines = [];
  for (const m of fresh) {
    const who = m.bot_id ? "" : `${await userName(m.user)}: `; // LINE転送は本文に送り主名が入っている
    let files = "";
    for (const f of m.files ?? []) {
      const path = saved.get(f.id);
      files += ` [ファイル ${f.name} id=${f.id}${path ? ` 保存先=${path}` : ""}]`;
    }
    const at = new Date(Number(m.ts) * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    lines.push(`[${at} ts=${m.ts}] ${who}${m.text ?? ""}${files}`);
  }
  const message = render("router", {
    ...common,
    CLIENT: ch.client,
    SOURCE: ch.source,
    CHANNEL: id,
    MESSAGES: lines.join("\n"),
  });

  try {
    const chatId = await spawn(message);
    if (chatId === null) return log(`MulmoTerminal が起動していないので ${ch.client} は次回に回す`);
    log(`${ch.client}: ${fresh.length}件 → 振り分け役 ${chatId}`);
    st.lastTs = fresh.at(-1).ts;
    st.failures = 0;
  } catch (err) {
    st.failures += 1;
    log(`${ch.client}: 起動失敗 ${st.failures}/${MAX_FAILURES}`, String(err));
    // 同じ束で何度も失敗したら、知らせて先へ進む（同じ失敗を繰り返さない）
    if (st.failures >= MAX_FAILURES) {
      await slack("chat.postMessage", {
        channel: CONFIG.deskChannel,
        text: `⚠️ ${ch.client} の新着${fresh.length}件をエージェントに渡せませんでした: ${String(err).slice(0, 200)}\n<#${id}> を直接見てください。`,
      });
      st.lastTs = fresh.at(-1).ts;
      st.failures = 0;
    }
  }
}

// Mac の空きが減ったら一度だけ知らせる（空きが戻ったらまた知らせられるようにする）
async function checkDisk() {
  const { bavail, bsize } = statfsSync(HUB);
  const freeGB = Math.floor((bavail * bsize) / 1024 ** 3);
  const limit = CONFIG.diskAlertGB ?? 100;
  if (freeGB >= limit) {
    state.diskAlerted = false;
    return;
  }
  if (state.diskAlerted) return;
  if (!DRY)
    await slack("chat.postMessage", {
      channel: CONFIG.deskChannel,
      text: `<@${CONFIG.owner.slackUserId}> ⚠️ Macの空きが残り${freeGB}GBです。古い動画の整理を検討してください（保存先: ${join(HUB, "files")}）`,
    });
  log(`空き容量アラート ${freeGB}GB`);
  state.diskAlerted = true;
}

// その日のメール確認時刻を過ぎていて、まだやっていなければ起動
async function checkMail() {
  const now = new Date();
  const today = now.toLocaleDateString("sv-SE");
  const hhmm = now.toTimeString().slice(0, 5);
  const due = CONFIG.mailCheckTimes.filter((t) => t <= hhmm).at(-1);
  if (!due || state.lastMailCheck === `${today} ${due}`) return;

  const since = state.lastMailCheckAt ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const chatId = await spawn(render("mail", { ...common, SINCE: since }));
  if (chatId === null) return;
  log(`メール確認 → ${chatId}`);
  state.lastMailCheck = `${today} ${due}`;
  state.lastMailCheckAt = now.toISOString();
}

for (const [id, ch] of Object.entries(CONFIG.channels)) {
  await checkChannel(id, ch).catch((err) => log(`${ch.client}: 読み取り失敗`, String(err)));
}
await checkMail().catch((err) => log("メール確認: 失敗", String(err)));
await checkDisk().catch((err) => log("空き容量の確認: 失敗", String(err)));
if (!DRY) save();
