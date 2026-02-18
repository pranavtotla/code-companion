import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import {
  stripAnsi,
  OutputBuffer,
  verifySlackSignature,
  SlackBridge,
} from "../src/slack.js";
import {
  createServer,
  type CodeCompanionServer,
  type SpawnPty,
  type IPtyLike,
} from "../src/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(
  signingSecret: string,
  timestamp: string,
  body: string
): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  return (
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex")
  );
}

class MockPty implements IPtyLike {
  pid = Math.floor(Math.random() * 100000);
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((e: { exitCode: number }) => void)[] = [];
  killed = false;
  written: string[] = [];
  lastResize: { cols: number; rows: number } | null = null;

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onExit(callback: (e: { exitCode: number }) => void): void {
    this.exitCallbacks.push(callback);
  }

  write(data: string): void {
    this.written.push(data);
    for (const cb of this.dataCallbacks) cb(data);
  }

  resize(cols: number, rows: number): void {
    this.lastResize = { cols, rows };
  }

  kill(_signal?: string): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const cb of this.dataCallbacks) cb(data);
  }

  emitExit(exitCode: number): void {
    for (const cb of this.exitCallbacks) cb({ exitCode });
  }
}

function createMockPty(): { spawner: SpawnPty; instances: MockPty[] } {
  const instances: MockPty[] = [];
  const spawner: SpawnPty = () => {
    const mock = new MockPty();
    instances.push(mock);
    return mock;
  };
  return { spawner, instances };
}

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H")).toBe("");
  });

  it("passes plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles mixed ANSI and plain content", () => {
    expect(stripAnsi("\x1b[1m\x1b[32m$ \x1b[0mls -la")).toBe("$ ls -la");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("removes multiple consecutive ANSI codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[4m\x1b[31mbold underline red\x1b[0m")).toBe(
      "bold underline red"
    );
  });
});

// ---------------------------------------------------------------------------
// OutputBuffer
// ---------------------------------------------------------------------------

