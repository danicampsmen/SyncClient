import { getAccessToken } from './auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

const handleResponse = async (res: Response) => {
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('gdrive_access_token');
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

  // Query: get files in the specified folder, not trashed.
  const query = `'${folderId}' in parents and trashed = false`;
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.append('q', query);
  url.searchParams.append('fields', 'files(id, name, mimeType, modifiedTime)');
  url.searchParams.append('orderBy', 'folder,name');
  url.searchParams.append('pageSize', '100');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  await handleResponse(res);
  const data = await res.json();
  return data.files || [];
};

export const listFolders = async (parentFolderId = 'root'): Promise<DriveFile[]> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const query = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.append('q', query);
  url.searchParams.append('fields', 'files(id, name, mimeType, modifiedTime)');
  url.searchParams.append('orderBy', 'name');
  url.searchParams.append('pageSize', '200');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  await handleResponse(res);
  const data = await res.json();
  return data.files || [];
};

export const getFileContent = async (fileId: string, asBlob = false): Promise<string | Blob> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  await handleResponse(res);
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
    try {
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
          if (putRes.ok) {
            return await putRes.json();
          }
        }
      }
    } catch (e: any) {
      console.warn('[Drive API] Error en sesión Resumable, usando fallback multipart:', e.message);
    }
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileBlob, name);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  await handleResponse(res);
  return await res.json();
};


export const deleteFile = async (fileId: string): Promise<void> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  await handleResponse(res);
};

export const createFolder = async (folderId: string, name: string): Promise<DriveFile> => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [folderId],
  };

  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  await handleResponse(res);
  return await res.json();
};
