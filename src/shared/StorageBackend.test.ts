import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteBackend } from './StorageBackend';
import type { SyncOperation } from './schema';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function operation(status: SyncOperation['status'] = 'pending'): SyncOperation {
    return {
        id: 'operation-1',
        pair_id: 'pair-1',
        rel_path: 'notes/a.pdf',
        operation_type: 'upload',
        remote_id: null,
        status,
        attempts: 0,
        last_error: null,
        created_at: Date.now(),
        updated_at: Date.now(),
    };
}

describe('SQLiteBackend Phase 1 persistence', () => {
    it('creates migrations and persists cursors, operations, sessions, and conflicts', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-storage-'));
        temporaryDirectories.push(directory);
        const backend = new SQLiteBackend(directory);

        expect(await backend.init()).toBe(true);
        backend.setDriveCursor({
            pair_id: 'pair-1',
            account_id: 'account-1',
            corpus_id: 'user',
            drive_id: 'my-drive',
            page_token: 'token-1',
            last_success_at: Date.now(),
            status: 'active',
        });
        backend.createOperation(operation());
        await expect(backend.checkpoint()).resolves.toBeUndefined();
        await expect(access(path.join(directory, 'sync_state_v2.db.backup'))).resolves.toBeUndefined();
        backend.setUploadSession({
            operation_id: 'operation-1',
            remote_id: null,
            session_uri: 'https://upload.example/session',
            file_size: 1024,
            confirmed_offset: 0,
            chunk_size: 262144,
            updated_at: Date.now(),
        });
        backend.setConflict({
            id: 'conflict-1',
            pair_id: 'pair-1',
            rel_path: 'notes/a.pdf',
            local_hash: 'local',
            remote_hash: 'remote',
            base_hash: 'base',
            resolution: 'pending',
            created_at: Date.now(),
        });

        expect(backend.getDriveCursor({
            pair_id: 'pair-1',
            account_id: 'account-1',
            corpus_id: 'user',
            drive_id: 'my-drive',
        })?.page_token).toBe('token-1');
        expect(backend.getRecoverableOperations('pair-1')).toHaveLength(1);
        expect(backend.getUploadSession('operation-1')?.confirmed_offset).toBe(0);
        expect(backend.getPendingConflicts('pair-1')).toHaveLength(1);
    });

    it('recovers running operations as retry after restart', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-storage-'));
        temporaryDirectories.push(directory);
        const first = new SQLiteBackend(directory);
        await first.init();
        first.createOperation(operation('running'));

        const restarted = new SQLiteBackend(directory);
        await restarted.init();

        expect(restarted.getRecoverableOperations('pair-1')[0]?.status).toBe('retry');
    });
});
