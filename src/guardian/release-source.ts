import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

export const sha256 = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
export const requireRelease = (condition: unknown, code: string): void => { if (!condition) throw new Error(code); };
export const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root,file);
  return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function gitReadBuffer(root: string, args: string[], input?:string): Buffer {
  return execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args], {stdio:['pipe','pipe','pipe'],input,
    timeout:3000,killSignal:'SIGKILL',maxBuffer:1024*1024,
    env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});
}
/** Validate before decoding; unlike TextDecoder defaults this neither replaces bytes
 * nor removes a UTF-8 BOM. Raw object payloads remain Buffers. */
export function strictUtf8(bytes:Buffer,code:string):string {
  requireRelease(isUtf8(bytes),code);return bytes.toString('utf8');
}
export function gitReadRaw(root: string, ...args: string[]): string {
  const diff=args[0]==='diff' || (args[0]==='--literal-pathspecs' && args[1]==='diff');
  const code=diff && !args.includes('--name-only') ? 'PREPR_DIFF_ENCODING_UNSUPPORTED' : 'PREPR_PATH_ENCODING_UNSUPPORTED';
  return strictUtf8(gitReadBuffer(root,args),code);
}
export function gitRead(root: string, ...args: string[]): string { return gitReadRaw(root,...args).trim(); }
/** Hash exactly a local blob's bytes, never Git's clean/EOL/encoding conversions. */
export const gitBlobSha1=(bytes:Buffer):string=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');

/** Native Git batch metadata/content reads, with transport prohibited by the shared
 * reader. Only validated object IDs are accepted; no paths, filters or expressions. */
