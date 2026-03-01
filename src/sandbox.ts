import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';

const HEALTH_CHECK_INTERVAL_SECONDS = 60;

/** R2 key used to persist maintenance mode flag */
export const MAINTENANCE_FLAG_KEY = '_system/sandbox-shutdown';

export class MoltbotSandbox extends Sandbox<MoltbotEnv> {
  /**
   * Handle custom maintenance routes before delegating to base Sandbox.
   *
   * /__maintenance/shutdown — cancel health checks and kill gateway process
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__maintenance/shutdown' && request.method === 'POST') {
      console.log('[MAINTENANCE] Entering maintenance mode');
      // Cancel health check schedules so the DO can become idle
      this.deleteSchedules('checkGatewayHealth');

      // Kill gateway process
      try {
        const proc = await findExistingMoltbotProcess(this);
        if (proc) {
          await proc.kill();
          console.log('[MAINTENANCE] Gateway process killed');
        }
      } catch (err) {
        console.error('[MAINTENANCE] Error killing process:', err);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return super.fetch(request);
  }

  onStart() {
    super.onStart();
    // Schedule the first health check after container starts
    this.deleteSchedules('checkGatewayHealth');
    this.schedule(HEALTH_CHECK_INTERVAL_SECONDS, 'checkGatewayHealth').catch((err) => {
      console.error('[HEALTH] Failed to schedule initial health check:', err);
    });
    console.log('[HEALTH] Scheduled gateway health check');
  }

  async checkGatewayHealth() {
    console.log('[HEALTH] Running gateway health check...');

    // Check maintenance flag — if active, skip and don't reschedule
    try {
      const flag = await this.env.MOLTBOT_BUCKET.head(MAINTENANCE_FLAG_KEY);
      if (flag !== null) {
        console.log('[HEALTH] Maintenance mode active, skipping health check');
        this.deleteSchedules('checkGatewayHealth');
        return;
      }
    } catch (err) {
      console.error('[HEALTH] Failed to check maintenance flag, continuing:', err);
    }

    try {
      const process = await findExistingMoltbotProcess(this);
      if (process?.status === 'starting') {
        console.log('[HEALTH] Gateway is still starting, skipping this check');
      } else if (!process || process.status !== 'running') {
        console.log('[HEALTH] Gateway not running, restarting...');
        await ensureMoltbotGateway(this, this.env);
        console.log('[HEALTH] Gateway restarted successfully');
      } else {
        console.log('[HEALTH] Gateway is healthy, pid:', process.id);
      }
    } catch (err) {
      console.error('[HEALTH] Health check failed:', err);
      try {
        await this.start();
        await ensureMoltbotGateway(this, this.env);
        console.log('[HEALTH] Container and gateway restarted');
      } catch (startErr) {
        console.error('[HEALTH] Container restart also failed:', startErr);
      }
    } finally {
      // Always schedule the next check regardless of success/failure
      this.deleteSchedules('checkGatewayHealth');
      this.schedule(HEALTH_CHECK_INTERVAL_SECONDS, 'checkGatewayHealth').catch((err) => {
        console.error('[HEALTH] Failed to schedule next health check:', err);
      });
    }
  }
}
