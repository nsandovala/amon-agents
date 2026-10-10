/**
 * fs-helpers.ts
 *
 * Helpers de filesystem usados por status/audit/scan. Sin dependencias
 * externas: solo `fs/promises`, `fs`, `path`. Pensados para ser baratos
 * en repos chicos (audit/scan recorren ≤ 5k archivos).
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { basename, dirname, join, relative } from "path";

/** Lee las últimas N líneas no vacías de un archivo. Si no existe → []. */
export async function tailLines(filePath: string, n: number): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

/** Devuelve la última línea no vacía como JSON, o null si no hay/parse falla. */
export async function lastJsonLine<T = unknown>(filePath: string): Promise<T | null> {
  const lines = await tailLines(filePath, 50);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      continue;
    }
  }
  return null;
}

/** Devuelve el archivo más recientemente modificado de un directorio (no recursivo). */
export async function newestFile(dir: string): Promise<{ path: string; mtime: Date } | null> {
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir);
  let best: { path: string; mtime: Date } | null = null;
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (!best || st.mtime > best.mtime) best = { path: full, mtime: st.mtime };
    } catch {
      // skip
    }
  }
  return best;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".cache",
  "coverage",
  ".turbo",
  ".vercel",
  "out",
  ".opencode",
]);

export interface WalkOptions {
  /** Max files walked before bailing (safety brake). */
  maxFiles?: number;
  /** Max depth in directory levels. */
  maxDepth?: number;
  /** Extra dir names to skip. */
  skipDirs?: Iterable<string>;
}

/**
 * Recorre un repo retornando rutas relativas a `root`. Se salta automaticamente
 * directorios pesados/derivados (node_modules, .git, .next, dist, build, etc.).
 */
export async function walkRepo(
  root: string,
  options: WalkOptions = {}
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 8;
  const skip = new Set([...SKIP_DIRS, ...(options.skipDirs ?? [])]);
  const out: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (out.length >= maxFiles) return;

    let entries: import("fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(full, depth + 1);
      } else if (ent.isFile()) {
        out.push(relative(root, full));
      }
    }
  }

  await visit(root, 0);
  return out;
}

/** Lee JSON con fallback null si no existe o parsea mal. */
export async function readJsonSafe<T = unknown>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Existe sincrónica que devuelve también mtime (o null). */
export function statSyncSafe(p: string): { exists: boolean; isFile: boolean; mtime?: Date } {
  try {
    const st = statSync(p);
    return { exists: true, isFile: st.isFile(), mtime: st.mtime };
  } catch {
    return { exists: false, isFile: false };
  }
}

/** Asegura que la carpeta del archivo existe. */
export function dirOf(filePath: string): string {
  return dirname(filePath);
}

export interface AtomicWriteDeps {
  mkdirFn?: (path: string, opts: { recursive: boolean }) => Promise<unknown>;
  writeFileFn?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  renameFn?: (src: string, dst: string) => Promise<void>;
  unlinkFn?: (path: string) => Promise<void>;
  uuidFn?: () => string;
}

/**
 * Writes `data` to `destPath` atomically using a same-directory temp file
 * and fs.rename(). Readers see either the previous complete file or the new
 * complete file — never a partial write.
 *
 * Creates the destination directory if it does not exist.
 * On any failure, attempts best-effort removal of the temp file before
 * re-throwing the original error.
 *
 * GUARANTEES:
 *   - No partial reads: rename is atomic on POSIX (Linux, macOS).
 *   - No temp content leak: .tmp files are invisible to JSON readers that
 *     filter for .json files.
 *   - Best-effort cleanup on controlled failure: if writeFile or rename
 *     throws, an attempt is made to unlink the temp file. Abrupt process
 *     termination (SIGKILL, power loss) may leave an orphaned .tmp file;
 *     no automatic cleanup is performed in R1.
 *   - Last-writer wins under concurrent calls: POSIX rename is atomic, so
 *     no corruption occurs when two callers race to the same destination.
 *     One write silently prevails; the other's content is discarded.
 *
 * DOES NOT GUARANTEE:
 *   - Power-loss durability: no fsync. Data is in the OS page cache on
 *     return. A power failure after rename() may revert the file.
 *   - Exactly-once execution: this utility protects file integrity only.
 *     It does not prevent a job from executing more than once.
 *   - Multi-file transactions: two sequential atomicWriteFile calls are not
 *     coordinated. A reader between them observes an inconsistent pair.
 *   - Concurrent writer coordination: the upstream existence checks in
 *     runWorkerJob() and runGuardianReview() are not atomic with respect to
 *     this write. Two concurrent callers passing those checks simultaneously
 *     will both write; the last rename wins without error. No locking
 *     mechanism is introduced in R1.
 *
 * WINDOWS: fs.rename() may fail with EPERM if the destination is held open
 *   by another process. This platform is recognized but not verified in CI.
 *   No unlink-before-rename fallback is used; rename failures are propagated.
 */
export async function atomicWriteFile(
  destPath: string,
  data: string,
  deps: AtomicWriteDeps = {}
): Promise<void> {
  const dir = dirname(destPath);
  const base = basename(destPath);
  const uuid = (deps.uuidFn ?? randomUUID)();
  const tmpPath = join(dir, `${base}.${uuid}.tmp`);

  const doMkdir = deps.mkdirFn ?? mkdir;
  const doWrite = deps.writeFileFn ?? writeFile;
  const doRename = deps.renameFn ?? rename;
  const doUnlink = deps.unlinkFn ?? unlink;

  await doMkdir(dir, { recursive: true });
  try {
    await doWrite(tmpPath, data, "utf8");
    await doRename(tmpPath, destPath);
  } catch (err) {
    try { await doUnlink(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
