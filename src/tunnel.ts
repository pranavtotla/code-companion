import { spawn, type ChildProcess } from "node:child_process";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 15_000;

export class TunnelManager {
  private process: ChildProcess | null = null;
  private _url: string | null = null;

  get url(): string | null {
    return this._url;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Start a cloudflared quick tunnel pointing to the given port.
   * Parses the generated *.trycloudflare.com URL from stderr.
   * Rejects if cloudflared is not installed or fails to start.
   */
  start(port: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.isRunning) {
        reject(new Error("Tunnel is already running"));
        return;
      }

      const child = spawn("cloudflared", [
        "tunnel",
        "--url",
        `http://localhost:${port}`,
      ]);

      this.process = child;

      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.stop();
          reject(new Error("Timed out waiting for cloudflared tunnel URL"));
        }
      }, START_TIMEOUT_MS);

      const onData = (chunk: Buffer) => {
        if (settled) return;
        const text = chunk.toString();
        const match = text.match(URL_PATTERN);
        if (match) {
          settled = true;
          clearTimeout(timeout);
          this._url = match[0];
          // Clean up data listeners once URL is extracted
          child.stdout?.removeListener("data", onData);
          child.stderr?.removeListener("data", onData);
          resolve(match[0]);
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.process = null;
        this._url = null;

        if (err.code === "ENOENT") {
          reject(
            new Error(
              "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
            ),
          );
        } else {
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.process = null;
        this._url = null;
        reject(
          new Error(`cloudflared exited with code ${code} before producing a URL`),
        );
      });

      // Unconditional close handler: if cloudflared crashes after the promise
      // settled (URL was already extracted), clean up stale state so isRunning
      // reflects reality.
      child.on("close", () => {
        this.process = null;
        this._url = null;
      });
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this._url = null;
    }
  }
}
