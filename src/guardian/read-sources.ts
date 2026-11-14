import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { buildOperationalSnapshot } from '../ops/projection';
import type { OperationalSnapshot } from '../ops/types';
import { READ_LIMITS, ReadSourceError } from './read-contracts';

export interface OperationalRead {
  snapshot: OperationalSnapshot;
  available: {worker: boolean; jobs: boolean; guardian: boolean};
}
/** Host-owned, already bound read capabilities. Never construct these from tool arguments. */
export interface GuardianReadSources {
  operational(now: Date): Promise<OperationalRead>;
  mission(): Promise<unknown>;
}

const WORKER = 'outputs/worker/worker-status.json';
const JOBS = 'outputs/worker/jobs';
const REVIEWS = 'outputs/guardian/reviews';
export const MISSION_EXPORT = 'outputs/mission/board-snapshot.json';

/** Captures the host working directory once. No caller-selected path, URL or env override.
 * The OS owner remains the trust boundary, as with the existing sb-mission/1 export.
 */
export function createLocalReadSources(): GuardianReadSources {
  const hostRoot = process.cwd();
  async function reader() {
    const root = await realpath(hostRoot);
    let bytes = 0;
    async function checked(file: string, directory = false) {
      const rel = relative(root, file);
      if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new ReadSourceError('SOURCE_INVALID');
      let cursor = root;
      const parts = rel.split(sep);
      for (let i = 0; i < parts.length; i++) {
        cursor = join(cursor, parts[i]);
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) {
          throw new ReadSourceError('SOURCE_INVALID');
        }
        if (!directory && i === parts.length - 1 && stat.nlink !== 1) throw new ReadSourceError('SOURCE_INVALID');
      }
      if (await realpath(file) !== file) throw new ReadSourceError('SOURCE_INVALID');
    }
    async function read(file: string): Promise<string> {
      if (bytes >= READ_LIMITS.totalBytes) throw new ReadSourceError('SOURCE_LIMIT_EXCEEDED');
      await checked(file);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new ReadSourceError('SOURCE_INVALID');
        if (stat.size > READ_LIMITS.fileBytes) throw new ReadSourceError('SOURCE_LIMIT_EXCEEDED');
        const buffer = Buffer.alloc(Math.min(READ_LIMITS.fileBytes, READ_LIMITS.totalBytes - bytes) + 1);
        let size = 0;
        while (size < buffer.length) {
          const chunk = await handle.read(buffer, size, buffer.length - size, null);
          if (!chunk.bytesRead) break;
          size += chunk.bytesRead;
        }
        bytes += size;
        if (size > READ_LIMITS.fileBytes || bytes > READ_LIMITS.totalBytes) throw new ReadSourceError('SOURCE_LIMIT_EXCEEDED');
        const value = buffer.subarray(0, size).toString('utf8');
        try {
          const parsed: unknown = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch { throw new ReadSourceError('SOURCE_INVALID'); }
        return value;
      } finally { await handle.close(); }
    }
    return {root, read, checked};
  }
  const mappedError = (error: unknown): ReadSourceError => error instanceof ReadSourceError
    ? error : new ReadSourceError('SOURCE_UNAVAILABLE');
  return {
    async operational(now) {
      try {
        const io = await reader();
        const available = {worker: false, jobs: false, guardian: false};
        let failure: ReadSourceError | undefined;
        const paths = {worker: join(io.root, WORKER), jobs: join(io.root, JOBS), guardian: join(io.root, REVIEWS)};
        const allowed = new Set([paths.worker]);
        const snapshot = await buildOperationalSnapshot({cwd: io.root, now: () => now,
          readFile: async file => {
            try {
              if (failure) throw failure;
              if (!allowed.has(file)) throw new ReadSourceError('SOURCE_INVALID');
              const text = await io.read(file);
              // Protect the existing projection from coercing a malformed findings value into a count.
              if (relative(paths.guardian, file).split(sep).length === 1) {
                const value = JSON.parse(text) as {findings?: unknown};
                if (!Array.isArray(value.findings)) throw new ReadSourceError('SOURCE_INVALID');
              }
              if (file === paths.worker) available.worker = true;
              return text;
            } catch (error) {
              if (!(file === paths.worker && (error as NodeJS.ErrnoException).code === 'ENOENT')) failure ??= mappedError(error);
              throw error;
            }
          },
          readdir: async dir => {
            try {
              const kind = dir === paths.jobs ? 'jobs' : dir === paths.guardian ? 'guardian' : null;
              if (!kind) throw new ReadSourceError('SOURCE_INVALID');
              await io.checked(dir, true);
              const names = await readdir(dir);
              if (names.length > READ_LIMITS.maxRecords) throw new ReadSourceError('SOURCE_LIMIT_EXCEEDED');
              available[kind] = true;
              names.filter(n => n.endsWith('.json')).forEach(n => allowed.add(join(dir, n)));
              return names;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= mappedError(error);
              throw error;
            }
          },
        }).catch(error => { throw failure ?? new ReadSourceError('SOURCE_INVALID'); });
        // projection.ts intentionally tolerates IO errors. Do not certify those as empty/healthy here.
        if (failure) throw failure;
        return {snapshot, available};
      } catch (error) { throw mappedError(error); }
    },
    async mission() {
      try {
        const io = await reader();
        return JSON.parse(await io.read(join(io.root, MISSION_EXPORT))) as unknown;
      } catch (error) { throw mappedError(error); }
    },
  };
}
