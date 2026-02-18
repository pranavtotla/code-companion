import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  createServer,
  type CodeCompanionServer,
  type SpawnPty,
  type IPtyLike,
} from "../src/server.js";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const TEST_PORT = 0; // Let OS pick a free port

/** Creates a fake PTY that echoes input as output */
function createMockPty(): {
  spawner: SpawnPty;
  instances: MockPty[];
} {
  const instances: MockPty[] = [];
  const spawner: SpawnPty = (_command, _args, _options) => {
    const mock = new MockPty();
    instances.push(mock);
    return mock;
  };
  return { spawner, instances };
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
    // Echo it back like a terminal would
    for (const cb of this.dataCallbacks) {
      cb(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.lastResize = { cols, rows };
  }

  kill(_signal?: string): void {
    this.killed = true;
  }

  /** Simulate the PTY emitting data */
  emitData(data: string): void {
    for (const cb of this.dataCallbacks) {
      cb(data);
    }
  }

  /** Simulate the process exiting */
  emitExit(exitCode: number): void {
    for (const cb of this.exitCallbacks) {
      cb({ exitCode });
    }
  }
}

function connectClient(
  port: number,
  query: Record<string, string>
): ClientSocket {
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

function waitForEventWithTimeout(
  socket: ClientSocket,
  event: string,
  timeout = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${event}`)),
      timeout
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("Server", () => {
  let server: CodeCompanionServer;
  const clients: ClientSocket[] = [];
  let mockPtyFactory: ReturnType<typeof createMockPty>;

  afterEach(() => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("starts and listens on a port", async () => {
    mockPtyFactory = createMockPty();
    server = await createServer({
      port: TEST_PORT,
      spawnPty: mockPtyFactory.spawner,
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it("creates a room via POST /api/rooms", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
    // Verify a PTY was spawned
    expect(mockPtyFactory.instances).toHaveLength(1);
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

  it("allows a client to join an existing room", async () => {
    // Create a room first
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    // Connect a client
    const client = connectClient(server.port, {
      roomCode: code,
      displayName: "Alice",
    });
    clients.push(client);

    const joined = await waitForEventWithTimeout(client, "user:joined");
    expect(joined.name).toBe("Alice");
    expect(joined.users).toContain("Alice");
  });

  it("relays terminal output from PTY to connected clients", async () => {
    // Create a room
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    // Connect client
    const client = connectClient(server.port, {
      roomCode: code,
      displayName: "User1",
    });
    clients.push(client);

    // Wait for join to complete
    await waitForEventWithTimeout(client, "user:joined");

    // Get the mock PTY for this room (it's the latest one)
    const mockPty =
      mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

    // Set up listener for terminal output, then emit data from PTY
    const outputPromise = waitForEventWithTimeout(client, "terminal:output");
    mockPty.emitData("Hello from PTY!");
    const output = await outputPromise;
    expect(output).toBe("Hello from PTY!");
  });

  it("relays terminal input from client to PTY", async () => {
    // Create a room
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    // Connect client
    const client = connectClient(server.port, {
      roomCode: code,
      displayName: "Typer",
    });
    clients.push(client);

    await waitForEventWithTimeout(client, "user:joined");

    const mockPty =
      mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

    // Send terminal input from client
    client.emit("terminal:input", "ls -la\n");

    // Give a moment for the event to propagate
    await new Promise((r) => setTimeout(r, 100));

    expect(mockPty.written).toContain("ls -la\n");
  });

  it("only allows room creator to resize the terminal", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    const creator = connectClient(server.port, {
      roomCode: code,
      displayName: "Creator",
    });
    clients.push(creator);
    await waitForEventWithTimeout(creator, "user:joined");

    const guest = connectClient(server.port, {
      roomCode: code,
      displayName: "Guest",
    });
    clients.push(guest);
    await waitForEventWithTimeout(guest, "user:joined");

    const mockPty = mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

    // Guest tries to resize — should be ignored
    guest.emit("terminal:resize", { cols: 999, rows: 999 });
    await new Promise((r) => setTimeout(r, 100));
    expect(mockPty.lastResize).toBeNull();

    // Creator resizes — should work
    creator.emit("terminal:resize", { cols: 200, rows: 50 });
    await new Promise((r) => setTimeout(r, 100));
    expect(mockPty.lastResize).toEqual({ cols: 200, rows: 50 });
  });

  it("notifies room when a user disconnects", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    // Connect two clients
    const client1 = connectClient(server.port, {
      roomCode: code,
      displayName: "Alice",
    });
    clients.push(client1);
    await waitForEventWithTimeout(client1, "user:joined");

    const client2 = connectClient(server.port, {
      roomCode: code,
      displayName: "Bob",
    });
    clients.push(client2);
    await waitForEventWithTimeout(client2, "user:joined");

    // Set up listener on client1 for user:left
    const leftPromise = waitForEventWithTimeout(client1, "user:left");

    // Disconnect client2
    client2.disconnect();

    const left = await leftPromise;
    expect(left.name).toBe("Bob");
    expect(left.users).not.toContain("Bob");
  });

  it("kills PTY when last user disconnects", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    const mockPty =
      mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

    const client = connectClient(server.port, {
      roomCode: code,
      displayName: "Solo",
    });
    clients.push(client);
    await waitForEventWithTimeout(client, "user:joined");

    expect(mockPty.killed).toBe(false);

    // Disconnect the only client
    client.disconnect();

    // Give a moment for disconnect handler to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(mockPty.killed).toBe(true);
  });

  it("returns 500 when PTY spawn fails", async () => {
    // Create a server with a failing PTY spawner
    const failServer = await createServer({
      port: TEST_PORT,
      spawnPty: () => {
        throw new Error("PTY not available");
      },
    });

    try {
      const res = await fetch(`http://localhost:${failServer.port}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("Failed to spawn shell");
    } finally {
      await failServer.close();
    }
  });

  it("relays typing indicators between clients", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    const client1 = connectClient(server.port, {
      roomCode: code,
      displayName: "Alice",
    });
    clients.push(client1);
    await waitForEventWithTimeout(client1, "user:joined");

    const client2 = connectClient(server.port, {
      roomCode: code,
      displayName: "Bob",
    });
    clients.push(client2);
    await waitForEventWithTimeout(client2, "user:joined");

    // Alice should receive typing indicator from Bob
    const typingPromise = waitForEventWithTimeout(client1, "user:typing");
    client2.emit("user:typing");
    const typing = await typingPromise;
    expect(typing.name).toBe("Bob");

    // Alice should receive stop-typing from Bob
    const stopTypingPromise = waitForEventWithTimeout(
      client1,
      "user:stop-typing"
    );
    client2.emit("user:stop-typing");
    const stopTyping = await stopTypingPromise;
    expect(stopTyping.name).toBe("Bob");
  });

  it("notifies clients when PTY process exits", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    const client = connectClient(server.port, {
      roomCode: code,
      displayName: "Watcher",
    });
    clients.push(client);
    await waitForEventWithTimeout(client, "user:joined");

    const mockPty =
      mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

    const exitPromise = waitForEventWithTimeout(client, "terminal:exit");
    mockPty.emitExit(0);
    const exitData = await exitPromise;
    expect(exitData.exitCode).toBe(0);
  });
});
