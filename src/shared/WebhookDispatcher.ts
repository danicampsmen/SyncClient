/**
 * WebhookDispatcher - Despachador de notificaciones HTTP post-sincronización.
 * Envía eventos en formato JSON a URLs configuradas cuando finaliza o falla un ciclo.
 */

import { SyncWebhook } from './schema';

export interface WebhookPayload {
  pairId: string;
  sessionId: string;
  event: 'sync_completed' | 'sync_failed';
  summary: {
    filesUploaded: number;
    filesDownloaded: number;
    filesDeleted: number;
    filesFailed: number;
    durationMs: number;
  };
  error?: string;
  timestamp: number;
}

export class WebhookDispatcher {
  /**
   * Despacha un evento a una lista de webhooks configurados.
   */
  public static async dispatch(webhooks: SyncWebhook[], payload: WebhookPayload): Promise<void> {
    if (!webhooks || webhooks.length === 0) return;

    const activeWebhooks = webhooks.filter((w) => w.is_active === 1);

    for (const hook of activeWebhooks) {
      if (hook.event_trigger === 'success' && payload.event !== 'sync_completed') continue;
      if (hook.event_trigger === 'error' && payload.event !== 'sync_failed') continue;

      try {
        await fetch(hook.target_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'SyncClient-WebhookDispatcher/2.0',
          },
          body: JSON.stringify(payload),
        });
      } catch (err: any) {
        // Enviar evento de webhook fallido sin romper la sincronización principal
        console.warn(`[WebhookDispatcher] Error al notificar ${hook.target_url}:`, err?.message || err);
      }
    }
  }
}
