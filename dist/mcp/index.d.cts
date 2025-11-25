import { M as Message, A as AsyncResolver } from '../AsyncResolver-BAKw2H2q.cjs';
import { T as Transport } from '../Transport-sRzkGEga.cjs';

interface MCPRequestParams {
    transportId: string;
    payload: unknown;
    options?: Record<string, unknown>;
}
declare class RowstMCPServer {
    private readonly resolvers;
    registerTransport(id: string, transport: Transport, options?: Record<string, unknown>): void;
    unregisterTransport(id: string): void;
    handleRequest(params: MCPRequestParams): Promise<Message>;
    getMetrics(transportId: string): ReturnType<AsyncResolver['getMetrics']>;
    getMCPConfig(): Record<string, unknown>;
}

export { type MCPRequestParams, RowstMCPServer };
