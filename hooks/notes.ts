// Pure logic: what to tell the person, and how each channel is spelt. No
// engine calls, so it is tested on its own.

export type Desktop = 'auto' | 'terminal' | 'system' | 'off'

export type Settings = {
  minSeconds: number
  onPermission: boolean
  onIdle: boolean
  desktop: Desktop
  sound: 'chime' | 'none'
  phoneUrl: string
  phoneMinSeconds: number
}

export type Kind = 'done' | 'error' | 'permission' | 'idle'

export type Note = {
  kind: Kind
  title: string
  body: string
  // Whether it reaches the phone, when a phone URL is set.
  isForPhone: boolean
}

export type Platform = 'linux' | 'darwin' | 'windows' | 'other'

// What `uname -s` says, or undefined where uname could not run.
export function platformFrom(uname: string | undefined, os: string | undefined): Platform {
  const name = (uname ?? '').trim()
  if (name === 'Linux') return 'linux'
  if (name === 'Darwin') return 'darwin'
  if (/^(MINGW|MSYS|CYGWIN)/.test(name) || os === 'Windows_NT') return 'windows'
  return 'other'
}

const DESKTOPS: readonly Desktop[] = ['auto', 'terminal', 'system', 'off']

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const desktop = DESKTOPS.find(d => d === options.desktop) ?? 'auto'
  return {
    minSeconds: number(options.minSeconds, 30),
    onPermission: options.onPermission !== false,
    onIdle: options.onIdle === true,
    desktop,
    sound: options.sound === 'none' ? 'none' : 'chime',
    phoneUrl: typeof options.phoneUrl === 'string' ? options.phoneUrl.trim() : '',
    phoneMinSeconds: number(options.phoneMinSeconds, 120),
  }
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// The answer's first line of prose, markdown marks removed, cut to `max`; a
// heading only when the answer has nothing else, code never.
export function gist(answer: string, max = 140): string {
  let heading = ''
  let isInCode = false
  for (const raw of answer.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      isInCode = !isInCode
      continue
    }
    if (isInCode) continue
    const isHeading = /^\s*#{1,6}\s/.test(raw)
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
    if (line === '' || /^(---|\|)/.test(line)) continue
    if (isHeading) {
      heading ||= line
      continue
    }
    return line.length <= max ? line : line.slice(0, max - 1).trimEnd() + '…'
  }
  return heading.length <= max ? heading : heading.slice(0, max - 1).trimEnd() + '…'
}

export type TurnEnd = {
  answer: string
  durationMs: number
  reason: string
  isAborted: boolean
  agentId?: string
}

// A main-loop turn that ran long enough, ended by itself. An aborted turn is
// one the person stopped, so they are there; a subagent's end is not theirs.
export function turnNote(s: Settings, turn: TurnEnd, project: string): Note | null {
  if (turn.agentId !== undefined || turn.isAborted || turn.reason === 'aborted') return null
  if (turn.durationMs < s.minSeconds * 1000) return null
  const took = duration(turn.durationMs)
  const isError = turn.reason === 'error' || turn.reason === 'refusal'
  const said = gist(turn.answer)
  return {
    kind: isError ? 'error' : 'done',
    title: isError ? `Claude stopped · ${project}` : `Claude is done · ${project}`,
    body: isError ? `The turn ended with an error after ${took}.` : said === '' ? `Finished in ${took}.` : `${said} (${took})`,
    isForPhone: turn.durationMs >= s.phoneMinSeconds * 1000,
  }
}

export type EngineNotification = { notification_type: string; message: string; title?: string }

// Claude Code's own notifications: a permission dialog, or a wait for input.
// `plugin_notification` is a mod's own (this one's included) and never echoed.
export function engineNote(s: Settings, n: EngineNotification, project: string): Note | null {
  if (n.notification_type === 'permission_prompt' && s.onPermission) {
    return { kind: 'permission', title: `Claude needs your approval · ${project}`, body: n.message, isForPhone: true }
  }
  if (n.notification_type === 'idle_prompt' && s.onIdle) {
    return { kind: 'idle', title: `Claude is waiting · ${project}`, body: n.message, isForPhone: false }
  }
  return null
}

export function soundFile(kind: Kind): string {
  return kind === 'done' ? 'sounds/done.wav' : 'sounds/attention.wav'
}

// The players to try in turn on Linux, each given the file's absolute path.
export function linuxPlayers(file: string): string[][] {
  return [['paplay', file], ['pw-play', file], ['aplay', '-q', file]]
}

