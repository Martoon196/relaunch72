/**
 * Stateless Model Context Protocol server over Streamable HTTP (JSON-RPC 2.0 by
 * POST, JSON replies, no sessions, no server-initiated streams). Only the tools
 * capability is exposed. Hand-written rather than a dependency, like the studio's
 * WebSocket endpoint, so the supply-chain gate stays unchanged.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolHost {
  listTools(): readonly McpToolDefinition[];
  /** Resolves with the result object; throws an Error whose message is safe to show. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpReply { readonly status: number; readonly body: unknown }

interface JsonRpcRequest { jsonrpc: '2.0'; id?: unknown; method: string; params?: unknown }

function isRequest(value: unknown): value is JsonRpcRequest {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as JsonRpcRequest).jsonrpc === '2.0' && typeof (value as JsonRpcRequest).method === 'string';
}

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export class McpServer {
  constructor(private readonly host: McpToolHost, private readonly serverInfo: { name: string; version: string }) {}

  /** `parsed` is the decoded request body (object or array); returns the HTTP reply. */
  async handle(parsed: unknown): Promise<McpReply> {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0 || parsed.length > 20) return { status: 400, body: error(null, -32600, 'Invalid request') };
      const replies = (await Promise.all(parsed.map((item) => this.one(item)))).filter((r) => r !== null);
      return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
    }
    if (!isRequest(parsed)) return { status: 400, body: error(null, -32600, 'Invalid request') };
    const reply = await this.one(parsed);
    return reply === null ? { status: 202, body: null } : { status: 200, body: reply };
  }

  private async one(item: unknown): Promise<Record<string, unknown> | null> {
    if (!isRequest(item)) return error(null, -32600, 'Invalid request');
    const { id, method } = item;
    const params = item.params && typeof item.params === 'object' && !Array.isArray(item.params) ? item.params as Record<string, unknown> : {};
    if (method.startsWith('notifications/')) return null;
    if (id === undefined) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return ok({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: this.serverInfo });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.host.listTools() });
      case 'tools/call': {
        const name = params.name;
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
        if (typeof name !== 'string' || !this.host.listTools().some((t) => t.name === name)) return error(id, -32602, 'Unknown tool');
        try {
          const result = await this.host.callTool(name, args);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : 'The tool failed.' }], isError: true });
        }
      }
      default:
        return error(id, -32601, 'Method not found');
    }
  }
}
