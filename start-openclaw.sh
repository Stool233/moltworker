#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=${SYNC_TRANSFERS:-16} --checkers=${SYNC_CHECKERS:-8} --fast-list --s3-no-check-bucket"
# Append optional rclone flags from SYNC_* environment variables
# (using SYNC_ prefix to avoid collision with rclone's built-in RCLONE_* env vars)
[ -n "$SYNC_BWLIMIT" ] && [ "$SYNC_BWLIMIT" != "0" ] && RCLONE_FLAGS="$RCLONE_FLAGS --bwlimit=$SYNC_BWLIMIT"
[ -n "$SYNC_TPSLIMIT" ] && [ "$SYNC_TPSLIMIT" != "0" ] && RCLONE_FLAGS="$RCLONE_FLAGS --tpslimit=$SYNC_TPSLIMIT"
[ -n "$SYNC_MAX_TRANSFER" ] && [ "$SYNC_MAX_TRANSFER" != "0" ] && RCLONE_FLAGS="$RCLONE_FLAGS --max-transfer=$SYNC_MAX_TRANSFER"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    if rclone ls "r2:${R2_BUCKET}/openclaw/openclaw.json" $RCLONE_FLAGS 2>/dev/null | grep -q openclaw.json; then
        echo "Restoring config from R2..."
        rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        echo "Restoring from legacy R2 backup..."
        rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Legacy config restored and migrated"
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Restore workspace
    REMOTE_WS_COUNT=$(rclone ls "r2:${R2_BUCKET}/workspace/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_WS_COUNT" -gt 0 ]; then
        echo "Restoring workspace from R2 ($REMOTE_WS_COUNT files)..."
        mkdir -p "$WORKSPACE_DIR"
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Restore skills
    REMOTE_SK_COUNT=$(rclone ls "r2:${R2_BUCKET}/skills/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SK_COUNT" -gt 0 ]; then
        echo "Restoring skills from R2 ($REMOTE_SK_COUNT files)..."
        mkdir -p "$SKILLS_DIR"
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: skills restore failed with exit code $?"
        echo "Skills restored"
    fi
else
    echo "R2 not configured, starting fresh"
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    # Priority: OpenRouter > OpenAI direct > Anthropic direct > Cloudflare AI Gateway
    AUTH_ARGS=""
    if [ -n "$OPENROUTER_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENROUTER_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Backup config before patching (safety net, stored in /tmp to avoid R2 sync)
try {
    if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, '/tmp/openclaw.json.pre-patch');
    }
} catch (e) {
    console.warn('Failed to create config backup:', e.message);
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// v2026.2.23: Control UI now requires allowedOrigins for non-loopback binds.
// We use containerFetch() from CF Workers so the Host header is an internal address
// and we can't predict all public origins. Security boundary is at CF Access layer.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// ── Provider Reconciliation ──
// Ensures provider config matches current env vars on every startup,
// even when R2 restores an old openclaw.json from a different provider.
// Priority: OpenAI direct > Anthropic direct > Cloudflare AI Gateway

// Anthropic model specs lookup (source: platform.claude.com/docs/en/about-claude/models/overview)
const ANTHROPIC_MODELS = {
    // Current generation
    'claude-opus-4-6':              { name: 'Claude Opus 4.6',   contextWindow: 200000, maxTokens: 131072 },
    'claude-sonnet-4-6':            { name: 'Claude Sonnet 4.6', contextWindow: 200000, maxTokens: 65536 },
    'claude-haiku-4-5-20251001':    { name: 'Claude Haiku 4.5',  contextWindow: 200000, maxTokens: 65536 },
    // Previous generation
    'claude-sonnet-4-5-20250929':   { name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 65536 },
    'claude-opus-4-5-20251101':     { name: 'Claude Opus 4.5',   contextWindow: 200000, maxTokens: 65536 },
    'claude-opus-4-1-20250805':     { name: 'Claude Opus 4.1',   contextWindow: 200000, maxTokens: 32768 },
    'claude-sonnet-4-20250514':     { name: 'Claude Sonnet 4',   contextWindow: 200000, maxTokens: 65536 },
    'claude-opus-4-20250514':       { name: 'Claude Opus 4',     contextWindow: 200000, maxTokens: 32768 },
    'claude-3-haiku-20240307':      { name: 'Claude Haiku 3',    contextWindow: 200000, maxTokens: 4096 },
};
// Support alias IDs (without date suffix)
const ANTHROPIC_ALIASES = {
    'claude-opus-4-5':   'claude-opus-4-5-20251101',
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
    'claude-opus-4-0':   'claude-opus-4-20250514',
    'claude-haiku-4-5':  'claude-haiku-4-5-20251001',
};
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// OpenAI model specs
const OPENAI_MODELS = {
    'gpt-5.3-codex': { name: 'GPT-5.3 Codex', contextWindow: 400000, maxTokens: 128000 },
};
const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex';

// OpenRouter model specs (via openrouter.ai, OpenAI-compatible API)
const OPENROUTER_MODELS = {
    'moonshotai/kimi-k2.5':     { name: 'Kimi K2.5',          contextWindow: 262144, maxTokens: 65536 },
    'moonshotai/kimi-k2':       { name: 'Kimi K2',            contextWindow: 262144, maxTokens: 65536 },
};
const DEFAULT_OPENROUTER_MODEL = 'moonshotai/kimi-k2.5';

config.models = config.models || {};
config.models.providers = config.models.providers || {};
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};

