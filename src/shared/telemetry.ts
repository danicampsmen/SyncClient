let sentryInitialized = false;

export function initFrontendTelemetry(): void {
  if (sentryInitialized) return;
  if (typeof window === 'undefined') return;
  const dsn = (import.meta as any).env?.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  import('@sentry/capacitor').then(({ init }) => {
    init({
      dsn,
      environment: import.meta.env?.MODE || 'production',
      tracesSampleRate: 0.1,
      beforeSend(event) {
        if (event.request?.url) {
          event.request.url = event.request.url.replace(/access_token=[^&]+/g, 'access_token=REDACTED');
        }
        return event;
      },
    });
    sentryInitialized = true;
  }).catch(() => { /* ignore */ });
}

export function captureFrontendException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryInitialized) return;
  import('@sentry/capacitor').then(({ captureException }) => {
    captureException(error, context);
  }).catch(() => {});
}

export function captureFrontendMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (!sentryInitialized) return;
  import('@sentry/capacitor').then(({ captureMessage }) => {
    captureMessage(message, level);
  }).catch(() => {});
}
