import type { Env } from "./env";

export async function verifySignature(env: Env, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

async function lineGet(env: Env, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
}

// source.type が group / room / user のどれでも送り主の表示名を返す
export async function senderName(env: Env, source: LineSource): Promise<string> {
  if (!source.userId) return "（不明）";
  const url =
    source.type === "group"
      ? `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`
      : source.type === "room"
        ? `https://api.line.me/v2/bot/room/${source.roomId}/member/${source.userId}`
        : `https://api.line.me/v2/bot/profile/${source.userId}`;
  const res = await lineGet(env, url);
  if (!res.ok) return "（不明）";
  const p = (await res.json()) as { displayName?: string };
  return p.displayName ?? "（不明）";
}

export async function groupName(env: Env, groupId: string): Promise<string> {
  const res = await lineGet(env, `https://api.line.me/v2/bot/group/${groupId}/summary`);
  if (!res.ok) return groupId;
  const g = (await res.json()) as { groupName?: string };
  return g.groupName ?? groupId;
}

// Worker のメモリは128MBなので、それより十分小さいものだけ運ぶ
const MAX_BYTES = 80 * 1024 * 1024;

export async function messageContent(env: Env, messageId: string): Promise<{ bytes: ArrayBuffer; type: string } | "too-large" | null> {
  const res = await lineGet(env, `https://api-data.line.me/v2/bot/message/${messageId}/content`);
  if (!res.ok) return null;
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    return "too-large";
  }
  return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "application/octet-stream" };
}

// 動画・音声はLINE側の変換が終わるまで取り出せない。数秒おきに最大5回だけ確かめる
export async function waitTranscoding(env: Env, messageId: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const res = await lineGet(env, `https://api-data.line.me/v2/bot/message/${messageId}/content/transcoding`);
    if (!res.ok) return false;
    const { status } = (await res.json()) as { status: string };
    if (status === "succeeded") return true;
    if (status === "failed") return false;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
}

export interface LineSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineEvent {
  type: string;
  timestamp: number;
  source: LineSource;
  message?: { id: string; type: string; text?: string; fileName?: string };
}
