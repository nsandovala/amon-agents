import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { READ_TOOLS } from './read-contracts';

const root=process.cwd(),entry=path.join(root,'src/guardian/mcp-stdio.ts');
const register=path.join(root,'node_modules/ts-node/register');
const dirs:string[]=[];
function directory(){const parent=path.join(root,'.execution-qa');fs.mkdirSync(parent,{recursive:true});
  const dir=fs.mkdtempSync(path.join(parent,'mcp-stdio-test-'));dirs.push(dir);return dir;}
function inventory(dir:string){return fs.readdirSync(dir,{recursive:true}).sort();}
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

describe('official SDK client against real stdio child process (empty QA sources)',()=>{
  it('initializes, lists/calls all tools, rejects extra args and closes by EOF without signals',async()=>{
    const cwd=directory(),before=inventory(cwd);
    // A hung child must be reported, never cleaned up implicitly by the SDK fallback.
    const kill=vi.spyOn(ChildProcess.prototype,'kill').mockImplementation(()=>{throw Error('Signals forbidden in this test');});
    const transport=new StdioClientTransport({command:process.execPath,args:['-r',register,entry],cwd,stderr:'pipe',
      env:{TS_NODE_PROJECT:path.join(root,'tsconfig.json')}});
    let stderr='';transport.stderr!.on('data',chunk=>{stderr+=chunk.toString();});
    const client=new Client({name:'guardian-stdio-test',version:'1.0.0'});const errors:Error[]=[];
    client.onerror=error=>{errors.push(error);};
    let pid:number|null=null;
    try {
      await client.connect(transport);pid=transport.pid;expect(pid).toBeTypeOf('number');
      expect((await client.listTools()).tools.map(t=>t.name)).toEqual([...READ_TOOLS]);
      for(const name of READ_TOOLS){
        const result=await client.callTool({name,arguments:{}},undefined,{timeout:5000});
        expect(result.structuredContent).toMatchObject({executionAuthorized:false});
        expect(result.isError).toBe(name!=='get_runtime_status');
      }
      expect(await client.callTool({name:'list_recent_jobs',arguments:{limit:101}})).toMatchObject({isError:true,
        structuredContent:{error:{code:'INVALID_ARGUMENTS'}}});
      expect(errors).toEqual([]);expect(stderr).toBe('');expect(inventory(cwd)).toEqual(before);
    } finally {await client.close();}
    expect(kill).not.toHaveBeenCalled();expect(transport.pid).toBeNull();
    if(pid)expect(()=>process.kill(pid!,0)).toThrow(); // signal 0 only checks existence; never terminates.
  },20000);
  it('keeps stdout valid JSON-RPC and stderr constant on malformed input and SDK errors',async()=>{
    const child=spawn(process.execPath,['-r',register,entry],{cwd:directory(),env:{...process.env,TS_NODE_PROJECT:path.join(root,'tsconfig.json')},stdio:'pipe'});
    const exited=once(child,'exit');let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    const messages=()=>stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const send=(v:unknown)=>child.stdin.write(JSON.stringify(v)+'\n');
    try {
      child.stdin.write('private-token-invalid-json\n');
      send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'raw-test',version:'1'}}});
      await vi.waitFor(()=>expect(messages().some(m=>m.id===1)).toBe(true),{timeout:12000});
      send({jsonrpc:'2.0',method:'notifications/initialized'});
      send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_runtime_status',arguments:null}});
      // The pinned SDK reports envelope schema parse failures as -32603 before our handler.
      // Preserve that failure code while ensuring its diagnostic text/data never reaches stdout.
      await vi.waitFor(()=>expect(messages().find(m=>m.id===2)).toEqual({jsonrpc:'2.0',id:2,error:{code:-32603,message:'Internal error.'}}));
    } finally {child.stdin.end();}
    expect(await exited).toEqual([0,null]);
    expect(messages().every(m=>m.jsonrpc==='2.0')).toBe(true);
    expect(stderr).toBe('GUARDIAN_MCP_PROTOCOL_ERROR\n');
    expect(stdout+stderr).not.toMatch(/private-token|stack|\/Users/);
  },20000);
  it('refuses CLI source overrides without writing stdout',async()=>{
    const child=spawn(process.execPath,['-r',register,entry,'--root','/private'],{cwd:root,stdio:'pipe'});
    let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});child.stdin.end();
    expect(await once(child,'exit')).toEqual([2,null]);expect(stdout).toBe('');
    expect(stderr).toBe('GUARDIAN_MCP_NO_ARGUMENTS_ALLOWED\n');
  },20000);
});
