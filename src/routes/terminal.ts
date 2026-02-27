import { Hono } from 'hono';
import type { PtyOptions } from '@cloudflare/sandbox';
import type { AppEnv } from '../types';

const terminal = new Hono<AppEnv>();

/**
 * WebSocket terminal endpoint.
 * Upgrades the connection to a WebSocket and proxies to the sandbox PTY.
 *
 * Note: getSandbox() adds terminal() via a runtime Proxy, but the Sandbox
 * class type declaration omits it. We use a type assertion to bridge this gap.
 */
terminal.get('/ws/terminal', async (c) => {
  const upgrade = c.req.header('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const sandbox = c.get('sandbox') as unknown as { terminal(request: Request, options?: PtyOptions): Promise<Response> };
  const url = new URL(c.req.url);
  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);

  console.log(`[TERMINAL] Opening PTY session cols=${cols} rows=${rows}`);

  return sandbox.terminal(c.req.raw, { cols, rows });
});

export { terminal };
