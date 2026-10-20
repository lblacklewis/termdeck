import type { SavedSession } from '@shared/types'

/**
 * How a saved entry describes where it goes.
 *
 * SSH has a login, telnet has a host and a port and usually no username, and a
 * serial entry has a device on this machine plus a line speed. One function so
 * the tree tooltip, the hosts table and anything else that grows later cannot
 * disagree about what a host is called in this version.
 */
export function describeTarget(session: SavedSession): string {
  if (session.kind === 'serial') {
    const serial = session.serial
    const device = serial?.path ?? session.host
    return serial ? `${device} · ${serial.baudRate} baud` : device
  }
  if (session.kind === 'telnet') return `${session.host}:${session.port || 23}`
  return `${session.username}@${session.host}:${session.port}`
}
