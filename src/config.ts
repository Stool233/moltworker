/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}

/** R2 key for rclone sync settings */
export const RCLONE_SETTINGS_KEY = '_system/rclone-settings';

/** Default rclone sync configuration */
export const DEFAULT_RCLONE_CONFIG: import('./types').RcloneSyncConfig = {
  enabled: true,
  transfers: 4,
  checkers: 4,
  bwlimit: '10M',
  tpslimit: 10,
  maxTransfer: '500M',
  syncInterval: 120,
};
