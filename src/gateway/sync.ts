import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv, RcloneSyncConfig } from '../types';
import { getR2BucketName, RCLONE_SETTINGS_KEY, DEFAULT_RCLONE_CONFIG } from '../config';
import { ensureRcloneConfig } from './r2';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

const LAST_SYNC_FILE = '/tmp/.last-sync';

function rcloneRemote(env: MoltbotEnv, prefix: string): string {
  return `r2:${getR2BucketName(env)}/${prefix}`;
}

/**
 * Read rclone sync config from R2, merging with defaults.
 */
export async function getRcloneConfig(bucket: R2Bucket): Promise<RcloneSyncConfig> {
  try {
    const obj = await bucket.get(RCLONE_SETTINGS_KEY);
    if (obj) {
      const stored = (await obj.json()) as Partial<RcloneSyncConfig>;
      return { ...DEFAULT_RCLONE_CONFIG, ...stored };
    }
  } catch (e) {
    console.warn('Failed to read rclone config from R2:', e);
  }
  return { ...DEFAULT_RCLONE_CONFIG };
}

/**
 * Save rclone sync config to R2.
 */
export async function saveRcloneConfig(bucket: R2Bucket, config: RcloneSyncConfig): Promise<void> {
  await bucket.put(RCLONE_SETTINGS_KEY, JSON.stringify(config));
}

/**
 * Build rclone CLI flags from config.
 */
export function buildRcloneFlags(config: RcloneSyncConfig): string {
  const flags = [
    `--transfers=${config.transfers}`,
    `--checkers=${config.checkers}`,
    '--fast-list',
    '--s3-no-check-bucket',
    '--size-only',
  ];
  if (config.bwlimit && config.bwlimit !== '0') {
    flags.push(`--bwlimit=${config.bwlimit}`);
  }
  if (config.tpslimit > 0) {
    flags.push(`--tpslimit=${config.tpslimit}`);
  }
  if (config.maxTransfer && config.maxTransfer !== '0') {
    flags.push(`--max-transfer=${config.maxTransfer}`);
  }
  return flags.join(' ');
}

/**
 * Detect which config directory exists in the container.
 */
async function detectConfigDir(sandbox: Sandbox): Promise<string | null> {
  const check = await sandbox.exec(
    'test -f /root/.openclaw/openclaw.json && echo openclaw || ' +
      '(test -f /root/.clawdbot/clawdbot.json && echo clawdbot || echo none)',
  );
  const result = check.stdout?.trim();
  if (result === 'openclaw') return '/root/.openclaw';
  if (result === 'clawdbot') return '/root/.clawdbot';
  return null;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 * Uses rclone for direct S3 API access (no FUSE mount overhead).
 *
 * When sync is disabled in config, automatic syncs are skipped unless
 * force=true (used for manual "Backup Now" and shutdown sync).
 */
export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options?: { force?: boolean },
): Promise<SyncResult> {
  if (!(await ensureRcloneConfig(sandbox, env))) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Check if sync is enabled (unless forced)
  const rcloneConfig = await getRcloneConfig(env.MOLTBOT_BUCKET);
  if (!rcloneConfig.enabled && !options?.force) {
    return { success: true, details: 'Sync is disabled' };
  }

  const configDir = await detectConfigDir(sandbox);
  if (!configDir) {
    return {
      success: false,
      error: 'Sync aborted: no config file found',
      details: 'Neither openclaw.json nor clawdbot.json found in config directory.',
    };
  }

  const remote = (prefix: string) => rcloneRemote(env, prefix);
  const flags = buildRcloneFlags(rcloneConfig);

  // Sync config (rclone sync propagates deletions)
  const configResult = await sandbox.exec(
    `rclone sync ${configDir}/ ${remote('openclaw/')} ${flags} --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**'`,
    { timeout: 120000 },
  );
  if (!configResult.success) {
    return {
      success: false,
      error: 'Config sync failed',
      details: configResult.stderr?.slice(-500),
    };
  }

  // Sync workspace (non-fatal, rclone sync propagates deletions)
  await sandbox.exec(
    `test -d /root/clawd && rclone sync /root/clawd/ ${remote('workspace/')} ${flags} --exclude='skills/**' --exclude='.git/**' || true`,
    { timeout: 120000 },
  );

  // Sync skills (non-fatal)
  await sandbox.exec(
    `test -d /root/clawd/skills && rclone sync /root/clawd/skills/ ${remote('skills/')} ${flags} || true`,
    { timeout: 120000 },
  );

  // Write timestamp
  await sandbox.exec(`date -Iseconds > ${LAST_SYNC_FILE}`);
  const tsResult = await sandbox.exec(`cat ${LAST_SYNC_FILE}`);
  const lastSync = tsResult.stdout?.trim();

  return { success: true, lastSync };
}
