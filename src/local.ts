import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { backendFetch } from './services/backendSession';

export interface LocalFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export const listLocalFiles = async (path: string): Promise<LocalFile[]> => {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await Filesystem.readdir({ path, directory: Directory.Documents });
      return res.files.map(f => ({
        id: f.uri,
        name: f.name,
        mimeType: f.type === 'directory' ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
        modifiedTime: new Date(f.mtime || Date.now()).toISOString()
      }));
    } catch (e) {
      return [];
    }
  }

  const res = await backendFetch(`/api/local/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.files;
};

export const getLocalFileContent = async (path: string, asBase64 = false): Promise<string> => {
  if (Capacitor.isNativePlatform()) {
    const res = await Filesystem.readFile({ path, directory: Directory.Documents, encoding: asBase64 ? undefined : Encoding.UTF8 });
    return res.data as string;
  }

  const res = await backendFetch(`/api/local/content?path=${encodeURIComponent(path)}${asBase64 ? '&base64=true' : ''}`);
  if (!res.ok) throw new Error(await res.text());
  if (asBase64) {
    const data = await res.json();
    return data.content;
  }
  return await res.text();
};

export const writeLocalFileContent = async (path: string, content: string, isBase64 = false): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({ path, data: content, directory: Directory.Documents, encoding: isBase64 ? undefined : Encoding.UTF8 });
    return;
  }

  const res = await backendFetch(`/api/local/content?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, base64: isBase64 })
  });
  if (!res.ok) throw new Error(await res.text());
};

export const createLocalDir = async (path: string): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    await Filesystem.mkdir({ path, directory: Directory.Documents, recursive: true });
    return;
  }

  const res = await backendFetch(`/api/local/dir?path=${encodeURIComponent(path)}`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error(await res.text());
};

export const deleteLocalFile = async (path: string): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    try {
      // Intenta eliminar como directorio, si falla intenta como archivo
      await Filesystem.rmdir({ path, directory: Directory.Documents, recursive: true });
    } catch {
      await Filesystem.deleteFile({ path, directory: Directory.Documents });
    }
    return;
  }

  const res = await backendFetch(`/api/local/files?path=${encodeURIComponent(path)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(await res.text());
};
