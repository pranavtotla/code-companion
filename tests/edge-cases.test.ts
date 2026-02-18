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

  emitData(data: string): void {
    for (const cb of this.dataCallbacks) {
      cb(data);
    }
  }

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

describe("Edge cases", () => {
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

  it("rejects connection without roomCode", async () => {
    mockPtyFactory = createMockPty();
    server = await createServer({
      port: TEST_PORT,
      spawnPty: mockPtyFactory.spawner,
    });

    const client = connectClient(server.port, { displayName: "Alice" });
    clients.push(client);

    const error = await waitForEventWithTimeout(client, "error:room");
    expect(error.message).toContain("required");
  });

  it("rejects connection without displayName", async () => {
    const client = connectClient(server.port, { roomCode: "abc123" });
    clients.push(client);

    const error = await waitForEventWithTimeout(client, "error:room");
    expect(error.message).toContain("required");
  });

  it("rejects connection to a non-existent room", async () => {
    const client = connectClient(server.port, {
      roomCode: "zzzzzz",
      displayName: "Lost",
    });
    clients.push(client);

    const error = await waitForEventWithTimeout(client, "error:room");
    expect(error.message).toContain("not found");
  });

  it("allows room to be reused after all users leave and a new room is created", async () => {
    // Create a room
    const res = await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
    });
    const { code } = await res.json();

    // Join and leave
    const c1 = connectClient(server.port, {
      roomCode: code,
      displayName: "Temp",
    });
    clients.push(c1);
    await waitForEventWithTimeout(c1, "user:joined");
    c1.disconnect();

    // Wait for disconnect to propagate and room to be destroyed
    await new Promise((r) => setTimeout(r, 200));

    // Old room code should now be invalid
    const c2 = connectClient(server.port, {
      roomCode: code,
      displayName: "Late",
    });
    clients.push(c2);

    const error = await waitForEventWithTimeout(c2, "error:room");
    expect(error.message).toContain("not found");
  });

  it("handles empty string roomCode as missing", async () => {
    const client = connectClient(server.port, {
      roomCode: "",
      displayName: "Alice",
    });
    clients.push(client);

    const error = await waitForEventWithTimeout(client, "error:room");
    expect(error.message).toContain("required");
  });

  it("handles empty string displayName as missing", async () => {
    const client = connectClient(server.port, {
      roomCode: "abc123",
      displayName: "",
    });
    clients.push(client);

    const error = await waitForEventWithTimeout(client, "error:room");
    expect(error.message).toContain("required");
  });
});
