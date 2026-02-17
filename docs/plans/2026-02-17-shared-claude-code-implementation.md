# Shared Claude Code — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A web app that wraps the real `claude` CLI in a PTY and lets two people share the same session via browser.

**Architecture:** Node.js server spawns `claude` in a pseudo-terminal per room. socket.io relays terminal I/O between the PTY and two browser clients. xterm.js renders the terminal in the browser. Room codes let the guest join.

**Tech Stack:** Node.js, TypeScript, Express, socket.io, node-pty, xterm.js, vitest

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

**Step 1: Create package.json**

```json
{
  "name": "shared-claude-code",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.21.0",
    "nanoid": "^5.0.9",
    "node-pty": "^1.0.0",
    "socket.io": "^4.8.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "socket.io-client": "^4.8.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Install dependencies**

Run: `npm install`
Expected: Clean install, node_modules created.

**Step 4: Commit**

```bash
git add package.json tsconfig.json package-lock.json
git commit -m "chore: scaffold project with dependencies"
```

---

### Task 2: Room Management — Tests First

**Files:**
- Create: `tests/rooms.test.ts`
- Create: `src/rooms.ts`

**Step 1: Write the failing tests**

```typescript
// tests/rooms.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomManager, Room } from "../src/rooms.js";

describe("RoomManager", () => {
  let manager: RoomManager;

  beforeEach(() => {
    manager = new RoomManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  describe("createRoom", () => {
    it("creates a room with a 6-character code", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      expect(room.code).toHaveLength(6);
      expect(room.code).toMatch(/^[a-z0-9]+$/);
    });

    it("stores the room and retrieves it by code", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      const found = manager.getRoom(room.code);
      expect(found).toBe(room);
    });

    it("sets host display name when provided", () => {
      const room = manager.createRoom({ cwd: "/tmp", hostName: "Alice" });
      expect(room.hostName).toBe("Alice");
    });
  });

  describe("getRoom", () => {
    it("returns undefined for unknown codes", () => {
      expect(manager.getRoom("nope")).toBeUndefined();
    });
  });

  describe("Room", () => {
    it("tracks connected user count", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      expect(room.userCount).toBe(0);
    });

    it("allows up to 2 users", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      const added1 = room.addUser("socket1", "Alice");
      const added2 = room.addUser("socket2", "Bob");
      expect(added1).toBe(true);
      expect(added2).toBe(true);
      expect(room.userCount).toBe(2);
    });

    it("rejects a 3rd user", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      const added3 = room.addUser("socket3", "Charlie");
      expect(added3).toBe(false);
      expect(room.userCount).toBe(2);
    });

    it("removes a user by socket ID", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      room.removeUser("socket1");
      expect(room.userCount).toBe(1);
    });

    it("returns user display name by socket ID", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      expect(room.getUserName("socket1")).toBe("Alice");
    });

    it("lists all connected users", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      expect(room.getUsers()).toEqual([
        { socketId: "socket1", name: "Alice" },
        { socketId: "socket2", name: "Bob" },
      ]);
    });
  });

  describe("destroyRoom", () => {
    it("removes the room from the manager", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      manager.destroyRoom(room.code);
      expect(manager.getRoom(room.code)).toBeUndefined();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rooms.test.ts`
Expected: FAIL — module `../src/rooms.js` does not exist.

**Step 3: Implement rooms.ts**

```typescript
// src/rooms.ts
import { nanoid } from "nanoid";

interface UserInfo {
  socketId: string;
  name: string;
}

interface CreateRoomOptions {
  cwd: string;
  hostName?: string;
}

const MAX_USERS = 2;

export class Room {
  readonly code: string;
  readonly cwd: string;
  readonly hostName: string;
  private users: Map<string, string> = new Map(); // socketId → displayName

  constructor(code: string, options: CreateRoomOptions) {
    this.code = code;
    this.cwd = options.cwd;
    this.hostName = options.hostName ?? "Host";
  }

  get userCount(): number {
    return this.users.size;
  }

  addUser(socketId: string, name: string): boolean {
    if (this.users.size >= MAX_USERS) return false;
    this.users.set(socketId, name);
    return true;
  }

  removeUser(socketId: string): void {
    this.users.delete(socketId);
  }

  getUserName(socketId: string): string | undefined {
    return this.users.get(socketId);
  }

  getUsers(): UserInfo[] {
    return Array.from(this.users.entries()).map(([socketId, name]) => ({
      socketId,
      name,
    }));
  }

  destroy(): void {
    this.users.clear();
  }
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();

  createRoom(options: CreateRoomOptions): Room {
    const code = nanoid(6).toLowerCase();
    const room = new Room(code, options);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  destroyRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      room.destroy();
      this.rooms.delete(code);
    }
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rooms.test.ts`
Expected: All 9 tests PASS.

**Step 5: Commit**

```bash
git add src/rooms.ts tests/rooms.test.ts
git commit -m "feat: add room management with create/join/destroy"
```

---

### Task 3: Server Core — Express + socket.io + PTY

**Files:**
- Create: `src/server.ts`
- Create: `tests/server.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/server.test.ts
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { createServer, type SharedClaudeServer } from "../src/server.js";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const TEST_PORT = 0; // Let OS pick a free port

function connectClient(port: number, query: Record<string, string>): ClientSocket {
  return ioClient(`http://localhost:${port}`, {
    query,
    transports: ["websocket"],
    forceNew: true,
  });
}

function waitForEvent(socket: ClientSocket, event: string): Promise<any> {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

describe("Server", () => {
  let server: SharedClaudeServer;
  const clients: ClientSocket[] = [];

  afterEach(() => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("starts and listens on a port", async () => {
    server = await createServer({ port: TEST_PORT });
    expect(server.port).toBeGreaterThan(0);
  });

  it("creates a room via POST /api/rooms", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp", hostName: "Alice" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
  });

  it("returns 404 for joining a non-existent room", async () => {
    const client = connectClient(server.port, {
      roomCode: "nope00",
      displayName: "Bob",
    });
    clients.push(client);

    const error = await waitForEvent(client, "error:room");
    expect(error.message).toContain("not found");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — module `../src/server.js` does not exist.

**Step 3: Implement server.ts**

```typescript
// src/server.ts
import express from "express";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import * as pty from "node-pty";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RoomManager } from "./rooms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SharedClaudeServer {
  port: number;
  close(): Promise<void>;
}

interface ServerOptions {
  port?: number;
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

  // --- Middleware ---
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- REST API ---
  app.post("/api/rooms", (req, res) => {
    const { cwd, hostName } = req.body ?? {};
    const workingDir = cwd || process.cwd();
    const room = roomManager.createRoom({ cwd: workingDir, hostName });

    // Spawn claude in a PTY
    const shell = pty.spawn("claude", [], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    // Store PTY on room for later access
    (room as any).pty = shell;

    // When PTY produces output, broadcast to all sockets in the room
    shell.onData((data: string) => {
      io.to(room.code).emit("terminal:output", data);
    });

    // When claude exits, notify room and clean up
    shell.onExit(({ exitCode }) => {
      io.to(room.code).emit("terminal:exit", { exitCode });
      roomManager.destroyRoom(room.code);
    });

    res.json({ code: room.code });
  });

  // --- WebSocket ---
  io.on("connection", (socket) => {
    const { roomCode, displayName } = socket.handshake.query as Record<
      string,
      string
    >;

    if (!roomCode || !displayName) {
      socket.emit("error:room", { message: "roomCode and displayName required" });
      socket.disconnect();
      return;
    }

    const room = roomManager.getRoom(roomCode);
    if (!room) {
      socket.emit("error:room", { message: `Room '${roomCode}' not found` });
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

    // Terminal input from this user → PTY stdin
    socket.on("terminal:input", (data: string) => {
      const ptyProcess = (room as any).pty as pty.IPty | undefined;
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
      const ptyProcess = (room as any).pty as pty.IPty | undefined;
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
        const ptyProcess = (room as any).pty as pty.IPty | undefined;
        if (ptyProcess) {
          ptyProcess.kill();
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: All 3 tests PASS.

Note: The "creates a room" test spawns a real `claude` process. If `claude` is not on the test machine PATH, the test will error. That's acceptable — this is an integration test that needs the real CLI.

**Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: add server with Express, socket.io, and PTY spawning"
```

---

### Task 4: Client — Landing Page

**Files:**
- Create: `public/index.html`
- Create: `public/style.css`

**Step 1: Create index.html**

The HTML has two views: a landing page (create/join) and a session page (terminal). We toggle visibility with JS — no router needed.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Shared Claude Code</title>
  <link rel="stylesheet" href="/style.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
</head>
<body>
  <!-- Landing Page -->
  <div id="landing" class="page">
    <h1>Shared Claude Code</h1>
    <p class="subtitle">Collaborate in a shared Claude Code terminal session</p>

    <div class="card-container">
      <!-- Create Room -->
      <div class="card">
        <h2>Create Session</h2>
        <label>
          Your Name
          <input type="text" id="create-name" placeholder="Alice" maxlength="20" />
        </label>
        <label>
          Working Directory
          <input type="text" id="create-cwd" placeholder="/path/to/project" />
        </label>
        <button id="btn-create">Create Room</button>
      </div>

      <!-- Join Room -->
      <div class="card">
        <h2>Join Session</h2>
        <label>
          Your Name
          <input type="text" id="join-name" placeholder="Bob" maxlength="20" />
        </label>
        <label>
          Room Code
          <input type="text" id="join-code" placeholder="abc123" maxlength="6" />
        </label>
        <button id="btn-join">Join Room</button>
      </div>
    </div>
  </div>

  <!-- Session Page -->
  <div id="session" class="page hidden">
    <div id="status-bar">
      <span id="room-code-display"></span>
      <span id="users-display"></span>
      <span id="typing-display"></span>
    </div>
    <div id="terminal-container"></div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="/client.js"></script>
</body>
</html>
```

**Step 2: Create style.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
  background: #1a1a2e;
  color: #e0e0e0;
  min-height: 100vh;
}

.page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
.hidden { display: none !important; }

/* Landing */
h1 { font-size: 2rem; margin-bottom: 0.25rem; color: #fff; }
.subtitle { color: #888; margin-bottom: 2rem; }

.card-container { display: flex; gap: 2rem; flex-wrap: wrap; justify-content: center; }
.card {
  background: #16213e;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 2rem;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.card h2 { font-size: 1.2rem; color: #ccc; }

label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: #999; }
input {
  padding: 0.6rem;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: #0f0f23;
  color: #e0e0e0;
  font-size: 1rem;
  font-family: inherit;
}
input:focus { outline: none; border-color: #5865f2; }

button {
  padding: 0.7rem;
  border: none;
  border-radius: 6px;
  background: #5865f2;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  font-family: inherit;
}
button:hover { background: #4752c4; }

/* Session */
#session { padding: 0; min-height: 100vh; justify-content: flex-start; }
#status-bar {
  width: 100%;
  padding: 0.5rem 1rem;
  background: #0f0f23;
  border-bottom: 1px solid #2a2a4a;
  display: flex;
  gap: 1.5rem;
  font-size: 0.85rem;
  color: #888;
  align-items: center;
}
#status-bar span { white-space: nowrap; }
#room-code-display { color: #5865f2; font-weight: bold; }
#typing-display { color: #faa61a; font-style: italic; }

#terminal-container {
  flex: 1;
  width: 100%;
  background: #000;
}
```

**Step 3: Verify by starting the server**

Run: `npm run dev`
Open: `http://localhost:3000`
Expected: See the landing page with Create/Join cards.

**Step 4: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: add landing page UI with create/join room forms"
```

---

### Task 5: Client — Terminal Session + socket.io Wiring

**Files:**
- Create: `public/client.js`

**Step 1: Implement client.js**

```javascript
// public/client.js
(function () {
  const $ = (sel) => document.querySelector(sel);
  const landingPage = $("#landing");
  const sessionPage = $("#session");
  const roomCodeDisplay = $("#room-code-display");
  const usersDisplay = $("#users-display");
  const typingDisplay = $("#typing-display");

  let socket = null;
  let term = null;
  let fitAddon = null;
  let typingTimeout = null;

  // --- Landing Page Handlers ---

  $("#btn-create").addEventListener("click", async () => {
    const name = $("#create-name").value.trim() || "Host";
    const cwd = $("#create-cwd").value.trim() || undefined;

    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, hostName: name }),
    });

    if (!res.ok) {
      alert("Failed to create room");
      return;
    }

    const { code } = await res.json();
    joinRoom(code, name);
  });

  $("#btn-join").addEventListener("click", () => {
    const name = $("#join-name").value.trim() || "Guest";
    const code = $("#join-code").value.trim().toLowerCase();

    if (!code || code.length !== 6) {
      alert("Enter a 6-character room code");
      return;
    }

    joinRoom(code, name);
  });

  // --- Session Logic ---

  function joinRoom(roomCode, displayName) {
    // Switch to session view
    landingPage.classList.add("hidden");
    sessionPage.classList.remove("hidden");
    roomCodeDisplay.textContent = "Room: " + roomCode;

    // Set up xterm.js
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      theme: {
        background: "#0f0f23",
        foreground: "#e0e0e0",
        cursor: "#5865f2",
      },
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($("#terminal-container"));
    fitAddon.fit();

    // Connect socket.io
    socket = io({
      query: { roomCode, displayName },
      transports: ["websocket"],
    });

    // Terminal output from server → render
    socket.on("terminal:output", (data) => {
      term.write(data);
    });

    // Terminal exited
    socket.on("terminal:exit", ({ exitCode }) => {
      term.write("\r\n\x1b[33m[Claude exited with code " + exitCode + "]\x1b[0m\r\n");
    });

    // User input → server
    term.onData((data) => {
      socket.emit("terminal:input", data);

      // Typing indicator
      socket.emit("user:typing");
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit("user:stop-typing");
      }, 1000);
    });

    // Resize → server
    term.onResize(({ cols, rows }) => {
      socket.emit("terminal:resize", { cols, rows });
    });

    window.addEventListener("resize", () => {
      if (fitAddon) fitAddon.fit();
    });

    // Send initial size
    socket.on("connect", () => {
      socket.emit("terminal:resize", { cols: term.cols, rows: term.rows });
    });

    // Presence events
    socket.on("user:joined", ({ name, users }) => {
      usersDisplay.textContent = "Users: " + users.join(", ");
      if (name !== displayName) {
        term.write("\r\n\x1b[36m[" + name + " joined]\x1b[0m\r\n");
      }
    });

    socket.on("user:left", ({ name, users }) => {
      usersDisplay.textContent = "Users: " + users.join(", ");
      term.write("\r\n\x1b[33m[" + name + " left]\x1b[0m\r\n");
    });

    // Typing indicator
    socket.on("user:typing", ({ name }) => {
      typingDisplay.textContent = name + " is typing...";
    });

    socket.on("user:stop-typing", () => {
      typingDisplay.textContent = "";
    });

    // Error
    socket.on("error:room", ({ message }) => {
      alert("Error: " + message);
      sessionPage.classList.add("hidden");
      landingPage.classList.remove("hidden");
    });

    // Disconnected
    socket.on("disconnect", () => {
      term.write("\r\n\x1b[31m[Disconnected from server]\x1b[0m\r\n");
    });
  }
})();
```

**Step 2: Manual test — single user**

Run: `npm run dev`
Open: `http://localhost:3000`
1. Enter a name and working directory (e.g. `/tmp`)
2. Click "Create Room"
3. Expected: Terminal appears, `claude` CLI starts, you can interact with it
4. Note the room code in the status bar

**Step 3: Manual test — two users**

1. Copy the room code
2. Open a second browser tab to `http://localhost:3000`
3. Enter a name and the room code, click "Join"
4. Expected: Both tabs show the same terminal output. Typing in either tab sends input to Claude.
5. Expected: Status bar shows both user names. Typing indicator appears.

**Step 4: Commit**

```bash
git add public/client.js
git commit -m "feat: add client with xterm.js terminal and socket.io wiring"
```

---

### Task 6: Error Handling and Edge Cases

**Files:**
- Modify: `src/server.ts`
- Modify: `public/client.js`
- Create: `tests/edge-cases.test.ts`

**Step 1: Write failing tests for edge cases**

```typescript
// tests/edge-cases.test.ts
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { createServer, type SharedClaudeServer } from "../src/server.js";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const TEST_PORT = 0;

function connectClient(port: number, query: Record<string, string>): ClientSocket {
  return ioClient(`http://localhost:${port}`, {
    query,
    transports: ["websocket"],
    forceNew: true,
  });
}

