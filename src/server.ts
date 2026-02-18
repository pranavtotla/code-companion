import express from "express";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RoomManager } from "./rooms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RoomInfo {
  roomCode: string;
  userCount: number;
  localUrl: string;
}

export interface CreateRoomResult {
  roomCode: string;
  localUrl: string;
}

export interface CodeCompanionServer {
  port: number;
  close(): Promise<void>;
  createRoom(options: { cwd?: string }): Promise<CreateRoomResult>;
  getRooms(): RoomInfo[];
  stopRoom(code: string): boolean;
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

  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(express.json());

  // --- Shared room-creation logic ---
  function createRoomInternal(cwd?: string): { roomCode: string } {
    const room = roomManager.createRoom();

    let shell: IPtyLike;
    try {
      shell = spawnPty("bash", [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: cwd ?? process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      roomManager.destroyRoom(room.code);
      throw err;
    }

    // Store PTY process for this room
    ptyProcesses.set(room.code, shell);

    // When PTY produces output, broadcast to all sockets in the room
    shell.onData((data: string) => {
      io.to(room.code).emit("terminal:output", data);
    });

    // When shell exits, notify room and clean up
    shell.onExit(({ exitCode }) => {
      io.to(room.code).emit("terminal:exit", { exitCode });
      ptyProcesses.delete(room.code);
      roomManager.destroyRoom(room.code);
    });

    return { roomCode: room.code };
  }

  // --- REST API ---
  app.post("/api/rooms", (req, res) => {
    try {
      const cwd = req.body?.cwd as string | undefined;
      const { roomCode } = createRoomInternal(cwd);
      res.json({ code: roomCode });
    } catch (err) {
      console.error("PTY spawn failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Failed to spawn shell: ${message}` });
    }
  });

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
            roomManager.destroyAll();
            io.close();
            httpServer.close(() => res());
          }),

        async createRoom(opts: { cwd?: string } = {}): Promise<CreateRoomResult> {
          const { roomCode } = createRoomInternal(opts.cwd);
          return {
            roomCode,
            localUrl: `http://localhost:${actualPort}/?room=${roomCode}`,
          };
        },

        getRooms(): RoomInfo[] {
          return roomManager.getAllRooms().map((room) => ({
            roomCode: room.code,
            userCount: room.userCount,
            localUrl: `http://localhost:${actualPort}/?room=${room.code}`,
          }));
        },

        stopRoom(code: string): boolean {
          const room = roomManager.getRoom(code);
          if (!room) return false;

          const ptyProcess = ptyProcesses.get(code);
          if (ptyProcess) {
            ptyProcess.kill();
            ptyProcesses.delete(code);
          }

          // Notify connected clients
          io.to(code).emit("terminal:exit", { exitCode: 0 });

          roomManager.destroyRoom(code);
          return true;
        },
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
  createServer({ port }).then((s) => {
    console.log(`Code Companion running on http://localhost:${s.port}`);
  });
}
