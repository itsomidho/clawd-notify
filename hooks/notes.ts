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

export type Platform = 'linux' | 'darwin' | 'other'

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

export function isPhoneUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+\/[^\s]+$/.test(url)
}
