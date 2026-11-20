import fs from 'node:fs';
import path from 'node:path';
import { inside, requireRelease, sha256 } from '../guardian/release-source';

export interface IntegrityEntry {
  path: string; kind: 'file'|'directory'|'symlink'; mode: number;
  sha256?: string; contentBase64?: string; target?: string;
  linkState?: 'internal'|'external'|'broken';
}
export interface IntegritySnapshot { entries: IntegrityEntry[]; errors: string[] }
export function safeRelative(file: string): boolean {
  return typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) &&
    !file.includes('\\') && !file.includes('\0') && file.split('/').every(p => !!p && p !== '.' && p !== '..' && p !== '.git');
}
/** Integrity capture, not a recursive walker. lstat classifies before content access.
 * Directory links are recorded, never traversed; callers enumerate canonical paths.
 * Errors are explicit, never an empty/successful digest. O_NOFOLLOW protects final opens;
 * before/after checks detect ordinary races, not malicious write-and-restore by the OS owner.
 * Optional contentPaths retains bytes only for review inputs; every regular file is still hashed. */
export function captureIntegrity(rootInput: string, files: string[], contentPaths?: ReadonlySet<string>): IntegritySnapshot {
  const root=fs.realpathSync(rootInput), entries: IntegrityEntry[]=[], errors: string[]=[];
  requireRelease(files.length <= 5000 && new Set(files).size === files.length,'INTEGRITY_PATH_LIMIT');
  let bytes=0;
  for (const file of [...files].sort()) {
    try {
      requireRelease(safeRelative(file),'INTEGRITY_UNSAFE_PATH');
      const target=path.join(root,file);
      let parent=path.dirname(target);
      while (parent !== root) {
        requireRelease(!fs.lstatSync(parent).isSymbolicLink(),'INTEGRITY_LINK_ANCESTOR');
        parent=path.dirname(parent);
      }
      const before=fs.lstatSync(target), mode=before.mode & 0o777;
      if (before.isSymbolicLink()) {
        const link=fs.readlinkSync(target);
        let linkState: IntegrityEntry['linkState']='broken';
        try {linkState=inside(root,fs.realpathSync(target)) ? 'internal':'external';} catch (e) {
          if (!['ENOENT','ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        }
        entries.push({path:file,kind:'symlink',mode,target:link,linkState});
        if (linkState !== 'internal') errors.push(`${file}: INTEGRITY_${linkState.toUpperCase()}_LINK`);
      } else if (before.isDirectory()) entries.push({path:file,kind:'directory',mode});
      else {
        requireRelease(before.isFile() && before.nlink === 1,'INTEGRITY_UNSAFE_ENTRY');
        requireRelease(before.size <= 8*1024*1024 && bytes+before.size <= 32*1024*1024,'INTEGRITY_SIZE_LIMIT');
        const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try {
          const opened=fs.fstatSync(fd);
          requireRelease(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev,'INTEGRITY_CHANGED');
          const content=fs.readFileSync(fd), after=fs.fstatSync(fd);
          requireRelease(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,'INTEGRITY_CHANGED');
          bytes+=content.length;
          entries.push({path:file,kind:'file',mode,sha256:sha256(content),
            ...(contentPaths===undefined || contentPaths.has(file) ? {contentBase64:content.toString('base64')} : {})});
        } finally {fs.closeSync(fd);}
      }
      const after=fs.lstatSync(target);
      requireRelease(before.ino === after.ino && before.dev === after.dev && before.mode === after.mode &&
        before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,'INTEGRITY_CHANGED');
    } catch (e) {
      const reason=e instanceof Error && /^INTEGRITY_[A-Z_]+$/.test(e.message) ? e.message : `INTEGRITY_READ_${(e as NodeJS.ErrnoException).code ?? 'FAILED'}`;
      errors.push(`${file}: ${reason}`);
    }
  }
  return {entries,errors};
}
