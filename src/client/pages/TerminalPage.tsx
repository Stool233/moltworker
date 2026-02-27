import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SandboxAddon, type ConnectionState } from '@cloudflare/sandbox/xterm';
import '@xterm/xterm/css/xterm.css';
import './TerminalPage.css';

const STATE_LABELS: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Connected',
};

export default function TerminalPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sandboxAddonRef = useRef<SandboxAddon | null>(null);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');

  const handleReconnect = useCallback(() => {
    const addon = sandboxAddonRef.current;
    if (!addon) return;
    addon.disconnect();
    addon.connect({ sandboxId: 'moltbot' });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#f8f9fa',
        cursor: '#e94560',
        selectionBackground: 'rgba(233, 69, 96, 0.3)',
        black: '#1a1a2e',
        red: '#ef4444',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f8f9fa',
        brightBlack: '#6b7280',
        brightRed: '#ff6b6b',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: ({ origin }) => {
        const cols = term.cols;
        const rows = term.rows;
        return `${origin}/ws/terminal?cols=${cols}&rows=${rows}`;
      },
      reconnect: true,
      onStateChange: (state) => {
        setConnState(state);
      },
    });
    term.loadAddon(sandboxAddon);

    term.open(el);
    fitAddon.fit();
    sandboxAddon.connect({ sandboxId: 'moltbot' });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    sandboxAddonRef.current = sandboxAddon;

    // Resize handling
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      sandboxAddon.disconnect();
      sandboxAddon.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      sandboxAddonRef.current = null;
    };
  }, []);

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <div className="terminal-status">
          <span className={`status-dot status-dot--${connState}`} />
          <span className="status-label">{STATE_LABELS[connState]}</span>
        </div>
        <button
          className="terminal-btn"
          onClick={handleReconnect}
          disabled={connState === 'connecting'}
        >
          Reconnect
        </button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
