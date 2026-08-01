import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { RcloneRunner } from './rcloneRunner';
import { RclonePairConfig } from '../shared/rcloneConfig';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function config(lockDirectory: string): RclonePairConfig {
  return {
    pairId: 'pair-a',
    localPath: '/tmp/local',
    remotePath: 'drive:remote',
    operation: 'bisync',
    configPath: path.join(lockDirectory, 'rclone.conf'),
    lockDirectory,
    dryRun: true,
    confirmDestructive: false,
  };
}

describe('RcloneRunner', () => {
  it('spawns without a shell, passes dry-run, and releases the pair lock', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-rclone-'));
    temporaryDirectories.push(directory);
    const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
    const spawn = (command: string, args: readonly string[], options: { shell?: boolean }): ChildProcess => {
      calls.push({ command, args, shell: options.shell ?? true });
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    const runner = new RcloneRunner(spawn);

    await runner.run(config(directory));
    await runner.run(config(directory));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: 'rclone',
      shell: false,
      args: ['bisync', '/tmp/local', 'drive:remote', '--config', path.join(directory, 'rclone.conf'), '--dry-run'],
    });
  });

  it('releases the lock when spawning fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-rclone-'));
    temporaryDirectories.push(directory);
    let attempts = 0;
    const spawn = (_command: string, _args: readonly string[], _options: { shell?: boolean }): ChildProcess => {
      attempts += 1;
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit(attempts === 1 ? 'error' : 'close', attempts === 1 ? new Error('not found') : 0));
      return child;
    };
    const runner = new RcloneRunner(spawn);

    await expect(runner.run(config(directory))).rejects.toThrow('not found');
    await expect(runner.run(config(directory))).resolves.toMatchObject({ exitCode: 0 });
  });
});
