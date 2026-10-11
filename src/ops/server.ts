import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { buildOperationalSnapshot, OperationalProjectionDeps } from "./projection";

export interface OpsServerOptions extends OperationalProjectionDeps {
  host?: string;
  port?: number;
}

export interface StartedOpsServer {
  server: Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

export const DEFAULT_OPS_HOST = "127.0.0.1";
export const DEFAULT_OPS_PORT = 4785;

export class OpsServerHostError extends Error {
  constructor(host: string) {
    super(
      `Ops server host must be a loopback address (127.0.0.1 or ::1); got: "${host}". ` +
      `Binding to non-loopback interfaces is not permitted.`
    );
    this.name = "OpsServerHostError";
  }
}

/**
 * Asserts that host is an exact loopback address literal.
 * Accepts "127.0.0.1" and "::1" only — no normalization, no trim.
 * The caller is responsible for passing a clean string.
 */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_ADDRESSES.has(host)) {
    throw new OpsServerHostError(host);
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function createOpsServer(options: OpsServerOptions = {}): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, options);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: OpsServerOptions): Promise<void> {
  try {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${options.host ?? DEFAULT_OPS_HOST}`);
    if (url.pathname !== "/api/ops/snapshot") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const snapshot = await buildOperationalSnapshot(options);
    sendJson(res, 200, snapshot);
  } catch {
    sendJson(res, 500, { error: "snapshot_unavailable" });
  }
}

/**
 * Starts the operational snapshot HTTP server.
 *
 * SECURITY MODEL — loopback confinement only:
 *
 *   - Binding is restricted to loopback addresses (127.0.0.1 or ::1).
 *     assertLoopbackHost() throws OpsServerHostError — as a rejected
 *     Promise — before any socket is created if a non-loopback host
 *     is requested.
 *
 *   - Loopback confinement is a network boundary, not client
 *     authentication or authorization. Any process running on the
 *     local machine — including scripts, tooling, and browser tabs —
 *     can read the snapshot response without credentials.
 *
 *   - The snapshot response includes absolute filesystem paths
 *     (workspace.root, job.repo, job.worktreePath). These are
 *     acceptable exposure for a local developer tool; they must not
 *     be surfaced on non-loopback interfaces.
 *
 *   - Browser-originated requests: modern browsers enforce the
 *     Same-Origin Policy and block cross-origin response reads.
 *     However, the request itself is still sent and processed.
 *     DNS rebinding attacks can bypass the origin check by resolving
 *     an attacker-controlled domain to 127.0.0.1.
 *     Follow-up consideration (not this sprint): validate the Host
 *     request header against the configured loopback address.
 *
 *   - Port 4785 is predictable. There is no secret in the URL.
 *     Any local process that knows or guesses the port can read
 *     the snapshot.
 */
export async function startOpsServer(options: OpsServerOptions = {}): Promise<StartedOpsServer> {
  const host = options.host ?? DEFAULT_OPS_HOST;
  const port = options.port ?? DEFAULT_OPS_PORT;

  assertLoopbackHost(host);

  const server = createOpsServer(options);

  return new Promise<StartedOpsServer>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({
        server,
        host,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
