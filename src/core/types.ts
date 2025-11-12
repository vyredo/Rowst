import type { Logger } from './logger.js';

export type MessageType = 'request' | 'response' | 'notification';

export interface Message<TPayload = unknown> {
  id: string;
  type: MessageType;
  payload: TPayload;
  timestamp?: string;
  meta?: {
    attempts?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  latency?: number;
}

export enum ErrorCode {
  TIMEOUT = 'TIMEOUT',
  TRANSPORT_CLOSED = 'TRANSPORT_CLOSED',
  TRANSPORT_ERROR = 'TRANSPORT_ERROR',
  BACKPRESSURE = 'BACKPRESSURE',
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  SEND_FAILED = 'SEND_FAILED'
}

export interface CorrelatorOptions {
  defaultTimeout?: number;
  maxInflight?: number;
  logger?: Logger;
}

export interface RequestOptions {
  timeout?: number;
  retries?: number;
  tags?: string[];
  jitterFactor?: number;
  backoffMultiplier?: number;
  [key: string]: unknown;
}

export interface Metrics {
  inflightCount: number;
  totalRequests: number;
  totalResponses: number;
  totalTimeouts: number;
  totalErrors: number;
  latencies: number[];
}

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p50: number;
  p95: number;
  p99: number;
}