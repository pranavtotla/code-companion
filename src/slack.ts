import * as crypto from "node:crypto";
import { WebClient } from "@slack/web-api";

const ANSI_REGEX =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\([A-Z]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

export class OutputBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly onFlush: (text: string) => void;

  constructor(delayMs: number, onFlush: (text: string) => void) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  append(data: string): void {
    this.buffer += data;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = "";
  }

  private flush(): void {
    this.timer = null;
    const text = stripAnsi(this.buffer);
    this.buffer = "";
    if (text.length > 0) {
      this.onFlush(text);
    }
  }
}

const MAX_SIGNATURE_AGE_SECONDS = 300; // 5 minutes

export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SIGNATURE_AGE_SECONDS) {
    return false;
  }

  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(basestring)
    .digest("hex");
  const computed = `v0=${hmac}`;

  if (computed.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(signature)
  );
}

interface SlackBridgeOptions {
  botToken: string;
  signingSecret: string;
}

interface LinkedRoom {
  channelId: string;
  threadTs: string;
  buffer: OutputBuffer;
}

const OUTPUT_BUFFER_DELAY_MS = 500;
const MAX_SLACK_TEXT_LENGTH = 3900;

export class SlackBridge {
  readonly client: WebClient;
  readonly signingSecret: string;
  private linkedRooms: Map<string, LinkedRoom> = new Map();
  private threadToRoom: Map<string, string> = new Map(); // "channel:thread" -> roomCode
  private writeCallback: ((roomCode: string, data: string) => void) | null =
    null;

  constructor(options: SlackBridgeOptions) {
    this.client = new WebClient(options.botToken);
    this.signingSecret = options.signingSecret;
  }

  linkRoom(roomCode: string, channelId: string, threadTs: string): void {
    const buffer = new OutputBuffer(OUTPUT_BUFFER_DELAY_MS, (text) => {
      this.postOutput(channelId, threadTs, text);
    });
    this.linkedRooms.set(roomCode, { channelId, threadTs, buffer });
    this.threadToRoom.set(`${channelId}:${threadTs}`, roomCode);
  }

  unlinkRoom(roomCode: string): void {
    const linked = this.linkedRooms.get(roomCode);
    if (!linked) return;
    linked.buffer.destroy();
    this.threadToRoom.delete(`${linked.channelId}:${linked.threadTs}`);
    this.linkedRooms.delete(roomCode);
  }

  getRoomForThread(channelId: string, threadTs: string): string | undefined {
    return this.threadToRoom.get(`${channelId}:${threadTs}`);
  }

  onOutput(roomCode: string, data: string): void {
    const linked = this.linkedRooms.get(roomCode);
    if (linked) {
      linked.buffer.append(data);
    }
  }

  onRoomDestroyed(roomCode: string): void {
    const linked = this.linkedRooms.get(roomCode);
    if (linked) {
      this.client.chat
        .postMessage({
          channel: linked.channelId,
          thread_ts: linked.threadTs,
          text: "Session ended.",
        })
        .catch(() => {});
      this.unlinkRoom(roomCode);
    }
  }

  handleThreadReply(channelId: string, threadTs: string, text: string): void {
    const roomCode = this.getRoomForThread(channelId, threadTs);
    if (roomCode && this.writeCallback) {
      this.writeCallback(roomCode, text + "\n");
    }
  }

  onWrite(callback: (roomCode: string, data: string) => void): void {
    this.writeCallback = callback;
  }

  private postOutput(
    channelId: string,
    threadTs: string,
    text: string
  ): void {
    let truncated = text;
    if (truncated.length > MAX_SLACK_TEXT_LENGTH) {
      truncated = truncated.slice(0, MAX_SLACK_TEXT_LENGTH) + "…";
    }
    this.client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "```\n" + truncated + "\n```",
      })
      .catch(() => {});
  }

  destroy(): void {
    const codes = Array.from(this.linkedRooms.keys());
    for (const roomCode of codes) {
      this.unlinkRoom(roomCode);
    }
  }
}
