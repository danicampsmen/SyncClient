/**
 * DomainErrors — Jerarquía de errores fuertemente tipada para SyncClient.
 * Permite tomar decisiones estructuradas en bloques catch (reintentos, refresco de token, pausa por seguridad).
 */

export abstract class SyncClientError extends Error {
  public abstract readonly code: string;
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationExpiredError extends SyncClientError {
  public readonly code = 'UNAUTHORIZED_EXPIRED_TOKEN';
  constructor(message = 'El token de autenticación con Google Drive ha expirado.') {
    super(message);
  }
}

export class MassDeletionDetectedError extends SyncClientError {
  public readonly code = 'MASS_DELETION_APPROVAL_REQUIRED';
  constructor(
    public readonly pairId: string,
    public readonly deletionCount: number,
    public readonly totalFiles: number,
    message = `Detección de borrado masivo para el par ${pairId} (${deletionCount}/${totalFiles}).`
  ) {
    super(message);
  }
}

export class RateLimitExceededError extends SyncClientError {
  public readonly code = 'DRIVE_RATE_LIMIT_EXCEEDED';
  constructor(public readonly retryAfterSeconds = 5, message = 'Límite de cuota de API de Google Drive alcanzado.') {
    super(message);
  }
}

export class NetworkTransientError extends SyncClientError {
  public readonly code = 'NETWORK_TRANSIENT_FAILURE';
  constructor(message = 'Fallo temporal de conexión a red.') {
    super(message);
  }
}

export class StorageCorruptionError extends SyncClientError {
  public readonly code = 'STORAGE_CORRUPTION_ERROR';
  constructor(message = 'Corrupción detectada en el almacenamiento local SQLite.') {
    super(message);
  }
}