const anthropicModel = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
const resolvedId = ANTHROPIC_ALIASES[anthropicModel] || anthropicModel;
const specs = ANTHROPIC_MODELS[resolvedId] || { name: anthropicModel, contextWindow: 200000, maxTokens: 65536 };

// Recent models to register alongside primary (primary first)
const ANTHROPIC_RECENT = [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
];

let reconciledPrimary = false;

if (process.env.OPENROUTER_API_KEY) {
    // OpenRouter — highest priority, OpenAI-compatible API
    const openrouterModel = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    const openrouterSpecs = OPENROUTER_MODELS[openrouterModel] || { name: openrouterModel, contextWindow: 262144, maxTokens: 65536 };

    const openrouterModelsArray = [];
    openrouterModelsArray.push({ id: openrouterModel, name: openrouterSpecs.name, contextWindow: openrouterSpecs.contextWindow, maxTokens: openrouterSpecs.maxTokens });
    for (const [mid, s] of Object.entries(OPENROUTER_MODELS)) {
        if (mid !== openrouterModel) {
            openrouterModelsArray.push({ id: mid, name: s.name, contextWindow: s.contextWindow, maxTokens: s.maxTokens });
        }
    }

    config.models.providers['openrouter'] = {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        api: 'openai-completions',
        models: openrouterModelsArray,
    };
    config.agents.defaults.model = { primary: 'openrouter/' + openrouterModel };
    reconciledPrimary = true;
    console.log('Provider reconciled: OpenRouter, model=' + openrouterModel
        + ' (' + openrouterModelsArray.length + ' models registered'
        + ', context=' + openrouterSpecs.contextWindow + ', maxTokens=' + openrouterSpecs.maxTokens + ')');

} else if (process.env.OPENAI_API_KEY) {
    // OpenAI direct — register primary + all known models
    const openaiModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    const openaiSpecs = OPENAI_MODELS[openaiModel] || { name: openaiModel, contextWindow: 200000, maxTokens: 65536 };

    const OPENAI_RECENT = ['gpt-5.3-codex'];
    const openaiModelsArray = [];
    openaiModelsArray.push({ id: openaiModel, name: openaiSpecs.name, contextWindow: openaiSpecs.contextWindow, maxTokens: openaiSpecs.maxTokens });
    for (const mid of OPENAI_RECENT) {
        if (mid !== openaiModel && OPENAI_MODELS[mid]) {
            const s = OPENAI_MODELS[mid];
            openaiModelsArray.push({ id: mid, name: s.name, contextWindow: s.contextWindow, maxTokens: s.maxTokens });
        }
    }

    config.models.providers['openai-codex'] = {
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY,
        api: 'openai-responses',
        models: openaiModelsArray,
    };
    // Clean up stale 'openai' provider that older versions may have created
    delete config.models.providers['openai'];
    config.agents.defaults.model = { primary: 'openai-codex/' + openaiModel };
    reconciledPrimary = true;
    console.log('Provider reconciled: OpenAI Codex (API key), model=' + openaiModel
        + ' (' + openaiModelsArray.length + ' models registered'
        + ', context=' + openaiSpecs.contextWindow + ', maxTokens=' + openaiSpecs.maxTokens + ')');

} else if (process.env.ANTHROPIC_API_KEY && !process.env.AI_GATEWAY_BASE_URL) {
    // Anthropic direct — register primary + recent models
    const anthropicModelsArray = [];
    anthropicModelsArray.push({ id: anthropicModel, name: specs.name, contextWindow: specs.contextWindow, maxTokens: specs.maxTokens });
    for (const mid of ANTHROPIC_RECENT) {
        if (mid !== anthropicModel && ANTHROPIC_MODELS[mid]) {
            const s = ANTHROPIC_MODELS[mid];
            anthropicModelsArray.push({ id: mid, name: s.name, contextWindow: s.contextWindow, maxTokens: s.maxTokens });
        }
    }

    config.models.providers['anthropic'] = {
        baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        apiKey: process.env.ANTHROPIC_API_KEY,
        api: 'anthropic-messages',
        models: anthropicModelsArray,
    };
    config.agents.defaults.model = { primary: 'anthropic/' + anthropicModel };
    reconciledPrimary = true;
    console.log('Provider reconciled: Anthropic direct, model=' + anthropicModel
        + ' (' + anthropicModelsArray.length + ' models registered'
        + ', context=' + specs.contextWindow + ', maxTokens=' + specs.maxTokens + ')');
}
// Note: Cloudflare AI Gateway case is already handled by the
// CF_AI_GATEWAY_MODEL section below.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        if (!reconciledPrimary) {
            config.agents.defaults.model = { primary: providerName + '/' + modelId };
        }
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl
            + (reconciledPrimary ? ' (primary kept from reconciliation)' : ''));
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// ── Sync agents.list[].model with defaults ──
// The default agent's model.primary overrides agents.defaults.model,
// so we must keep them in sync after reconciliation.
if (config.agents.defaults.model && Array.isArray(config.agents.list)) {
    const newPrimary = config.agents.defaults.model.primary;
    // Stale provider names from older config versions
    const staleProviders = ['openai'];
    for (const agent of config.agents.list) {
        if (agent.default || agent.id === 'main') {
            agent.model = agent.model || {};
            agent.model.primary = newPrimary;
        } else if (agent.model && agent.model.primary) {
            // Fix any agent referencing a stale/removed provider
            const agentProvider = agent.model.primary.split('/')[0];
            if (staleProviders.includes(agentProvider)) {
                agent.model.primary = newPrimary;
            }
        }
    }
}