export function readPrePrIndexBlobs(root:string,ids:string[],contents=false):Map<string,Buffer> {
  requireRelease(ids.length<=5000 && ids.every(id=>/^[a-f0-9]{40}$/.test(id)),'PREPR_INDEX_UNSUPPORTED');
  const unique=[...new Set(ids)],result=new Map<string,Buffer>();if(!unique.length)return result;
  let output:Buffer;
  try {output=gitReadBuffer(root,['cat-file',contents?'--batch':'--batch-check=%(objectname) %(objecttype)'],unique.join('\n')+'\n');}
  catch(e) {
    if(['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes((e as NodeJS.ErrnoException).code ?? ''))throw new Error('PREPR_OBJECT_OUTPUT_TOO_LARGE');
    throw new Error('PREPR_OBJECT_UNAVAILABLE');
  }
  let offset=0;
  for(const id of unique){
    const end=output.indexOf(10,offset);requireRelease(end>=offset,'PREPR_OBJECT_UNAVAILABLE');
    const header=strictUtf8(output.subarray(offset,end),'PREPR_OBJECT_UNAVAILABLE');offset=end+1;
    if(!contents){requireRelease(header===id+' blob','PREPR_OBJECT_UNAVAILABLE');continue;}
    const match=/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(header);
    requireRelease(match && match[1]===id,'PREPR_OBJECT_UNAVAILABLE');
    const size=Number(match![2]);requireRelease(Number.isSafeInteger(size) && size<=output.length-offset-1,'PREPR_OBJECT_UNAVAILABLE');
    const bytes=output.subarray(offset,offset+size);offset+=size;
    requireRelease(output[offset++]===10 && gitBlobSha1(bytes)===id,'PREPR_OBJECT_UNAVAILABLE');
    result.set(id,bytes);
  }
  requireRelease(offset===output.length,'PREPR_OBJECT_UNAVAILABLE');return result;
}

/** Pre-PR metadata-only guard. Neither config enumeration nor cached ls-files reads
 * worktree content through a filter. Use the SAME host environment as later reads.
 * Reject all driver declarations, even unused/empty ones: attribute selection (root,
 * nested, info/attributes or core.attributesFile) cannot make an executable acceptable.
 * Git resolves effective local/worktree config and conditional/recursive includes.
 * Do not print config values, rewrite config, or clear index flags to obtain a PASS. */
export function assertPrePrGitInspectionSafe(root: string): void {
  let keys:string;
  try {
    keys=gitReadRaw(root,'config','--includes','--null','--list','--name-only');
    requireRelease(keys==='' || keys.endsWith('\0'),'PREPR_GIT_FILTER_UNSAFE');
    requireRelease(!keys.split('\0').some(key=>/^filter\.[\s\S]*\.(clean|process|smudge)$/i.test(key)),'PREPR_GIT_FILTER_UNSAFE');
  } catch { throw new Error('PREPR_GIT_FILTER_UNSAFE'); }
  requireRelease(!keys.split('\0').some(key=>/^extensions\.partialclone$/i.test(key) ||
    /^remote\.[\s\S]*\.(promisor|partialclonefilter)$/i.test(key)),'PREPR_PARTIAL_CLONE_UNSUPPORTED');
  try {
    const entries=gitReadRaw(root,'ls-files','--cached','-v','-z');
    requireRelease(entries==='' || entries.endsWith('\0'),'PREPR_INDEX_FLAGS_UNSAFE');
    // -v uses lowercase for assume-unchanged; S/s denotes skip-worktree.
    // H and M are the only accepted cached tags; unmerged M is rejected by snapshot.
    requireRelease(entries.split('\0').slice(0,-1).every(row=>/^[HM] [\s\S]+$/.test(row)),'PREPR_INDEX_FLAGS_UNSAFE');
  } catch { throw new Error('PREPR_INDEX_FLAGS_UNSAFE'); }
}

/** Hash bytes, names and executable bits, including ignored/untracked source.
 * Only the fixed Git, dependency and Next output directories are excluded.
 * No filters, repository scripts or configuration modules are executed. */
export function directoryDigest(root: string, kind: 'source'|'dependencies'|'artifact'): string {
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!prefix && kind === 'source' && ['.git','node_modules','.next'].includes(name)) continue;
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(dir,name);
      const s = fs.lstatSync(file);
      if (s.isSymbolicLink()) {
        // npm's local .bin links are allowed; links out of the dependency tree are not.
        requireRelease(kind === 'dependencies' && inside(root,fs.realpathSync(file)),'RELEASE_EXTERNAL_OR_SOURCE_LINK');
        hash.update(JSON.stringify([relative,'link',fs.readlinkSync(file)]));
      } else if (s.isDirectory()) { hash.update(JSON.stringify([relative,'dir'])); walk(file,relative); }
      else {
        requireRelease(s.isFile() && s.nlink === 1,'RELEASE_UNSAFE_FILE');
        requireRelease(kind !== 'source' || !/^\.env(?:\.|$)/.test(name),'RELEASE_ENV_FILE_UNSUPPORTED');
        const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
        requireRelease(s.ino === after.ino && s.size === after.size && s.mtimeMs === after.mtimeMs &&
          s.ctimeMs === after.ctimeMs,'RELEASE_FILE_CHANGED_DURING_READ');
        hash.update(JSON.stringify([relative,s.mode & 0o111,bytes.length,sha256(bytes)]));
      }
    }
  };
  requireRelease(!fs.lstatSync(root).isSymbolicLink(),'RELEASE_EXTERNAL_OR_SOURCE_LINK');
  walk(root,''); return hash.digest('hex');
}

function object(v: unknown): v is Record<string, any> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function manifestHintsNext(root: string, manifest: Record<string, any>): boolean {
  if (['next.config.js','next.config.mjs','next.config.ts'].some(p => fs.existsSync(path.join(root,p)))) return true;
  if (object(manifest.scripts) && Object.values(manifest.scripts).some(v => typeof v === 'string' && /(?:^|[\s/])next\s+(?:build|dev|start)(?:$|\s)/.test(v))) return true;
  return ['dependencies','devDependencies','optionalDependencies','peerDependencies'].some(field =>
    object(manifest[field]) && Object.entries(manifest[field]).some(([name,value]) =>
      name === 'next' || (typeof value === 'string' && value.startsWith('npm:next@'))));
}

const stableVersionPattern = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
function stableVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || value.trim() !== value || !new RegExp(`^${stableVersionPattern}$`).test(value)) return null;
  const parts=value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
