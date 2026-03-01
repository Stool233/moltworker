import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncToR2, getRcloneConfig, buildRcloneFlags } from './sync';
import { DEFAULT_RCLONE_CONFIG } from '../config';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockExecResult,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';
import type { RcloneSyncConfig } from '../types';

/** Create a mock R2Bucket with optional stored rclone config */
function createMockBucket(storedConfig?: Partial<RcloneSyncConfig>) {
  return {
    get: vi.fn().mockResolvedValue(
      storedConfig
        ? { json: () => Promise.resolve(storedConfig) }
        : null,
    ),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as R2Bucket;
}

/** Create a mock env with R2 credentials and a mock bucket */
function createMockEnvWithBucket(
  storedConfig?: Partial<RcloneSyncConfig>,
  overrides: Record<string, unknown> = {},
) {
  const bucket = createMockBucket(storedConfig);
  return createMockEnvWithR2({ MOLTBOT_BUCKET: bucket as any, ...overrides });
}

describe('buildRcloneFlags', () => {
  it('builds flags from default config', () => {
    const flags = buildRcloneFlags(DEFAULT_RCLONE_CONFIG);
    expect(flags).toContain('--transfers=16');
    expect(flags).toContain('--checkers=8');
    expect(flags).not.toContain('--bwlimit');
    expect(flags).not.toContain('--tpslimit');
    expect(flags).not.toContain('--max-transfer');
    expect(flags).toContain('--fast-list');
    expect(flags).toContain('--s3-no-check-bucket');
  });

  it('omits bwlimit when set to "0"', () => {
    const config = { ...DEFAULT_RCLONE_CONFIG, bwlimit: '0' };
    const flags = buildRcloneFlags(config);
    expect(flags).not.toContain('--bwlimit');
  });

  it('omits tpslimit when set to 0', () => {
    const config = { ...DEFAULT_RCLONE_CONFIG, tpslimit: 0 };
    const flags = buildRcloneFlags(config);
    expect(flags).not.toContain('--tpslimit');
  });

  it('omits max-transfer when set to "0"', () => {
    const config = { ...DEFAULT_RCLONE_CONFIG, maxTransfer: '0' };
    const flags = buildRcloneFlags(config);
    expect(flags).not.toContain('--max-transfer');
  });
});

describe('getRcloneConfig', () => {
  it('returns defaults when no config stored in R2', async () => {
    const bucket = createMockBucket();
    const config = await getRcloneConfig(bucket);
    expect(config).toEqual(DEFAULT_RCLONE_CONFIG);
  });

  it('merges stored config with defaults', async () => {
    const bucket = createMockBucket({ transfers: 8, bwlimit: '20M' });
    const config = await getRcloneConfig(bucket);
    expect(config.transfers).toBe(8);
    expect(config.bwlimit).toBe('20M');
    expect(config.checkers).toBe(DEFAULT_RCLONE_CONFIG.checkers);
  });
});

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('configuration checks', () => {
    it('returns error when R2 is not configured', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('R2 storage is not configured');
    });
  });

  describe('disabled sync', () => {
    it('skips sync when disabled and not forced', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValueOnce(createMockExecResult('yes')); // rclone configured

      const env = createMockEnvWithBucket({ enabled: false });
      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.details).toBe('Sync is disabled');
      // Should not have called detectConfigDir (only 1 exec call for rclone check)
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('runs sync when disabled but force=true', async () => {
      const timestamp = '2026-01-27T12:00:00+00:00';
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
        .mockResolvedValueOnce(createMockExecResult('openclaw')) // config detect
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync config
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync workspace
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync skills
        .mockResolvedValueOnce(createMockExecResult()) // date > last-sync
        .mockResolvedValueOnce(createMockExecResult(timestamp)); // cat last-sync

      const env = createMockEnvWithBucket({ enabled: false });
      const result = await syncToR2(sandbox, env, { force: true });

      expect(result.success).toBe(true);
      expect(result.lastSync).toBe(timestamp);
    });
  });

  describe('config detection', () => {
    it('returns error when no config file found', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
        .mockResolvedValueOnce(createMockExecResult('none')); // no config dir

      const env = createMockEnvWithBucket();
      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: no config file found');
    });
  });

  describe('sync execution', () => {
    it('returns success with timestamp after sync', async () => {
      const timestamp = '2026-01-27T12:00:00+00:00';
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
        .mockResolvedValueOnce(createMockExecResult('openclaw')) // config detect
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync config
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync workspace
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync skills
        .mockResolvedValueOnce(createMockExecResult()) // date > last-sync
        .mockResolvedValueOnce(createMockExecResult(timestamp)); // cat last-sync

      const env = createMockEnvWithBucket();
      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBe(timestamp);
    });

    it('falls back to legacy clawdbot config directory', async () => {
      const timestamp = '2026-01-27T12:00:00+00:00';
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
        .mockResolvedValueOnce(createMockExecResult('clawdbot')) // legacy config
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync config
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync workspace
        .mockResolvedValueOnce(createMockExecResult()) // rclone sync skills
        .mockResolvedValueOnce(createMockExecResult()) // date > last-sync
        .mockResolvedValueOnce(createMockExecResult(timestamp)); // cat last-sync

      const env = createMockEnvWithBucket();
      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);

      // Config sync command should reference .clawdbot
      const configSyncCall = execMock.mock.calls[2][0];
      expect(configSyncCall).toContain('/root/.clawdbot/');
    });

    it('returns error when config sync fails', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
        .mockResolvedValueOnce(createMockExecResult('openclaw')) // config detect
        .mockResolvedValueOnce(
          createMockExecResult('', { exitCode: 1, success: false, stderr: 'rclone error' }),
        );

      const env = createMockEnvWithBucket();
      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Config sync failed');
    });

    it('uses rclone sync (not copy) to propagate deletions', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes'))
        .mockResolvedValueOnce(createMockExecResult('openclaw'))
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult('2026-01-27'));

      const env = createMockEnvWithBucket();
      await syncToR2(sandbox, env);

      const configCmd = execMock.mock.calls[2][0];
      expect(configCmd).toMatch(/^rclone sync /);
    });

    it('rclone commands use dynamic flags from config', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes'))
        .mockResolvedValueOnce(createMockExecResult('openclaw'))
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult('2026-01-27'));

      // Default config uses transfers=16
      const env = createMockEnvWithBucket();
      await syncToR2(sandbox, env);

      const configCmd = execMock.mock.calls[2][0];
      expect(configCmd).toContain('--transfers=16');
      expect(configCmd).toContain("--exclude='.git/**'");
      expect(configCmd).toContain('/root/.openclaw/');
      expect(configCmd).toContain('r2:moltbot-data/openclaw/');
    });

    it('uses custom bucket name', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock
        .mockResolvedValueOnce(createMockExecResult('yes'))
        .mockResolvedValueOnce(createMockExecResult('openclaw'))
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult())
        .mockResolvedValueOnce(createMockExecResult('2026-01-27'));

      const env = createMockEnvWithBucket(undefined, { R2_BUCKET_NAME: 'my-custom-bucket' });
      await syncToR2(sandbox, env);

      const configCmd = execMock.mock.calls[2][0];
      expect(configCmd).toContain('r2:my-custom-bucket/openclaw/');
    });
  });
});
