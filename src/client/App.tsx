import { useState, useEffect, lazy, Suspense } from 'react';
import AdminPage from './pages/AdminPage';
import './App.css';

const TerminalPage = lazy(() => import('./pages/TerminalPage'));

type Tab = 'devices' | 'terminal';

function getTabFromHash(): Tab {
  return window.location.hash === '#terminal' ? 'terminal' : 'devices';
}

export default function App() {
  const [tab, setTab] = useState<Tab>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (t: Tab) => {
    window.location.hash = t === 'terminal' ? '#terminal' : '';
  };

  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>Moltbot Admin</h1>
        <nav className="header-nav">
          <button
            className={`nav-tab${tab === 'devices' ? ' nav-tab--active' : ''}`}
            onClick={() => navigate('devices')}
          >
            Devices
          </button>
          <button
            className={`nav-tab${tab === 'terminal' ? ' nav-tab--active' : ''}`}
            onClick={() => navigate('terminal')}
          >
            Terminal
          </button>
        </nav>
      </header>
      <main className={`app-main${tab === 'terminal' ? ' app-main--terminal' : ''}`}>
        {tab === 'devices' ? (
          <AdminPage />
        ) : (
          <Suspense fallback={<div className="terminal-loading">Loading terminal...</div>}>
            <TerminalPage />
          </Suspense>
        )}
      </main>
    </div>
  );
}
