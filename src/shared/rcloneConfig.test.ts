import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RclonePairConfig, validateRcloneConfigPath, validateRcloneLockDirectory, validateRclonePairConfig } from './rcloneConfig';

const base: RclonePairConfig = {
  pairId: 'ubuntu-pair',
  localPath: '/tmp/sync',
  remotePath: 'drive:SyncClient',
  operation: 'bisync',
  configPath: '/home/user/.config/rclone/rclone.conf',
  lockDirectory: '/tmp/syncclient-locks',
  dryRun: true,
  confirmDestructive: false,
};

describe('validateRclonePairConfig', () => {
  it('requires absolute local and lock paths', () => {
    expect(() => validateRclonePairConfig({ ...base, localPath: 'relative' })).toThrow(/localPath/);
    expect(() => validateRclonePairConfig({ ...base, lockDirectory: 'relative' })).toThrow(/lockDirectory/);
  });

  it('requires dry-run or explicit confirmation for destructive operations', () => {
    expect(() => validateRclonePairConfig({ ...base, dryRun: false })).toThrow(/dry-run/);
    expect(() => validateRclonePairConfig({ ...base, dryRun: false, confirmDestructive: true })).not.toThrow();
  });

  it('rejects malformed remote paths and pair ids', () => {
    expect(() => validateRclonePairConfig({ ...base, remotePath: '/not-a-remote' })).toThrow(/remotePath/);
    expect(() => validateRclonePairConfig({ ...base, pairId: '../unsafe' })).toThrow(/pairId/);
  });
});

describe('validateRcloneConfigPath', () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('rejects an existing config readable by group or other users', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'rclone.conf');
    await writeFile(configPath, '[drive]\n', { mode: 0o644 });
    await expect(validateRcloneConfigPath(configPath)).rejects.toThrow(/private regular file/);
    await chmod(configPath, 0o600);
    await expect(validateRcloneConfigPath(configPath)).resolves.toBeUndefined();
  });

  it('requires a private lock directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-lock-config-'));
    temporaryDirectories.push(directory);
    await expect(validateRcloneLockDirectory(directory)).resolves.toBeUndefined();
    await chmod(directory, 0o755);
    await expect(validateRcloneLockDirectory(directory)).rejects.toThrow(/private directory/);
  });
});
