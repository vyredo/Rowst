import {
  AsyncResolver,
  WebSocketTransport,
  Logger,
  LogLevel,
  ConsoleTransport
} from '../../dist/index.js';

const logger = new Logger({
  level: LogLevel.DEBUG,
  transports: [new ConsoleTransport()],
  prefix: 'WebSocketClient'
});

async function main() {
  const socket = new WebSocket('ws://localhost:4000');
  const transport = new WebSocketTransport(socket, { logger });

  const resolver = new AsyncResolver(transport, {
    defaultTimeout: 10_000,
    maxInflight: 256,
    logger
  });

  socket.addEventListener('open', async () => {
    const response = await resolver.request<{ ok: boolean; echo: string }>({
      action: 'echo',
      payload: 'Hello from client'
    });

    logger.info('Server responded', { response });
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('WebSocket client error', error);
});