function appleString(text: string): string {
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// A GVariant string literal, as gdbus parses its arguments.
function gvariantString(text: string): string {
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

// The system's own notification commands, to try in turn; none where there
// are none. On Linux, gdbus speaks to the notification service directly: it
// still works where notify-send does not (an AppImage terminal, such as
// Pane's, that puts its own older libnotify first on LD_LIBRARY_PATH).
export function systemCommands(platform: Platform, note: Note): string[][] {
  if (platform === 'linux') {
    const isUrgent = note.kind === 'permission'
    return [
      ['notify-send', '--app-name=Claude Code', `--urgency=${isUrgent ? 'critical' : 'normal'}`, note.title, note.body],
      [
        'gdbus', 'call', '--session',
        '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.Notify',
        gvariantString('Claude Code'), '0', "''", gvariantString(note.title), gvariantString(note.body),
        '[]', `{'urgency': <byte ${isUrgent ? 2 : 1}>}`, '10000',
      ],
    ]
  }
  if (platform === 'darwin') {
    return [['osascript', '-e', `display notification ${appleString(note.body)} with title ${appleString(note.title)}`]]
  }
  return []
}

// An ntfy publish: the body is the message, the headers its title and look.
// Header values are kept to Latin-1, as HTTP headers must be.
export function phoneRequest(note: Note): { method: string; headers: Record<string, string>; body: string } {
  const latin1 = (text: string) => text.replace(/·/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '')
  const tags = { done: 'white_check_mark', error: 'x', permission: 'raised_hand', idle: 'hourglass' }[note.kind]
  return {
    method: 'POST',
    headers: {
      Title: latin1(note.title),
      Tags: tags,
      Priority: note.kind === 'permission' ? 'high' : 'default',
    },
    body: note.body,
  }
}

// ---------- whether the desktop shows what it is sent ----------

const NOTIFICATIONS = ['--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications']

export const SERVER_INFO = ['gdbus', 'call', '--session', ...NOTIFICATIONS, '--method', 'org.freedesktop.Notifications.GetServerInformation']

export type Server = { name: string; vendor: string }

// GetServerInformation's answer, `('cinnamon', 'GNOME', '6.6.9', '1.2')`.
export function parseServer(out: string): Server | undefined {
  const m = out.match(/\(\s*'([^']*)'\s*,\s*'([^']*)'/)
  return m === null ? undefined : { name: m[1] ?? '', vendor: m[2] ?? '' }
}

// Whether a failed GetServerInformation means no server is there at all
// (rather than gdbus missing, which says nothing about the desktop).
export function isNoServer(stderr: string): boolean {
  return /not provided by any \.service|ServiceUnknown|NameHasNoOwner/i.test(stderr)
}

// One question to put to the desktop: hidden when `isHidden(stdout)`.
// A probe whose command fails or is missing answers nothing.
export type Probe = { argv: string[]; isHidden: (out: string) => boolean; reason: string }

const isTrue = (out: string) => out.trim() === 'true'

// The Do Not Disturb switches of the notification server that answered, and
// the spec's own `Inhibited` property, which any server may carry (Plasma does).
export function bannerProbes(server: Server): Probe[] {
  const id = `${server.name} ${server.vendor}`.toLowerCase()
  const probes: Probe[] = [
    {
      argv: ['gdbus', 'call', '--session', ...NOTIFICATIONS, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Notifications', 'Inhibited'],
      isHidden: out => /<true>/.test(out),
      reason: 'your notification server is set to Do Not Disturb',
    },
  ]
  if (id.includes('gnome-shell')) {
    probes.push({
      argv: ['gsettings', 'get', 'org.gnome.desktop.notifications', 'show-banners'],
      isHidden: out => out.trim() === 'false',
      reason: "GNOME's Do Not Disturb is on: turn it off in the clock menu, or in Settings → Notifications",
    })
  } else if (id.includes('cinnamon')) {
    probes.push({
      argv: ['gsettings', 'get', 'org.cinnamon.desktop.notifications', 'display-notifications'],
      isHidden: out => out.trim() === 'false',
      reason: "Cinnamon's notifications are turned off: System Settings → Notifications → Enable notifications",
    })
  } else if (id.includes('mate')) {
    probes.push({
      argv: ['gsettings', 'get', 'org.mate.NotificationDaemon', 'do-not-disturb'],
      isHidden: isTrue,
      reason: "MATE's Do Not Disturb is on: turn it off in the notification settings",
    })
  } else if (id.includes('xfce')) {
    probes.push({
      argv: ['xfconf-query', '-c', 'xfce4-notifyd', '-p', '/do-not-disturb'],
      isHidden: isTrue,
      reason: "Xfce's Do Not Disturb is on: turn it off in the notifications plugin or Settings → Notifications",
    })
  } else if (id.includes('dunst')) {
    probes.push({
      argv: ['dunstctl', 'is-paused'],
      isHidden: isTrue,
      reason: 'dunst is paused: run `dunstctl set-paused false`',
    })
  } else if (id.includes('mako')) {
    probes.push({
      argv: ['makoctl', 'mode'],
      isHidden: out => out.split('\n').some(m => m.trim() === 'do-not-disturb'),
      reason: 'mako is in do-not-disturb mode: run `makoctl mode -r do-not-disturb`',
    })
  } else if (id.includes('swaync') || id.includes('swaynotificationcenter')) {
    probes.push({
      argv: ['swaync-client', '--get-dnd', '--skip-wait'],
      isHidden: isTrue,
      reason: "SwayNC's Do Not Disturb is on: run `swaync-client --toggle-dnd`",
    })
  }
  return probes
}

// macOS keeps the active Focus in ~/Library/DoNotDisturb/DB/Assertions.json:
// a Focus is on while it holds an assertion record.
export function isMacFocusOn(json: string): boolean | undefined {
  try {
    const data: unknown = JSON.parse(json)
    const entries = (data as { data?: { storeAssertionRecords?: unknown[] }[] }).data ?? []
    return entries.some(e => Array.isArray(e.storeAssertionRecords) && e.storeAssertionRecords.length > 0)
  } catch {
    return undefined
  }
}

export function isPhoneUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+\/[^\s]+$/.test(url)
}
