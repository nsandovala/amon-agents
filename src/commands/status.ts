/**
 * Comando `amon status`.
 * Reporta provider/modelo activos, push enabled, SB API URL, health-check de Ollama,
 * ruta del CLI ejecutado y posible conflicto de PATH.
 */
import { getActiveModel, getActiveProvider } from "../llm/call-llm";
import { info, warn } from "../utils/logger";

interface StatusReport {
  provider: string;
  model: string;
  pushEnabled: boolean;
  sbApiUrl: string;
  ollama: { configuredUrl: string; reachable: boolean | "n/a"; detail: string };
  cliPath: string;
  pathConflict: boolean;
}

const HEALTH_TIMEOUT_MS = 3000;

async function pingOllama(baseUrl: string): Promise<{ reachable: boolean; detail: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (res.ok) {
      return { reachable: true, detail: `HTTP ${res.status} desde ${url}` };
    }
    return { reachable: false, detail: `HTTP ${res.status} desde ${url}` };
  } catch (err) {
    const msg = (err as Error).message || "error desconocido";
    return { reachable: false, detail: `${msg} (${url})` };
  } finally {
    clearTimeout(id);
  }
}

function detectPathConflict(execPath: string): boolean {
  // If the executable path does NOT reference amon-agents project files,
  // it's likely the old mini-agentes-cli or another package.
  return !(
    execPath.includes("amon-agents") ||
    execPath.includes("amon.ts") ||
    execPath.includes("amon.js")
  );
}

async function buildReport(): Promise<StatusReport> {
  const provider = getActiveProvider();
  const model = getActiveModel();
  const pushEnabled = process.env.AMON_AGENTS_PUSH_TO_SB === "true";
  const sbApiUrl = (process.env.SENTINEL_BOARD_API_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  const ollamaUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

  let ollama: StatusReport["ollama"];
  if (provider === "ollama") {
    const ping = await pingOllama(ollamaUrl);
    ollama = { configuredUrl: ollamaUrl, reachable: ping.reachable, detail: ping.detail };
  } else {
    ollama = {
      configuredUrl: ollamaUrl,
      reachable: "n/a",
      detail: `provider activo es ${provider}; no se ejecutó health-check`,
    };
  }

  const cliPath = process.argv[1] ?? "(desconocido)";
  const pathConflict = detectPathConflict(cliPath);

  return { provider, model, pushEnabled, sbApiUrl, ollama, cliPath, pathConflict };
}

function pad(label: string, width: number): string {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

function formatReachable(value: boolean | "n/a"): string {
  if (value === "n/a") return "n/a";
  return value ? "reachable" : "unreachable";
}

function printReport(report: StatusReport): void {
  const lines = [
    "",
    "  AMON CLI · status",
    "  ─────────────────────────────────",
    `  ${pad("Provider:", 14)}${report.provider}`,
    `  ${pad("Model:", 14)}${report.model}`,
    `  ${pad("Push to SB:", 14)}${report.pushEnabled ? "enabled" : "disabled"}`,
    `  ${pad("SB API URL:", 14)}${report.sbApiUrl}`,
    `  ${pad("Ollama URL:", 14)}${report.ollama.configuredUrl}`,
    `  ${pad("Ollama:", 14)}${formatReachable(report.ollama.reachable)}  (${report.ollama.detail})`,
    `  ${pad("CLI path:", 14)}${report.cliPath}`,
  ];

  if (report.pathConflict) {
    lines.push("");
    lines.push("  ⚠  CONFLICTO DE PATH DETECTADO");
    lines.push(`     El binario ejecutado (${report.cliPath}) no pertenece a amon-agents.`);
    lines.push("     Es posible que otro CLI \"amon\" (mini-agentes-cli u otro) tenga prioridad en PATH.");
    lines.push("     Recomendación: usa \"amon-agents\" como alias seguro, o desinstala el CLI anterior:");
    lines.push("       npm uninstall -g mini-agentes-cli");
    lines.push("       npm install -g .   (desde la raíz de amon-agents)");
  }

  lines.push("");

  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

export async function statusCommand(): Promise<number> {
  const report = await buildReport();
  printReport(report);

  if (report.pathConflict) {
    warn("[amon status] Conflicto de PATH detectado — CLI ejecutado: " + report.cliPath);
  }

  info("[amon status] Reporte emitido.");
  return 0;
}
