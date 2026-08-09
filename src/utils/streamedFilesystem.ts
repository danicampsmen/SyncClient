import { registerPlugin } from '@capacitor/core';

export interface StreamedFilesystemPlugin {
  readChunk(options: { path: string; offset: number; length: number }): Promise<{ data: string; bytesRead: number }>;
}

export const StreamedFilesystem = registerPlugin<StreamedFilesystemPlugin>('StreamedFilesystem');
