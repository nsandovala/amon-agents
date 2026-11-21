import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gitBlobSha1, inside, requireRelease, sha256, strictUtf8 } from '../guardian/release-source';

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
export const generatedSourceRoots=['node_modules','dist','coverage','.next','.execution-qa','outputs'] as const;
export const inventoryLimits=Object.freeze({entries:5000,depth:32,pathBytes:4096,totalPathBytes:1024*1024,milliseconds:3000});
/** Compare all path components, including directory prefixes and deleted/index paths.
 * NFC + lowercase is deliberately conservative, not a filesystem collation emulator. */
export function assertInventoryNames(paths:string[]):void {
  requireRelease(paths.length<=inventoryLimits.entries*6,'PREPR_INVENTORY_ENTRY_LIMIT');
  const unique=new Set(paths),names=new Map<string,string>(),started=performance.now();let bytes=0;
  requireRelease(unique.size<=inventoryLimits.entries,'PREPR_INVENTORY_ENTRY_LIMIT');
  for(const file of unique){
    requireRelease(performance.now()-started<=inventoryLimits.milliseconds,'PREPR_INVENTORY_TIME_LIMIT');
    const size=Buffer.byteLength(file);bytes+=size;
    requireRelease(size<=inventoryLimits.pathBytes && bytes<=inventoryLimits.totalPathBytes,'PREPR_INVENTORY_PATH_LIMIT');
    requireRelease(file.split('/').length<=inventoryLimits.depth,'PREPR_INVENTORY_DEPTH_LIMIT');
    requireRelease(safeRelative(file),'PREPR_UNSAFE_PATH');let prefix='';
    for(const part of file.split('/')){
      prefix=prefix?prefix+'/'+part:part;
      const folded=prefix.normalize('NFC').toLowerCase(),previous=names.get(folded);
      requireRelease(previous===undefined || previous===prefix,'PREPR_INVENTORY_CASE_COLLISION');
      names.set(folded,prefix);
    }
  }
}
/** Bounded metadata enumeration for the existing integrity capture. Never follows
 * symlinks or reads file content. A generated root is pruned only if it is an actual
 * directory with no indexed descendants; tracked source always takes precedence.
 * Deadlines are cooperative between syscalls, not cancellation of blocked OS I/O. */
export function inventorySource(rootInput:string,indexPaths:string[]):{files:string[];directories:string[]} {
  const root=fs.realpathSync(rootInput),files:string[]=[],directories:string[]=[];
  const started=performance.now();let count=0,pathBytes=0;
  const budget=()=>requireRelease(performance.now()-started<=inventoryLimits.milliseconds,'PREPR_INVENTORY_TIME_LIMIT');
  const walk=(relative:string,depth:number)=>{
    budget();requireRelease(depth<=inventoryLimits.depth,'PREPR_INVENTORY_DEPTH_LIMIT');
    const full=path.join(root,relative),before=fs.lstatSync(full);
    requireRelease(before.isDirectory() && !before.isSymbolicLink(),'PREPR_INVENTORY_UNSAFE');
    // Node 20/22 accept buffer names; @types/node's OpenDirOptions omits that literal.
    const dir=fs.opendirSync(full,{encoding:'buffer' as BufferEncoding,bufferSize:1});
    try {
      for(;;){
        budget();const entry=dir.readSync();budget();if(!entry)break;
        requireRelease(++count<=inventoryLimits.entries,'PREPR_INVENTORY_ENTRY_LIMIT');
        const raw=entry.name as unknown;
        requireRelease(Buffer.isBuffer(raw),'PREPR_PATH_ENCODING_UNSUPPORTED');
        const name=strictUtf8(raw as Buffer,'PREPR_PATH_ENCODING_UNSUPPORTED');
        const file=relative?relative+'/'+name:name;
        const bytes=Buffer.byteLength(file);pathBytes+=bytes;
        requireRelease(bytes<=inventoryLimits.pathBytes && pathBytes<=inventoryLimits.totalPathBytes,'PREPR_INVENTORY_PATH_LIMIT');
        // The root Git metadata directory/file is not source. Case aliases or links
        // are not equivalent exclusions, nor are nested repositories supported.
        const stat=fs.lstatSync(path.join(root,file));budget();
        if(file==='.git'){
          requireRelease(stat.isDirectory() || stat.isFile(),'PREPR_INVENTORY_UNSAFE');continue;
        }
        requireRelease(safeRelative(file) && !file.split('/').some(p=>p.toLowerCase()==='.git'),'PREPR_UNSAFE_PATH');
        if(stat.isDirectory()){
          directories.push(file);
          if(!relative && generatedSourceRoots.some(p=>p===name) && !indexPaths.some(p=>p===file || p.startsWith(file+'/')))continue;
          walk(file,depth+1);
        }else{
          requireRelease(stat.isSymbolicLink() || (stat.isFile() && stat.nlink===1),'PREPR_INVENTORY_UNSAFE');files.push(file);
        }
      }
    }finally{dir.closeSync();}
    const after=fs.lstatSync(full);budget();
    requireRelease(before.ino===after.ino && before.dev===after.dev && before.mode===after.mode &&
      before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs,'PREPR_INVENTORY_CHANGED');
  };
  try{walk('',0);assertInventoryNames([...directories,...files,...indexPaths]);budget();}
  catch(e){if(e instanceof Error && /^PREPR_[A-Z_]+$/.test(e.message))throw e;throw new Error('PREPR_INVENTORY_READ_FAILED');}
  return {files:files.sort(),directories:directories.sort()};
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
        const linkBytes=fs.readlinkSync(target,{encoding:'buffer'}),link=strictUtf8(linkBytes,'INTEGRITY_UNSAFE_PATH');
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
