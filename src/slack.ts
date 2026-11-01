import type { Env } from "./env";

async function slackCall(env: Env, method: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: new URLSearchParams(params),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

export async function post(env: Env, channel: string, text: string, threadTs?: string): Promise<string> {
  const params: Record<string, string> = { channel, text, unfurl_links: "false" };
  if (threadTs) params.thread_ts = threadTs;
  const data = await slackCall(env, "chat.postMessage", params);
  return data.ts as string;
}

export async function uploadFile(
  env: Env,
  channel: string,
  bytes: ArrayBuffer,
  filename: string,
  comment: string,
): Promise<void> {
  const { upload_url, file_id } = await slackCall(env, "files.getUploadURLExternal", {
    filename,
    length: String(bytes.byteLength),
  });
  const up = await fetch(upload_url, { method: "POST", body: bytes });
  if (!up.ok) throw new Error(`Slack upload: ${up.status}`);
  await slackCall(env, "files.completeUploadExternal", {
    files: JSON.stringify([{ id: file_id, title: filename }]),
    channel_id: channel,
    initial_comment: comment,
  });
}
