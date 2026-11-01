// LINE → Slack の転送だけを受け持つ。考えるのは Mac の MulmoTerminal（hub/poller.mjs）
import { groupConfig, type Env } from "./env";
import { groupName, messageContent, senderName, verifySignature, waitTranscoding, type LineEvent } from "./line";
import * as slack from "./slack";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("ok");

    const body = await req.text();
    if (!(await verifySignature(env, body, req.headers.get("x-line-signature")))) {
      return new Response("bad signature", { status: 401 });
    }
    const { events } = JSON.parse(body) as { events: LineEvent[] };
    // LINEには先に200を返し、転送はそのあとで行う
    ctx.waitUntil(Promise.all(events.map((e) => handleEvent(env, e).catch((err) => console.error(err)))));
    return new Response("ok");
  },
};

async function handleEvent(env: Env, ev: LineEvent): Promise<void> {
  const src = ev.source;
  const key = src.groupId ?? src.roomId ?? "self";
  const registered = groupConfig(env, key);
  // 1対1でBotに転送したもの・未登録グループは受信箱へ
  const channel = registered?.channel || env.SLACK_INBOX_CHANNEL;

  if (ev.type === "join" && src.groupId) {
    const name = await groupName(env, src.groupId);
    await slack.post(
      env,
      env.SLACK_INBOX_CHANNEL,
      `Botがグループ「${name}」に入りました。\ngroupId: \`${src.groupId}\`\nwrangler.toml の GROUPS に登録すると専用チャンネルに流れます。`,
    );
    return;
  }
  if (ev.type !== "message" || !ev.message) return;

  const sender = await senderName(env, src);
  // 1社が複数グループを持つことがあるので、登録済みでも必ずグループ名を付ける
  const label = registered
    ? `[${registered.name}] `
    : key === "self"
      ? "[手動転送] "
      : `[${src.groupId ? await groupName(env, src.groupId) : "未登録"} / ${key}] `;
  const m = ev.message;

  const media = MEDIA[m.type];
  if (!media) {
    const text = m.type === "text" ? (m.text ?? "") : `（${m.type}）`;
    await slack.post(env, channel, `${label}*${sender}*: ${text}`);
    return;
  }

  const what = m.type === "file" ? `ファイル ${m.fileName}` : media.label;
  const ready = m.type === "video" || m.type === "audio" ? await waitTranscoding(env, m.id) : true;
  const content = ready ? await messageContent(env, m.id) : null;
  if (content && content !== "too-large") {
    const filename = m.type === "file" && m.fileName ? m.fileName : `${m.id}.${media.ext}`;
    await slack.uploadFile(env, channel, content.bytes, filename, `${label}*${sender}*: （${what}）`);
  } else {
    // 運べなかったことは必ず残す（中身はLINEアプリで見てもらう）
    const why = content === "too-large" ? "大きすぎて転送できません" : "取り出せませんでした";
    await slack.post(env, channel, `${label}*${sender}*: （${what}・${why}。LINEで確認してください）`);
  }
}

const MEDIA: Record<string, { label: string; ext: string }> = {
  image: { label: "画像", ext: "jpg" },
  video: { label: "動画", ext: "mp4" },
  audio: { label: "音声", ext: "m4a" },
  file: { label: "ファイル", ext: "bin" },
};
