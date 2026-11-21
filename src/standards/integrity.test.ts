import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertInventoryNames, captureIntegrity, inventoryLimits, inventorySource } from './integrity';
import { performance } from 'node:perf_hooks';
import { gitBlobSha1 } from '../guardian/release-source';
const roots:string[]=[];
function fixture() {const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'prepr-integrity-')));roots.push(root);return root;}
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
describe('preservation integrity capture',()=>{
  it('classifies regular files, directories and Claude/OpenCode directory links without following links',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'canonical'));fs.writeFileSync(path.join(root,'canonical/skill'),'bytes');
    fs.symlinkSync('canonical',path.join(root,'adapter'));fs.writeFileSync(path.join(root,'plain'),'hello');
    const read=vi.spyOn(fs,'readFileSync');
    const result=captureIntegrity(root,['plain','canonical','adapter']);
    expect(result.errors).toEqual([]);expect(read).toHaveBeenCalledTimes(1);
    expect(result.entries).toContainEqual(expect.objectContaining({path:'adapter',kind:'symlink',target:'canonical',linkState:'internal'}));
    expect(result.entries).toContainEqual(expect.objectContaining({path:'canonical',kind:'directory'}));
    expect(result.entries).toContainEqual(expect.objectContaining({path:'plain',kind:'file',contentBase64:Buffer.from('hello').toString('base64')}));
  });
  it('reports external, broken, cyclic and unreadable entries instead of ignoring them',()=>{
    const root=fixture();fs.symlinkSync(os.tmpdir(),path.join(root,'external'));
    fs.symlinkSync('missing',path.join(root,'broken'));fs.symlinkSync('cycle',path.join(root,'cycle'));
    const r=captureIntegrity(root,['external','broken','cycle','missing']);
    expect(r.errors).toHaveLength(4);expect(r.entries.map(e=>e.linkState)).toEqual(['broken','broken','external']);
  });
  it('does not follow any directory-link ancestor or traversal path',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'dir'));fs.writeFileSync(path.join(root,'dir/file'),'x');
    fs.symlinkSync('dir',path.join(root,'alias'));
    const read=vi.spyOn(fs,'readFileSync');
    expect(captureIntegrity(root,['alias/file','../file']).errors).toHaveLength(2);expect(read).not.toHaveBeenCalled();
  });
  it('reports read failure and closes the opened descriptor',()=>{
    const root=fixture();fs.writeFileSync(path.join(root,'file'),'x');
    const close=vi.spyOn(fs,'closeSync');vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});
    expect(captureIntegrity(root,['file']).errors).toEqual(['file: INTEGRITY_READ_EACCES']);expect(close).toHaveBeenCalledOnce();
  });
  it('hashes every file while retaining bytes only for requested review paths',()=>{
    const root=fixture();fs.writeFileSync(path.join(root,'unchanged'),'baseline');fs.writeFileSync(path.join(root,'changed'),'candidate');
    const complete=captureIntegrity(root,['unchanged','changed']),selective=captureIntegrity(root,['unchanged','changed'],new Set(['changed']));
    expect(selective.errors).toEqual([]);
    expect(selective.entries.find(e=>e.path==='changed')).toEqual(complete.entries.find(e=>e.path==='changed'));
    const {contentBase64,...identity}=complete.entries.find(e=>e.path==='unchanged')!;
    expect(selective.entries.find(e=>e.path==='unchanged')).toEqual(identity);
  });
  it('computes raw blob identities without retaining unchanged bytes and includes special mode bits',()=>{
    const root=fixture(),bytes=Buffer.from([0,255,13,10]);fs.writeFileSync(path.join(root,'raw'),bytes);fs.chmodSync(path.join(root,'raw'),0o1644);
    fs.symlinkSync('raw',path.join(root,'link'));
    const r=captureIntegrity(root,['raw','link'],new Set(),{gitBlobHashes:true});
    expect(r.errors).toEqual([]);
    expect(r.entries.find(e=>e.path==='raw')).toMatchObject({gitBlobOid:gitBlobSha1(bytes),mode:0o1644});
    expect(r.entries.find(e=>e.path==='raw')).not.toHaveProperty('contentBase64');
    expect(r.entries.find(e=>e.path==='link')).toMatchObject({gitBlobOid:gitBlobSha1(Buffer.from('raw')),kind:'symlink'});
  });
  it('distinguishes ordinary deletion from an unsafe ancestor even when the leaf is absent',()=>{
    const root=fixture();fs.symlinkSync(os.tmpdir(),path.join(root,'alias'));
    const r=captureIntegrity(root,['removed/file','alias/no-such-prepr-file'],new Set(),{allowMissing:true});
    expect(r.missing).toEqual(['removed/file']);expect(r.errors).toEqual(['alias/no-such-prepr-file: INTEGRITY_LINK_ANCESTOR']);
  });
  it('does not classify disappearance after initial lstat as an ordinary deletion',()=>{
    const root=fixture();fs.writeFileSync(path.join(root,'file'),'x');
    vi.spyOn(fs,'openSync').mockImplementation(()=>{throw Object.assign(new Error('race'),{code:'ENOENT'});});
    const r=captureIntegrity(root,['file'],new Set(),{allowMissing:true});
    expect(r.missing).toEqual([]);expect(r.errors).toEqual(['file: INTEGRITY_READ_ENOENT']);
  });

});
describe('bounded physical source inventory',()=>{
  it('enumerates metadata without following links and prunes only actual generated root directories',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist/build'),'ignored');
    fs.mkdirSync(path.join(root,'nested/dist'),{recursive:true});fs.writeFileSync(path.join(root,'nested/dist/source'),'source');
    fs.writeFileSync(path.join(root,'plain'),'source');fs.symlinkSync(os.tmpdir(),path.join(root,'outputs'));
    const read=vi.spyOn(fs,'readFileSync');const r=inventorySource(root,[]);
    expect(r.files).toEqual(['nested/dist/source','outputs','plain']);expect(read).not.toHaveBeenCalled();
  });
  it('does not prune a generated directory containing indexed source',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist/tracked'),'a');fs.writeFileSync(path.join(root,'dist/other'),'b');
    expect(inventorySource(root,['dist/tracked']).files).toEqual(['dist/other','dist/tracked']);
  });
  it('rejects case/normalization ambiguity across directory prefixes and index names',()=>{
    expect(()=>assertInventoryNames(['src/file','SRC/other'])).toThrow('PREPR_INVENTORY_CASE_COLLISION');
    expect(()=>assertInventoryNames(['caf\u00e9','cafe\u0301'])).toThrow('PREPR_INVENTORY_CASE_COLLISION');
    expect(()=>assertInventoryNames(['same/file','same/file'])).not.toThrow();
  });
  it('bounds depth and counts empty directories',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,...Array(inventoryLimits.depth+1).fill('d')),{recursive:true});
    expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_DEPTH_LIMIT');
    expect(()=>assertInventoryNames(['d/'.repeat(33)+'missing'])).toThrow('PREPR_INVENTORY_DEPTH_LIMIT');
  });
  it('bounds aggregate path metadata and rejects hardlinked files',()=>{
    expect(()=>assertInventoryNames(Array.from({length:4000},(_,i)=>String(i)+'x'.repeat(300)))).toThrow('PREPR_INVENTORY_PATH_LIMIT');
    const root=fixture();fs.writeFileSync(path.join(root,'one'),'x');fs.linkSync(path.join(root,'one'),path.join(root,'two'));
    expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_UNSAFE');
  });
  it('bounds total entries without collecting a whole directory in memory',()=>{
    const root=fixture();for(let i=0;i<=inventoryLimits.entries;i++)fs.writeFileSync(path.join(root,String(i)),'');
    vi.spyOn(performance,'now').mockReturnValue(0);const close=vi.spyOn(fs.Dir.prototype,'closeSync');
    expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_ENTRY_LIMIT');expect(close).toHaveBeenCalled();
  });
  it('closes handles on deadline and reports read failures',()=>{
    const root=fixture();fs.writeFileSync(path.join(root,'file'),'x');let calls=0;
    vi.spyOn(performance,'now').mockImplementation(()=>++calls<5?0:inventoryLimits.milliseconds+1);
    const close=vi.spyOn(fs.Dir.prototype,'closeSync');expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_TIME_LIMIT');expect(close).toHaveBeenCalled();
    vi.restoreAllMocks();vi.spyOn(fs,'opendirSync').mockImplementation(()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});
    expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_READ_FAILED');
  });
  it.each([{label:'invalid UTF-8',raw:Buffer.from([0xff])},{label:'oversized',raw:Buffer.alloc(inventoryLimits.pathBytes+1,97)}])('rejects $label raw names before accessing entries',({raw})=>{
    const root=fixture(),close=vi.fn();
    vi.spyOn(fs,'opendirSync').mockReturnValue({readSync:()=>({name:raw}),closeSync:close} as unknown as fs.Dir);
    const stat=vi.spyOn(fs,'lstatSync');expect(()=>inventorySource(root,[])).toThrow(raw.length===1?'PREPR_PATH_ENCODING_UNSUPPORTED':'PREPR_INVENTORY_PATH_LIMIT');
    expect(stat).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledOnce();
  });
  it('detects a directory changing during enumeration',()=>{
    const root=fixture(),original=fs.lstatSync.bind(fs);let calls=0;
    vi.spyOn(fs,'lstatSync').mockImplementation(((...args:Parameters<typeof fs.lstatSync>)=>{
      const stat=original(...args);if(++calls===2)Object.assign(stat,{mtimeMs:Number(stat.mtimeMs)+1});return stat;
    }) as typeof fs.lstatSync);
    expect(()=>inventorySource(root,[])).toThrow('PREPR_INVENTORY_CHANGED');
  });
});
