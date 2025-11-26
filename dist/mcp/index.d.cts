import { M as Message, A as AsyncResolver } from '../AsyncResolver-C9T1x8hr.cjs';
import { T as Transport } from '../logger-CBj8alH5.cjs';

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
