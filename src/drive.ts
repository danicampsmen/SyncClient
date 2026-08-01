import { getAccessToken, refreshAccessToken, logout } from './auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

// R5: Exponential backoff para 429/5xx (1s → 2s → 4s → 8s → máx 32s)
const RETRY_BACKOFF_BASE_MS = 1000;
const RETRY_MAX_BACKOFF_MS = 32000;
const MAX_RETRY_ATTEMPTS = 5;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepWithRetry(res: Response, retryFactory: (token: string) => Promise<Response>, maxAttempts = MAX_RETRY_ATTEMPTS): Promise<Response> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    const delay = Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BACKOFF_BASE_MS * (2 ** attempt));
    const retryAfter = res.headers.get('Retry-After');
    const waitMs = retryAfter ? Math.min(RETRY_MAX_BACKOFF_MS, parseInt(retryAfter, 10) * 1000) : delay;
    await sleep(waitMs);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Drive API error: No access token available for retry after 429');
      return await retryFactory(token);
    } catch (err: any) {
      console.error('[Drive API] Error during 429 retry:', err?.message || err);
      attempt++;
    }
  }
  throw new Error(`Drive API error (${res.status}): Máximo número de reintentos (${maxAttempts}) alcanzado`);
}

// Fix C: No eliminar el token inmediatamente al recibir 401.
// En su lugar, intentar renovar el token una vez antes de declarar la sesión expirada.
// Promise-based mutex: múltiples 401 simultáneos comparten una sola renovación.
let refreshPromise: Promise<void> | null = null;

const handleResponse = async (res: Response, retryFactory?: (token: string) => Promise<Response>): Promise<Response> => {
  if (!res.ok) {
    // R5: Handle 429 with exponential backoff (1s → 2s → 4s → 8s → max 32s)
    if (res.status === 429) {
      console.warn('[Drive API] Rate limited (429), applying exponential backoff with Retry-After support');
      const token = await getAccessToken();
      if (!token || !retryFactory) throw new Error('Drive API error (429): Rate limited and no retry path available');
      await res.body?.cancel().catch(() => { });
      return sleepWithRetry(res, retryFactory);
    }
    if (res.status >= 500 && retryFactory) {
      console.warn(`[Drive API] Server error (${res.status}), applying exponential backoff`);
      await res.body?.cancel().catch(() => { });
      return sleepWithRetry(res, retryFactory);
    }
    if (res.status === 401) {
      // Fix C: Intentar renovar el token una vez antes de fallar
      // Promise-based mutex: si otra llamada ya está renovando, esperamos a su resultado
      if (retryFactory) {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            console.log('[Drive API] 401 recibido. Intentando renovar token antes de fallar...');
            await refreshAccessToken();
          })();
        }
        await refreshPromise;
        refreshPromise = null;
        
        const refreshed = await getAccessToken();
        if (refreshed) {
          const retryRes = await retryFactory(refreshed);
          if (retryRes.ok) return retryRes;
          if (retryRes.status === 401) {
            await logout();
            throw new Error('Drive API error (401): Sesión de Google Drive expirada. Se requiere re-conectar tu cuenta.');
          }
          const errorText = await retryRes.text();
          throw new Error(`Drive API error (${retryRes.status}): ${errorText}`);
        }
        await logout();
        throw new Error('Drive API error (401): Sesión de Google Drive expirada. Se requiere re-conectar tu cuenta.');
      }
      await logout();
      throw new Error('Drive API error (401): Sesión de Google Drive expirada. Se requiere re-conectar tu cuenta.');
    }
    const errorText = await res.text();
    throw new Error(`Drive API error (${res.status}): ${errorText}`);
  }
  return res;
};

