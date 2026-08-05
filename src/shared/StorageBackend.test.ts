import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteBackend } from './StorageBackend';
import type { FileState, SyncOperation } from './schema';

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
            source_hash: null,
            updated_at: Date.now(),
        });
        backend.setConflict({
            id: 'conflict-1',
            pair_id: 'pair-1',
            rel_path: 'notes/a.pdf',
            local_hash: 'local',
            remote_hash: 'remote',
            base_hash: 'base',
            remote_id: 'remote-id-1',
            reason: 'both_modified',
            resolution: 'pending',
            created_at: Date.now(),
            updated_at: Date.now(),
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

    it('keeps pending journal entries available for startup reconciliation', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-storage-'));
        temporaryDirectories.push(directory);
        const first = new SQLiteBackend(directory);
        await first.init();
        const journalId = first.journalStart('pair-1', 'upload_start', 'notes/pending.pdf');
        expect(first.getPendingJournalEntries('pair-1')).toHaveLength(1);

        const restarted = new SQLiteBackend(directory);
        await restarted.init();

        expect(restarted.getPendingJournalEntries('pair-1')[0]?.id).toBe(journalId);
    });

    it('commits file state, journal, and operation completion together', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-storage-'));
        temporaryDirectories.push(directory);
        const backend = new SQLiteBackend(directory);
        await backend.init();
        backend.createOperation(operation('running'));
        const journalId = backend.journalStart('pair-1', 'upload_start', 'notes/a.pdf');
        const state: FileState = {
            pair_id: 'pair-1',
            rel_path: 'notes/a.pdf',
            remote_id: 'remote-1',
            local_mtime: Date.now(),
            remote_mtime: Date.now(),
            file_size: 3,
            md5_hash: 'hash',
            block_hashes: null,
            vector_clock: '{}',
            device_id: 'device-1',
            etag: null,
            updated_at: Date.now(),
            is_tombstone: 0,
        };

        backend.commitTransfer('pair-1', new Map([[state.rel_path, state]]), [journalId], ['operation-1']);

        expect(backend.getFileState('pair-1', state.rel_path)?.remote_id).toBe('remote-1');
        expect(backend.getPendingJournalEntries('pair-1')).toHaveLength(0);
        expect(backend.getRecoverableOperations('pair-1')).toHaveLength(0);
    });

    it('cascades rename and delete operations across nested folder structures', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-storage-'));
        temporaryDirectories.push(directory);
        const backend = new SQLiteBackend(directory);
        await backend.init();

        const folderState: FileState = {
            pair_id: 'pair-1', rel_path: 'FolderA', remote_id: 'remote-folder-1',
            local_mtime: Date.now(), remote_mtime: Date.now(), file_size: null, md5_hash: null,
            block_hashes: null, vector_clock: '{}', device_id: 'device-1', etag: null, updated_at: Date.now(), is_tombstone: 0
        };
        const childState: FileState = {
            pair_id: 'pair-1', rel_path: 'FolderA/SubFolderB/file.txt', remote_id: 'remote-file-1',
            local_mtime: Date.now(), remote_mtime: Date.now(), file_size: 100, md5_hash: 'hash-1',
            block_hashes: null, vector_clock: '{}', device_id: 'device-1', etag: null, updated_at: Date.now(), is_tombstone: 0
        };

        backend.setFileState('pair-1', 'FolderA', folderState);
        backend.setFileState('pair-1', 'FolderA/SubFolderB/file.txt', childState);

        // Test rename cascade
        backend.renameFolderStateCascade('pair-1', 'FolderA', 'FolderRenamed');
        expect(backend.getFileState('pair-1', 'FolderA')).toBeNull();
        expect(backend.getFileState('pair-1', 'FolderRenamed')?.remote_id).toBe('remote-folder-1');
        expect(backend.getFileState('pair-1', 'FolderRenamed/SubFolderB/file.txt')?.remote_id).toBe('remote-file-1');

        // Test delete cascade
        backend.deleteFolderStateCascade('pair-1', 'FolderRenamed');
        expect(backend.getFileState('pair-1', 'FolderRenamed')?.is_tombstone).toBe(1);
        expect(backend.getFileState('pair-1', 'FolderRenamed/SubFolderB/file.txt')?.is_tombstone).toBe(1);
    });
});
