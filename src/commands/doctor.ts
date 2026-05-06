/**
 * Comando `amon doctor`.
 * Diagnóstico completo del entorno de ejecución de AMON Agents.
 *
 * Revisa:
 *  - ruta del CLI actual
 *  - cwd actual
 *  - .env.local cargado
 *  - versiones de node y npm
 *  - provider activo
 *  - modelo activo
 *  - LLM config válida
 *  - Ollama reachable (si provider=ollama)
 *  - modelo instalado en Ollama (si provider=ollama)
 *  - Sentinel Board API URL configurada
 *  - Sentinel Board Agent Token configurado
 *  - push enabled/disabled
 *  - outputs/ existente
 *  - posible conflicto de PATH (where.exe/which -a)
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { getActiveModel, getActiveProvider, validateLLMConfig } from "../llm/call-llm";
import { info } from "../utils/logger";

/* ── helpers ────────────────────────────────────────────────── */

const HEALTH_TIMEOUT_MS = 3000;

interface Check {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const ICON: Record<Check["status"], string> = {
  ok: "✔",
  warn: "⚠",
  fail: "✖",
};

function fmtCheck(c: Check): string {
  return `  ${ICON[c.status]}  ${c.label.padEnd(30)} ${c.detail}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/* ── checks ─────────────────────────────────────────────────── */

function checkCliPath(): Check {
  const execPath = process.argv[1] ?? "(desconocido)";
  return { label: "CLI path", status: "ok", detail: execPath };
}

function checkCwd(): Check {
  return { label: "Working directory", status: "ok", detail: process.cwd() };
}

function checkEnvLocal(): Check {
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    return { label: ".env.local", status: "ok", detail: `cargado desde ${envPath}` };
  }
  return { label: ".env.local", status: "warn", detail: "no encontrado en cwd — usando solo env del proceso" };
}

function checkNodeVersion(): Check {
  return { label: "Node version", status: "ok", detail: process.version };
}

function checkNpmVersion(): Check {
  try {
    const npmVersion = execSync("npm --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return { label: "npm version", status: "ok", detail: npmVersion };
  } catch {
    return { label: "npm version", status: "warn", detail: "no se pudo determinar" };
  }
}

function checkProvider(): Check {
  const rawProvider = process.env.AMON_AGENTS_PROVIDER;
  if (!rawProvider || rawProvider.trim().length === 0) {
    return { label: "Provider activo", status: "fail", detail: "AMON_AGENTS_PROVIDER no configurado" };
  }
  try {
    const provider = getActiveProvider();
    return { label: "Provider activo", status: "ok", detail: provider };
  } catch (e) {
    return { label: "Provider activo", status: "fail", detail: (e as Error).message };
  }
}

function checkModel(): Check {
  try {
    const model = getActiveModel();
    return { label: "Modelo activo", status: "ok", detail: model };
  } catch (e) {
    return { label: "Modelo activo", status: "fail", detail: (e as Error).message };
  }
}

function checkLLMConfig(): Check {
  const { valid, errors } = validateLLMConfig();
  if (valid) {
    return { label: "LLM config", status: "ok", detail: "válida" };
  }
  return { label: "LLM config", status: "fail", detail: errors.join("; ") };
}

async function checkOllamaReachable(): Promise<Check> {
  const provider = getActiveProvider();
  if (provider !== "ollama") {
    return { label: "Ollama reachable", status: "ok", detail: `n/a (provider=${provider})` };
  }
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    await fetchJson(`${baseUrl}/api/tags`);
    return { label: "Ollama reachable", status: "ok", detail: `HTTP 200 desde ${baseUrl}` };
  } catch (e) {
    return { label: "Ollama reachable", status: "fail", detail: `${(e as Error).message} (${baseUrl})` };
  }
}

async function checkOllamaModelInstalled(): Promise<Check> {
  const provider = getActiveProvider();
  if (provider !== "ollama") {
    return { label: "Ollama model installed", status: "ok", detail: `n/a (provider=${provider})` };
  }
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = getActiveModel();
  try {
    const data = (await fetchJson(`${baseUrl}/api/tags`)) as {
      models?: Array<{ name?: string }>;
    };
    const models = (data.models ?? []).map((m) => m.name ?? "");
    const found = models.some(
      (m) => m === model || m.startsWith(`${model}:`) || model.startsWith(`${m.split(":")[0]}:`)
    );
    if (found) {
      return { label: "Ollama model installed", status: "ok", detail: `${model} encontrado` };
    }
    return {
      label: "Ollama model installed",
      status: "fail",
      detail: `${model} no instalado. Modelos locales: [${models.join(", ")}]`,
    };
  } catch (e) {
    return { label: "Ollama model installed", status: "fail", detail: (e as Error).message };
  }
}

function checkSBApiUrl(): Check {
  const url = process.env.SENTINEL_BOARD_API_URL;
  if (url && url.trim().length > 0) {
    return { label: "SB API URL", status: "ok", detail: url.replace(/\/$/, "") };
  }
  return { label: "SB API URL", status: "warn", detail: "no definida — default http://localhost:3000" };
}

function checkSBToken(): Check {
  const token = process.env.SENTINEL_BOARD_AGENT_TOKEN;
  if (token && token.trim().length > 0) {
    const masked = token.length > 8 ? `${token.slice(0, 3)}...${token.slice(-4)}` : "****";
    return { label: "SB Agent Token", status: "ok", detail: masked };
  }
  return { label: "SB Agent Token", status: "warn", detail: "no definido" };
}

function checkPushEnabled(): Check {
  const enabled = process.env.AMON_AGENTS_PUSH_TO_SB === "true";
  return {
    label: "Push to SB",
    status: enabled ? "ok" : "warn",
    detail: enabled ? "enabled" : "disabled",
  };
}

function checkOutputsDir(): Check {
  const outputsPath = resolve(process.cwd(), "outputs");
  if (existsSync(outputsPath)) {
    return { label: "outputs/ directory", status: "ok", detail: outputsPath };
  }
  return { label: "outputs/ directory", status: "warn", detail: "no existe — se creará bajo demanda" };
}

function checkPathConflict(): Check {
  const execPath = process.argv[1] ?? "(desconocido)";
  const isAmonAgents =
    execPath.includes("amon-agents") || execPath.includes("amon.ts") || execPath.includes("amon.js");

  try {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "where.exe amon" : "which -a amon";
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const lines = result.split(/\r?\n/).filter(Boolean);

    if (lines.length > 1) {
      return {
        label: "PATH / ejecutable",
        status: "warn",
        detail: `múltiples binarios: ${lines.join(", ")}. Posible conflicto con otro CLI "amon". Usa "amon-agents" como alias seguro.`,
      };
    }

    if (lines.length === 1) {
      const line = lines[0];
      if (
        isAmonAgents ||
        line.includes("amon-agents") ||
        line.includes("amon.js") ||
        line.includes("amon.ts")
      ) {
        return { label: "PATH / ejecutable", status: "ok", detail: line };
      }
      return {
        label: "PATH / ejecutable",
        status: "warn",
        detail: `${line} — posible conflicto con otro CLI "amon". Usa "amon-agents" como alias seguro.`,
      };
    }
  } catch {
    // Command not found or no amon in PATH
  }

  if (!isAmonAgents) {
    return {
      label: "PATH / ejecutable",
      status: "warn",
      detail: `${execPath} — posible conflicto con otro CLI "amon". Usa "amon-agents" como alias seguro.`,
    };
  }

  return { label: "PATH / ejecutable", status: "ok", detail: execPath };
}

/* ── main ───────────────────────────────────────────────────── */

export async function doctorCommand(): Promise<number> {
  const checks: Check[] = [];

  // Sync checks
  checks.push(checkCliPath());
  checks.push(checkCwd());
  checks.push(checkEnvLocal());
  checks.push(checkNodeVersion());
  checks.push(checkNpmVersion());
  checks.push(checkProvider());
  checks.push(checkModel());
  checks.push(checkLLMConfig());

  // Async checks (Ollama)
  checks.push(await checkOllamaReachable());
  checks.push(await checkOllamaModelInstalled());

  // Integration checks
  checks.push(checkSBApiUrl());
  checks.push(checkSBToken());
  checks.push(checkPushEnabled());
  checks.push(checkOutputsDir());

  // PATH conflict
  checks.push(checkPathConflict());

  // ── render ──
  const w = process.stdout.write.bind(process.stdout);
  w("\n");
  w("  ╔══════════════════════════════════════════╗\n");
  w("  ║         AMON CLI  ·  doctor              ║\n");
  w("  ║  Orquestador de agentes para desarrollo  ║\n");
  w("  ╚══════════════════════════════════════════╝\n");
  w("\n");

  let failCount = 0;
  let warnCount = 0;
  for (const c of checks) {
    w(fmtCheck(c) + "\n");
    if (c.status === "fail") failCount++;
    if (c.status === "warn") warnCount++;
  }

  w("\n");
  if (failCount > 0) {
    w(`  Resultado: ${failCount} error(es), ${warnCount} advertencia(s).\n`);
    w("  Revisa los items marcados con ✖ antes de ejecutar amon run.\n");
  } else if (warnCount > 0) {
    w(`  Resultado: OK con ${warnCount} advertencia(s).\n`);
  } else {
    w("  Resultado: todo OK ✔\n");
  }
  w("\n");

  info("[amon doctor] Diagnóstico completado.");
  return failCount > 0 ? 1 : 0;
}