// ── Build agents.defaults.models from all configured providers ──
// This gives the UI a complete model catalog / allowlist.
const defaultsModels = {};
const providers = config.models.providers || {};
for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (Array.isArray(providerConfig.models)) {
        for (const model of providerConfig.models) {
            const key = providerName + '/' + model.id;
            defaultsModels[key] = { alias: model.name || model.id };
        }
    }
}
// Merge: preserve existing entries not covered by providers
// (e.g., user-added dynamic gateway models like kimi-k2.5)
const existing = config.agents.defaults.models || {};
for (const [key, val] of Object.entries(existing)) {
    if (!defaultsModels[key]) {
        defaultsModels[key] = val;
    }
}
config.agents.defaults.models = defaultsModels;
console.log('agents.defaults.models synced: ' + Object.keys(defaultsModels).length + ' models');

// Channel configuration
// Merge-overwrite: spread existing R2-restored config, then override env-driven fields.
// This preserves user-customised keys (voice, groupPolicy, streaming, etc.)
// while ensuring env vars always win. Breaking schema changes should be handled
// by dedicated migration logic (see streaming boolean→enum below), not by
// discarding the entire channel object.
if (process.env.TELEGRAM_BOT_TOKEN) {
    const existing = config.channels.telegram || {};
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || existing.dmPolicy || 'pairing';
    config.channels.telegram = {
        ...existing,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open' && !config.channels.telegram.allowFrom) {
        config.channels.telegram.allowFrom = ['*'];
    }
    // v2026.2.23: allowFrom now expects pure numeric IDs by default.
    // Enable name matching for backward compat with username-based allowFrom lists.
    config.channels.telegram.dangerouslyAllowNameMatching = true;
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const existing = config.channels.discord || {};
    const dmPolicy = process.env.DISCORD_DM_POLICY || (existing.dm && existing.dm.policy) || 'pairing';
    const dm = { ...(existing.dm || {}), policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = dm.allowFrom || ['*'];
    }
    config.channels.discord = {
        ...existing,
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const existing = config.channels.slack || {};
    config.channels.slack = {
        ...existing,
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

// Feishu (Lark) configuration
if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    const existing = config.channels.feishu || {};
    config.channels.feishu = {
        ...existing,
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        enabled: true,
    };
}

// v2026.2.23: streaming config changed from boolean to enum ('partial'|'off'|'adaptive').
// Migrate old R2-restored configs that may still have boolean values.
for (const [chName, chConfig] of Object.entries(config.channels || {})) {
    if (chConfig && typeof chConfig.streaming === 'boolean') {
        chConfig.streaming = chConfig.streaming ? 'partial' : 'off';
    }
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured && [ "${SYNC_ENABLED:-true}" = "true" ]; then
    BG_SYNC_INTERVAL="${SYNC_INTERVAL:-30}"
    echo "Starting background R2 sync loop (interval: ${BG_SYNC_INTERVAL}s)..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep "$BG_SYNC_INTERVAL"

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
