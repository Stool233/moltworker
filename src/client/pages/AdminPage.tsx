import { useState, useEffect, useCallback } from 'react';
import {
  listDevices,
  approveDevice,
  approveAllDevices,
  restartGateway,
  getStorageStatus,
  triggerSync,
  getSandboxStatus,
  shutdownSandbox,
  startSandbox,
  getRcloneSettings,
  updateRcloneSettings,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
  type StorageStatusResponse,
  type SandboxStatusResponse,
  type RcloneSyncConfig,
} from '../api';
import './AdminPage.css';

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

function formatSyncTime(isoString: string | null) {
  if (!isoString) return 'Never';
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatTimeAgo(ts: number) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AdminPage() {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [restartInProgress, setRestartInProgress] = useState(false);
  const [syncInProgress, setSyncInProgress] = useState(false);
  const [sandboxActionInProgress, setSandboxActionInProgress] = useState(false);
  const [rcloneConfig, setRcloneConfig] = useState<RcloneSyncConfig | null>(null);
  const [rcloneForm, setRcloneForm] = useState<RcloneSyncConfig | null>(null);
  const [rcloneFormDirty, setRcloneFormDirty] = useState(false);
  const [rcloneSaving, setRcloneSaving] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data: DeviceListResponse = await listDevices();
      setPending(data.pending || []);
      setPaired(data.paired || []);

      if (data.error) {
        setError(data.error);
      } else if (data.parseError) {
        setError(`Parse error: ${data.parseError}`);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch devices');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus();
      setStorageStatus(status);
    } catch (err) {
      // Don't show error for storage status - it's not critical
      console.error('Failed to fetch storage status:', err);
    }
  }, []);

  const fetchSandboxStatus = useCallback(async () => {
    try {
      const status = await getSandboxStatus();
      setSandboxStatus(status);
    } catch (err) {
      console.error('Failed to fetch sandbox status:', err);
    }
  }, []);

  const fetchRcloneSettings = useCallback(async () => {
    try {
      const config = await getRcloneSettings();
      setRcloneConfig(config);
      setRcloneForm(config);
      setRcloneFormDirty(false);
    } catch (err) {
      console.error('Failed to fetch rclone settings:', err);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    fetchStorageStatus();
    fetchSandboxStatus();
    fetchRcloneSettings();
  }, [fetchDevices, fetchStorageStatus, fetchSandboxStatus, fetchRcloneSettings]);

  const handleApprove = async (requestId: string) => {
    setActionInProgress(requestId);
    try {
      const result = await approveDevice(requestId);
      if (result.success) {
        // Refresh the list
        await fetchDevices();
      } else {
        setError(result.error || 'Approval failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve device');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleApproveAll = async () => {
    if (pending.length === 0) return;

    setActionInProgress('all');
    try {
      const result = await approveAllDevices();
      if (result.failed && result.failed.length > 0) {
        setError(`Failed to approve ${result.failed.length} device(s)`);
      }
      // Refresh the list
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve devices');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRestartGateway = async () => {
    if (
      !confirm(
        'Are you sure you want to restart the gateway? This will disconnect all clients temporarily.',
      )
    ) {
      return;
    }

    setRestartInProgress(true);
    try {
      const result = await restartGateway();
      if (result.success) {
        setError(null);
        // Show success message briefly
        alert('Gateway restart initiated. Clients will reconnect automatically.');
      } else {
        setError(result.error || 'Failed to restart gateway');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart gateway');
    } finally {
      setRestartInProgress(false);
    }
  };

  const handleSync = async () => {
    setSyncInProgress(true);
    try {
      const result = await triggerSync();
      if (result.success) {
        // Update the storage status with new lastSync time
        setStorageStatus((prev) => (prev ? { ...prev, lastSync: result.lastSync || null } : null));
        setError(null);
      } else {
        setError(result.error || 'Sync failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setSyncInProgress(false);
    }
  };

  const handleShutdownSandbox = async () => {
    if (
      !confirm(
        'Are you sure you want to shut down the sandbox?\n\n' +
          'This will:\n' +
          '- Sync data to R2 (if configured)\n' +
          '- Stop the gateway process\n' +
          '- Let the container sleep to save costs\n\n' +
          'You can restart it anytime from this panel.',
      )
    ) {
      return;
    }

    setSandboxActionInProgress(true);
    try {
      const result = await shutdownSandbox();
      if (result.success) {
        setError(null);
        setSandboxStatus({ status: 'stopped', maintenanceMode: true });
      } else {
        setError(result.error || 'Failed to shut down sandbox');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to shut down sandbox');
    } finally {
      setSandboxActionInProgress(false);
    }
  };

  const handleStartSandbox = async () => {
    setSandboxActionInProgress(true);
    try {
      const result = await startSandbox();
      if (result.success) {
        setError(null);
        setSandboxStatus({ status: 'starting', maintenanceMode: false });
        // Poll for status updates until running
        const pollInterval = setInterval(async () => {
          try {
            const status = await getSandboxStatus();
            setSandboxStatus(status);
            if (status.status === 'running') {
              clearInterval(pollInterval);
              // Refresh devices and storage status once sandbox is running
              fetchDevices();
              fetchStorageStatus();
            }
          } catch {
            // Keep polling on error
          }
        }, 5000);
        // Stop polling after 5 minutes
        setTimeout(() => clearInterval(pollInterval), 300000);
      } else {
        setError(result.error || 'Failed to start sandbox');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start sandbox');
    } finally {
      setSandboxActionInProgress(false);
    }
  };

  const handleRcloneChange = (field: keyof RcloneSyncConfig, value: string | number | boolean) => {
    if (!rcloneForm) return;
    setRcloneForm({ ...rcloneForm, [field]: value });
    setRcloneFormDirty(true);
  };

  const handleRcloneSave = async () => {
    if (!rcloneForm) return;
    setRcloneSaving(true);
    try {
      await updateRcloneSettings(rcloneForm);
      setRcloneConfig(rcloneForm);
      setRcloneFormDirty(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sync settings');
    } finally {
      setRcloneSaving(false);
    }
  };

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      {storageStatus && !storageStatus.configured && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>R2 Storage Not Configured</strong>
            <p>
              Paired devices and conversations will be lost when the container restarts. To enable
              persistent storage, configure R2 credentials. See the{' '}
              <a
                href="https://github.com/cloudflare/moltworker"
                target="_blank"
                rel="noopener noreferrer"
              >
                README
              </a>{' '}
              for setup instructions.
            </p>
            {storageStatus.missing && (
              <p className="missing-secrets">Missing: {storageStatus.missing.join(', ')}</p>
            )}
          </div>
        </div>
      )}

      {storageStatus?.configured && (
        <div className="success-banner">
          <div className="storage-status">
            <div className="storage-info">
              <span>
                R2 storage is configured. Your data will persist across container restarts.
              </span>
              <span className="last-sync">
                Last backup: {formatSyncTime(storageStatus.lastSync)}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSync}
              disabled={syncInProgress || sandboxStatus?.maintenanceMode}
            >
              {syncInProgress && <ButtonSpinner />}
              {syncInProgress ? 'Syncing...' : 'Backup Now'}
            </button>
          </div>
        </div>
      )}

      {storageStatus?.configured && rcloneForm && (
        <section className="devices-section sync-section">
          <div className="section-header">
            <h2>Sync Settings</h2>
          </div>
          <div className="sync-toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('enabled', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
            <span className="toggle-label">
              {rcloneForm.enabled ? 'Auto-sync enabled' : 'Auto-sync disabled'}
            </span>
          </div>
          <p className="hint">
            Controls automatic background sync to R2. Manual backups and shutdown sync always run regardless of this setting.
          </p>
          <div className={`form-grid ${!rcloneForm.enabled ? 'form-disabled' : ''}`}>
            <div className="form-group">
              <label className="form-label">Transfers</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={64}
                value={rcloneForm.transfers}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('transfers', parseInt(e.target.value) || 1)}
              />
              <span className="form-hint">Parallel file transfers (1-64)</span>
            </div>
            <div className="form-group">
              <label className="form-label">Checkers</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={64}
                value={rcloneForm.checkers}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('checkers', parseInt(e.target.value) || 1)}
              />
              <span className="form-hint">Parallel file checkers (1-64)</span>
            </div>
            <div className="form-group">
              <label className="form-label">Bandwidth Limit</label>
              <input
                type="text"
                className="form-input"
                value={rcloneForm.bwlimit}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('bwlimit', e.target.value)}
              />
              <span className="form-hint">e.g. "10M", "0" = unlimited</span>
            </div>
            <div className="form-group">
              <label className="form-label">TPS Limit</label>
              <input
                type="number"
                className="form-input"
                min={0}
                max={1000}
                value={rcloneForm.tpslimit}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('tpslimit', parseInt(e.target.value) || 0)}
              />
              <span className="form-hint">API transactions/sec (0 = unlimited)</span>
            </div>
            <div className="form-group">
              <label className="form-label">Max Transfer</label>
              <input
                type="text"
                className="form-input"
                value={rcloneForm.maxTransfer}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('maxTransfer', e.target.value)}
              />
              <span className="form-hint">e.g. "500M", "0" = unlimited</span>
            </div>
            <div className="form-group">
              <label className="form-label">Sync Interval</label>
              <input
                type="number"
                className="form-input"
                min={10}
                max={3600}
                value={rcloneForm.syncInterval}
                disabled={!rcloneForm.enabled}
                onChange={(e) => handleRcloneChange('syncInterval', parseInt(e.target.value) || 10)}
              />
              <span className="form-hint">Seconds between syncs (10-3600)</span>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="btn btn-primary"
              onClick={handleRcloneSave}
              disabled={!rcloneFormDirty || rcloneSaving}
            >
              {rcloneSaving && <ButtonSpinner />}
              {rcloneSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </section>
      )}

      <section className={`devices-section sandbox-section ${sandboxStatus?.maintenanceMode ? 'sandbox-stopped' : 'sandbox-running'}`}>
        <div className="section-header">
          <div className="sandbox-title">
            <h2>Sandbox Controls</h2>
            {sandboxStatus && (
              <span className={`sandbox-status-badge ${sandboxStatus.status}`}>
                <span className="status-dot" />
                {sandboxStatus.status === 'running'
                  ? 'Running'
                  : sandboxStatus.status === 'starting'
                    ? 'Starting...'
                    : sandboxStatus.status === 'stopped'
                      ? 'Stopped'
                      : 'Unknown'}
              </span>
            )}
          </div>
          {sandboxStatus?.maintenanceMode ? (
            <button
              className="btn btn-success"
              onClick={handleStartSandbox}
              disabled={sandboxActionInProgress}
            >
              {sandboxActionInProgress && <ButtonSpinner />}
              {sandboxActionInProgress ? 'Starting...' : 'Start Sandbox'}
            </button>
          ) : (
            <button
              className="btn btn-danger"
              onClick={handleShutdownSandbox}
              disabled={sandboxActionInProgress || sandboxStatus?.status === 'starting'}
            >
              {sandboxActionInProgress && <ButtonSpinner />}
              {sandboxActionInProgress ? 'Shutting down...' : 'Shutdown Sandbox'}
            </button>
          )}
        </div>
        <p className="hint">
          {sandboxStatus?.maintenanceMode
            ? 'The sandbox container is stopped to save costs. Click "Start Sandbox" to resume. Cold start takes 1-2 minutes.'
            : 'Shut down the sandbox container when not in use to save costs. Data will be synced to R2 before shutdown.'}
        </p>
      </section>

      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>Gateway Controls</h2>
          <button
            className="btn btn-danger"
            onClick={handleRestartGateway}
            disabled={restartInProgress || sandboxStatus?.maintenanceMode}
          >
            {restartInProgress && <ButtonSpinner />}
            {restartInProgress ? 'Restarting...' : 'Restart Gateway'}
          </button>
        </div>
        <p className="hint">
          Restart the gateway to apply configuration changes or recover from errors. All connected
          clients will be temporarily disconnected.
        </p>
      </section>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading devices...</p>
        </div>
      ) : (
        <>
          <section className="devices-section">
            <div className="section-header">
              <h2>Pending Pairing Requests</h2>
              <div className="header-actions">
                {pending.length > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={handleApproveAll}
                    disabled={actionInProgress !== null}
                  >
                    {actionInProgress === 'all' && <ButtonSpinner />}
                    {actionInProgress === 'all'
                      ? 'Approving...'
                      : `Approve All (${pending.length})`}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={fetchDevices} disabled={loading}>
                  Refresh
                </button>
              </div>
            </div>

            {pending.length === 0 ? (
              <div className="empty-state">
                <p>No pending pairing requests</p>
                <p className="hint">
                  Devices will appear here when they attempt to connect without being paired.
                </p>
              </div>
            ) : (
              <div className="devices-grid">
                {pending.map((device) => (
                  <div key={device.requestId} className="device-card pending">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge pending">Pending</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      {device.remoteIp && (
                        <div className="detail-row">
                          <span className="label">IP:</span>
                          <span className="value">{device.remoteIp}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Requested:</span>
                        <span className="value" title={formatTimestamp(device.ts)}>
                          {formatTimeAgo(device.ts)}
                        </span>
                      </div>
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-success"
                        onClick={() => handleApprove(device.requestId)}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === device.requestId && <ButtonSpinner />}
                        {actionInProgress === device.requestId ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="devices-section">
            <div className="section-header">
              <h2>Paired Devices</h2>
            </div>

            {paired.length === 0 ? (
              <div className="empty-state">
                <p>No paired devices</p>
              </div>
            ) : (
              <div className="devices-grid">
                {paired.map((device) => (
                  <div key={device.deviceId} className="device-card paired">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge paired">Paired</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Paired:</span>
                        <span className="value" title={formatTimestamp(device.approvedAtMs)}>
                          {formatTimeAgo(device.approvedAtMs)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
