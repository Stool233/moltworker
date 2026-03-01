import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { MAINTENANCE_FLAG_KEY } from '../sandbox';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  syncToR2,
  waitForProcess,
} from '../gateway';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  // In maintenance mode, return empty lists without touching the sandbox
  if (c.get('maintenanceMode')) {
    return c.json({
      pending: [],
      paired: [],
      error: 'Sandbox is stopped. Start the sandbox to manage devices.',
    });
  }

  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url and --token (OpenClaw v2026.2.3 requires explicit credentials with --url)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listProc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveProc = await sandbox.startProcess(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success =
          approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  if (hasCredentials) {
    try {
      const result = await sandbox.exec('cat /tmp/.last-sync 2>/dev/null || echo ""');
      const timestamp = result.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  // In maintenance mode, reject sync
  if (c.get('maintenanceMode')) {
    return c.json({ success: false, error: 'Sandbox is stopped. Start the sandbox first.' }, 400);
  }

  const sandbox = c.get('sandbox');

  const result = await syncToR2(sandbox, c.env);

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  // In maintenance mode, reject restart
  if (c.get('maintenanceMode')) {
    return c.json({ error: 'Sandbox is stopped. Start the sandbox first.' }, 400);
  }

  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/sandbox/status - Get sandbox status
adminApi.get('/sandbox/status', async (c) => {
  const maintenanceMode = c.get('maintenanceMode');

  if (maintenanceMode) {
    return c.json({
      status: 'stopped' as const,
      maintenanceMode: true,
    });
  }

  // Check if gateway is running
  try {
    const sandbox = c.get('sandbox');
    const proc = await findExistingMoltbotProcess(sandbox);
    const gatewayRunning = proc !== null && proc.status === 'running';

    return c.json({
      status: gatewayRunning ? ('running' as const) : ('starting' as const),
      maintenanceMode: false,
    });
  } catch {
    return c.json({
      status: 'unknown' as const,
      maintenanceMode: false,
    });
  }
});

// POST /api/admin/sandbox/shutdown - Shut down the sandbox container
adminApi.post('/sandbox/shutdown', async (c) => {
  try {
    // 1. Sync data to R2 if credentials are available
    let syncResult = null;
    if (c.env.R2_ACCESS_KEY_ID && c.env.R2_SECRET_ACCESS_KEY && c.env.CF_ACCOUNT_ID) {
      try {
        const sandbox = c.get('sandbox');
        syncResult = await syncToR2(sandbox, c.env);
        console.log('[SHUTDOWN] R2 sync result:', syncResult.success);
      } catch (syncErr) {
        console.error('[SHUTDOWN] R2 sync failed (continuing with shutdown):', syncErr);
      }
    }

    // 2. Call DO's maintenance endpoint to cancel health checks and kill gateway
    const doId = c.env.Sandbox.idFromName('moltbot');
    const doStub = c.env.Sandbox.get(doId);
    await doStub.fetch(new Request('http://do/__maintenance/shutdown', { method: 'POST' }));
    console.log('[SHUTDOWN] DO maintenance shutdown completed');

    // 3. Write maintenance flag to R2
    await c.env.MOLTBOT_BUCKET.put(
      MAINTENANCE_FLAG_KEY,
      JSON.stringify({ shutdownAt: new Date().toISOString() }),
    );
    console.log('[SHUTDOWN] Maintenance flag written to R2');

    return c.json({
      success: true,
      message: 'Sandbox shutting down. Container will sleep within ~30 seconds.',
      synced: syncResult?.success ?? false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/sandbox/start - Start the sandbox container
adminApi.post('/sandbox/start', async (c) => {
  try {
    // 1. Remove maintenance flag from R2
    await c.env.MOLTBOT_BUCKET.delete(MAINTENANCE_FLAG_KEY);
    console.log('[START] Maintenance flag removed from R2');

    // 2. Get sandbox with keepAlive options (normal mode)
    const sleepAfter = c.env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
    const options: SandboxOptions =
      sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter };
    const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);

    // 3. Start gateway in the background
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err) => {
        console.error('[START] Gateway start failed:', err);
      }),
    );

    return c.json({
      success: true,
      message: 'Sandbox starting. This may take 1-2 minutes on cold start.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