export const listFiles = async (folderId = 'root'): Promise<DriveFile[]> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  // B3 Fix: Paginación completa con nextPageToken.
  // Con 100GB de datos, una sola página de 100 archivos es insuficiente.
  // Incluir md5Checksum y size para verificación de integridad (B8).
  const query = `'${folderId}' in parents and trashed = false`;
  let allFiles: DriveFile[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.append('q', query);
    url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink)');
    url.searchParams.append('orderBy', 'folder,name');
    url.searchParams.append('pageSize', '1000');
    if (pageToken) url.searchParams.append('pageToken', pageToken);

    const doFetch = (t: string) => fetch(url.toString(), {
      headers: { Authorization: `Bearer ${t}` },
    });

    const res = await doFetch(token);
    const verifiedRes = await handleResponse(res, doFetch);
    const data = await verifiedRes.json();
    if (data.files) allFiles.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
};

export const listFolders = async (parentFolderId = 'root'): Promise<DriveFile[]> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  // B4 Fix: Paginación completa con nextPageToken (mismo bug que listFiles).
  const query = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  let allFolders: DriveFile[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.append('q', query);
    url.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime)');
    url.searchParams.append('orderBy', 'name');
    url.searchParams.append('pageSize', '1000');
    if (pageToken) url.searchParams.append('pageToken', pageToken);

    const doFetch = (t: string) => fetch(url.toString(), {
      headers: { Authorization: `Bearer ${t}` },
    });

    const res = await doFetch(token);
    const verifiedRes = await handleResponse(res, doFetch);
    const data = await verifiedRes.json();
    if (data.files) allFolders.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFolders;
};

export const getFileContent = async (fileId: string, asBlob = false): Promise<string | Blob> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const doFetch = (t: string) => fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${t}` },
  });

  const res = await doFetch(token);
  const verifiedRes = await handleResponse(res, doFetch);
  if (asBlob) {
    return await verifiedRes.blob();
  }
  return await verifiedRes.text();
};

export const uploadFile = async (folderId: string, name: string, content: string | Blob, mimeType = 'application/octet-stream'): Promise<DriveFile> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const metadata = {
    name,
    parents: [folderId],
  };

  const fileBlob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const sizeThreshold = 5 * 1024 * 1024; // 5 MB para conmutar a Resumable Upload

  if (fileBlob.size >= sizeThreshold) {
    console.log(`[Drive API] Archivo pesado (${Math.round(fileBlob.size / 1024 / 1024)} MB). Usando protocolo Resumable Upload para protección ante cortes WiFi.`);
    // B7 Fix: Intentar resumable upload con retry para 401 (token expirado durante subida)
    const attemptResumable = async (retry = true): Promise<DriveFile | null> => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      
      const doFetch = () => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': fileBlob.type || mimeType,
          'X-Upload-Content-Length': fileBlob.size.toString(),
        },
        body: JSON.stringify(metadata),
      });

      const initRes = await doFetch();
      const verifiedInitRes = await handleResponse(initRes, doFetch);

      if (verifiedInitRes.ok) {
        const sessionUri = verifiedInitRes.headers.get('Location');
        if (sessionUri) {
          const putRes = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              'Content-Type': fileBlob.type || mimeType,
              'Content-Length': fileBlob.size.toString(),
            },
            body: fileBlob,
          });
          if (putRes.status === 401 && retry) {
            // Retry with refreshed token
            return attemptResumable(false);
          }
          if (putRes.ok) {
            return await putRes.json();
          }
          const errText = await putRes.text();
          throw new Error(`Drive API error (${putRes.status}): ${errText}`);
        }
      }
      return null;
    };
    const result = await attemptResumable();
    if (result) return result;
    throw new Error('Resumable upload failed: no response body from Drive API');
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileBlob, name);

  const doFetch = (t: string) => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}` },
    body: form,
  });

  const res = await doFetch(token);
  const verifiedRes = await handleResponse(res, doFetch);
  return await verifiedRes.json();
};


export const deleteFile = async (fileId: string): Promise<void> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const doFetch = (t: string) => fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${t}` },
  });

  const res = await doFetch(token);
  const verifiedRes = await handleResponse(res, doFetch);
  void verifiedRes; // Ensure response is verified before returning
};

export const createFolder = async (folderId: string, name: string): Promise<DriveFile> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [folderId],
  };

  const doFetch = (t: string) => fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  const res = await doFetch(token);
  const verifiedRes = await handleResponse(res, doFetch);
  return await verifiedRes.json();
};