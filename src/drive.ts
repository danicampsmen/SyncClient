import { getAccessToken, refreshAccessToken } from './auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

// Fix C: No eliminar el token inmediatamente al recibir 401.
// En su lugar, intentar renovar el token una vez antes de declarar la sesión expirada.
let isRefreshing = false;

const handleResponse = async (res: Response, retryFactory?: (token: string) => Promise<Response>): Promise<Response> => {
  if (!res.ok) {
    if (res.status === 401) {
      // Fix C: Intentar renovar el token una vez antes de fallar
      if (retryFactory && !isRefreshing) {
        isRefreshing = true;
        console.log('[Drive API] 401 recibido. Intentando renovar token antes de fallar...');
        const refreshed = await refreshAccessToken();
        isRefreshing = false;
        if (refreshed) {
          // Fix P1: Re-obtener token fresco y pasarlo a la factory (no usar el token del closure)
          const freshToken = await getAccessToken();
          if (freshToken) {
            const retryRes = await retryFactory(freshToken);
            if (retryRes.ok) return retryRes;
            if (retryRes.status === 401) {
              // La renovación no funcionó — sesión realmente expirada
              localStorage.removeItem('gdrive_access_token');
              localStorage.removeItem('gdrive_token_expiry');
              throw new Error('Drive API error (401): Sesión de Google Drive expirada. Se requiere re-conectar tu cuenta.');
            }
            const errorText = await retryRes.text();
            throw new Error(`Drive API error (${retryRes.status}): ${errorText}`);
          }
        }
        localStorage.removeItem('gdrive_access_token');
        localStorage.removeItem('gdrive_token_expiry');
        throw new Error('Drive API error (401): Sesión de Google Drive expirada. Se requiere re-conectar tu cuenta.');
      }
      localStorage.removeItem('gdrive_access_token');
      localStorage.removeItem('gdrive_token_expiry');
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
    await handleResponse(res, doFetch);
    const data = await res.json();
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
    await handleResponse(res, doFetch);
    const data = await res.json();
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
  await handleResponse(res, doFetch);
  if (asBlob) {
    return await res.blob();
  }
  return await res.text();
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
      const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': fileBlob.type || mimeType,
          'X-Upload-Content-Length': fileBlob.size.toString(),
        },
        body: JSON.stringify(metadata),
      });

      if (initRes.status === 401 && retry) {
        console.warn('[Drive API] Token expirado en resumable init, renovando...');
        localStorage.removeItem('gdrive_access_token');
        localStorage.removeItem('gdrive_token_expiry');
        return attemptResumable(false);
      }

      if (initRes.ok) {
        const sessionUri = initRes.headers.get('Location');
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
            localStorage.removeItem('gdrive_access_token');
            localStorage.removeItem('gdrive_token_expiry');
            return attemptResumable(false);
          }
          if (putRes.ok) {
            return await putRes.json();
          }
        }
      }
      return null;
    };
    try {
      const result = await attemptResumable();
      if (result) return result;
    } catch (e: any) {
      console.warn('[Drive API] Error en sesión Resumable, usando fallback multipart:', e.message);
    }
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
  await handleResponse(res, doFetch);
  return await res.json();
};


export const deleteFile = async (fileId: string): Promise<void> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const doFetch = (t: string) => fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${t}` },
  });

  const res = await doFetch(token);
  await handleResponse(res, doFetch);
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
  await handleResponse(res, doFetch);
  return await res.json();
};