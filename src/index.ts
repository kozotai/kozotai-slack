export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  KOZOTAI_EVENT_API_KEY: string;
  KOZOTAI_EVENT_API_URL?: string;
}

const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SLACK_SIGNATURE_TOLERANCE_SEC = 60 * 5;
const DEFAULT_KOZOTAI_EVENT_API_URL = "https://api.kozotai.com/v1/event";

/**
 * 既に処理済みの Slack event_id を保持するベストエフォートの重複排除キャッシュ。
 * Worker インスタンス単位でのみ有効。グローバル重複排除が必要なら KV/Durable Objects 等を使う。
 */
const PROCESSED_EVENT_IDS = new Set<string>();
const PROCESSED_EVENT_IDS_MAX = 1000;

const REACTION_WORKING = "hourglass_flowing_sand";
const REACTION_OK = "white_check_mark";
const REACTION_NG = "x";
const REACTION_WARN = "warning";

type SlackMessageFile = {
  name: string | null;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
};

type SlackMessageEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  files?: unknown;
};

type SlackEventRequestBody = {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent;
};

function markEventProcessed(eventId: string): boolean {
  if (PROCESSED_EVENT_IDS.has(eventId)) return false;
  PROCESSED_EVENT_IDS.add(eventId);

  if (PROCESSED_EVENT_IDS.size > PROCESSED_EVENT_IDS_MAX) {
    const iter = PROCESSED_EVENT_IDS.values();
    const toDelete = PROCESSED_EVENT_IDS_MAX / 2;
    for (let i = 0; i < toDelete; i++) {
      const value = iter.next().value;
      if (value === undefined) break;
      PROCESSED_EVENT_IDS.delete(value);
    }
  }

  return true;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function getRequiredEnv(env: Env): {
  signingSecret: string;
  botToken: string;
  apiKey: string;
  apiUrl: string;
} {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  const botToken = env.SLACK_BOT_TOKEN;
  const apiKey = env.KOZOTAI_EVENT_API_KEY;

  if (!signingSecret || !botToken || !apiKey) {
    throw new Error("SLACK_SIGNING_SECRET / SLACK_BOT_TOKEN / KOZOTAI_EVENT_API_KEY が必要です");
  }

  return {
    signingSecret,
    botToken,
    apiKey,
    apiUrl: env.KOZOTAI_EVENT_API_URL ?? DEFAULT_KOZOTAI_EVENT_API_URL,
  };
}

function extractFiles(message: SlackMessageEvent): SlackMessageFile[] | undefined {
  if (!Array.isArray(message.files) || message.files.length === 0) return;
  return message.files as SlackMessageFile[];
}

function shouldIgnoreMessage(message: SlackMessageEvent | undefined): boolean {
  if (!message) return true;
  if (message.type !== "message") return true;
  if (message.bot_id) return true;
  if (message.subtype === "bot_message") return true;
  if (message.subtype === "message_changed" || message.subtype === "message_deleted") {
    return true;
  }
  return false;
}

function getHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifySlackSignature(
  rawBody: string,
  headers: Headers,
  signingSecret: string
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - requestTime) > SLACK_SIGNATURE_TOLERANCE_SEC) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  const expected = `v0=${getHex(new Uint8Array(digest))}`;

  return timingSafeEqual(expected, signature);
}

async function downloadSlackFile(url: string, botToken: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Slack ファイル取得失敗: HTTP ${res.status}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

async function pushEvent(params: {
  comment: string;
  files: { bytes: Uint8Array; filename: string; contentType: string }[];
  apiKey: string;
  apiUrl: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const form = new FormData();
  const comment = params.comment.trim();

  if (comment) form.append("comment", comment);

  for (const file of params.files) {
    const bytes = new Uint8Array(file.bytes);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: file.contentType });
    form.append("files", blob, file.filename);
  }

  const res = await fetch(params.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: form,
  });
  const body = await res.text();

  return { ok: res.ok, status: res.status, body };
}

