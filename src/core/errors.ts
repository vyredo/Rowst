import type { Message } from './types.js';

export class RowstError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = 'RowstError';
  }
}

export class TimeoutError extends RowstError {
  constructor(message = 'Request timed out', details?: unknown) {
    super(message, 'TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

export class TransportClosedError extends RowstError {
  constructor(message = 'Transport is closed', details?: unknown) {
    super(message, 'TRANSPORT_CLOSED', details);
    this.name = 'TransportClosedError';
  }
}

export class TransportError extends RowstError {
  constructor(message = 'Transport error', details?: unknown) {
    super(message, 'TRANSPORT_ERROR', details);
    this.name = 'TransportError';
  }
}

export class BackpressureError extends RowstError {
  constructor(message = 'Too many inflight requests', details?: unknown) {
    super(message, 'BACKPRESSURE', details);
    this.name = 'BackpressureError';
  }
}

export class InvalidMessageError extends RowstError {
  constructor(message = 'Invalid message received', details?: unknown) {
    super(message, 'INVALID_MESSAGE', details);
    this.name = 'InvalidMessageError';
  }
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof RowstError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: error.message,
      details: {
        name: error.name,
        stack: error.stack
      }
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unknown error occurred',
    details: error
  };
}

export function isErrorMessage(message: Message): boolean {
  return typeof message.error !== 'undefined';
}