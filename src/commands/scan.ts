/**
 * Comando `amon scan --repo <ruta>`.
 *
 * V1 sin IA: recorre el repo, detecta stack, lista docs, rutas API (Next App
 * Router), archivos críticos y produce:
 *   - outputs/scans/<repoName>-<ts>.json     (machine-readable)
 *   - outputs/scans/<repoName>-<ts>.md       (human-readable summary)
 *   - eventos NDJSON con type=scan.finding
 *
 * Pensado para alimentar SB Runtime y futuros prompts de planner sin necesidad
 * de leer el repo completo otra vez.
 */
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { basename, isAbsolute, join, resolve } from "path";
import { ParsedArgs } from "../cli/parse-args";
import { emitAmonEvent } from "../events/event-emitter";
import { readJsonSafe, statSyncSafe, walkRepo } from "../utils/fs-helpers";
import { error, info } from "../utils/logger";

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ScanFinding {
  id: string;
  level: "info" | "warn";
  category: "stack" | "docs" | "api" | "critical" | "structure";
  message: string;
  detail?: Record<string, unknown>;
}

export interface ScanReport {
  schema: "amon-agents.scan/v1";
  generatedAt: string;
  repo: { name: string; absolutePath: string };
  stack: {
    isNode: boolean;
    isNext: boolean;
    isTypeScript: boolean;
    runtime: "node" | "unknown";
    framework: "next" | "express" | "unknown";
    dependenciesTop: string[];
    scriptsAvailable: string[];
  };
  structure: {
    totalFilesScanned: number;
    topLevelDirs: string[];
    fileCountByExt: Record<string, number>;
  };
  docs: { paths: string[]; readme: string | null };
  api: { routerType: "next-app" | "next-pages" | "none"; routes: string[] };
  criticalFiles: string[];
  findings: ScanFinding[];
}

function resolveRepoPath(flag: unknown): string | null {
  if (typeof flag !== "string" || !flag.trim()) return null;
  const p = flag.trim();
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

const CRITICAL_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "drizzle.config.ts",
  "drizzle.config.js",
  "vercel.json",
  ".env.example",
  "AGENT.md",
  "AGENTS.md",
  "README.md",
  "ROADMAP.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "docker-compose.yml",
  "pnpm-workspace.yaml",
]);

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  if (i < 0) return "";
  return path.slice(i).toLowerCase();
}

function isDocPath(rel: string): boolean {
  if (rel.startsWith("docs/") || rel.startsWith("docs\\")) return true;
  return /\.(md|mdx)$/i.test(rel) && !rel.includes("node_modules");
}

function nextAppRoute(rel: string): string | null {
  const norm = rel.replace(/\\/g, "/");
  // app/.../route.ts | route.tsx | route.js
  const m = norm.match(/^app\/(.*\/)?route\.(ts|tsx|js|mjs)$/);
  if (!m) return null;
  const seg = (m[1] ?? "").replace(/\/$/, "");
  return "/" + (seg.length ? seg : "");
}

function nextPagesApi(rel: string): string | null {
  const norm = rel.replace(/\\/g, "/");
  // pages/api/foo.ts
  const m = norm.match(/^pages\/api\/(.+)\.(ts|tsx|js)$/);
  if (!m) return null;
  const seg = m[1];
  return "/api/" + seg.replace(/index$/, "").replace(/\/$/, "");
}

async function buildScan(repo: string): Promise<ScanReport> {
  const pkg = await readJsonSafe<PackageJson>(join(repo, "package.json"));
  const files = await walkRepo(repo, { maxFiles: 5000, maxDepth: 8 });

  const fileCountByExt: Record<string, number> = {};
  const docs: string[] = [];
  const apiRoutes = new Set<string>();
  let routerType: ScanReport["api"]["routerType"] = "none";
  const criticalFound: string[] = [];

  for (const rel of files) {
    const ext = extOf(rel);
    if (ext) fileCountByExt[ext] = (fileCountByExt[ext] ?? 0) + 1;
    if (isDocPath(rel)) docs.push(rel);
    const appRoute = nextAppRoute(rel);
    if (appRoute) {
      routerType = "next-app";
      apiRoutes.add(appRoute);
    }
    const pagesRoute = nextPagesApi(rel);
    if (pagesRoute) {
      if (routerType !== "next-app") routerType = "next-pages";
      apiRoutes.add(pagesRoute);
    }
    const name = rel.split(/[\\/]/).pop() ?? rel;
    if (CRITICAL_FILENAMES.has(name)) criticalFound.push(rel);
  }

  // Top-level dirs (no archivos sueltos)
  const topLevelDirs = Array.from(
    new Set(files.map((r) => r.split(/[\\/]/)[0])),
  ).filter((d) => statSyncSafe(join(repo, d)).exists && !d.includes("."));

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const isNext = !!deps["next"];
  const isTypeScript = !!deps["typescript"] || existsSync(join(repo, "tsconfig.json"));
  const framework: ScanReport["stack"]["framework"] = isNext
    ? "next"
    : deps["express"]
      ? "express"
      : "unknown";

  const stack: ScanReport["stack"] = {
    isNode: pkg !== null,
    isNext,
    isTypeScript,
    runtime: pkg ? "node" : "unknown",
    framework,
    dependenciesTop: Object.keys(deps).slice(0, 25),
    scriptsAvailable: Object.keys(pkg?.scripts ?? {}),
  };

  // README de raíz
  const readmeCandidate = ["README.md", "Readme.md", "readme.md"]
    .map((n) => join(repo, n))
    .find((p) => existsSync(p));

  const findings: ScanFinding[] = [];

  findings.push({
    id: "stack.detected",
    level: "info",
    category: "stack",
    message: `${stack.runtime}/${stack.framework} · TS=${stack.isTypeScript}`,
    detail: stack as unknown as Record<string, unknown>,
  });

  findings.push({
    id: "structure.summary",
    level: "info",
    category: "structure",
    message: `Escaneados ${files.length} archivos. Top dirs: ${topLevelDirs.join(", ") || "(ninguno)"}`,
    detail: { totalFilesScanned: files.length, topLevelDirs },
  });

  if (apiRoutes.size > 0) {
    findings.push({
      id: "api.routes",
      level: "info",
      category: "api",
      message: `${apiRoutes.size} rutas API detectadas (${routerType})`,
      detail: { count: apiRoutes.size, routerType, sample: Array.from(apiRoutes).slice(0, 5) },
    });
  } else {
    findings.push({
      id: "api.none",
      level: "info",
      category: "api",
      message: "No se detectaron rutas API (Next App/Pages router).",
    });
  }

  findings.push({
    id: "docs.list",
    level: "info",
    category: "docs",
    message: `${docs.length} archivos de documentación (md/mdx).`,
    detail: { count: docs.length, sample: docs.slice(0, 10) },
  });

  findings.push({
    id: "critical.list",
    level: "info",
    category: "critical",
    message: `${criticalFound.length} archivos críticos detectados.`,
    detail: { sample: criticalFound.slice(0, 20) },
  });

  return {
    schema: "amon-agents.scan/v1",
    generatedAt: new Date().toISOString(),
    repo: { name: basename(repo) || "repo", absolutePath: repo },
    stack,
    structure: {
      totalFilesScanned: files.length,
      topLevelDirs,
      fileCountByExt,
    },
    docs: {
      paths: docs.slice(0, 200),
      readme: readmeCandidate ?? null,
    },
    api: { routerType, routes: Array.from(apiRoutes).sort() },
    criticalFiles: criticalFound,
    findings,
  };
}