/** Deliberately bounded stable grammar: exact/^/~ and comparator sets joined by
 * whitespace (AND) or || (OR). Parse EVERY branch before evaluating the union;
 * a valid matching branch cannot hide unsupported syntax elsewhere. */
function nextRangeMatches(range: string, actual: number[]): boolean | null {
  if (range.length > 1024) return null;
  const atom=String.raw`(?:\^|~|>=|<=|>|<|=)?\s*${stableVersionPattern}`;
  const groups=range.split('||').map(group => {
    const clause=group.trim();
    if (!new RegExp(`^${atom}(?:\\s+${atom})*$`).test(clause)) return null;
    const matches=[...clause.matchAll(new RegExp(String.raw`(\^|~|>=|<=|>|<|=)?\s*(${stableVersionPattern})`,'g'))].map(token => {
      const target=stableVersion(token[2]);
      if (!target) return null;
      const index=actual.findIndex((value,i) => value !== target[i]);
      const cmp=index < 0 ? 0 : Math.sign(actual[index]-target[index]);
      switch (token[1] ?? '=') {
        case '^':
          if (target[0] > 0) return cmp >= 0 && actual[0] === target[0];
          if (target[1] > 0) return cmp >= 0 && actual[0] === 0 && actual[1] === target[1];
          return cmp === 0;
        case '~': return cmp >= 0 && actual[0] === target[0] && actual[1] === target[1];
        case '>=': return cmp >= 0; case '<=': return cmp <= 0;
        case '>': return cmp > 0; case '<': return cmp < 0;
        default: return cmp === 0;
      }
    });
    return matches.includes(null) ? null : matches.every(Boolean);
  });
  return groups.includes(null) ? null : groups.some(Boolean);
}

export interface ReleaseSource {
  root: string; headSha: string; branch: string; sourceSha256: string; manifestSha256: string;
  lockfileSha256: string; stack: 'next'|'other'; nextVersion: string | null; treeClean: boolean;
}
/** No source execution. Both declarations and the resolved npm package must agree. */
export function inspectReleaseManifests(root: string): Pick<ReleaseSource,'manifestSha256'|'lockfileSha256'|'stack'|'nextVersion'> {
  for (const name of ['package.json','package-lock.json']) {
    const stat=fs.lstatSync(path.join(root,name));
    requireRelease(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,'RELEASE_MANIFEST_UNTRUSTED');
  }
  const manifestText = fs.readFileSync(path.join(root,'package.json'),'utf8');
  const lockfileText = fs.readFileSync(path.join(root,'package-lock.json'),'utf8');
  const manifest = JSON.parse(manifestText.replace(/^\uFEFF/,'')), lock = JSON.parse(lockfileText.replace(/^\uFEFF/,''));
  requireRelease(object(manifest) && object(lock) && [2,3].includes(lock.lockfileVersion) &&
    object(lock.packages) && object(lock.packages['']) && !manifest.workspaces && !lock.packages[''].workspaces,
    'RELEASE_STACK_AMBIGUOUS');
  requireRelease(!['pnpm-lock.yaml','yarn.lock','npm-shrinkwrap.json','bun.lock','bun.lockb'].some(p => fs.existsSync(path.join(root,p))),
    'RELEASE_STACK_AMBIGUOUS');
  const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies'];
  const declarations: string[] = [];
  for (const field of fields) {
    const a = manifest[field], b = lock.packages[''][field];
    requireRelease((a === undefined || object(a)) && (b === undefined || object(b)),'RELEASE_STACK_AMBIGUOUS');
    requireRelease(a?.next === b?.next,'RELEASE_MANIFEST_LOCK_MISMATCH');
    if (a?.next !== undefined) { requireRelease(typeof a.next === 'string','RELEASE_STACK_AMBIGUOUS'); declarations.push(a.next); }
  }
  const entries = Object.entries(lock.packages).filter(([p]) => /(^|\/)node_modules\/next$/.test(p));
  const pkg = lock.packages['node_modules/next'];
  const hashes={manifestSha256:sha256(manifestText),lockfileSha256:sha256(lockfileText)};
  if (!declarations.length && !entries.length) {
    requireRelease(!manifestHintsNext(root,manifest),'RELEASE_STACK_AMBIGUOUS');
    return {...hashes,stack:'other',nextVersion:null};
  }
  requireRelease(declarations.length > 0 && new Set(declarations).size === 1 && entries.length === 1 &&
    object(pkg) && !pkg.link,'RELEASE_STACK_AMBIGUOUS');
  const version=stableVersion(pkg.version);
  requireRelease(version,'RELEASE_NEXT_VERSION_INVALID');
  const matches=nextRangeMatches(declarations[0],version!);
  requireRelease(matches !== null,'RELEASE_NEXT_RANGE_UNSUPPORTED');
  requireRelease(matches,'RELEASE_NEXT_RANGE_MISMATCH');
  return {...hashes,stack:'next',nextVersion:pkg.version};
}

