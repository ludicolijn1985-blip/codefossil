import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { McpClient } from './mcp-client.js';

/** A stand-in MCP server: answers initialize, and echoes tool calls back as text. */
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: {} });
    else if (message.params.name === 'fail') reply({ content: [{ type: 'text', text: 'no' }], isError: true });
    else if (message.params.name === 'rpc-error')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'bad' } }) + '\\n');
    else reply({ content: [{ type: 'text', text: JSON.stringify(message.params) }] });
  }
});
`;

const fake = () => new McpClient(process.execPath, ['-e', FAKE_SERVER], tmpdir());

describe('MCP client', () => {
  it('opens a session and calls tools with their arguments as JSON, not command-line text', async () => {
    const client = fake();
    try {
      const path = 'src/a & b; rm -rf ~.ts';
      const result = await client.callTool('lens', { path });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ name: 'lens', arguments: { path } });
    } finally {
      client.dispose();
    }
  });

  it('reports tool errors and protocol errors', async () => {
    const client = fake();
    try {
      expect(await client.callTool('fail', {})).toEqual({ text: 'no', isError: true });
      await expect(client.callTool('rpc-error', {})).rejects.toThrow('bad');
    } finally {
      client.dispose();
    }
  });

  it('rejects calls when the server is gone', async () => {
    const client = new McpClient(process.execPath, ['-e', 'process.exit(3)'], tmpdir());
    await expect(client.callTool('lens', {})).rejects.toThrow(/exited/);
    client.dispose();
  });
});