async function slackApi(
  method: "reactions.add" | "reactions.remove",
  body: Record<string, string>,
  botToken: string
): Promise<void> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error ?? `HTTP ${res.status}`}`);
  }
}

async function addReaction(
  channel: string | undefined,
  ts: string | undefined,
  name: string,
  botToken: string
): Promise<void> {
  if (!channel || !ts) return;
  await slackApi("reactions.add", { channel, timestamp: ts, name }, botToken);
}

async function removeReaction(
  channel: string | undefined,
  ts: string | undefined,
  name: string,
  botToken: string
): Promise<void> {
  if (!channel || !ts) return;
  await slackApi("reactions.remove", { channel, timestamp: ts, name }, botToken);
}

async function handleMessageEvent(payload: SlackEventRequestBody, env: Env): Promise<void> {
  const { botToken, apiKey, apiUrl } = getRequiredEnv(env);
  const message = payload.event;

  if (shouldIgnoreMessage(message)) return;

  const comment = typeof message?.text === "string" ? message.text : "";
  const files = message ? extractFiles(message) : undefined;

  if (!files && !comment.trim()) return;

  const channel = typeof message?.channel === "string" ? message.channel : undefined;
  const ts = typeof message?.ts === "string" ? message.ts : undefined;

  try {
    await addReaction(channel, ts, REACTION_WORKING, botToken);
  } catch (error) {
    console.warn(`リアクション追加に失敗 (${REACTION_WORKING})`, error);
  }

  const parts: { bytes: Uint8Array; filename: string; contentType: string }[] = [];

  if (files) {
    const toSend = files.slice(0, MAX_FILES);
    for (let i = 0; i < toSend.length; i++) {
      const file = toSend[i];
      const size = file.size ?? 0;
      if (size > MAX_FILE_BYTES) {
        console.warn(
          `スキップ: ${file.name ?? String(i)} が ${MAX_FILE_BYTES} バイトを超えています (${size})`
        );
        continue;
      }

      const url = file.url_private_download;
      if (!url) {
        console.warn(`スキップ: url_private_download なし (${file.name ?? i})`);
        continue;
      }

      try {
        const bytes = await downloadSlackFile(url, botToken);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          console.warn(`スキップ: ダウンロード後サイズ超過 (${file.name ?? i})`);
          continue;
        }

        parts.push({
          bytes,
          filename: file.name ?? `file-${i + 1}`,
          contentType: file.mimetype ?? "application/octet-stream",
        });
      } catch (error) {
        console.error(`ファイル取得エラー: ${file.name ?? i}`, error);
      }
    }

    if (parts.length === 0 && !comment.trim()) {
      console.warn("送信可能なファイルがありません");
      try {
        await removeReaction(channel, ts, REACTION_WORKING, botToken);
      } catch {
        // no_reaction などは無視
      }
      try {
        await addReaction(channel, ts, REACTION_WARN, botToken);
      } catch (error) {
        console.warn(`リアクション追加に失敗 (${REACTION_WARN})`, error);
      }
      return;
    }
  }

  try {
    const result = await pushEvent({ comment, files: parts, apiKey, apiUrl });
    try {
      await removeReaction(channel, ts, REACTION_WORKING, botToken);
    } catch {
      // no_reaction などは無視
    }

    if (result.ok) {
      console.info(`KOZOTAI イベント送信成功: HTTP ${result.status}`);
      try {
        await addReaction(channel, ts, REACTION_OK, botToken);
      } catch (error) {
        console.warn(`リアクション追加に失敗 (${REACTION_OK})`, error);
      }
    } else {
      console.error(`KOZOTAI イベント送信失敗: HTTP ${result.status} ${result.body}`);
      try {
        await addReaction(channel, ts, REACTION_NG, botToken);
      } catch (error) {
        console.warn(`リアクション追加に失敗 (${REACTION_NG})`, error);
      }
    }
  } catch (error) {
    console.error("KOZOTAI API リクエストエラー", error);
    try {
      await removeReaction(channel, ts, REACTION_WORKING, botToken);
    } catch {
      // no_reaction などは無視
    }
    try {
      await addReaction(channel, ts, REACTION_NG, botToken);
    } catch (reactionError) {
      console.warn(`リアクション追加に失敗 (${REACTION_NG})`, reactionError);
    }
  }
}

async function handleSlackEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let requiredEnv: ReturnType<typeof getRequiredEnv>;
  try {
    requiredEnv = getRequiredEnv(env);
  } catch (error) {
    console.error(error);
    return new Response("Missing required environment variables", { status: 500 });
  }

  const rawBody = await request.text();
  const verified = await verifySlackSignature(
    rawBody,
    request.headers,
    requiredEnv.signingSecret
  );
  if (!verified) {
    return new Response("Invalid Slack signature", { status: 401 });
  }

  let payload: SlackEventRequestBody;
  try {
    payload = JSON.parse(rawBody) as SlackEventRequestBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (payload.type === "url_verification") {
    return new Response(payload.challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const retryNum = request.headers.get("x-slack-retry-num");
  const retryReason = request.headers.get("x-slack-retry-reason");
  if (retryNum) {
    console.info(`Slack リトライをスキップ: retry_num=${retryNum} reason=${retryReason ?? "-"}`);
    return new Response("ok");
  }

  const eventId = payload.event_id;
  if (eventId && !markEventProcessed(eventId)) {
    console.info(`重複イベントをスキップ: event_id=${eventId}`);
    return new Response("ok");
  }

  if (payload.type === "event_callback" && payload.event) {
    ctx.waitUntil(handleMessageEvent(payload, env));
  }

  return new Response("ok");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvents(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
