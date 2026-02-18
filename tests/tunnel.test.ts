import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock child_process.spawn before importing TunnelManager
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { TunnelManager } from "../src/tunnel.js";
import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

/** Create a fake ChildProcess that behaves like a real one for testing. */
function createFakeProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  proc.pid = 12345;
  return proc;
}

describe("TunnelManager", () => {
  let tunnel: TunnelManager;

  beforeEach(() => {
    tunnel = new TunnelManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    tunnel.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("url is null before start", () => {
      expect(tunnel.url).toBeNull();
    });

    it("isRunning is false before start", () => {
      expect(tunnel.isRunning).toBe(false);
    });
  });

  describe("start()", () => {
    it("resolves with a URL when cloudflared outputs the trycloudflare URL on stderr", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      // Simulate cloudflared output on stderr
      fakeProc.stderr!.emit(
        "data",
        Buffer.from(
          "2024-01-15T10:00:00Z INF |  https://random-words-here.trycloudflare.com  |",
        ),
      );

      const url = await startPromise;

      expect(url).toBe("https://random-words-here.trycloudflare.com");
      expect(tunnel.url).toBe("https://random-words-here.trycloudflare.com");
      expect(tunnel.isRunning).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("cloudflared", [
        "tunnel",
        "--url",
        "http://localhost:3000",
      ]);
    });

    it("resolves with a URL when cloudflared outputs the URL on stdout", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(8080);

      fakeProc.stdout!.emit(
        "data",
        Buffer.from("https://my-tunnel-name.trycloudflare.com"),
      );

      const url = await startPromise;

      expect(url).toBe("https://my-tunnel-name.trycloudflare.com");
      expect(tunnel.url).toBe("https://my-tunnel-name.trycloudflare.com");
    });

    it("rejects when cloudflared is not found (ENOENT error)", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      const err = new Error("spawn cloudflared ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      fakeProc.emit("error", err);

      await expect(startPromise).rejects.toThrow("cloudflared is not installed");
    });

    it("rejects if cloudflared exits early with non-zero code", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      fakeProc.emit("close", 1);

      await expect(startPromise).rejects.toThrow(
        "cloudflared exited with code 1 before producing a URL",
      );
    });

    it("rejects on timeout if no URL is produced within 15 seconds", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      // Advance timers past the 15-second timeout
      vi.advanceTimersByTime(15_000);

      await expect(startPromise).rejects.toThrow(
        "Timed out waiting for cloudflared tunnel URL",
      );
    });

    it("rejects if already running", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      // Emit URL so start resolves
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("https://first-tunnel.trycloudflare.com"),
      );
      await startPromise;

      // Try to start again while running
      await expect(tunnel.start(3000)).rejects.toThrow(
        "Tunnel is already running",
      );
    });

    it("resets state on ENOENT error", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      const err = new Error("spawn cloudflared ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      fakeProc.emit("error", err);

      await expect(startPromise).rejects.toThrow();
      expect(tunnel.url).toBeNull();
      expect(tunnel.isRunning).toBe(false);
    });

    it("resets state on early exit", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);
      fakeProc.emit("close", 1);

      await expect(startPromise).rejects.toThrow();
      expect(tunnel.url).toBeNull();
      expect(tunnel.isRunning).toBe(false);
    });

    it("propagates non-ENOENT errors directly", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      fakeProc.emit("error", err);

      await expect(startPromise).rejects.toThrow("permission denied");
    });

    it("ignores stderr output that does not contain a trycloudflare URL", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);

      // Emit non-URL output, should not resolve
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("2024-01-15T10:00:00Z INF Starting tunnel"),
      );

      // Tunnel should still be running, waiting for URL
      expect(tunnel.url).toBeNull();

      // Now emit the URL
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("https://actual-tunnel.trycloudflare.com"),
      );

      const url = await startPromise;
      expect(url).toBe("https://actual-tunnel.trycloudflare.com");
    });
  });

  describe("stop()", () => {
    it("kills the process and resets state", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("https://test-tunnel.trycloudflare.com"),
      );
      await startPromise;

      expect(tunnel.isRunning).toBe(true);
      expect(tunnel.url).toBe("https://test-tunnel.trycloudflare.com");

      tunnel.stop();

      expect(fakeProc.kill).toHaveBeenCalled();
      expect(tunnel.isRunning).toBe(false);
      expect(tunnel.url).toBeNull();
    });

    it("is safe to call when not running", () => {
      expect(() => tunnel.stop()).not.toThrow();
      expect(tunnel.isRunning).toBe(false);
      expect(tunnel.url).toBeNull();
    });

    it("is safe to call multiple times", async () => {
      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("https://test-tunnel.trycloudflare.com"),
      );
      await startPromise;

      tunnel.stop();
      tunnel.stop();

      expect(tunnel.isRunning).toBe(false);
      expect(tunnel.url).toBeNull();
    });
  });

  describe("isRunning", () => {
    it("is false before start, true after start, false after stop", async () => {
      expect(tunnel.isRunning).toBe(false);

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const startPromise = tunnel.start(3000);
      fakeProc.stderr!.emit(
        "data",
        Buffer.from("https://test-tunnel.trycloudflare.com"),
      );
      await startPromise;

      expect(tunnel.isRunning).toBe(true);

      tunnel.stop();

      expect(tunnel.isRunning).toBe(false);
    });
  });
});