function buildMarkdownSummary(report: ScanReport): string {
  const lines: string[] = [
    `# Scan: ${report.repo.name}`,
    "",
    `Generado: ${report.generatedAt}`,
    `Path: \`${report.repo.absolutePath}\``,
    "",
    `## Stack`,
    `- Runtime: ${report.stack.runtime}`,
    `- Framework: ${report.stack.framework}`,
    `- TypeScript: ${report.stack.isTypeScript ? "sí" : "no"}`,
    `- Scripts npm: ${report.stack.scriptsAvailable.join(", ") || "(ninguno)"}`,
    `- Dependencias principales: ${report.stack.dependenciesTop.join(", ") || "(ninguna)"}`,
    "",
    `## Estructura`,
    `- Archivos escaneados: ${report.structure.totalFilesScanned}`,
    `- Top-level dirs: ${report.structure.topLevelDirs.join(", ") || "(ninguno)"}`,
    "",
    `## API`,
    `- Router: ${report.api.routerType}`,
    `- Rutas detectadas (${report.api.routes.length}):`,
    ...report.api.routes.slice(0, 30).map((r) => `  - \`${r}\``),
  ];

  if (report.api.routes.length > 30) {
    lines.push(`  - ... (${report.api.routes.length - 30} más)`);
  }

  lines.push("", "## Archivos críticos");
  for (const f of report.criticalFiles.slice(0, 30)) {
    lines.push(`- \`${f}\``);
  }
  if (report.criticalFiles.length > 30) {
    lines.push(`- ... (${report.criticalFiles.length - 30} más)`);
  }

  lines.push("", "## Docs", `Total: ${report.docs.paths.length}`);
  for (const f of report.docs.paths.slice(0, 30)) {
    lines.push(`- \`${f}\``);
  }

  return lines.join("\n") + "\n";
}

export async function scanCommand(args: ParsedArgs): Promise<number> {
  const repo = resolveRepoPath(args.flags.repo);
  if (!repo) {
    error("[amon scan] Falta --repo <ruta>.");
    info("Ejemplo: amon scan --repo ../sentinel-board");
    return 1;
  }
  if (!existsSync(repo)) {
    error(`[amon scan] Ruta no existe: ${repo}`);
    return 1;
  }

  const runId =
    typeof args.flags.runId === "string" ? args.flags.runId : `scan-${Date.now()}`;
  info(`[amon scan] Escaneando ${repo}`);

  const report = await buildScan(repo);

  for (const f of report.findings) {
    await emitAmonEvent({
      runId,
      type: "scan.finding",
      level: f.level,
      message: f.message,
      consumer: "sentinel-board",
      payload: {
        category: f.category,
        findingId: f.id,
        repo,
        detail: f.detail,
      },
    });
  }

  const repoName = report.repo.name;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(process.cwd(), "outputs", "scans");
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, `${repoName}-${stamp}.json`);
  const mdPath = join(outDir, `${repoName}-${stamp}.md`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(mdPath, buildMarkdownSummary(report), "utf8");

  info(`[amon scan] JSON: ${jsonPath}`);
  info(`[amon scan] Markdown: ${mdPath}`);
  info(
    `[amon scan] ${report.structure.totalFilesScanned} archivos · ${report.api.routes.length} rutas API · ${report.docs.paths.length} docs · ${report.criticalFiles.length} archivos críticos`,
  );

  return 0;
}
