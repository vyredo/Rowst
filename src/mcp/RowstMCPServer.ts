import { AsyncResolver } from '../core/AsyncResolver.js';
import type { Message } from '../core/types.js';
import type { Transport } from '../transports/Transport.js';

export interface MCPRequestParams {
  transportId: string;
  payload: unknown;
  options?: Record<string, unknown>;
}

export class RowstMCPServer {
  private readonly resolvers = new Map<string, AsyncResolver>();

  registerTransport(id: string, transport: Transport, options?: Record<string, unknown>): void {
    if (this.resolvers.has(id)) {
      throw new Error(`Transport ${id} already registered`);
    }
    const resolver = new AsyncResolver(transport, options);
    this.resolvers.set(id, resolver);
  }

  unregisterTransport(id: string): void {
    const resolver = this.resolvers.get(id);
    if (!resolver) {
      return;
    }
    resolver.destroy();
    this.resolvers.delete(id);
  }

  async handleRequest(params: MCPRequestParams): Promise<Message> {
    const resolver = this.resolvers.get(params.transportId);
    if (!resolver) {
      throw new Error(`Transport ${params.transportId} not found`);
    }

    return await resolver.request(params.payload, params.options);
  }

  getMetrics(transportId: string): ReturnType<AsyncResolver['getMetrics']> {
    const resolver = this.resolvers.get(transportId);
    if (!resolver) {
      throw new Error(`Transport ${transportId} not found`);
    }

    return resolver.getMetrics();
  }

  getMCPConfig(): Record<string, unknown> {
    return {
      name: 'rowst',
      version: '0.1.0',
      tools: [
        {
          name: 'rowst.request',
          description: 'Send a request over a Rowst transport',
          inputSchema: {
            type: 'object',
            properties: {
              transportId: { type: 'string' },
              payload: { type: 'object' },
              options: { type: 'object' }
            },
            required: ['transportId', 'payload']
          }
        },
        {
          name: 'rowst.metrics',
          description: 'Get metrics for a Rowst transport',
          inputSchema: {
            type: 'object',
            properties: {
              transportId: { type: 'string' }
            },
            required: ['transportId']
          }
        }
      ]
    };
  }
}