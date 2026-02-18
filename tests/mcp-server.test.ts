import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createServer,
  type CodeCompanionServer,
  type SpawnPty,
  type IPtyLike,
} from "../src/server.js";
import { TunnelManager } from "../src/tunnel.js";
import {
  handleCreateSession,
  handleListSessions,
  handleGetSessionInfo,
  handleStopSession,
  handleStopServer,
  type McpDeps,
} from "../src/mcp-server.js";

// ---------------------------------------------------------------------------
// MockPty — same pattern as server.test.ts
// ---------------------------------------------------------------------------

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
// MockTunnelManager — lightweight stub for the tunnel
// ---------------------------------------------------------------------------

class MockTunnelManager {
  private _url: string | null = null;
  private _isRunning = false;
  startCalls: number[] = [];
  stopCalls = 0;

  get url(): string | null {
    return this._url;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async start(port: number): Promise<string> {
    this.startCalls.push(port);
    this._isRunning = true;
    this._url = `https://test-tunnel-${port}.trycloudflare.com`;
    return this._url;
  }

  stop(): void {
    this.stopCalls++;
    this._isRunning = false;
    this._url = null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDeps(
  server: CodeCompanionServer | null,
  tunnel: MockTunnelManager
): McpDeps {
  return {
    getServer: async () => {
      if (!server) throw new Error("No server available");
      return server;
    },
    tunnel: tunnel as unknown as TunnelManager,
    peekServer: () => server,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server Handlers", () => {
  let server: CodeCompanionServer;
  let mockPtyFactory: ReturnType<typeof createMockPty>;
  let tunnel: MockTunnelManager;

  beforeEach(async () => {
    mockPtyFactory = createMockPty();
    server = await createServer({
      port: 0,
      spawnPty: mockPtyFactory.spawner,
    });
    tunnel = new MockTunnelManager();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  // -----------------------------------------------------------------------
  // handleCreateSession
  // -----------------------------------------------------------------------

  describe("handleCreateSession", () => {
    it("starts server and returns room info", async () => {
      const deps = createDeps(server, tunnel);
      const result = await handleCreateSession({}, deps);

      expect(result.roomCode).toHaveLength(6);
      expect(result.localUrl).toContain(`/?room=${result.roomCode}`);
      expect(result.localUrl).toContain(`http://localhost:${server.port}`);
      expect(result.tunnelUrl).toBeUndefined();
    });

    it("reuses existing server on subsequent calls", async () => {
      const deps = createDeps(server, tunnel);
      const result1 = await handleCreateSession({}, deps);
      const result2 = await handleCreateSession({}, deps);

      expect(result1.roomCode).not.toBe(result2.roomCode);
      // Both should reference the same port (same server)
      expect(result1.localUrl).toContain(`:${server.port}`);
      expect(result2.localUrl).toContain(`:${server.port}`);
    });

    it("starts tunnel when tunnel=true and tunnel not running", async () => {
      const deps = createDeps(server, tunnel);
      const result = await handleCreateSession({ tunnel: true }, deps);

      expect(result.tunnelUrl).toBeDefined();
      expect(result.tunnelUrl).toContain("trycloudflare.com");
      expect(tunnel.startCalls).toHaveLength(1);
      expect(tunnel.startCalls[0]).toBe(server.port);
    });

    it("reuses existing tunnel when tunnel=true and already running", async () => {
      // Start the tunnel first
      await tunnel.start(server.port);
      const existingUrl = tunnel.url;

      const deps = createDeps(server, tunnel);
      const result = await handleCreateSession({ tunnel: true }, deps);

      expect(result.tunnelUrl).toBe(existingUrl);
      // Should not have called start again (it was already running)
      expect(tunnel.startCalls).toHaveLength(1);
    });

    it("includes tunnelUrl when tunnel is running even if tunnel=false", async () => {
      await tunnel.start(server.port);
      const deps = createDeps(server, tunnel);
      const result = await handleCreateSession({ tunnel: false }, deps);

      expect(result.tunnelUrl).toBeDefined();
      expect(result.tunnelUrl).toContain("trycloudflare.com");
    });

    it("does not include tunnelUrl when tunnel is not running and tunnel=false", async () => {
      const deps = createDeps(server, tunnel);
      const result = await handleCreateSession({ tunnel: false }, deps);

      expect(result.tunnelUrl).toBeUndefined();
    });

    it("passes cwd to createRoom", async () => {
      let capturedCwd: string | undefined;
      const cwdServer = await createServer({
        port: 0,
        spawnPty: (_command, _args, options) => {
          capturedCwd = options.cwd;
          return new MockPty();
        },
      });

      try {
        const deps = createDeps(cwdServer, tunnel);
        await handleCreateSession({ cwd: "/tmp" }, deps);
        expect(capturedCwd).toBe("/tmp");
      } finally {
        await cwdServer.close();
      }
    });

    it("uses getServer to lazily create the server", async () => {
      let serverCreated = false;
      const deps: McpDeps = {
        getServer: async () => {
          serverCreated = true;
          return server;
        },
        tunnel: tunnel as unknown as TunnelManager,
        peekServer: () => (serverCreated ? server : null),
      };

      expect(serverCreated).toBe(false);
      await handleCreateSession({}, deps);
      expect(serverCreated).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // handleListSessions
  // -----------------------------------------------------------------------

  describe("handleListSessions", () => {
    it("returns empty when no server running", () => {
      const deps = createDeps(null, tunnel);
      const result = handleListSessions(deps);

      expect(result.sessions).toEqual([]);
    });

    it("returns empty sessions array when server running but no rooms", () => {
      const deps = createDeps(server, tunnel);
      const result = handleListSessions(deps);

      expect(result.sessions).toEqual([]);
    });

    it("returns all active sessions", async () => {
      const deps = createDeps(server, tunnel);

      // Create two rooms
      await handleCreateSession({}, deps);
      await handleCreateSession({}, deps);

      const result = handleListSessions(deps);
      expect(result.sessions).toHaveLength(2);

      for (const session of result.sessions) {
        expect(session.roomCode).toHaveLength(6);
        expect(session.userCount).toBe(0);
        expect(session.localUrl).toContain(`/?room=${session.roomCode}`);
        expect(session.tunnelUrl).toBeUndefined();
      }
    });

    it("includes tunnelUrl when tunnel is running", async () => {
      await tunnel.start(server.port);
      const deps = createDeps(server, tunnel);

      await handleCreateSession({}, deps);
      const result = handleListSessions(deps);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].tunnelUrl).toContain("trycloudflare.com");
    });

    it("does not include tunnelUrl when tunnel is not running", async () => {
      const deps = createDeps(server, tunnel);
      await handleCreateSession({}, deps);

      const result = handleListSessions(deps);
      expect(result.sessions[0].tunnelUrl).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // handleGetSessionInfo
  // -----------------------------------------------------------------------

  describe("handleGetSessionInfo", () => {
    it("returns room details", async () => {
      const deps = createDeps(server, tunnel);
      const { roomCode } = await handleCreateSession({}, deps);

      const result = handleGetSessionInfo({ roomCode }, deps);
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({
        roomCode,
        userCount: 0,
      });
      if ("localUrl" in result) {
        expect(result.localUrl).toContain(`/?room=${roomCode}`);
      }
    });

    it("returns error when server not running", () => {
      const deps = createDeps(null, tunnel);
      const result = handleGetSessionInfo({ roomCode: "abc123" }, deps);

      expect(result).toHaveProperty("error");
      if ("error" in result) {
        expect(result.error).toBe("Server is not running");
      }
    });

    it("returns error when room not found", () => {
      const deps = createDeps(server, tunnel);
      const result = handleGetSessionInfo({ roomCode: "zzzzzz" }, deps);

      expect(result).toHaveProperty("error");
      if ("error" in result) {
        expect(result.error).toContain("not found");
      }
    });

    it("includes tunnelUrl when tunnel is running", async () => {
      await tunnel.start(server.port);
      const deps = createDeps(server, tunnel);
      const { roomCode } = await handleCreateSession({}, deps);

      const result = handleGetSessionInfo({ roomCode }, deps);
      expect(result).not.toHaveProperty("error");
      if ("tunnelUrl" in result) {
        expect(result.tunnelUrl).toContain("trycloudflare.com");
      }
    });

    it("does not include tunnelUrl when tunnel is not running", async () => {
      const deps = createDeps(server, tunnel);
      const { roomCode } = await handleCreateSession({}, deps);

      const result = handleGetSessionInfo({ roomCode }, deps);
      expect(result).not.toHaveProperty("error");
      expect(result).not.toHaveProperty("tunnelUrl");
    });
  });

  // -----------------------------------------------------------------------
  // handleStopSession
  // -----------------------------------------------------------------------

  describe("handleStopSession", () => {
    it("stops a specific session", async () => {
      const deps = createDeps(server, tunnel);
      const { roomCode } = await handleCreateSession({}, deps);

      const result = handleStopSession({ roomCode }, deps);
      expect(result).toEqual({ success: true });

      // Verify room is gone
      const rooms = server.getRooms();
      expect(rooms.find((r) => r.roomCode === roomCode)).toBeUndefined();
    });

    it("returns error when server not running", () => {
      const deps = createDeps(null, tunnel);
      const result = handleStopSession({ roomCode: "abc123" }, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Server is not running");
    });

    it("returns error when room not found", () => {
      const deps = createDeps(server, tunnel);
      const result = handleStopSession({ roomCode: "zzzzzz" }, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("does not affect other sessions", async () => {
      const deps = createDeps(server, tunnel);
      const session1 = await handleCreateSession({}, deps);
      const session2 = await handleCreateSession({}, deps);

      handleStopSession({ roomCode: session1.roomCode }, deps);

      const rooms = server.getRooms();
      expect(rooms.find((r) => r.roomCode === session1.roomCode)).toBeUndefined();
      expect(rooms.find((r) => r.roomCode === session2.roomCode)).toBeDefined();
    });

    it("kills the PTY process when stopping a session", async () => {
      const deps = createDeps(server, tunnel);
      const { roomCode } = await handleCreateSession({}, deps);
      const pty = mockPtyFactory.instances[mockPtyFactory.instances.length - 1];

      expect(pty.killed).toBe(false);
      handleStopSession({ roomCode }, deps);
      expect(pty.killed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // handleStopServer
  // -----------------------------------------------------------------------

  describe("handleStopServer", () => {
    it("stops server and tunnel", async () => {
      await tunnel.start(server.port);
      const deps = createDeps(server, tunnel);

      // Create a session so there's something running
      await handleCreateSession({}, deps);

      const result = await handleStopServer(deps);
      expect(result).toEqual({ success: true });
      expect(tunnel.isRunning).toBe(false);
      expect(tunnel.stopCalls).toBe(1);
    });

    it("succeeds even when no server running", async () => {
      const deps = createDeps(null, tunnel);
      const result = await handleStopServer(deps);

      expect(result).toEqual({ success: true });
    });

    it("stops tunnel even when no server running", async () => {
      await tunnel.start(1234);
      const deps = createDeps(null, tunnel);

      await handleStopServer(deps);
      expect(tunnel.isRunning).toBe(false);
      expect(tunnel.stopCalls).toBe(1);
    });

    it("is safe to call multiple times", async () => {
      // Use a dedicated server for this test since we close it
      const extraPtyFactory = createMockPty();
      const extraServer = await createServer({
        port: 0,
        spawnPty: extraPtyFactory.spawner,
      });
      const deps = createDeps(extraServer, tunnel);

      await handleStopServer(deps);
      // Second call should succeed even though server is already closed
      const result = await handleStopServer(deps);
      expect(result).toEqual({ success: true });

      // Don't close again in afterEach since we set the main `server` separately
    });
  });

  // -----------------------------------------------------------------------
  // Integration-style: end-to-end flow
  // -----------------------------------------------------------------------

  describe("end-to-end flow", () => {
    it("create, list, info, stop session, list again", async () => {
      const deps = createDeps(server, tunnel);

      // Create a session
      const created = await handleCreateSession({}, deps);
      expect(created.roomCode).toHaveLength(6);

      // List sessions
      const listed = handleListSessions(deps);
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0].roomCode).toBe(created.roomCode);

      // Get info
      const info = handleGetSessionInfo(
        { roomCode: created.roomCode },
        deps
      );
      expect(info).not.toHaveProperty("error");
      if ("roomCode" in info) {
        expect(info.roomCode).toBe(created.roomCode);
      }

      // Stop the session
      const stopped = handleStopSession(
        { roomCode: created.roomCode },
        deps
      );
      expect(stopped.success).toBe(true);

      // List should now be empty
      const listedAfter = handleListSessions(deps);
      expect(listedAfter.sessions).toHaveLength(0);

      // Info should return error
      const infoAfter = handleGetSessionInfo(
        { roomCode: created.roomCode },
        deps
      );
      expect(infoAfter).toHaveProperty("error");
    });

    it("create multiple sessions with tunnel, stop server", async () => {
      const deps = createDeps(server, tunnel);

      // Create sessions, first with tunnel
      const s1 = await handleCreateSession({ tunnel: true }, deps);
      const s2 = await handleCreateSession({}, deps);

      expect(s1.tunnelUrl).toBeDefined();
      expect(s2.tunnelUrl).toBeDefined(); // tunnel already running from s1

      // List should show both
      const listed = handleListSessions(deps);
      expect(listed.sessions).toHaveLength(2);
      for (const s of listed.sessions) {
        expect(s.tunnelUrl).toBeDefined();
      }

      // Stop server
      await handleStopServer(deps);
      expect(tunnel.isRunning).toBe(false);

      // After server stop, a new deps with null server should show empty
      const emptyDeps = createDeps(null, tunnel);
      const emptyList = handleListSessions(emptyDeps);
      expect(emptyList.sessions).toHaveLength(0);
    });
  });
});
