import { useMemo, useState, type FormEvent, type JSX } from 'react'
import type { AuthMethod, SavedSession, SessionFolder, SessionTree } from '@shared/types'
import { BATCH_HOST_LIMIT, parseBatchHosts } from '@shared/batchHosts'
import { t } from '../i18n'

const api = window.termdeck

/** How the form is being filled: one host, or a list of them. */
type EditorMode = 'one' | 'many'

/**
 * What a saved host may connect as.
 *
 * `SessionKind` also carries `local`, which is deliberately not offered here:
 * the machine you are already sitting at is not a host, there is nothing about it
 * worth remembering, and every entry saved before telnet and serial existed is an
 * SSH one.
 */
type SavedKind = NonNullable<SavedSession['kind']>

/** The line settings of `SavedSession.serial`, named so the state can use them. */
type SerialDataBits = NonNullable<SavedSession['serial']>['dataBits']
type SerialParity = NonNullable<SavedSession['serial']>['parity']
type SerialStopBits = NonNullable<SavedSession['serial']>['stopBits']

/**
 * Line speeds the serial form offers.
 *
 * A menu rather than a text box because the four or five speeds that matter are
 * known, and a typo in this field is a port that opens and talks nonsense. It is
 * not a closed list: a saved rate that is not in here is added to the menu
 * instead of dropped, since a select whose value matches no option renders empty
 * and the next save would silently replace 1200 with whatever came first.
 */
const SERIAL_BAUD_RATES = [9600, 19200, 38400, 57600, 115200]

export interface SessionEditorProps {
  /** Existing session to edit, or null when creating a new one. */
  session: SavedSession | null
  /** Pre-selected parent folder when creating from a folder. */
  defaultParentId: string | null
  folders: SessionFolder[]
  knownTags: string[]
  /** Already saved sessions, so a batch can skip the ones that are already there. */
  existing?: SavedSession[]
  /** Credentials carried over from the quick-connect dialog. */
  prefill?: { password?: string; passphrase?: string }
  onCancel: () => void
  /** Called after a successful save; the tree itself arrives via broadcast. */
  onSaved: (tree: SessionTree) => void
  onDeleted?: (tree: SessionTree) => void
}

