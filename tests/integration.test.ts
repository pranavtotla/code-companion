import { describe, it, expect, afterEach } from "vitest";
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
// MockPty -- same pattern as other test files
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
// MockTunnelManager -- lightweight stub for the tunnel
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
// Integration deps factory -- mirrors the real main() ensureServer pattern
// ---------------------------------------------------------------------------

/**
 * Creates McpDeps with an `ensureServer` function that lazily creates
 * a new CodeCompanionServer when needed (just like the real main entry
 * point in mcp-server.ts).
 *
 * Returns the deps plus a list of all servers created (for cleanup in
 * afterEach).
 */
function createIntegrationDeps(): {
  deps: McpDeps;
  tunnel: MockTunnelManager;
  servers: CodeCompanionServer[];
  ptyInstances: MockPty[];
} {
  let server: CodeCompanionServer | null = null;
  const servers: CodeCompanionServer[] = [];
  const allPtyInstances: MockPty[] = [];
  const tunnel = new MockTunnelManager();

  async function ensureServer(): Promise<CodeCompanionServer> {
    if (!server) {
      const factory = createMockPty();
      // Collect all PTY instances for later inspection
      const originalSpawner = factory.spawner;
      const spawner: SpawnPty = (cmd, args, opts) => {
        const pty = originalSpawner(cmd, args, opts);
        allPtyInstances.push(factory.instances[factory.instances.length - 1]);
        return pty;
      };
      server = await createServer({ port: 0, spawnPty: spawner });
      servers.push(server);
    }
    return server;
  }

  const deps: McpDeps = {
    getServer: ensureServer,
    tunnel: tunnel as unknown as TunnelManager,
    peekServer: () => server,
    clearServer: () => {
      server = null;
    },
  };

  return { deps, tunnel, servers, ptyInstances: allPtyInstances };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration: Full plugin lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("create -> list -> info -> stop session -> verify removed", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) await s.close();
    });

    // Create a session (this triggers ensureServer internally)
    const created = await handleCreateSession({}, deps);
    expect(created.roomCode).toHaveLength(6);
    expect(created.localUrl).toContain(`/?room=${created.roomCode}`);

    // List sessions -- expect 1
    const listed = handleListSessions(deps);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].roomCode).toBe(created.roomCode);
    expect(listed.sessions[0].userCount).toBe(0);
    expect(listed.sessions[0].localUrl).toBe(created.localUrl);

    // Get session info -- expect details match
    const info = handleGetSessionInfo({ roomCode: created.roomCode }, deps);
    expect(info).not.toHaveProperty("error");
    expect(info).toMatchObject({
      roomCode: created.roomCode,
      userCount: 0,
      localUrl: created.localUrl,
    });

    // Stop the session
    const stopped = handleStopSession({ roomCode: created.roomCode }, deps);
    expect(stopped).toEqual({ success: true });

    // List sessions -- expect 0
    const listedAfter = handleListSessions(deps);
    expect(listedAfter.sessions).toHaveLength(0);

    // Info for the stopped session -- expect error
    const infoAfter = handleGetSessionInfo(
      { roomCode: created.roomCode },
      deps
    );
    expect(infoAfter).toHaveProperty("error");
    if ("error" in infoAfter) {
      expect(infoAfter.error).toContain("not found");
    }
  });

  it("multiple sessions can coexist and be independently stopped", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) await s.close();
    });

    // Create 2 sessions
    const session1 = await handleCreateSession({}, deps);
    const session2 = await handleCreateSession({}, deps);
    expect(session1.roomCode).not.toBe(session2.roomCode);

    // List -- expect 2
    const listed = handleListSessions(deps);
    expect(listed.sessions).toHaveLength(2);
    const codes = listed.sessions.map((s) => s.roomCode);
    expect(codes).toContain(session1.roomCode);
    expect(codes).toContain(session2.roomCode);

    // Stop first session
    const stopped1 = handleStopSession({ roomCode: session1.roomCode }, deps);
    expect(stopped1.success).toBe(true);

    // List -- expect 1 (second session still alive)
    const listedAfterFirst = handleListSessions(deps);
    expect(listedAfterFirst.sessions).toHaveLength(1);
    expect(listedAfterFirst.sessions[0].roomCode).toBe(session2.roomCode);

    // Verify first session info returns error
    const info1 = handleGetSessionInfo({ roomCode: session1.roomCode }, deps);
    expect(info1).toHaveProperty("error");

    // Verify second session info still works
    const info2 = handleGetSessionInfo({ roomCode: session2.roomCode }, deps);
    expect(info2).not.toHaveProperty("error");
    expect(info2).toHaveProperty("roomCode", session2.roomCode);

    // Stop second session
    const stopped2 = handleStopSession({ roomCode: session2.roomCode }, deps);
    expect(stopped2.success).toBe(true);

    // List -- expect 0
    const listedAfterBoth = handleListSessions(deps);
    expect(listedAfterBoth.sessions).toHaveLength(0);
  });

  it("stop_server clears all sessions", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      // Server may already be closed by handleStopServer, but close
      // any remaining ones just in case.
      for (const s of servers) {
        try {
          await s.close();
        } catch {
          // Already closed -- ignore.
        }
      }
    });

    // Create 3 sessions
    const s1 = await handleCreateSession({}, deps);
    const s2 = await handleCreateSession({}, deps);
    const s3 = await handleCreateSession({}, deps);

    // Verify all 3 exist
    const listed = handleListSessions(deps);
    expect(listed.sessions).toHaveLength(3);
    const codes = listed.sessions.map((s) => s.roomCode);
    expect(codes).toContain(s1.roomCode);
    expect(codes).toContain(s2.roomCode);
    expect(codes).toContain(s3.roomCode);

    // Stop server -- clears everything
    const result = await handleStopServer(deps);
    expect(result).toEqual({ success: true });

    // peekServer should return null (server reference cleared)
    expect(deps.peekServer()).toBeNull();

    // List should return empty (no server to query)
    const listedAfter = handleListSessions(deps);
    expect(listedAfter.sessions).toHaveLength(0);
  });

  it("can create sessions after stop_server", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) {
        try {
          await s.close();
        } catch {
          // Already closed -- ignore.
        }
      }
    });

    // Create a session
    const session1 = await handleCreateSession({}, deps);
    expect(session1.roomCode).toHaveLength(6);

    // Verify it exists
    const listed1 = handleListSessions(deps);
    expect(listed1.sessions).toHaveLength(1);

    // Stop the server
    await handleStopServer(deps);
    expect(deps.peekServer()).toBeNull();

    // List returns empty after server stop
    const listedEmpty = handleListSessions(deps);
    expect(listedEmpty.sessions).toHaveLength(0);

    // Create a new session -- ensureServer should auto-create a new server
    const session2 = await handleCreateSession({}, deps);
    expect(session2.roomCode).toHaveLength(6);
    expect(session2.roomCode).not.toBe(session1.roomCode);

    // The new server should be different from the first one
    expect(servers).toHaveLength(2);

    // Verify the new session is visible
    const listed2 = handleListSessions(deps);
    expect(listed2.sessions).toHaveLength(1);
    expect(listed2.sessions[0].roomCode).toBe(session2.roomCode);

    // Info should work for the new session
    const info = handleGetSessionInfo({ roomCode: session2.roomCode }, deps);
    expect(info).not.toHaveProperty("error");
    expect(info).toHaveProperty("roomCode", session2.roomCode);
  });

  it("stop_server stops the tunnel as well", async () => {
    const { deps, tunnel, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) {
        try {
          await s.close();
        } catch {
          // Already closed -- ignore.
        }
      }
    });

    // Create a session with tunnel enabled
    const session = await handleCreateSession({ tunnel: true }, deps);
    expect(session.tunnelUrl).toBeDefined();
    expect(tunnel.isRunning).toBe(true);

    // Stop server
    await handleStopServer(deps);

    // Tunnel should be stopped
    expect(tunnel.isRunning).toBe(false);
    expect(tunnel.stopCalls).toBe(1);
  });

  it("PTY processes are killed when sessions are stopped", async () => {
    const { deps, servers, ptyInstances } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) await s.close();
    });

    // Create two sessions
    const s1 = await handleCreateSession({}, deps);
    const s2 = await handleCreateSession({}, deps);

    // Both PTYs should be alive
    expect(ptyInstances).toHaveLength(2);
    expect(ptyInstances[0].killed).toBe(false);
    expect(ptyInstances[1].killed).toBe(false);

    // Stop first session
    handleStopSession({ roomCode: s1.roomCode }, deps);
    expect(ptyInstances[0].killed).toBe(true);
    expect(ptyInstances[1].killed).toBe(false);

    // Stop second session
    handleStopSession({ roomCode: s2.roomCode }, deps);
    expect(ptyInstances[1].killed).toBe(true);
  });

  it("stopping a non-existent session returns an error", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) await s.close();
    });

    // Create a session so the server is running
    await handleCreateSession({}, deps);

    // Try to stop a session that does not exist
    const result = handleStopSession({ roomCode: "zzzzzz" }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("getting info for a non-existent session returns an error", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) await s.close();
    });

    // Create a session so the server is running
    await handleCreateSession({}, deps);

    const result = handleGetSessionInfo({ roomCode: "zzzzzz" }, deps);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("not found");
    }
  });

  it("operations work correctly when no server has been started yet", () => {
    const { deps } = createIntegrationDeps();

    // List with no server -- should return empty, not throw
    const listed = handleListSessions(deps);
    expect(listed.sessions).toHaveLength(0);

    // Info with no server -- should return error, not throw
    const info = handleGetSessionInfo({ roomCode: "abc123" }, deps);
    expect(info).toHaveProperty("error");
    if ("error" in info) {
      expect(info.error).toBe("Server is not running");
    }

    // Stop session with no server -- should return error, not throw
    const stopped = handleStopSession({ roomCode: "abc123" }, deps);
    expect(stopped.success).toBe(false);
    expect(stopped.error).toBe("Server is not running");
  });

  it("stop_server is safe to call when no server is running", async () => {
    const { deps } = createIntegrationDeps();

    // No server has been started yet
    const result = await handleStopServer(deps);
    expect(result).toEqual({ success: true });
  });

  it("full cycle: create, stop server, recreate, stop session, stop server", async () => {
    const { deps, servers } = createIntegrationDeps();
    cleanups.push(async () => {
      for (const s of servers) {
        try {
          await s.close();
        } catch {
          // Already closed -- ignore.
        }
      }
    });

    // Round 1: create session, stop server
    const s1 = await handleCreateSession({}, deps);
    expect(handleListSessions(deps).sessions).toHaveLength(1);

    await handleStopServer(deps);
    expect(handleListSessions(deps).sessions).toHaveLength(0);
    expect(deps.peekServer()).toBeNull();

    // Round 2: create two sessions on a new server
    const s2 = await handleCreateSession({}, deps);
    const s3 = await handleCreateSession({}, deps);
    expect(handleListSessions(deps).sessions).toHaveLength(2);

    // Stop one session
    handleStopSession({ roomCode: s2.roomCode }, deps);
    expect(handleListSessions(deps).sessions).toHaveLength(1);

    // The remaining session should be s3
    const remaining = handleListSessions(deps);
    expect(remaining.sessions[0].roomCode).toBe(s3.roomCode);

    // Final stop server
    await handleStopServer(deps);
    expect(handleListSessions(deps).sessions).toHaveLength(0);
    expect(deps.peekServer()).toBeNull();

    // Should have created 2 servers total across the lifecycle
    expect(servers).toHaveLength(2);
  });
});
