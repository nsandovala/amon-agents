import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { PassThrough } from 'node:stream';
import { createGuardianReadAdapter } from './read-adapter';
import { READ_TOOL_CONTRACTS, READ_TOOLS } from './read-contracts';
import type { GuardianReadSources, OperationalRead } from './read-sources';
import { createGuardianMcpServer, MCP_MAX_IN_FLIGHT } from './mcp-server';
import { MCP_MAX_INPUT_BYTES, safeProtocolMessage, startGuardianStdio } from './mcp-stdio';

const close: (() => Promise<void>)[] = [];
const empty: OperationalRead = {available: {worker:false,jobs:false,guardian:false}, snapshot:{
  generatedAt:'2026-11-14T00:00:00.000Z',systemStatus:'ok',workers:[],jobs:[],guardianReviews:[],agents:[]}};
function sources(): GuardianReadSources {
  return {operational:vi.fn(async()=>structuredClone(empty)),mission:vi.fn(async()=>{throw Error('/private/store TOKEN=secret');})};
}
async function connected(reads=sources()) {
  const server=createGuardianMcpServer(createGuardianReadAdapter(reads));
  const client=new Client({name:'guardian-unit-client',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  close.push(()=>client.close(),()=>server.close());
  await server.connect(serverTransport);await client.connect(clientTransport);
  return {client,server,reads};
}
afterEach(async()=>{for(const fn of close.splice(0))await fn();});

describe('Guardian MCP binding (SDK in-memory protocol, not stdio acceptance)',()=>{
  it('registers only the four canonical contracts and read-only annotations',async()=>{
    const {client}=await connected();
    const result=await client.listTools();
    expect(result.tools.map(t=>t.name)).toEqual([...READ_TOOLS]);
    for(const tool of result.tools){
      expect(tool.inputSchema).toEqual(READ_TOOL_CONTRACTS[tool.name as typeof READ_TOOLS[number]].inputSchema);
      expect(tool.annotations).toEqual({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
    }
    expect(client.getServerCapabilities()).toEqual({tools:{listChanged:false}});
  });
  it.each(READ_TOOLS)('returns matching structured/text results and false authority for %s',async name=>{
    const {client}=await connected();const r=await client.callTool({name,arguments:{}});
    expect(r.structuredContent).toMatchObject({schemaVersion:'guardian-read/1',executionAuthorized:false});
    expect(r.content).toEqual([{type:'text',text:JSON.stringify(r.structuredContent)}]);
    expect(r.isError).toBe(name!=='get_runtime_status');
    expect(JSON.stringify(r)).not.toMatch(/private|TOKEN|secret/);
  });
  it.each([
    ['get_runtime_status',{path:'/private/source'}],['get_mission_snapshot',{url:'https://private.test'}],
    ['list_recent_jobs',{limit:0}],['list_recent_jobs',{limit:101}],['list_recent_jobs',{limit:'1'}],
    ['list_recent_jobs',{since:'2026-02-30T00:00:00.000Z'}],['list_recent_jobs',{status:'approved'}],
    ['get_guardian_summary',{jobRef:'private-job'}],['get_guardian_summary',{verdict:'ALLOW'}],
  ])('delegates strict argument validation before source reads: %s %j',async(name,args)=>{
    const {client,reads}=await connected();
    const result=await client.callTool({name,arguments:args});
    expect(result).toMatchObject({isError:true,structuredContent:{ok:false,executionAuthorized:false,error:{code:'INVALID_ARGUMENTS'}}});
    expect(reads.operational).not.toHaveBeenCalled();expect(reads.mission).not.toHaveBeenCalled();
  });
  it('does not expose execution tools, pagination or asynchronous tasks',async()=>{
    const {client,reads}=await connected();
    expect(await client.callTool({name:'run_job',arguments:{}})).toMatchObject({isError:true,
      structuredContent:{error:{code:'INVALID_TOOL'},executionAuthorized:false}});
    await expect(client.listTools({cursor:'private-cursor'})).rejects.toThrow();
    await expect(client.callTool({name:'get_runtime_status',arguments:{},task:{}})).rejects.toThrow();
    expect(reads.operational).not.toHaveBeenCalled();
  });
  it('requires initialization before serving tools',async()=>{
    const reads=sources(),server=createGuardianMcpServer(createGuardianReadAdapter(reads));
    const [raw,transport]=InMemoryTransport.createLinkedPair();let received:JSONRPCMessage|undefined;
    raw.onmessage=m=>{received=m;};await raw.start();await server.connect(transport);close.push(()=>server.close());
    await raw.send({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
    await vi.waitFor(()=>expect(received).toMatchObject({error:{code:-32600}}));
    expect(reads.operational).not.toHaveBeenCalled();
  });
  it('bounds concurrent reads without adding a queue and recovers after they finish',async()=>{
    let release!: (value:OperationalRead)=>void;
    const pending=new Promise<OperationalRead>(resolve=>{release=resolve;});const reads=sources();
    vi.mocked(reads.operational).mockReturnValue(pending);
    const {client}=await connected(reads);
    const calls=Array.from({length:MCP_MAX_IN_FLIGHT},()=>client.callTool({name:'get_runtime_status'}));
    await vi.waitFor(()=>expect(reads.operational).toHaveBeenCalledTimes(MCP_MAX_IN_FLIGHT));
    await expect(client.callTool({name:'get_runtime_status'})).rejects.toThrow();
    expect(reads.operational).toHaveBeenCalledTimes(MCP_MAX_IN_FLIGHT);
    release(empty);await Promise.all(calls);
    expect(await client.callTool({name:'get_runtime_status'})).toMatchObject({isError:false});
  });
  it('strips SDK exception details and data from outgoing protocol errors',()=>{
    expect(safeProtocolMessage({jsonrpc:'2.0',id:7,error:{code:-32602,message:'/private TOKEN=secret',data:{stack:'private'}}}))
      .toEqual({jsonrpc:'2.0',id:7,error:{code:-32602,message:'Invalid parameters.'}});
  });
  it('closes on oversized input with a constant diagnostic and no stdout payload',async()=>{
    const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
    let stdout='',stderr='';output.on('data',chunk=>{stdout+=chunk;});errors.on('data',chunk=>{stderr+=chunk;});
    const server=await startGuardianStdio(input,output,errors);close.push(()=>server.close());
    input.write(Buffer.alloc(MCP_MAX_INPUT_BYTES+1,'x'));
    expect(stderr).toBe('GUARDIAN_MCP_PROTOCOL_ERROR\n');expect(stdout).toBe('');
    expect(input.listenerCount('data')).toBe(0);expect(input.isPaused()).toBe(true);
    input.end();
  });
});