describe("OutputBuffer", () => {
  it("buffers output and flushes after delay", async () => {
    const flushed: string[] = [];
    const buffer = new OutputBuffer(50, (text) => flushed.push(text));

    buffer.append("hello");
    expect(flushed).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 100));
    expect(flushed).toEqual(["hello"]);
  });

  it("resets timer on each append, batching output", async () => {
    const flushed: string[] = [];
    const buffer = new OutputBuffer(80, (text) => flushed.push(text));

    // Append every 40ms — timer should keep resetting, batching all output
    buffer.append("a");
    await new Promise((r) => setTimeout(r, 40));
    buffer.append("b");
    await new Promise((r) => setTimeout(r, 40));
    buffer.append("c");

    // Not enough time has passed since last append for the 80ms delay
    expect(flushed).toHaveLength(0);

    // Wait for the final flush
    await new Promise((r) => setTimeout(r, 120));
    expect(flushed).toEqual(["abc"]);
  });

  it("strips ANSI codes before flushing", async () => {
    const flushed: string[] = [];
    const buffer = new OutputBuffer(50, (text) => flushed.push(text));

    buffer.append("\x1b[31mred text\x1b[0m");
    await new Promise((r) => setTimeout(r, 100));
    expect(flushed).toEqual(["red text"]);
  });

  it("does nothing when destroyed before flush", async () => {
    const flushed: string[] = [];
    const buffer = new OutputBuffer(50, (text) => flushed.push(text));

    buffer.append("data");
    buffer.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(flushed).toHaveLength(0);
  });

  it("does not flush empty content after ANSI stripping", async () => {
    const flushed: string[] = [];
    const buffer = new OutputBuffer(50, (text) => flushed.push(text));

    buffer.append("\x1b[2J\x1b[H");
    await new Promise((r) => setTimeout(r, 100));
    // All content was ANSI codes, stripped to empty — onFlush should not fire
    expect(flushed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verifySlackSignature
// ---------------------------------------------------------------------------

describe("verifySlackSignature", () => {
  const signingSecret = "test-signing-secret-abc123";

  it("returns true for a valid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "token=xyzz0WbapA4vBCDEFasx0q6G&command=/code";
    const signature = makeSignature(signingSecret, timestamp, body);

    expect(verifySlackSignature(signingSecret, signature, timestamp, body)).toBe(
      true
    );
  });

  it("returns false for an invalid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "some body content";

    expect(
      verifySlackSignature(signingSecret, "v0=invalidsig", timestamp, body)
    ).toBe(false);
  });

  it("returns false for an old timestamp (>5 min)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const body = "old request body";
    const signature = makeSignature(signingSecret, timestamp, body);

    expect(verifySlackSignature(signingSecret, signature, timestamp, body)).toBe(
      false
    );
  });

  it("returns false for non-numeric timestamp", () => {
    const body = "body";
    const signature = makeSignature(signingSecret, "abc", body);

    expect(verifySlackSignature(signingSecret, signature, "abc", body)).toBe(
      false
    );
  });

  it("returns false when signature length differs from computed", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "body";

    // Signature that is too short
    expect(verifySlackSignature(signingSecret, "v0=short", timestamp, body)).toBe(
      false
    );
  });

  it("returns false for a different signing secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "body content";
    const signature = makeSignature("wrong-secret", timestamp, body);

    expect(verifySlackSignature(signingSecret, signature, timestamp, body)).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// SlackBridge
// ---------------------------------------------------------------------------

describe("SlackBridge", () => {
  let bridge: SlackBridge;

  beforeEach(() => {
    bridge = new SlackBridge({
      botToken: "xoxb-test-token",
      signingSecret: "test-secret",
    });
    // Stub chat.postMessage to avoid real API calls
    bridge.client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    bridge.destroy();
  });

  it("links a room to a Slack thread", () => {
    bridge.linkRoom("abc123", "C123", "1234567890.123456");
    const roomCode = bridge.getRoomForThread("C123", "1234567890.123456");
    expect(roomCode).toBe("abc123");
  });

  it("returns undefined for unlinked thread", () => {
    expect(bridge.getRoomForThread("C999", "9999999999.999999")).toBeUndefined();
  });

  it("unlinks a room and cleans up", () => {
    bridge.linkRoom("abc123", "C123", "1234567890.123456");
    bridge.unlinkRoom("abc123");
    expect(bridge.getRoomForThread("C123", "1234567890.123456")).toBeUndefined();
  });

  it("looks up room code by thread with multiple rooms", () => {
    bridge.linkRoom("room1", "C100", "1000.0001");
    bridge.linkRoom("room2", "C200", "2000.0002");
    bridge.linkRoom("room3", "C100", "3000.0003");

    expect(bridge.getRoomForThread("C100", "1000.0001")).toBe("room1");
    expect(bridge.getRoomForThread("C200", "2000.0002")).toBe("room2");
    expect(bridge.getRoomForThread("C100", "3000.0003")).toBe("room3");
  });

  it("onOutput feeds data to the room's output buffer", async () => {
    // We need to observe the postMessage call when the buffer flushes
    bridge.linkRoom("abc123", "C123", "1234567890.123456");

    bridge.onOutput("abc123", "hello from terminal");

    // Wait for the output buffer to flush (default is 500ms)
    await new Promise((r) => setTimeout(r, 700));

    expect(bridge.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: expect.stringContaining("hello from terminal"),
      })
    );
  });

  it("onOutput does nothing for unlinked room", () => {
    // Should not throw
    bridge.onOutput("nonexistent", "data");
  });

  it("onRoomDestroyed posts 'Session ended.' and unlinks", async () => {
    bridge.linkRoom("abc123", "C123", "1234567890.123456");

    bridge.onRoomDestroyed("abc123");

    expect(bridge.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "Session ended.",
      })
    );

    // Room should be unlinked
    expect(bridge.getRoomForThread("C123", "1234567890.123456")).toBeUndefined();
  });

  it("onRoomDestroyed does nothing for unlinked room", () => {
    // Should not throw
    bridge.onRoomDestroyed("nonexistent");
    expect(bridge.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("handleThreadReply calls write callback with text + newline", () => {
    const writeCalls: { roomCode: string; data: string }[] = [];
    bridge.onWrite((roomCode, data) => writeCalls.push({ roomCode, data }));

    bridge.linkRoom("abc123", "C123", "1234567890.123456");
    bridge.handleThreadReply("C123", "1234567890.123456", "ls -la");

    expect(writeCalls).toEqual([{ roomCode: "abc123", data: "ls -la\n" }]);
  });

  it("handleThreadReply does nothing for unlinked thread", () => {
    const writeCalls: { roomCode: string; data: string }[] = [];
    bridge.onWrite((roomCode, data) => writeCalls.push({ roomCode, data }));

    bridge.handleThreadReply("C999", "9999999999.999999", "test");

    expect(writeCalls).toHaveLength(0);
  });

  it("handleThreadReply does nothing when no write callback is set", () => {
    bridge.linkRoom("abc123", "C123", "1234567890.123456");
    // No onWrite callback registered — should not throw
    bridge.handleThreadReply("C123", "1234567890.123456", "hello");
  });

  it("destroy cleans up all rooms", () => {
    bridge.linkRoom("room1", "C100", "1000.0001");
    bridge.linkRoom("room2", "C200", "2000.0002");
    bridge.linkRoom("room3", "C300", "3000.0003");

    bridge.destroy();

    expect(bridge.getRoomForThread("C100", "1000.0001")).toBeUndefined();
    expect(bridge.getRoomForThread("C200", "2000.0002")).toBeUndefined();
    expect(bridge.getRoomForThread("C300", "3000.0003")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Server with Slack disabled
// ---------------------------------------------------------------------------

describe("Server with Slack disabled", () => {
  let server: CodeCompanionServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("starts without Slack env vars and serves rooms normally", async () => {
    const mockPtyFactory = createMockPty();
    server = await createServer({
      port: 0,
      spawnPty: mockPtyFactory.spawner,
    });

    expect(server.port).toBeGreaterThan(0);

    // Can still create rooms
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
    expect(mockPtyFactory.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Slack endpoints (integration)
// ---------------------------------------------------------------------------

describe("Slack endpoints", () => {
  let server: CodeCompanionServer;
  let mockPtyFactory: ReturnType<typeof createMockPty>;
  let bridge: SlackBridge;

  const TEST_SIGNING_SECRET = "slack-test-signing-secret-xyz";
  const TEST_BOT_TOKEN = "xoxb-test-bot-token";

  async function createSlackServer(): Promise<CodeCompanionServer> {
    mockPtyFactory = createMockPty();
    bridge = new SlackBridge({
      botToken: TEST_BOT_TOKEN,
      signingSecret: TEST_SIGNING_SECRET,
    });
    // Stub Slack API calls
    bridge.client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true });

    server = await createServer({
      port: 0,
      spawnPty: mockPtyFactory.spawner,
      slackBridge: bridge,
    } as any);

    return server;
  }

  /**
   * Send a signed POST request to a Slack endpoint.
   */
  async function slackPost(
    path: string,
    body: string,
    contentType = "application/x-www-form-urlencoded"
  ): Promise<Response> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature(TEST_SIGNING_SECRET, timestamp, body);

    return fetch(`http://localhost:${server.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });
  }

  async function slackPostJson(
    path: string,
    payload: Record<string, any>
  ): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature(TEST_SIGNING_SECRET, timestamp, body);

    return fetch(`http://localhost:${server.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });
  }

  afterEach(async () => {
    if (bridge) bridge.destroy();
    if (server) await server.close();
  });

  it("POST /slack/commands creates room and returns session info", async () => {
    await createSlackServer();

    const params = new URLSearchParams({
      command: "/code",
      text: "",
      channel_id: "C123",
      trigger_id: "T123",
    });

    const res = await slackPost("/slack/commands", params.toString());
    expect(res.ok).toBe(true);

    const data = await res.json();
    expect(data.response_type).toBe("in_channel");
    expect(data.text).toMatch(/[a-z0-9]{6}/); // Contains a room code
  });

  it("POST /slack/commands with 'join <code>' links existing room", async () => {
    await createSlackServer();

    // First create a room via the normal API
    const roomRes = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await roomRes.json();

    const params = new URLSearchParams({
      command: "/code",
      text: `join ${code}`,
      channel_id: "C123",
      trigger_id: "T123",
      thread_ts: "1234567890.123456",
    });

    const res = await slackPost("/slack/commands", params.toString());
    expect(res.ok).toBe(true);

    const data = await res.json();
    expect(data.response_type).toBe("in_channel");
    // Should confirm the join
    expect(data.text).toMatch(new RegExp(code));
  });

  it("POST /slack/commands with 'join <invalid>' returns error", async () => {
    await createSlackServer();

    const params = new URLSearchParams({
      command: "/code",
      text: "join zzzzzz",
      channel_id: "C123",
      trigger_id: "T123",
    });

    const res = await slackPost("/slack/commands", params.toString());
    const data = await res.json();
    expect(data.response_type).toBe("ephemeral");
    expect(data.text).toMatch(/not found/i);
  });

  it("POST /slack/events with url_verification returns challenge", async () => {
    await createSlackServer();

    const payload = {
      type: "url_verification",
      challenge: "test-challenge-string",
    };

    const res = await slackPostJson("/slack/events", payload);
    expect(res.ok).toBe(true);

    const data = await res.json();
    expect(data.challenge).toBe("test-challenge-string");
  });

  it("POST /slack/events with thread reply calls handleThreadReply", async () => {
    await createSlackServer();

    // Link a room first
    const roomRes = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await roomRes.json();
    bridge.linkRoom(code, "C123", "1234567890.123456");

    const writeCalls: { roomCode: string; data: string }[] = [];
    bridge.onWrite((roomCode, data) => writeCalls.push({ roomCode, data }));

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "echo hello",
        user: "U123",
      },
    };

    const res = await slackPostJson("/slack/events", payload);
    expect(res.ok).toBe(true);

    // The bridge should have received the reply
    expect(writeCalls).toEqual([{ roomCode: code, data: "echo hello\n" }]);
  });

  it("POST /slack/events ignores bot messages (has bot_id)", async () => {
    await createSlackServer();

    // Link a room
    const roomRes = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await roomRes.json();
    bridge.linkRoom(code, "C123", "1234567890.123456");

    const writeCalls: { roomCode: string; data: string }[] = [];
    bridge.onWrite((roomCode, data) => writeCalls.push({ roomCode, data }));

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "bot output",
        bot_id: "B123",
      },
    };

    const res = await slackPostJson("/slack/events", payload);
    expect(res.ok).toBe(true);

    // Bot messages should be ignored — no write callback
    expect(writeCalls).toHaveLength(0);
  });

  it("rejects requests with invalid Slack signatures", async () => {
    await createSlackServer();

    const body = "command=/code&text=&channel_id=C123";
    const res = await fetch(`http://localhost:${server.port}/slack/commands`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Slack-Signature": "v0=invalidsignature",
      },
      body,
    });

    expect(res.status).toBe(401);
  });
});
