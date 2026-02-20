import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';

const HEALTH_CHECK_INTERVAL_SECONDS = 60;

export class MoltbotSandbox extends Sandbox<MoltbotEnv> {
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
    try {
      const process = await findExistingMoltbotProcess(this);
      if (!process || process.status !== 'running') {
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
