import type { MoltbotEnv, RcloneSyncConfig } from '../types';

/**
 * Build environment variables to pass to the OpenClaw container process
 *
 * @param env - Worker environment bindings
 * @param options - Optional extra config (e.g. rclone settings)
 * @returns Environment variables record
 */
export function buildEnvVars(
  env: MoltbotEnv,
  options?: { rcloneConfig?: RcloneSyncConfig },
): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Direct provider keys (preferred)
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_MODEL) envVars.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.OPENAI_MODEL) envVars.OPENAI_MODEL = env.OPENAI_MODEL;
  if (env.OPENAI_BASE_URL) envVars.OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  if (env.OPENROUTER_API_KEY) envVars.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) envVars.OPENROUTER_MODEL = env.OPENROUTER_MODEL;

  // Cloudflare AI Gateway configuration (alternative)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) {
    envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  }
  if (env.CF_AI_GATEWAY_GATEWAY_ID) {
    envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  }

  // Legacy AI Gateway support: AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY
  // When set, these override direct keys for backward compatibility
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Legacy path routes through Anthropic base URL
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  // Map MOLTBOT_GATEWAY_TOKEN to OPENCLAW_GATEWAY_TOKEN (container expects this name)
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.OPENCLAW_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.TELEGRAM_DM_ALLOW_FROM) envVars.TELEGRAM_DM_ALLOW_FROM = env.TELEGRAM_DM_ALLOW_FROM;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.FEISHU_APP_ID) envVars.FEISHU_APP_ID = env.FEISHU_APP_ID;
  if (env.FEISHU_APP_SECRET) envVars.FEISHU_APP_SECRET = env.FEISHU_APP_SECRET;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  // R2 persistence credentials (used by rclone in start-openclaw.sh)
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;

  // Rclone sync configuration (read from R2, passed to start-openclaw.sh)
  if (options?.rcloneConfig) {
    const rc = options.rcloneConfig;
    envVars.RCLONE_ENABLED = String(rc.enabled);
    envVars.RCLONE_TRANSFERS = String(rc.transfers);
    envVars.RCLONE_CHECKERS = String(rc.checkers);
    envVars.RCLONE_BWLIMIT = rc.bwlimit;
    envVars.RCLONE_TPSLIMIT = String(rc.tpslimit);
    envVars.RCLONE_MAX_TRANSFER = rc.maxTransfer;
    envVars.RCLONE_SYNC_INTERVAL = String(rc.syncInterval);
  }

  return envVars;
}
