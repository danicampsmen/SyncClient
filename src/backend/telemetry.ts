import * as SentryNode from '@sentry/node';

let initialized = false;

export function initBackendTelemetry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  SentryNode.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = event.request.url.replace(/access_token=[^&]+/g, 'access_token=REDACTED');
      }
      return event;
    },
  });
  initialized = true;
}

export function captureBackendException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  SentryNode.captureException(error, context);
}

export function captureBackendMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (!initialized) return;
  SentryNode.captureMessage(message, level);
}