/** Existing local Next projects cannot silently use the legacy observation-only path.
 * Absent roots remain usable for offline historical/non-Next observation validation;
 * an authenticated release declaration always requires a live registered root. */
export function requireLocalNextHost(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  if (!['package.json','package-lock.json','next.config.js','next.config.mjs','next.config.ts'].some(p => fs.existsSync(path.join(root,p)))) return [];
  try {
    const manifestPath=path.join(root,'package.json');
    const stat=fs.lstatSync(manifestPath);
    requireRelease(stat.isFile() && !stat.isSymbolicLink(),'RELEASE_MANIFEST_UNTRUSTED');
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,''));
    requireRelease(object(manifest),'RELEASE_STACK_AMBIGUOUS');
    let hints=manifestHintsNext(root,manifest);
    const lockPath=path.join(root,'package-lock.json');
    if (fs.existsSync(lockPath)) {
      requireRelease(fs.lstatSync(lockPath).isFile() && !fs.lstatSync(lockPath).isSymbolicLink(),'RELEASE_MANIFEST_UNTRUSTED');
      const lock=JSON.parse(fs.readFileSync(lockPath,'utf8').replace(/^\uFEFF/,''));
      requireRelease(object(lock),'RELEASE_STACK_AMBIGUOUS');
      hints ||= !!lock.dependencies?.next || (object(lock.packages) && Object.entries(lock.packages).some(([p,v]) =>
        /(^|\/)node_modules\/next$/.test(p) || (object(v) && v.name === 'next')));
    }
    // Non-Next legacy projects do not acquire an npm-only prerequisite.
    if (!hints) return [];
    const detected=inspectReleaseManifests(root);
    return detected.stack === 'next' ? ['NEXT_HOST_CONTEXT_REQUIRED'] : ['RELEASE_STACK_AMBIGUOUS'];
  } catch (error) {
    // Retain actionable range diagnostics in the automatic/legacy host path too.
    if (error instanceof Error && ['RELEASE_NEXT_RANGE_UNSUPPORTED','RELEASE_NEXT_RANGE_MISMATCH','RELEASE_NEXT_VERSION_INVALID'].includes(error.message))
      return [error.message];
    return ['RELEASE_STACK_AMBIGUOUS'];
  }
}

/** Supported trust boundary: standalone npm v2/v3 projects. Ambiguity blocks. */
export function inspectReleaseSource(input: string): ReleaseSource {
  requireRelease(path.isAbsolute(input),'RELEASE_ROOT_INVALID');
  const root=fs.realpathSync(input);
  requireRelease(root === path.resolve(input) && gitRead(root,'rev-parse','--show-toplevel') === root,'RELEASE_ROOT_INVALID');
  const headSha=gitRead(root,'rev-parse','HEAD'), branch=gitRead(root,'symbolic-ref','--short','HEAD');
  const sourceSha256=directoryDigest(root,'source'), manifest=inspectReleaseManifests(root);
  const treeClean=!gitRead(root,'status','--porcelain','--untracked-files=all');
  requireRelease(sourceSha256 === directoryDigest(root,'source') && headSha === gitRead(root,'rev-parse','HEAD') &&
    branch === gitRead(root,'symbolic-ref','--short','HEAD'),'RELEASE_SOURCE_CHANGED_DURING_READ');
  return {root,headSha,branch,sourceSha256,...manifest,treeClean};
}
