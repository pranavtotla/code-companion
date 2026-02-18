import express from "express";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as querystring from "node:querystring";
import { RoomManager } from "./rooms.js";
import { SlackBridge, verifySlackSignature } from "./slack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CodeCompanionServer {
  port: number;
  close(): Promise<void>;
}

/** Minimal interface for a PTY-like process */
export interface IPtyLike {
  pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Function signature for spawning a PTY */
export type SpawnPty = (
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }
) => IPtyLike;

interface ServerOptions {
  port?: number;
  /** Override the PTY spawner (for testing) */
  spawnPty?: SpawnPty;
  /** Optional Slack integration */
  slackBridge?: SlackBridge;
}

const PTY_HELPER = path.join(__dirname, "pty-helper.py");

/**
 * Default PTY spawner using a Python helper script.
 *
 * The helper uses Python's pty.openpty() to create a real pseudo-terminal,
 * then relays between piped stdin/stdout and the PTY master fd.
 * Works with piped stdio from Node — no native modules needed.
 */
function defaultSpawnPty(
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }
): IPtyLike {
  const proc = spawn("python3", [PTY_HELPER, command, ...args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      TERM: options.name,
      COLUMNS: String(options.cols),
      LINES: String(options.rows),
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(e: { exitCode: number }) => void> = [];

  proc.stdout?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    for (const cb of dataCallbacks) cb(str);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    console.error("[PTY stderr]", chunk.toString("utf-8").slice(0, 200));
  });

  proc.on("exit", (code) => {
    for (const cb of exitCallbacks) cb({ exitCode: code ?? 0 });
  });

  proc.on("error", (err) => {
    console.error("[PTY error]", err);
  });

  return {
    pid: proc.pid ?? 0,
    onData: (cb) => {
      dataCallbacks.push(cb);
    },
    onExit: (cb) => {
      exitCallbacks.push(cb);
    },
    write: (data) => {
      proc.stdin?.write(data);
    },
    resize: () => {},
    kill: (signal) => {
      proc.kill(signal as NodeJS.Signals | undefined);
    },
  };
}

