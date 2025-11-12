import {
  WebSocketTransport,
  LogLevel,
  Logger,
  ConsoleTransport,
  type Message
} from '../../dist/index.js';
import { WebSocketServer, type WebSocket } from 'ws';

const logger = new Logger({
  level: LogLevel.INFO,
  transports: [new ConsoleTransport()],
  prefix: 'WebSocketServer'
});

const wss = new WebSocketServer({ port: 4000 });

wss.on('listening', () => {
  logger.info('WebSocket server listening on ws://localhost:4000');
});

wss.on('connection', (socket: WebSocket) => {
  logger.info('Client connected', { readyState: socket.readyState });

  const transport = new WebSocketTransport(socket, { logger });

  transport.on('close', () => {
    logger.info('Client disconnected');
  });

  transport.on('error', (error) => {
    logger.error('Transport error', { error: error.message });
  });

  transport.on('message', (raw) => {
    try {
      const parsed = JSON.parse(
        typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
      ) as Message<{ action?: string; payload?: unknown }>;

      if (parsed.type !== 'request') {
        logger.warn('Ignoring non-request message', { type: parsed.type });
        return;
      }

      if (parsed.payload?.action === 'echo') {
        const response: Message<{ ok: boolean; echo: unknown }> = {
          id: parsed.id,
          type: 'response',
          payload: {
            ok: true,
            echo: parsed.payload.payload
          },
          timestamp: new Date().toISOString()
        };
        socket.send(JSON.stringify(response));
        logger.info('Echoed payload to client');
        return;
      }

      logger.warn('Unknown action', { action: parsed.payload?.action });
    } catch (error) {
      logger.error('Failed to process message', {
        error: error instanceof Error ? error.message : error
      });
    }
  });
});