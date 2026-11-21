import fs from 'node:fs';
import path from 'node:path';
import { gitBlobSha1, inside, requireRelease, sha256 } from '../guardian/release-source';

export interface IntegrityEntry {
  path: string; kind: 'file'|'directory'|'symlink'; mode: number;
  sha256?: string; contentBase64?: string; target?: string; gitBlobOid?:string;
  linkState?: 'internal'|'external'|'broken';
}
export interface IntegritySnapshot { entries: IntegrityEntry[]; errors: string[]; missing?:string[] }
export function safeRelative(file: string): boolean {
  return typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) &&
    !file.includes('\\') && !file.includes('\0') && file.split('/').every(p => !!p && p !== '.' && p !== '..' && p !== '.git');
}
/** Integrity capture, not a recursive walker. lstat classifies before content access.
 * Directory links are recorded, never traversed; callers enumerate canonical paths.
 * Errors are explicit, never an empty/successful digest. O_NOFOLLOW protects final opens;
 * before/after checks detect ordinary races, not malicious write-and-restore by the OS owner.
 * Optional contentPaths retains bytes only for review inputs; every regular file is still hashed. */
export function captureIntegrity(rootInput: string, files: string[], contentPaths?: ReadonlySet<string>,
  options:{gitBlobHashes?:boolean;allowMissing?:boolean}={}): IntegritySnapshot {
  const root=fs.realpathSync(rootInput), entries: IntegrityEntry[]=[], errors: string[]=[],missing:string[]=[];
  requireRelease(files.length <= 5000 && new Set(files).size === files.length,'INTEGRITY_PATH_LIMIT');
  let bytes=0;
  for (const file of [...files].sort()) {
    let inspected=false;
    try {
      requireRelease(safeRelative(file),'INTEGRITY_UNSAFE_PATH');
      const target=path.join(root,file);
      let parent=root;
      // Check ancestors from root outward: even a missing leaf must never hide a
      // directory symlink or allow a later read to traverse outside the source.
      for(const component of file.split('/').slice(0,-1)) {
        parent=path.join(parent,component);
        const ancestor=fs.lstatSync(parent);
        requireRelease(!ancestor.isSymbolicLink(),'INTEGRITY_LINK_ANCESTOR');
        requireRelease(ancestor.isDirectory(),'INTEGRITY_UNSAFE_ENTRY');
      }
      const before=fs.lstatSync(target), mode=before.mode & 0o7777;
      inspected=true;
      if (before.isSymbolicLink()) {
        const linkBytes=fs.readlinkSync(target,{encoding:'buffer'}),link=linkBytes.toString('utf8');
        requireRelease(!link.includes('\ufffd'),'INTEGRITY_UNSAFE_PATH');
        let linkState: IntegrityEntry['linkState']='broken';
        try {linkState=inside(root,fs.realpathSync(target)) ? 'internal':'external';} catch (e) {
          if (!['ENOENT','ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        }
        entries.push({path:file,kind:'symlink',mode,target:link,linkState,
          ...(options.gitBlobHashes?{gitBlobOid:gitBlobSha1(linkBytes)}:{})});
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
            ...(options.gitBlobHashes?{gitBlobOid:gitBlobSha1(content)}:{}),
            ...(contentPaths===undefined || contentPaths.has(file) ? {contentBase64:content.toString('base64')} : {})});
        } finally {fs.closeSync(fd);}
      }
      const after=fs.lstatSync(target);
      requireRelease(before.ino === after.ino && before.dev === after.dev && before.mode === after.mode &&
        before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,'INTEGRITY_CHANGED');
    } catch (e) {
      if(options.allowMissing && !inspected && (e as NodeJS.ErrnoException).code==='ENOENT'){missing.push(file);continue;}
      const reason=e instanceof Error && /^INTEGRITY_[A-Z_]+$/.test(e.message) ? e.message : `INTEGRITY_READ_${(e as NodeJS.ErrnoException).code ?? 'FAILED'}`;
      errors.push(`${file}: ${reason}`);
    }
  }
  return {entries,errors,...(options.allowMissing?{missing}:{})};
}
