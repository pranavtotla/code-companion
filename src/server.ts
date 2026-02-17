import express from "express";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { RoomManager } from "./rooms.js";

/** Resolve full path to claude binary since child_process may not see shell PATH */
function resolveClaudePath(): string {
  try {
    return execFileSync("/usr/bin/which", ["claude"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "claude";
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SharedClaudeServer {
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
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(e: { exitCode: number }) => void> = [];

  proc.stdout?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    console.log("[PTY stdout]", JSON.stringify(str).slice(0, 200));
    for (const cb of dataCallbacks) cb(str);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    console.error("[PTY stderr]", JSON.stringify(str).slice(0, 200));
    for (const cb of dataCallbacks) cb(str);
  });

  proc.on("exit", (code, signal) => {
    console.log("[PTY exit] code:", code, "signal:", signal);
    for (const cb of exitCallbacks) cb({ exitCode: code ?? 0 });
  });

  proc.on("error", (err) => {
    console.error("[PTY error]", err);
  });

  console.log("[PTY spawned] pid:", proc.pid, "cmd:", fullCmd);

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
    resize: (cols, rows) => {
      // Update env and signal the Python helper to resize the PTY
      if (proc.pid) {
        process.env.COLUMNS = String(cols);
        process.env.LINES = String(rows);
        try {
          process.kill(proc.pid, "SIGUSR1");
        } catch {
          // Process may have already exited
        }
      }
    },
    kill: (signal) => {
      proc.kill(signal as NodeJS.Signals | undefined);
    },
  };
}

export async function createServer(
  options: ServerOptions = {}
): Promise<SharedClaudeServer> {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" },
  });
  const roomManager = new RoomManager();
  const spawnPty = options.spawnPty ?? defaultSpawnPty;
  const claudePath = resolveClaudePath();
  console.log("Resolved claude path:", claudePath);

  // Track PTY processes by room code for cleanup
  const ptyProcesses = new Map<string, IPtyLike>();

  // --- Middleware ---
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- REST API ---
  app.post("/api/rooms", (req, res) => {
    const { cwd, hostName } = req.body ?? {};
    const workingDir = cwd || process.cwd();

    // Validate the working directory exists
    if (!fs.existsSync(workingDir)) {
      res
        .status(400)
        .json({ error: `Directory does not exist: ${workingDir}` });
      return;
    }

    const room = roomManager.createRoom({ cwd: workingDir, hostName });

    try {
      // Spawn claude in a PTY
      const shell = spawnPty(claudePath, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: workingDir,
        env: process.env as Record<string, string>,
      });

      // Store PTY process for this room
      ptyProcesses.set(room.code, shell);

      // When PTY produces output, broadcast to all sockets in the room
      shell.onData((data: string) => {
        io.to(room.code).emit("terminal:output", data);
      });

      // When claude exits, notify room and clean up
      shell.onExit(({ exitCode }) => {
        io.to(room.code).emit("terminal:exit", { exitCode });
        ptyProcesses.delete(room.code);
        roomManager.destroyRoom(room.code);
      });
    } catch (err) {
      console.error("PTY spawn failed:", err);
      console.error("Claude path:", claudePath);
      console.error("Working dir:", workingDir);
      roomManager.destroyRoom(room.code);
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Failed to spawn claude: ${message}` });
      return;
    }

    res.json({ code: room.code });
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

    if (!room.addUser(socket.id, displayName)) {
      socket.emit("error:room", { message: "Room is full (max 2 users)" });
      socket.disconnect();
      return;
    }

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

    // Terminal resize
    socket.on("terminal:resize", (size: { cols: number; rows: number }) => {
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
    console.log(`Shared Claude Code running on http://localhost:${s.port}`);
  });
}
