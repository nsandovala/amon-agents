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

export const DEFAULT_OPS_HOST = "127.0.0.1";
export const DEFAULT_OPS_PORT = 4785;

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

export function startOpsServer(options: OpsServerOptions = {}): Promise<StartedOpsServer> {
  const host = options.host ?? DEFAULT_OPS_HOST;
  const port = options.port ?? DEFAULT_OPS_PORT;
  const server = createOpsServer(options);

  return new Promise((resolvePromise, reject) => {
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
