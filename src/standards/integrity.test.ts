import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureIntegrity } from './integrity';
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