export async function createServer(
  options: ServerOptions = {}
): Promise<CodeCompanionServer> {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" },
  });
  const roomManager = new RoomManager();
  const spawnPty = options.spawnPty ?? defaultSpawnPty;

  // Track PTY processes by room code for cleanup
  const ptyProcesses = new Map<string, IPtyLike>();
  const slackBridge = options.slackBridge ?? null;

  if (slackBridge) {
    slackBridge.onWrite((roomCode, input) => {
      const ptyProcess = ptyProcesses.get(roomCode);
      if (ptyProcess) ptyProcess.write(input);
    });
  }

  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- REST API ---
  app.post("/api/rooms", (_req, res) => {
    const room = roomManager.createRoom();

    try {
      // Spawn bash in a PTY
      const shell = spawnPty("bash", [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });

      // Store PTY process for this room
      ptyProcesses.set(room.code, shell);

      // When PTY produces output, broadcast to all sockets in the room
      shell.onData((data: string) => {
        io.to(room.code).emit("terminal:output", data);
        if (slackBridge) slackBridge.onOutput(room.code, data);
      });

      // When shell exits, notify room and clean up
      shell.onExit(({ exitCode }) => {
        io.to(room.code).emit("terminal:exit", { exitCode });
        if (slackBridge) slackBridge.onRoomDestroyed(room.code);
        ptyProcesses.delete(room.code);
        roomManager.destroyRoom(room.code);
      });
    } catch (err) {
      console.error("PTY spawn failed:", err);
      roomManager.destroyRoom(room.code);
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Failed to spawn shell: ${message}` });
      return;
    }

    res.json({ code: room.code });
  });

  // --- Slack endpoints (only when Slack integration is enabled) ---
  if (slackBridge) {
    // Slash command endpoint — needs raw body for signature verification
    app.post(
      "/slack/commands",
      express.raw({ type: "application/x-www-form-urlencoded" }),
      async (req, res) => {
        const rawBody = (req.body as Buffer).toString("utf-8");
        const signature = req.headers["x-slack-signature"] as string;
        const timestamp = req.headers["x-slack-request-timestamp"] as string;

        if (
          !signature ||
          !timestamp ||
          !verifySlackSignature(
            slackBridge.signingSecret,
            signature,
            timestamp,
            rawBody
          )
        ) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }

        const params = querystring.parse(rawBody);
        const text = (params.text as string | undefined)?.trim() ?? "";
        const channelId = params.channel_id as string;

        // "join <code>" — join an existing room
        const joinMatch = text.match(/^join\s+(\S+)$/i);
        if (joinMatch) {
          const code = joinMatch[1];
          const room = roomManager.getRoom(code);
          if (!room) {
            res.json({ response_type: "ephemeral", text: `Room '${code}' not found.` });
            return;
          }
          const thread = await slackBridge.client.chat.postMessage({
            channel: channelId,
            text: `Linked to session \`${code}\``,
          });
          slackBridge.linkRoom(code, channelId, thread.ts!);
          res.json({ response_type: "in_channel", text: `Joined session \`${code}\`` });
          return;
        }

        // Default — create a new room and spawn a PTY
        const room = roomManager.createRoom();
        try {
          const shell = spawnPty("bash", [], {
            name: "xterm-256color",
            cols: 120,
            rows: 40,
            cwd: process.cwd(),
            env: process.env as Record<string, string>,
          });

          ptyProcesses.set(room.code, shell);

          shell.onData((data: string) => {
            io.to(room.code).emit("terminal:output", data);
            if (slackBridge) slackBridge.onOutput(room.code, data);
          });

          shell.onExit(({ exitCode }) => {
            io.to(room.code).emit("terminal:exit", { exitCode });
            if (slackBridge) slackBridge.onRoomDestroyed(room.code);
            ptyProcesses.delete(room.code);
            roomManager.destroyRoom(room.code);
          });
        } catch (err) {
          roomManager.destroyRoom(room.code);
          res.json({ response_type: "ephemeral", text: "Failed to spawn shell." });
          return;
        }

        const thread = await slackBridge.client.chat.postMessage({
          channel: channelId,
          text: `New session started: \`${room.code}\``,
        });
        slackBridge.linkRoom(room.code, channelId, thread.ts!);
        res.json({
          response_type: "in_channel",
          text: `Session \`${room.code}\` created. Reply in the thread to send input.`,
        });
      }
    );

    // Events endpoint — handles url_verification and thread replies
    app.post("/slack/events", express.json(), (req, res) => {
      const body = req.body;

      // Slack URL verification challenge
      if (body.type === "url_verification") {
        res.json({ challenge: body.challenge });
        return;
      }

      // Handle message events in threads
      const event = body.event;
      if (
        event &&
        event.type === "message" &&
        event.thread_ts &&
        !event.bot_id
      ) {
        slackBridge.handleThreadReply(event.channel, event.thread_ts, event.text ?? "");
      }

      res.sendStatus(200);
    });
  }

  // --- WebSocket ---
  io.on("connection", (socket) => {
    const { roomCode, displayName } = socket.handshake.query as Record<
      string,
      string
    >;

    if (!roomCode || !displayName) {
      socket.emit("error:room", {
        message: "roomCode and displayName required",
      });
      socket.disconnect();
      return;
    }

    const room = roomManager.getRoom(roomCode);
    if (!room) {
      socket.emit("error:room", {
        message: `Room '${roomCode}' not found`,
      });
      socket.disconnect();
      return;
    }

    room.addUser(socket.id, displayName);

    socket.join(roomCode);

    // Notify everyone in the room
    io.to(roomCode).emit("user:joined", {
      name: displayName,
      users: room.getUsers().map((u) => u.name),
    });

    // Terminal input from this user -> PTY stdin
    socket.on("terminal:input", (data: string) => {
      const ptyProcess = ptyProcesses.get(roomCode);
      if (ptyProcess) {
        ptyProcess.write(data);
      }
    });

    // Typing indicator
    socket.on("user:typing", () => {
      socket.to(roomCode).emit("user:typing", { name: displayName });
    });

    socket.on("user:stop-typing", () => {
      socket.to(roomCode).emit("user:stop-typing", { name: displayName });
    });

    // Terminal resize (creator only)
    socket.on("terminal:resize", (size: { cols: number; rows: number }) => {
      if (socket.id !== room.creatorSocketId) return;
      const ptyProcess = ptyProcesses.get(roomCode);
      if (ptyProcess) {
        ptyProcess.resize(size.cols, size.rows);
      }
    });

    // Disconnect
    socket.on("disconnect", () => {
      room.removeUser(socket.id);
      io.to(roomCode).emit("user:left", {
        name: displayName,
        users: room.getUsers().map((u) => u.name),
      });

      // If room is empty, kill the PTY and destroy the room
      if (room.userCount === 0) {
        const ptyProcess = ptyProcesses.get(roomCode);
        if (ptyProcess) {
          ptyProcess.kill();
          ptyProcesses.delete(roomCode);
        }
        if (slackBridge) slackBridge.onRoomDestroyed(roomCode);
        roomManager.destroyRoom(roomCode);
      }
    });
  });

  // --- Start ---
  const port = options.port ?? 3000;
  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            // Kill all PTY processes
            for (const [code, ptyProcess] of ptyProcesses) {
              ptyProcess.kill();
              ptyProcesses.delete(code);
            }
            if (slackBridge) slackBridge.destroy();
            roomManager.destroyAll();
            io.close();
            httpServer.close(() => res());
          }),
      });
    });
  });
}

// Run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));
if (isMain) {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackSecret = process.env.SLACK_SIGNING_SECRET;
  let slackBridge: SlackBridge | undefined;

  if (slackToken && slackSecret) {
    slackBridge = new SlackBridge({ botToken: slackToken, signingSecret: slackSecret });
    console.log("Slack integration enabled");
  }

  createServer({ port, slackBridge }).then((s) => {
    console.log(`Code Companion running on http://localhost:${s.port}`);
  });
}
