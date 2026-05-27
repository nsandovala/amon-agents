/**
 * Comando `amon audit --repo <ruta>`.
 *
 * V1 sin IA: comprueba estado del repo, salud del package.json/lockfile,
 * scripts npm presentes, leakage de .env y stack detectado (Next/Node/TS).
 *
 * Output:
 *   - JSON normalizado en outputs/audits/<repoName>-<ts>.json
 *   - Eventos NDJSON en outputs/events.jsonl con type=audit.finding
 *
 * No requiere LLM. No modifica el repo auditado.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { basename, isAbsolute, join, resolve } from "path";
import { ParsedArgs } from "../cli/parse-args";
import { emitAmonEvent } from "../events/event-emitter";
import { readJsonSafe, statSyncSafe } from "../utils/fs-helpers";
import { error, info, warn } from "../utils/logger";

export type FindingLevel = "info" | "warn" | "error";

export interface AuditFinding {
  id: string;
  level: FindingLevel;
  category:
    | "git"
    | "package"
    | "lockfile"
    | "scripts"
    | "env"
    | "stack"
    | "structure";
  message: string;
  detail?: Record<string, unknown>;
}

export interface AuditReport {
  schema: "amon-agents.audit/v1";
  generatedAt: string;
  repo: { name: string; absolutePath: string };
  stack: {
    isNode: boolean;
    isNext: boolean;
    isTypeScript: boolean;
    packageManager: "npm" | "pnpm" | "yarn" | "unknown";
    nodeEngines?: string;
  };
  git: {
    isRepo: boolean;
    branch: string | null;
    dirty: boolean;
    aheadBehind: { ahead: number; behind: number } | null;
    untracked: number;
  };
  scripts: Record<string, string> | null;
  envLeakage: {
    committedEnvFiles: string[];
    examplePresent: boolean;
    gitIgnoredEnvDot: boolean;
  };
  summary: { errors: number; warnings: number; info: number };
  findings: AuditFinding[];
}

function resolveRepoPath(flag: unknown): string | null {
  if (typeof flag !== "string" || !flag.trim()) return null;
  const p = flag.trim();
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function tryGit(repo: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function detectGit(repo: string): AuditReport["git"] {
  if (!existsSync(join(repo, ".git"))) {
    return { isRepo: false, branch: null, dirty: false, aheadBehind: null, untracked: 0 };
  }
  const branch = tryGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusRaw = tryGit(repo, ["status", "--porcelain=v1", "-b"]);
  let dirty = false;
  let aheadBehind: { ahead: number; behind: number } | null = null;
  let untracked = 0;
  if (statusRaw) {
    const lines = statusRaw.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("## ")) {
        const m = line.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
        if (m) {
          aheadBehind = {
            ahead: m[1] ? Number(m[1]) : 0,
            behind: m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : 0,
          };
        }
      } else if (line.startsWith("??")) {
        untracked++;
        dirty = true;
      } else if (line.trim().length > 0) {
        dirty = true;
      }
    }
  }
  return { isRepo: true, branch, dirty, aheadBehind, untracked };
}

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

async function detectStack(repo: string, pkg: PackageJson | null): Promise<AuditReport["stack"]> {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const isNode = pkg !== null;
  const isNext = !!deps["next"];
  const isTypeScript =
    !!deps["typescript"] || existsSync(join(repo, "tsconfig.json"));

  let packageManager: AuditReport["stack"]["packageManager"] = "unknown";
  if (existsSync(join(repo, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(repo, "yarn.lock"))) packageManager = "yarn";
  else if (existsSync(join(repo, "package-lock.json"))) packageManager = "npm";

  return {
    isNode,
    isNext,
    isTypeScript,
    packageManager,
    nodeEngines: pkg?.engines?.node,
  };
}

async function detectEnvLeakage(repo: string): Promise<AuditReport["envLeakage"]> {
  // Lista de archivos en raíz que parecen .env y NO son ejemplo
  const root = await readdir(repo).catch(() => [] as string[]);
  const envCandidates = root.filter((name) =>
    /^\.env(\.|$)/.test(name) && !/\.example$/.test(name) && !/\.sample$/.test(name),
  );

  let gitIgnoredEnvDot = false;
  const gi = join(repo, ".gitignore");
  if (existsSync(gi)) {
    try {
      const txt = await readFile(gi, "utf8");
      gitIgnoredEnvDot = /(^|\n)\s*\.env(\.|\b|\*)/m.test(txt);
    } catch {
      // ignore
    }
  }

  // De los candidatos, descartamos los que git ignora si el repo es git
  let committedEnvFiles: string[] = envCandidates;
  if (existsSync(join(repo, ".git"))) {
    const checked: string[] = [];
    for (const f of envCandidates) {
      const out = tryGit(repo, ["check-ignore", "--quiet", f]);
      // check-ignore exit 0 = ignorado; aquí tryGit devuelve null si exit ≠ 0
      if (out === null) {
        // No ignorado por git → vive como tracked o untracked-not-ignored
        const tracked = tryGit(repo, ["ls-files", "--error-unmatch", f]);
        if (tracked !== null) checked.push(f); // tracked en el repo
        else checked.push(f); // untracked pero sin ignore — sigue siendo riesgo
      }
    }
    committedEnvFiles = checked;
  }

  return {
    committedEnvFiles,
    examplePresent: root.some((n) => /^\.env\.example$/.test(n)),
    gitIgnoredEnvDot,
  };
}

async function emitFinding(
  runId: string,
  repo: string,
  finding: AuditFinding
): Promise<void> {
  await emitAmonEvent({
    runId,
    type: "audit.finding",
    level: finding.level,
    message: finding.message,
    consumer: "sentinel-board",
    payload: {
      category: finding.category,
      findingId: finding.id,
      repo,
      detail: finding.detail,
    },
  });
}

function summarize(findings: AuditFinding[]): AuditReport["summary"] {
  return findings.reduce(
    (acc, f) => {
      if (f.level === "error") acc.errors++;
      else if (f.level === "warn") acc.warnings++;
      else acc.info++;
      return acc;
    },
    { errors: 0, warnings: 0, info: 0 } as AuditReport["summary"],
  );
}

export async function auditCommand(args: ParsedArgs): Promise<number> {
  const repo = resolveRepoPath(args.flags.repo);
  if (!repo) {
    error("[amon audit] Falta --repo <ruta>.");
    info("Ejemplo: amon audit --repo ../sentinel-board");
    return 1;
  }
  if (!existsSync(repo)) {
    error(`[amon audit] Ruta no existe: ${repo}`);
    return 1;
  }

  const runId =
    typeof args.flags.runId === "string" ? args.flags.runId : `audit-${Date.now()}`;
  info(`[amon audit] Auditando ${repo}`);

  const pkgPath = join(repo, "package.json");
  const pkg = await readJsonSafe<PackageJson>(pkgPath);
  const stack = await detectStack(repo, pkg);
  const git = detectGit(repo);
  const envLeakage = await detectEnvLeakage(repo);

  const findings: AuditFinding[] = [];

  // ── package.json ──
  if (!pkg) {
    findings.push({
      id: "pkg.missing",
      level: "error",
      category: "package",
      message: "package.json ausente — no parece un repo Node.",
    });
  } else {
    findings.push({
      id: "pkg.present",
      level: "info",
      category: "package",
      message: `package.json OK · ${pkg.name ?? "(sin name)"} v${pkg.version ?? "0.0.0"}`,
      detail: { name: pkg.name, version: pkg.version, engines: pkg.engines },
    });
  }

  // ── lockfile ──
  if (stack.isNode) {
    if (stack.packageManager === "unknown") {
      findings.push({
        id: "lock.missing",
        level: "warn",
        category: "lockfile",
        message: "No se encontró lockfile (package-lock.json / pnpm-lock.yaml / yarn.lock).",
      });
    } else {
      findings.push({
        id: "lock.present",
        level: "info",
        category: "lockfile",
        message: `Lockfile detectado · packageManager=${stack.packageManager}`,
        detail: { packageManager: stack.packageManager },
      });
    }
  }

  // ── npm scripts ──
  const scripts = pkg?.scripts ?? null;
  if (pkg) {
    const expected = ["build", "dev", "test", "typecheck"];
    const missing = expected.filter((s) => !scripts?.[s]);
    findings.push({
      id: "scripts.list",
      level: missing.length > 0 ? "warn" : "info",
      category: "scripts",
      message: missing.length > 0
        ? `npm scripts faltantes: ${missing.join(", ")}`
        : "npm scripts esperados presentes",
      detail: {
        present: scripts ? Object.keys(scripts) : [],
        missing,
      },
    });
  }

  // ── git ──
  if (!git.isRepo) {
    findings.push({
      id: "git.none",
      level: "warn",
      category: "git",
      message: "El directorio no es un repositorio git (.git ausente).",
    });
  } else {
    findings.push({
      id: "git.branch",
      level: "info",
      category: "git",
      message: `Branch actual: ${git.branch ?? "(detached)"} · dirty=${git.dirty} · untracked=${git.untracked}`,
      detail: { branch: git.branch, dirty: git.dirty, untracked: git.untracked, aheadBehind: git.aheadBehind },
    });
    if (git.dirty) {
      findings.push({
        id: "git.dirty",
        level: "warn",
        category: "git",
        message: `Working tree con cambios sin commitear (${git.untracked} untracked).`,
      });
    }
  }

  // ── .env leakage ──
  if (envLeakage.committedEnvFiles.length > 0) {
    findings.push({
      id: "env.leak",
      level: "error",
      category: "env",
      message: `Posible filtración de .env: ${envLeakage.committedEnvFiles.join(", ")}`,
      detail: { files: envLeakage.committedEnvFiles, gitIgnored: envLeakage.gitIgnoredEnvDot },
    });
  } else if (envLeakage.gitIgnoredEnvDot) {
    findings.push({
      id: "env.clean",
      level: "info",
      category: "env",
      message: ".env* correctamente listado en .gitignore.",
    });
  } else {
    findings.push({
      id: "env.gitignore.missing",
      level: "warn",
      category: "env",
      message: "No se encontró regla para .env* en .gitignore.",
    });
  }
  if (!envLeakage.examplePresent) {
    findings.push({
      id: "env.example.missing",
      level: "warn",
      category: "env",
      message: "No hay .env.example en el repo (recomendado para onboarding).",
    });
  }

  // ── stack ──
  findings.push({
    id: "stack.detect",
    level: "info",
    category: "stack",
    message: `Stack detectado · Node=${stack.isNode} · TS=${stack.isTypeScript} · Next=${stack.isNext} · pm=${stack.packageManager}`,
    detail: stack as unknown as Record<string, unknown>,
  });

  // ── estructura mínima ──
  const expectedDirs = ["app", "src", "lib", "components", "pages", "scripts"];
  const presentDirs = expectedDirs.filter((d) => statSyncSafe(join(repo, d)).exists);
  findings.push({
    id: "structure.dirs",
    level: "info",
    category: "structure",
    message: `Directorios raíz relevantes: ${presentDirs.join(", ") || "(ninguno conocido)"}`,
    detail: { presentDirs },
  });

  // Emit findings to NDJSON stream
  for (const f of findings) {
    await emitFinding(runId, repo, f);
  }

  const summary = summarize(findings);
  const repoName = basename(repo) || "repo";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(process.cwd(), "outputs", "audits");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${repoName}-${stamp}.json`);

  const report: AuditReport = {
    schema: "amon-agents.audit/v1",
    generatedAt: new Date().toISOString(),
    repo: { name: repoName, absolutePath: repo },
    stack,
    git,
    scripts,
    envLeakage,
    summary,
    findings,
  };

  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  info(`[amon audit] Reporte: ${outPath}`);
  info(
    `[amon audit] Findings: ${summary.errors} error(es) · ${summary.warnings} advertencia(s) · ${summary.info} info`,
  );
  if (summary.errors > 0) {
    warn("[amon audit] Se detectaron findings de severidad error. Revisa el reporte.");
  }

  return summary.errors > 0 ? 1 : 0;
}
