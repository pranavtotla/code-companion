import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer, type CodeCompanionServer } from "./server.js";
import { TunnelManager } from "./tunnel.js";

// ---------------------------------------------------------------------------
// Dependency injection types for testability
// ---------------------------------------------------------------------------

export interface McpDeps {
  getServer: () => Promise<CodeCompanionServer>;
  tunnel: TunnelManager;
  /** Peek at the current server without starting one (for read-only queries). */
  peekServer: () => CodeCompanionServer | null;
  /** Clear the cached server reference (e.g. after closing it). */
  clearServer: () => void;
}

// ---------------------------------------------------------------------------
// Handler functions (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateSession(
  params: { cwd?: string; tunnel?: boolean },
  deps: McpDeps
): Promise<{ roomCode: string; localUrl: string; tunnelUrl?: string }> {
  const srv = await deps.getServer();
  const result = await srv.createRoom({ cwd: params.cwd });

  let tunnelUrl: string | undefined;
  if (params.tunnel) {
    if (!deps.tunnel.isRunning) {
      try {
        tunnelUrl = await deps.tunnel.start(srv.port);
      } catch {
        // Tunnel failed — continue without it
      }
    } else {
      tunnelUrl = deps.tunnel.url ?? undefined;
    }
  } else if (deps.tunnel.isRunning) {
    tunnelUrl = deps.tunnel.url ?? undefined;
  }

  return {
    roomCode: result.roomCode,
    localUrl: result.localUrl,
    ...(tunnelUrl ? { tunnelUrl } : {}),
  };
}

export function handleListSessions(
  deps: McpDeps
): {
  sessions: Array<{
    roomCode: string;
    userCount: number;
    localUrl: string;
    tunnelUrl?: string;
  }>;
} {
  const srv = deps.peekServer();
  if (!srv) {
    return { sessions: [] };
  }

  const tunnelUrl = deps.tunnel.url;
  const rooms = srv.getRooms();
  return {
    sessions: rooms.map((room) => ({
      roomCode: room.roomCode,
      userCount: room.userCount,
      localUrl: room.localUrl,
      ...(tunnelUrl ? { tunnelUrl } : {}),
    })),
  };
}

export function handleGetSessionInfo(
  params: { roomCode: string },
  deps: McpDeps
):
  | { roomCode: string; userCount: number; localUrl: string; tunnelUrl?: string }
  | { error: string } {
  const srv = deps.peekServer();
  if (!srv) {
    return { error: "Server is not running" };
  }

  const rooms = srv.getRooms();
  const room = rooms.find((r) => r.roomCode === params.roomCode);
  if (!room) {
    return { error: `Room '${params.roomCode}' not found` };
  }

  const tunnelUrl = deps.tunnel.url;
  return {
    roomCode: room.roomCode,
    userCount: room.userCount,
    localUrl: room.localUrl,
    ...(tunnelUrl ? { tunnelUrl } : {}),
  };
}

export function handleStopSession(
  params: { roomCode: string },
  deps: McpDeps
): { success: boolean; error?: string } {
  const srv = deps.peekServer();
  if (!srv) {
    return { success: false, error: "Server is not running" };
  }

  const stopped = srv.stopRoom(params.roomCode);
  if (!stopped) {
    return { success: false, error: `Room '${params.roomCode}' not found` };
  }
  return { success: true };
}

export async function handleStopServer(
  deps: McpDeps
): Promise<{ success: true }> {
  const srv = deps.peekServer();
  if (srv) {
    await srv.close();
    deps.clearServer();
  }
  deps.tunnel.stop();
  return { success: true };
}

// ---------------------------------------------------------------------------
// MCP server wiring (only runs when this file is executed directly)
// ---------------------------------------------------------------------------

function createMcpServer(deps: McpDeps): McpServer {
  const mcp = new McpServer({ name: "code-companion", version: "0.1.0" });

  mcp.tool(
    "create_session",
    "Start a Code Companion terminal session. Returns a room code and URL.",
    {
      cwd: z.string().optional().describe("Working directory for the shell"),
      tunnel: z
        .boolean()
        .optional()
        .describe("Start a cloudflared tunnel for remote access"),
    },
    async (params) => {
      try {
        const result = await handleCreateSession(params, deps);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  mcp.tool("list_sessions", "List all active terminal sessions.", async () => {
    const result = handleListSessions(deps);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  mcp.tool(
    "get_session_info",
    "Get details about a specific terminal session.",
    {
      roomCode: z.string().describe("The room code to look up"),
    },
    async (params) => {
      const result = handleGetSessionInfo(params, deps);
      const isError = "error" in result;
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError,
      };
    }
  );

  mcp.tool(
    "stop_session",
    "Stop a specific terminal session.",
    {
      roomCode: z.string().describe("The room code to stop"),
    },
    async (params) => {
      const result = handleStopSession(params, deps);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    }
  );

  mcp.tool(
    "stop_server",
    "Stop the Code Companion server and tunnel.",
    async () => {
      const result = await handleStopServer(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return mcp;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isMain) {
  let server: CodeCompanionServer | null = null;
  const tunnel = new TunnelManager();

  async function ensureServer(): Promise<CodeCompanionServer> {
    if (!server) {
      server = await createServer({ port: 0 });
    }
    return server;
  }

  const deps: McpDeps = {
    getServer: ensureServer,
    tunnel,
    peekServer: () => server,
    clearServer: () => { server = null; },
  };

  const mcp = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

export { createMcpServer };
