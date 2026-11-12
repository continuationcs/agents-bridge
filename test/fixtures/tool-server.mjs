// Tiny MCP tool server for tests: tools `echo` and `delete_thing`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake', version: '0.0.0' });
server.registerTool('echo', { description: 'echo back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `tool echo: ${text}` }],
}));
server.registerTool('delete_thing', { description: 'deletes', inputSchema: { id: z.string() } }, async ({ id }) => ({
  content: [{ type: 'text', text: `deleted ${id}` }],
}));
await server.connect(new StdioServerTransport());