/** Flatten folders into indented options so nesting is visible in the select. */
function folderOptions(tree: SessionFolder[]): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, SessionFolder[]>()
  for (const folder of tree) {
    const list = byParent.get(folder.parentId) ?? []
    list.push(folder)
    byParent.set(folder.parentId, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  const out: Array<{ id: string; label: string }> = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      out.push({ id: folder.id, label: `${'— '.repeat(depth)}${folder.name}` })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * Session form, rendered as the body of a drawer.
 *
 * The `Drawer` supplies the sliding panel and the title, so this component only
 * owns the fields and the action row.
 */
export function SessionEditor({
  session,
  defaultParentId,
  folders,
  knownTags,
  existing,
  prefill,
  onCancel,
  onSaved,
  onDeleted
}: SessionEditorProps): JSX.Element {
  const [name, setName] = useState(session?.name ?? '')
  const [host, setHost] = useState(session?.host ?? '')
  const [port, setPort] = useState(String(session?.port ?? 22))
  const [username, setUsername] = useState(session?.username ?? 'root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>(session?.authMethod ?? 'password')
  const [privateKeyPath, setPrivateKeyPath] = useState(session?.privateKeyPath ?? '')

  /**
   * What kind of connection this entry is.
   *
   * Absent on everything saved before telnet and serial existed, and an absent
   * kind has always meant SSH, so that is the default here too.
   */
  const [kind, setKind] = useState<SavedKind>(session?.kind ?? 'ssh')

  /*
   * Serial line settings, held one state each rather than as one object: the
   * fields are edited independently and a change to the baud rate must not be
   * able to drop the other three.
   */
  const [serialPath, setSerialPath] = useState(session?.serial?.path ?? 'COM1')
  const [baudRate, setBaudRate] = useState(session?.serial?.baudRate ?? 115200)
  const [dataBits, setDataBits] = useState<SerialDataBits>(session?.serial?.dataBits ?? 8)
  const [parity, setParity] = useState<SerialParity>(session?.serial?.parity ?? 'none')
  const [stopBits, setStopBits] = useState<SerialStopBits>(session?.serial?.stopBits ?? 1)

  /**
   * Commands to type into the session once it is up, as one text block.
   *
   * Kept as a single string because a textarea is the whole editor: the line
   * structure only matters in one place, when the form is saved.
   */
  const [postCommands, setPostCommands] = useState(
    (session?.postConnectCommands ?? []).join('\n')
  )

  /**
   * Batch mode: a list of hosts instead of one form.
   *
   * Adding a subnet used to mean filling this form in once per address, so the
   * hosts arrived one at a time and the password had to be typed again for each.
   * Here the username, port, folder, authentication and password are shared, and
   * only the addresses differ — which is the whole shape of the job.
   */
  const [mode, setMode] = useState<EditorMode>('one')
  const [hostsText, setHostsText] = useState('')
  const batch = useMemo(() => parseBatchHosts(hostsText), [hostsText])

  /**
   * Password/passphrase fields. They start empty for an existing session:
   * the stored value is never sent to the renderer, only a `hasPassword` flag.
   * Leaving them blank keeps whatever is stored.
   */
  const [password, setPassword] = useState(prefill?.password ?? '')
  const [passphrase, setPassphrase] = useState(prefill?.passphrase ?? '')
  // Prefilled values count as an edit, so saving persists them.
  const [passwordTouched, setPasswordTouched] = useState(!!prefill?.password)
  const [passphraseTouched, setPassphraseTouched] = useState(!!prefill?.passphrase)
  const [revealed, setRevealed] = useState<string | null>(null)

  const [parentId, setParentId] = useState<string | null>(
    session?.parentId ?? defaultParentId ?? null
  )
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(session?.tags ?? [])
  const [notes, setNotes] = useState(session?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const options = folderOptions(folders)
  const editing = !!session?.id
  const batching = mode === 'many' && !editing

  const sharedPort = ((): number => {
    const parsed = Number.parseInt(port, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 22
  })()

  /**
   * The batch, minus the hosts that are already saved.
   *
   * Pasting `10.17.20.210-215` twice should not leave twelve sessions behind, and
   * the count of what was skipped is worth showing: a list that quietly came out
   * shorter is the one thing the user cannot check for themselves.
   */
  const batchPlan = useMemo(() => {
    const saved = new Set(
      (existing ?? []).map((s) => `${s.username}@${s.host}:${s.port}`)
    )
    const skipped: string[] = []
    const add = batch.entries.filter((entry) => {
      const key = `${entry.username ?? username.trim()}@${entry.host}:${entry.port ?? sharedPort}`
      if (!saved.has(key)) return true
      skipped.push(entry.host)
      return false
    })
    return { add, skipped }
  }, [batch.entries, existing, sharedPort, username])

  /*
   * Where the connection points.
   *
   * A serial line has no host, but a saved session does — the store keys entries
   * by it and the tree prints it — so the device path doubles as one. That is
   * also the string someone scanning the list is looking for.
   */
  const address = kind === 'serial' ? serialPath.trim() : host.trim()

  /*
   * The SSH-only half of the form: user name, authentication and the credential
   * fields. Telnet authenticates with nothing at all and a serial line is a wire,
   * so those fields are hidden rather than left to be filled in for nothing.
   */
  const sshOnly = batching || kind === 'ssh'

  /*
   * The speeds to offer. A saved rate missing from the common list is merged in
   * at its place in the order, so opening an old 1200-baud entry and saving it
   * again does not quietly change the line speed.
   */
  const baudChoices = SERIAL_BAUD_RATES.includes(baudRate)
    ? SERIAL_BAUD_RATES
    : [...SERIAL_BAUD_RATES, baudRate].sort((a, b) => a - b)

  const canSave = batching
    ? batchPlan.add.length > 0 && username.trim().length > 0
    : address.length > 0 && (kind !== 'ssh' || username.trim().length > 0)

  /**
   * What the box currently means, in words.
   *
   * Shown before saving rather than discovered afterwards: the summary is where
   * "the range only went up to 5" and "three of these are already saved" are
   * visible, and both are things a silent list would hide.
   */
  const batchSummary = useMemo((): string => {
    if (!hostsText.trim()) {
      return (
        'One host per line. A range like 10.17.20.210-215 is expanded, ' +
        'user@host:port overrides the shared username and port, and lines ' +
        `starting with # are ignored. Up to ${BATCH_HOST_LIMIT} at a time.`
      )
    }
    const parts = [
      `${batchPlan.add.length} host${batchPlan.add.length === 1 ? '' : 's'} will be added`
    ]
    if (batchPlan.skipped.length > 0) {
      parts.push(`${batchPlan.skipped.length} already saved, skipped`)
    }
    if (batch.problems.length > 0) {
      const first = batch.problems[0]
      parts.push(
        `${batch.problems.length} could not be read (${first.text}: ${first.reason})`
      )
    }
    if (batch.truncated) parts.push(`only the first ${BATCH_HOST_LIMIT} are added`)
    return parts.join(' · ')
  }, [batch.problems, batch.truncated, batchPlan, hostsText])

  const addTag = (raw: string): void => {
    const tag = raw.trim()
    if (!tag) return
    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
    setTagInput('')
  }

  const reveal = async (): Promise<void> => {
    const value = session?.id ? await api.revealCredential(session.id) : null
    if (value === null) {
      setError('No saved password to show for this session.')
      return
    }
    setRevealed(value)
    setPassword(value)
    setPasswordTouched(false)
  }

  /**
   * Switch the connection type without losing what has already been typed.
   *
   * The fields are only hidden, never cleared, so going SSH → serial → SSH hands
   * back the host that was in the box. The port is the single thing that follows
   * the kind: leaving 22 in the box when the entry becomes telnet would dial the
   * SSH port on nothing, and 23 left behind when it goes back to SSH is the same
   * mistake in reverse — but only a value that is still somebody's *default* is
   * replaced, since a port the user typed (2222) is their number, not ours.
   */
  const changeKind = (next: SavedKind): void => {
    if (next === kind) return
    const wasDefault = port.trim() === '' || port.trim() === (kind === 'telnet' ? '23' : '22')
    if (next !== 'serial' && wasDefault) setPort(next === 'telnet' ? '23' : '22')
    setKind(next)
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return

    /*
     * An empty address is reported in words rather than only by the disabled Save
     * button. It is the one half-filled state whose reason is not on screen — a
     * serial entry's address is a device path, which the host field cannot show —
     * and a dead button with no explanation is what the batch form was already
     * criticised for.
     */
    if (!batching && !address) {
      setError(
        kind === 'serial'
          ? t('sessioneditor.device_required', 'Enter the serial device path, for example COM3.')
          : t('sessioneditor.host_required', 'Enter a host name or address.')
      )
      return
    }
    if (!canSave) return

    setBusy(true)
    setError(null)
    try {
      if (batching) {
        /*
         * One write for the whole list, and the shared password sealed under each
         * new session's id. A session that is later rejected still gets asked for
         * its own password at connect time; nothing here needs to know which one
         * that will be.
         */
        const tree = await api.saveSessions({
          sessions: batchPlan.add.map((entry) => ({
            // The address is the name: "root@" six times over is six rows the
            // eye cannot tell apart, and the address is what is being scanned for.
            name: entry.host,
            host: entry.host,
            port: entry.port ?? sharedPort,
            username: entry.username ?? username.trim(),
            authMethod,
            privateKeyPath: privateKeyPath.trim() || undefined,
            tags,
            notes: notes.trim() || undefined,
            parentId
          })),
          credential: password ? { password } : undefined
        })
        onSaved(tree)
        return
      }

      const parsedPort = Number.parseInt(port, 10)

      /*
       * Each kind has its own default port and a serial line has none at all —
       * `0` rather than an invented number, because a device path is the whole
       * address of a serial entry.
       */
      const defaultPort = kind === 'telnet' ? 23 : 22
      const resolvedPort =
        kind === 'serial'
          ? 0
          : Number.isFinite(parsedPort) && parsedPort > 0
            ? parsedPort
            : defaultPort

      /*
       * One command per line, trimmed, with the empty lines dropped: a trailing
       * newline or the blank line someone leaves between two blocks is not a
       * command, and sending it would just press Enter on the shell.
       */
      const commands = postCommands
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      /*
       * The name a host gets when none was typed. SSH keeps the `user@host` it has
       * always had; a telnet host has no user name to prefix and a serial line is
       * identified by its device.
       */
      const defaultName = kind === 'ssh' ? `${username.trim()}@${address}` : address

      // Only send credentials the user actually edited; omitted keys keep
      // whatever is already stored (the store merges partial updates), and an
      // empty string is how a field is explicitly cleared. Only SSH has
      // credentials at all — for the other kinds the fields are hidden, and
      // sealing a password nobody can see is a secret nothing would read.
      const credential: { password?: string; passphrase?: string } = {}
      if (kind === 'ssh') {
        if (passwordTouched) credential.password = password
        if (passphraseTouched) credential.passphrase = passphrase
      }

      const tree = await api.saveSession({
        id: session?.id,
        name: name.trim() || defaultName,
        host: address,
        port: resolvedPort,
        username: username.trim(),
        authMethod,
        privateKeyPath: privateKeyPath.trim() || undefined,
        kind,
        /*
         * The serial block is written only for a serial entry. The store treats a
         * *present* key as a write even when the value is `undefined`, so leaving
         * the key out entirely is what stops an SSH host from growing a block it
         * has no use for. (Converting an existing serial entry to SSH therefore
         * leaves the old block in the store — harmless, since `kind` is what
         * decides how the entry connects, and better than writing a block that
         * describes a device the user has just moved away from.)
         */
        ...(kind === 'serial'
          ? { serial: { path: address, baudRate, dataBits, parity, stopBits } }
          : {}),
        // Same rule for the commands: a host with none does not gain `[]`, it
        // simply has no list.
        ...(commands.length > 0 ? { postConnectCommands: commands } : {}),
        tags,
        notes: notes.trim() || undefined,
        parentId,
        credential
      })
      onSaved(tree)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!session || !onDeleted) return
    setBusy(true)
    try {
      onDeleted(await api.deleteSession(session.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="td-drawer-form" onSubmit={(e) => void submit(e)} data-testid="session-form">
      <div className="td-form">
        {/*
          What the entry connects as decides which of the fields below exist at
          all, so it is asked first. Not offered while filling in a batch: that
          form is a list of addresses, and neither a serial device nor a telnet
          line is something a range of hosts can stand for.
        */}
        {!batching && (
          <label className="td-field">
            <span>{t('sessioneditor.connection_type', 'Connection type')}</span>
            <select
              aria-label="session-kind"
              className="td-select"
              data-testid="session-kind"
              value={kind}
              onChange={(e) => changeKind(e.target.value as SavedKind)}
            >
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet</option>
              <option value="serial">Serial</option>
            </select>
          </label>
        )}

        {/*
          One host or many. Only offered when creating: editing is about a session
          that exists, and there is no such thing as editing six of them at once.
        */}
        {!editing && (
          <div className="td-field">
            <span>{t('sessioneditor.mode', 'Mode')}</span>
            <div className="td-segmented">
              {(
                [
                  ['one', 'One host'],
                  ['many', 'Several hosts']
                ] as Array<[EditorMode, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={mode === value ? 'is-active' : ''}
                  data-testid={`session-mode-${value}`}
                  onClick={() => setMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!batching && (
          <label className="td-field">
            <span>{t('sessioneditor.name', 'Name')}</span>
            <input
              aria-label="session-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={host ? `${username}@${host}` : 'prod-web-1'}
            />
          </label>
        )}

        {batching ? (
          <>
            <label className="td-field">
              <span>{t('sessioneditor.hosts', 'Hosts')}</span>
              <textarea
                aria-label="session-hosts"
                className="td-hosts-input"
                rows={7}
                spellCheck={false}
                placeholder={'One per line, for example:\n10.17.20.210-215\nroot@web1.example.com:2222'}
                value={hostsText}
                onChange={(e) => setHostsText(e.target.value)}
              />
            </label>
            <p className="td-hint" data-testid="batch-summary">
              {batchSummary}
            </p>
          </>
        ) : kind === 'serial' ? (
          <>
            {/*
              A serial console: the device instead of an address, the line speed
              beside it, and the three small line settings below. They are on a
              second row on purpose — 8 / none / 1 is what almost every console
              wants, so they should be readable without competing with the two
              values that actually change per cable.
            */}
            <div className="td-field-row">
              <label className="td-field td-field-grow">
                <span>{t('sessioneditor.device', 'Device')}</span>
                <input
                  aria-label="session-serial-path"
                  data-testid="session-serial-path"
                  value={serialPath}
                  onChange={(e) => setSerialPath(e.target.value)}
                  placeholder="COM3"
                  spellCheck={false}
                />
              </label>
              <label className="td-field">
                <span>{t('sessioneditor.baud_rate', 'Baud rate')}</span>
                <select
                  aria-label="session-baud"
                  className="td-select"
                  data-testid="session-baud"
                  value={String(baudRate)}
                  onChange={(e) => setBaudRate(Number(e.target.value))}
                >
                  {baudChoices.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="td-field-row">
              <label className="td-field td-field-grow">
                <span>{t('sessioneditor.data_bits', 'Data bits')}</span>
                <select
                  aria-label="session-data-bits"
                  className="td-select"
                  data-testid="session-data-bits"
                  value={String(dataBits)}
                  onChange={(e) => setDataBits(Number(e.target.value) as SerialDataBits)}
                >
                  {([5, 6, 7, 8] as SerialDataBits[]).map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </select>
              </label>
              <label className="td-field td-field-grow">
                <span>{t('sessioneditor.parity', 'Parity')}</span>
                <select
                  aria-label="session-parity"
                  className="td-select"
                  data-testid="session-parity"
                  value={parity}
                  onChange={(e) => setParity(e.target.value as SerialParity)}
                >
                  {(
                    [
                      ['none', 'None'],
                      ['even', 'Even'],
                      ['odd', 'Odd'],
                      ['mark', 'Mark'],
                      ['space', 'Space']
                    ] as Array<[SerialParity, string]>
                  ).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="td-field td-field-grow">
                <span>{t('sessioneditor.stop_bits', 'Stop bits')}</span>
                <select
                  aria-label="session-stop-bits"
                  className="td-select"
                  data-testid="session-stop-bits"
                  value={String(stopBits)}
                  onChange={(e) => setStopBits(Number(e.target.value) as SerialStopBits)}
                >
                  {([1, 2] as SerialStopBits[]).map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <span className="td-hint">
              {t(
                'sessioneditor.serial_path_hint',
                'COM3 on Windows, /dev/ttyUSB0 or /dev/ttyS0 elsewhere. The path is also used as the host, so the entry stays findable in the list.'
              )}
            </span>
          </>
        ) : (
          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>{t('sessioneditor.host', 'Host')}</span>
              <input
                aria-label="session-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t('sessioneditor.10_0_0_1_or_example_com', '10.0.0.1 or example.com')}
                spellCheck={false}
              />
            </label>
            <label className="td-field td-field-port">
              <span>{t('sessioneditor.port', 'Port')}</span>
              <input
                aria-label="session-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </label>
          </div>
        )}

        {/*
          Username and port are the shared values in batch mode, so they sit
          together on one row there; the port is only a per-host field in the
          single form, where it has already been asked for above.
        */}
        {sshOnly && (
          <div className={batching ? 'td-field-row' : undefined}>
            <label className={batching ? 'td-field td-field-grow' : 'td-field'}>
              <span>{t('sessioneditor.username', 'Username')}</span>
              <input
                aria-label="session-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                spellCheck={false}
              />
            </label>
            {batching && (
              <label className="td-field td-field-port">
                <span>{t('sessioneditor.port_2', 'Port')}</span>
                <input
                  aria-label="session-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  inputMode="numeric"
                />
              </label>
            )}
          </div>
        )}

        <label className="td-field">
          <span>{t('sessioneditor.folder', 'Folder')}</span>
          <select
            aria-label="session-folder"
            className="td-select"
            value={parentId ?? ''}
            onChange={(e) => setParentId(e.target.value || null)}
          >
            <option value="">{t('sessioneditor.root', '(root)')}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/*
          Authentication, and the credential fields it selects, exist only for
          SSH. A telnet session has no user name or key to give and a serial line
          is not authenticated at all, so the whole group is hidden for them
          rather than left on screen implying a secret is needed.
        */}
        {sshOnly && (
          <div className="td-field">
            <span>{t('sessioneditor.authentication', 'Authentication')}</span>
            <div className="td-segmented">
              {(
                [
                  ['password', 'Password'],
                  ['key', 'Private key'],
                  ['agent', 'SSH agent']
                ] as Array<[AuthMethod, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={authMethod === value ? 'is-active' : ''}
                  onClick={() => setAuthMethod(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {sshOnly && authMethod === 'password' && (
          <label className="td-field">
            <span>
              {t('sessioneditor.password', 'Password')}
              {batching && <span className="td-field-note"> {t('sessioneditor.shared_by_every_host', '— shared by every host')}</span>}
              {!batching && session?.hasPassword && !passwordTouched && (
                <span className="td-field-note"> {t('sessioneditor.one_is_saved', '— one is saved')}</span>
              )}
            </span>
            <div className="td-field-row">
              <input
                className="td-field-grow"
                aria-label="session-password"
                type={revealed !== null ? 'text' : 'password'}
                value={password}
                placeholder={session?.hasPassword ? '•••••••• (unchanged)' : ''}
                autoComplete="off"
                onChange={(e) => {
                  setPassword(e.target.value)
                  setPasswordTouched(true)
                }}
              />
              {session?.id && session.hasPassword && (
                <button type="button" className="td-btn" onClick={() => void reveal()}>
                  {t('sessioneditor.show', 'Show')}
                </button>
              )}
            </div>
            <span className="td-hint">
              {t('sessioneditor.saved_encrypted_on_this_mach', 'Saved encrypted on this machine, with the key held by your operating system\'s keychain — no master password to type.')}
            </span>
          </label>
        )}

        {sshOnly && authMethod === 'key' && (
          <>
            <label className="td-field">
              <span>{t('sessioneditor.private_key_file', 'Private key file')}</span>
              <div className="td-field-row">
                <input
                  className="td-field-grow"
                  aria-label="session-key-path"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder="/home/me/.ssh/id_ed25519"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="td-btn"
                  onClick={() =>
                    void api.pickPrivateKey().then((p) => {
                      if (p) setPrivateKeyPath(p)
                    })
                  }
                >
                  {t('sessioneditor.browse', 'Browse…')}
                </button>
              </div>
            </label>

            <label className="td-field">
              <span>
                {t('sessioneditor.key_passphrase_optional', 'Key passphrase (optional)')}
                {session?.hasPassphrase && !passphraseTouched && (
                  <span className="td-field-note"> {t('sessioneditor.one_is_saved_2', '— one is saved')}</span>
                )}
              </span>
              <input
                aria-label="session-passphrase"
                type="password"
                value={passphrase}
                placeholder={session?.hasPassphrase ? '•••••••• (unchanged)' : ''}
                autoComplete="off"
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  setPassphraseTouched(true)
                }}
              />
            </label>
          </>
        )}

        {sshOnly && authMethod === 'agent' && (
          <p className="td-hint">
            {t('sessioneditor.uses', 'Uses')}<code>SSH_AUTH_SOCK</code>{t('sessioneditor.or_pageant_on_windows', ', or Pageant on Windows.')}
          </p>
        )}

        {/*
          Commands typed into the session once it is up — `sudo -i`, a tail, a
          pager setting, whatever gets retyped every single time. Offered for all
          three kinds because a telnet console and a serial switch have exactly
          the same "first four things" problem an SSH session does. Hidden while
          filling in a batch: those entries are addresses, and the same commands
          on twenty hosts at once is a guess rather than a convenience.
        */}
        {!batching && (
          <label className="td-field">
            <span>{t('sessioneditor.post_connect_commands', 'Commands to run after login')}</span>
            <textarea
              aria-label="session-post-commands"
              className="td-textarea"
              data-testid="session-post-commands"
              rows={4}
              spellCheck={false}
              placeholder={'sudo -i\ncd /var/log\nless -R app.log'}
              value={postCommands}
              onChange={(e) => setPostCommands(e.target.value)}
            />
            <span className="td-hint">
              {t(
                'sessioneditor.post_connect_hint',
                'One command per line. Each is typed into the session once it is up, in order, with a moment in between; blank lines are ignored.'
              )}
            </span>
          </label>
        )}

        <div className="td-field">
          <span>{t('sessioneditor.tags', 'Tags')}</span>
          <div className="td-tag-editor">
            {tags.map((tag) => (
              <span key={tag} className="td-tag">
                {tag}
                <button
                  type="button"
                  className="td-tag-remove"
                  onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              aria-label="session-tag-input"
              className="td-tag-input"
              list="td-known-tags"
              placeholder={t('sessioneditor.add_tag', 'add tag…')}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag(tagInput)
                } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                  setTags((prev) => prev.slice(0, -1))
                }
              }}
            />
            <datalist id="td-known-tags">
              {knownTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        </div>

        <label className="td-field">
          <span>{t('sessioneditor.notes', 'Notes')}</span>
          <input
            aria-label="session-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error && <div className="td-form-error">{error}</div>}
      </div>

      <div className="td-drawer-actions">
        {session && onDeleted && (
          <button
            type="button"
            className="td-btn td-btn-danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t('sessioneditor.delete', 'Delete')}
          </button>
        )}
        <span className="td-spacer" />
        <button type="button" className="td-btn" onClick={onCancel}>
          {t('sessioneditor.cancel', 'Cancel')}
        </button>
        <button
          type="submit"
          className="td-btn td-btn-primary"
          data-testid="session-save"
          disabled={!canSave || busy}
        >
          {busy
            ? 'Saving…'
            : batching
              ? `Add ${batchPlan.add.length} host${batchPlan.add.length === 1 ? '' : 's'}`
              : 'Save'}
        </button>
      </div>
    </form>
  )
}
