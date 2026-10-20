import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import type { SavedSession, TunnelSpec, TunnelState } from '@shared/types'
import { describeTarget } from './sessionLabel'
import { t } from '../i18n'

interface TunnelsPageProps {
  /** Saved hosts, so a tunnel can be pointed at one without another round trip. */
  hosts: SavedSession[]
}

/** What a new tunnel starts as: the shape most people want first (a web UI). */
const BLANK = {
  name: '',
  savedSessionId: '',
  localPort: '8080',
  remoteHost: '127.0.0.1',
  remotePort: '80'
}

interface Form {
  name: string
  savedSessionId: string
  localPort: string
  remoteHost: string
  remotePort: string
}

const asForm = (spec: TunnelSpec): Form => ({
  name: spec.name,
  savedSessionId: spec.savedSessionId,
  localPort: String(spec.localPort),
  remoteHost: spec.remoteHost,
  remotePort: String(spec.remotePort)
})

/** A port someone can actually dial: 1-65535, no fractions. */
function readPort(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

const statusLabel: Record<TunnelState['status'], string> = {
  stopped: 'Stopped',
  starting: 'Connecting…',
  running: 'Running',
  error: 'Error'
}

/**
 * Local port forwarding, as a list you can start and leave running.
 *
 * `-L` semantics, and the page is written around the one thing that is easy to
 * get backwards: the *first* port is on this machine, the *second* address is
 * reached from the SSH host. The empty state and the row layout both spell that
 * out, because a forward that is set up the wrong way round looks like it works
 * and simply never connects.
 *
 * Only loopback is offered as the local address. Binding a forward on `0.0.0.0`
 * publishes an internal service to the whole local network — a deliberate act
 * that deserves its own decision, not a default in a text box.
 */
export function TunnelsPage({ hosts }: TunnelsPageProps): JSX.Element {
  const [tunnels, setTunnels] = useState<TunnelState[]>([])
  const [form, setForm] = useState<Form | null>(null)
  /** Id being edited, or the empty string for a new tunnel. */
  const [editingId, setEditingId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.termdeck.listTunnels().then(setTunnels)
    return window.termdeck.onTunnelsChanged(setTunnels)
  }, [])

  /** Only SSH entries can carry a forward. */
  const sshHosts = useMemo(
    () => hosts.filter((host) => !host.kind || host.kind === 'ssh'),
    [hosts]
  )
  const hostName = useCallback(
    (id: string) => sshHosts.find((host) => host.id === id)?.name ?? 'a deleted host',
    [sshHosts]
  )

  const openNew = (): void => {
    setError(null)
    setEditingId('')
    setForm({ ...BLANK, savedSessionId: sshHosts[0]?.id ?? '' })
  }

  const openEdit = (tunnel: TunnelState): void => {
    setError(null)
    setEditingId(tunnel.id)
    setForm(asForm(tunnel))
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!form) return
    const localPort = readPort(form.localPort)
    const remotePort = readPort(form.remotePort)
    if (!form.savedSessionId) {
      setError(t('tunnelspage.pick_a_host', 'Pick the SSH host this tunnel runs through.'))
      return
    }
    if (!form.remoteHost.trim()) {
      setError(t('tunnelspage.remote_host_required', 'The destination host cannot be empty.'))
      return
    }
    if (localPort === null || remotePort === null) {
      setError(t('tunnelspage.ports', 'Ports must be whole numbers between 1 and 65535.'))
      return
    }

    const spec: TunnelSpec = {
      id: editingId,
      name: form.name.trim(),
      savedSessionId: form.savedSessionId,
      localHost: '127.0.0.1',
      localPort,
      remoteHost: form.remoteHost.trim(),
      remotePort
    }
    const specs: TunnelSpec[] = tunnels.map(toSpec)
    if (editingId) {
      const at = specs.findIndex((tunnel) => tunnel.id === editingId)
      if (at >= 0) specs[at] = spec
      else specs.push(spec)
    } else {
      specs.push(spec)
    }

    setBusy(true)
    try {
      const saved = await window.termdeck.saveTunnels(specs)
      setTunnels(saved)
      setForm(null)
      setEditingId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: Promise<TunnelState[]>): Promise<void> => {
    setBusy(true)
    try {
      setTunnels(await action)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="td-page" data-testid="tunnels-page">
      <header className="td-page-head">
        <div className="td-page-bar">
          <h1 className="td-page-sub">{t('tunnelspage.tunnels', 'Tunnels')}</h1>
          <div className="td-page-actions">
            <button
              className="td-btn td-btn-primary"
              data-testid="tunnel-add"
              disabled={sshHosts.length === 0}
              onClick={openNew}
            >
              {t('tunnelspage.add_tunnel', 'Add tunnel')}
            </button>
          </div>
        </div>
        <p className="td-page-meta">
          {t(
            'tunnelspage.explain',
            'A local forward opens a port on this machine and carries it, through the SSH host, to an address that host can reach.'
          )}
        </p>
      </header>

      <div className="td-page-body">
        {form && (
          <form className="td-drawer-form" data-testid="tunnel-form" onSubmit={(e) => void submit(e)}>
            <label className="td-field">
              <span>{t('tunnelspage.name', 'Name')}</span>
              <input
                className="td-input"
                data-testid="tunnel-name"
                value={form.name}
                placeholder={t('tunnelspage.name_placeholder', 'Optional label')}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>

            <label className="td-field">
              <span>{t('tunnelspage.host', 'Through host')}</span>
              <select
                className="td-input"
                data-testid="tunnel-host"
                value={form.savedSessionId}
                onChange={(e) => setForm({ ...form, savedSessionId: e.target.value })}
              >
                {sshHosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} ({describeTarget(host)})
                  </option>
                ))}
              </select>
            </label>

            <div className="td-field-row">
              <label className="td-field">
                <span>{t('tunnelspage.local_port', 'Local port')}</span>
                <input
                  className="td-input"
                  data-testid="tunnel-local-port"
                  inputMode="numeric"
                  value={form.localPort}
                  onChange={(e) => setForm({ ...form, localPort: e.target.value })}
                />
              </label>
              <label className="td-field">
                <span>{t('tunnelspage.remote_host', 'Destination')}</span>
                <input
                  className="td-input"
                  data-testid="tunnel-remote-host"
                  value={form.remoteHost}
                  placeholder="127.0.0.1"
                  onChange={(e) => setForm({ ...form, remoteHost: e.target.value })}
                />
              </label>
              <label className="td-field">
                <span>{t('tunnelspage.remote_port', 'Port')}</span>
                <input
                  className="td-input"
                  data-testid="tunnel-remote-port"
                  inputMode="numeric"
                  value={form.remotePort}
                  onChange={(e) => setForm({ ...form, remotePort: e.target.value })}
                />
              </label>
            </div>

            <p className="td-hint">
              {t(
                'tunnelspage.direction',
                '127.0.0.1 on this machine will reach the destination as seen from the SSH host. Only this machine can use the forward.'
              )}
            </p>

            {error && <p className="td-form-error">{error}</p>}

            <div className="td-page-actions">
              <button className="td-btn td-btn-primary" data-testid="tunnel-save" disabled={busy} type="submit">
                {t('tunnelspage.save', 'Save')}
              </button>
              <button
                className="td-btn"
                data-testid="tunnel-cancel"
                type="button"
                onClick={() => {
                  setForm(null)
                  setEditingId('')
                  setError(null)
                }}
              >
                {t('tunnelspage.cancel', 'Cancel')}
              </button>
            </div>
          </form>
        )}

        {tunnels.length === 0 && !form && (
          <p className="td-page-empty" data-testid="tunnels-empty">
            {sshHosts.length === 0
              ? t(
                  'tunnelspage.no_hosts',
                  'Save an SSH host first — a tunnel has to run through one.'
                )
              : t(
                  'tunnelspage.empty',
                  'No tunnels yet. Add one to reach a service that only the remote host can see.'
                )}
          </p>
        )}

        <ul className="td-sftp-list">
          {tunnels.map((tunnel) => (
            <li
              key={tunnel.id}
              className="td-sftp-row"
              data-testid="tunnel-row"
              data-tunnel-id={tunnel.id}
              data-tunnel-status={tunnel.status}
            >
              <span className="td-sftp-icon" aria-hidden="true">
                {tunnel.status === 'running' ? '●' : tunnel.status === 'error' ? '!' : '○'}
              </span>
              <span className="td-node-label">{tunnel.name}</span>
              <span className="td-sftp-path" data-contrast-exempt>
                {tunnel.localHost}:{tunnel.localPort} → {tunnel.remoteHost}:{tunnel.remotePort}
              </span>
              <span className="td-page-meta">
                {t('tunnelspage.via', 'via')} {hostName(tunnel.savedSessionId)}
              </span>
              <span className="td-pill" data-testid="tunnel-status">
                {statusLabel[tunnel.status]}
                {tunnel.status === 'running' && tunnel.connections > 0
                  ? ` · ${tunnel.connections}`
                  : ''}
              </span>

              <span className="td-snippet-row-actions">
                {(tunnel.status === 'stopped' || tunnel.status === 'error') && (
                  <button
                    className="td-btn"
                    data-testid="tunnel-start"
                    disabled={busy}
                    onClick={() => void run(window.termdeck.startTunnel(tunnel.id))}
                  >
                    {t('tunnelspage.start', 'Start')}
                  </button>
                )}
                {(tunnel.status === 'running' || tunnel.status === 'starting') && (
                  <button
                    className="td-btn"
                    data-testid="tunnel-stop"
                    disabled={busy}
                    onClick={() => void run(window.termdeck.stopTunnel(tunnel.id))}
                  >
                    {t('tunnelspage.stop', 'Stop')}
                  </button>
                )}
                <button
                  className="td-btn"
                  data-testid="tunnel-edit"
                  onClick={() => openEdit(tunnel)}
                >
                  {t('tunnelspage.edit', 'Edit')}
                </button>
                <button
                  className="td-btn"
                  data-testid="tunnel-delete"
                  disabled={busy}
                  onClick={() => void run(window.termdeck.removeTunnel(tunnel.id))}
                >
                  {t('tunnelspage.delete', 'Delete')}
                </button>
              </span>

              {tunnel.status === 'error' && tunnel.message && (
                <span className="td-hint" data-testid="tunnel-message">
                  {tunnel.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** The storable half of a state row: the main process owns status and counts. */
function toSpec(tunnel: TunnelState): TunnelSpec {
  return {
    id: tunnel.id,
    name: tunnel.name,
    savedSessionId: tunnel.savedSessionId,
    localHost: tunnel.localHost,
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort
  }
}
