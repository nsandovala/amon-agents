import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createGuardianReadAdapter } from './read-adapter';
import { READ_TOOL_CONTRACTS, READ_TOOLS, ReadTool } from './read-contracts';

export const MCP_MAX_IN_FLIGHT = 4;
const descriptions: Record<ReadTool, string> = {
  get_runtime_status: 'Observe local Worker status, heartbeat freshness and source availability. Grants no execution authority.',
  list_recent_jobs: 'Read bounded, filtered job observations with opaque references. Does not execute jobs.',
  get_guardian_summary: 'Read bounded Guardian observations and counts. A verdict is not execution authorization.',
  get_mission_snapshot: 'Read the fixed local sb-mission/1 export, sanitized and always executionAuthorized:false.',
};

/** A transport binding only. Validation, source selection and sanitization remain in MCP-001A. */
export function createGuardianMcpServer(adapter = createGuardianReadAdapter()): Server {
  const server = new Server({name: 'amon-guardian-read', version: '1.0.0'}, {capabilities: {tools: {listChanged: false}}});
  let initialized = false;
  let active = 0;
  server.oninitialized = () => { initialized = true; };
  const requireInitialized = () => {
    if (!initialized) throw new McpError(ErrorCode.InvalidRequest, 'Initialization required.');
  };
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    requireInitialized();
    if (request.params?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, 'Pagination is not supported.');
    return {tools: READ_TOOLS.map(name => ({name, description: descriptions[name],
      inputSchema: structuredClone(READ_TOOL_CONTRACTS[name].inputSchema),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}}))};
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    requireInitialized();
    // No asynchronous tasks or execution capability is registered, even if a client asks for it.
    if (request.params.task !== undefined) throw new McpError(ErrorCode.InvalidParams, 'Tasks are not supported.');
    if (active >= MCP_MAX_IN_FLIGHT) throw new McpError(ErrorCode.InternalError, 'Read capacity reached.');
    active++;
    try {
      const result = await adapter.call(request.params.name, request.params.arguments);
      return {content: [{type: 'text' as const, text: JSON.stringify(result)}],
        structuredContent: result, isError: !result.ok};
    } catch {
      // Never forward host paths, exceptions, stack traces or source payloads into MCP errors.
      throw new McpError(ErrorCode.InternalError, 'Read failed.');
    } finally { active--; }
  });
  return server;
}
