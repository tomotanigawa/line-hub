export interface Env {
  SLACK_INBOX_CHANNEL: string;
  GROUPS: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  SLACK_BOT_TOKEN: string;
}

export interface GroupConfig {
  name: string;
  channel: string;
}

export function groupConfig(env: Env, groupId: string): GroupConfig | null {
  const all = JSON.parse(env.GROUPS || "{}") as Record<string, GroupConfig>;
  return all[groupId] ?? null;
}