function waitForEvent(socket: ClientSocket, event: string): Promise<any> {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

describe("Edge cases", () => {
  let server: SharedClaudeServer;
  const clients: ClientSocket[] = [];

  afterEach(() => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("rejects connection without roomCode", async () => {
    server = await createServer({ port: TEST_PORT });
    const client = connectClient(server.port, { displayName: "Alice" });
    clients.push(client);

    const error = await waitForEvent(client, "error:room");
    expect(error.message).toContain("required");
  });

  it("rejects connection without displayName", async () => {
    const client = connectClient(server.port, { roomCode: "abc123" });
    clients.push(client);

    const error = await waitForEvent(client, "error:room");
    expect(error.message).toContain("required");
  });

  it("rejects 3rd user joining a full room", async () => {
    // Create room
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    const { code } = await res.json();

    // Join 2 users
    const c1 = connectClient(server.port, { roomCode: code, displayName: "A" });
    const c2 = connectClient(server.port, { roomCode: code, displayName: "B" });
    clients.push(c1, c2);

    await waitForEvent(c1, "user:joined");
    await waitForEvent(c2, "user:joined");

    // 3rd user
    const c3 = connectClient(server.port, { roomCode: code, displayName: "C" });
    clients.push(c3);

    const error = await waitForEvent(c3, "error:room");
    expect(error.message).toContain("full");
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/edge-cases.test.ts`
Expected: All 3 tests PASS (the server already handles these cases).

If any fail, fix the server code accordingly.

**Step 3: Add reconnection handling to client.js**

Add to the socket.io connection options in `public/client.js`:

```javascript
socket = io({
  query: { roomCode, displayName },
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

socket.on("reconnect_failed", () => {
  term.write("\r\n\x1b[31m[Failed to reconnect. Refresh to try again.]\x1b[0m\r\n");
});

socket.on("reconnect", () => {
  term.write("\r\n\x1b[32m[Reconnected]\x1b[0m\r\n");
});
```

**Step 4: Commit**

```bash
git add tests/edge-cases.test.ts src/server.ts public/client.js
git commit -m "feat: add edge case tests and reconnection handling"
```

---

### Task 7: Final Polish

**Files:**
- Modify: `public/index.html` — add copy-room-code button
- Modify: `public/client.js` — add copy functionality

**Step 1: Add copy button to status bar**

In `public/index.html`, update the room-code-display span:

```html
<span id="room-code-display"></span>
<button id="btn-copy-code" class="copy-btn" title="Copy room code">Copy</button>
```

**Step 2: Add copy handler in client.js**

Add after `roomCodeDisplay.textContent = "Room: " + roomCode;`:

```javascript
const copyBtn = $("#btn-copy-code");
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
});
```

**Step 3: Add copy button styles to style.css**

```css
.copy-btn {
  padding: 0.2rem 0.6rem;
  font-size: 0.75rem;
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  border-radius: 4px;
  color: #888;
  cursor: pointer;
}
.copy-btn:hover { background: #3a3a5a; color: #ccc; }
```

**Step 4: Manual test**

Run: `npm run dev`
1. Create a room
2. Click "Copy" button
3. Expected: Room code copied to clipboard

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add public/index.html public/client.js public/style.css
git commit -m "feat: add copy-room-code button and final polish"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Project scaffolding | — |
| 2 | Room management (create/join/destroy) | 9 unit tests |
| 3 | Server (Express + socket.io + PTY) | 3 integration tests |
| 4 | Client landing page | Manual |
| 5 | Client terminal + socket.io wiring | Manual (2-tab test) |
| 6 | Error handling and edge cases | 3 integration tests |
| 7 | Copy button and polish | Manual |

Total: 7 tasks, ~15 tests, one full working app.
