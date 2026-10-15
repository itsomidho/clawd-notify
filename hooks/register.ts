import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { NotifySent } from '../types'
import {
  engineNote,
  isPhoneUrl,
  linuxPlayers,
  phoneRequest,
  readSettings,
  soundFile,
  systemCommand,
  turnNote,
} from './notes'
import type { Note, Platform, Settings } from './notes'

const isMuted = atom({ plugin: 'clawd-notify', key: 'isMuted' } as const, false)
const sent = atom({ plugin: 'clawd-notify', key: 'sent' } as const, 0)
const last = atom({ plugin: 'clawd-notify', key: 'last' } as const, null)

// Learned once per load: the platform, and the terminal's own notification
// channel once a notification has gone through it.
let platform: Promise<Platform> | undefined
let channel: string | undefined

function platformOf($: Engine): Promise<Platform> {
  platform ??= $.process
    .run(['uname', '-s'], { timeoutMs: 3000 })
    .then(r => (r.stdout.trim() === 'Darwin' ? 'darwin' : r.stdout.trim() === 'Linux' ? 'linux' : 'other') as Platform)
    .catch(() => 'other' as Platform)
  return platform
}

async function run($: Engine, argv: string[]): Promise<boolean> {
  try {
    return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

async function system($: Engine, note: Note): Promise<boolean> {
  const argv = systemCommand(await platformOf($), note)
  return argv !== null && (await run($, argv))
}

async function terminal($: Engine, note: Note): Promise<'sent' | 'bell' | 'none'> {
  try {
    const r = await $.ui.notify(note.body, { title: note.title })
    if (!r.isSent) return 'none'
    channel = r.channel
    return r.channel === 'terminal_bell' ? 'bell' : 'sent'
  } catch {
    return 'none'
  }
}

async function desktop($: Engine, settings: Settings, note: Note): Promise<string | undefined> {
  const mode = settings.desktop
  if (mode === 'off') return undefined
  if (mode === 'system') return (await system($, note)) ? 'system' : undefined
  // Claude Code already sends its own permission and idle notifications
  // through the terminal's channel; add the system's only where it has none.
  if (note.kind === 'permission' || note.kind === 'idle') {
    const hasChannel = channel !== undefined && channel !== 'terminal_bell'
    return mode === 'auto' && !hasChannel && (await system($, note)) ? 'system' : undefined
  }
  const how = await terminal($, note)
  if (how === 'sent') return channel
  return mode === 'auto' && (await system($, note)) ? 'system' : how === 'bell' ? 'bell' : undefined
}

async function sound($: Engine, settings: Settings, note: Note): Promise<boolean> {
  if (settings.sound === 'none') return false
  const file = soundFile(note.kind)
  if ((await platformOf($)) === 'linux') {
    // The engine's player is macOS's afplay: on Linux, the desktop's own.
    for (const argv of linuxPlayers(`${$.plugin.root}/${file}`)) {
      if (await run($, argv)) return true
    }
    return false
  }
  try {
    await $.audio.play({ asset: file })
    return true
  } catch {
    return false
  }
}

async function phone($: Engine, settings: Settings, note: Note): Promise<boolean> {
  if (!note.isForPhone || !isPhoneUrl(settings.phoneUrl)) return false
  try {
    return (await $.http.fetch(settings.phoneUrl, phoneRequest(note))).ok
  } catch {
    return false
  }
}

async function deliver($: Engine, settings: Settings, note: Note, force = false): Promise<NotifySent> {
  const via: string[] = []
  if (force || !(await read($, isMuted))) {
    const [d, s, p] = await Promise.all([desktop($, settings, note), sound($, settings, note), phone($, settings, note)])
    if (d !== undefined) via.push(d)
    if (s) via.push('sound')
    if (p) via.push('phone')
  }
  const record: NotifySent = { kind: note.kind, title: note.title, body: note.body, at: await $.clock.now(), via }
  if (via.length > 0) {
    await update($, sent, n => n + 1)
    await update($, last, () => record)
  }
  return record
}

// Sent after the hook has answered, so a slow network never holds the turn.
function later($: Engine, settings: Settings, note: Note | null): void {
  if (note !== null) $.clock.after(0, () => void deliver($, settings, note).catch(() => undefined))
}

async function projectName($: Engine): Promise<string> {
  const root = await $.session.root()
  return root.slice(root.lastIndexOf('/') + 1) || root
}

async function status($: Engine, settings: Settings): Promise<string> {
  const lastSent = await read($, last)
  const phoneLine =
    settings.phoneUrl === ''
      ? 'off (set a phone push URL in /config)'
      : isPhoneUrl(settings.phoneUrl)
        ? `on, for approvals and turns over ${settings.phoneMinSeconds}s`
        : 'the URL is not a valid http(s) URL'
  return [
    `clawd-notify ${(await read($, isMuted)) ? 'is MUTED (/notify on to resume)' : 'is on'} · ${await read($, sent)} sent this session`,
    `Done: turns over ${settings.minSeconds}s · approvals: ${settings.onPermission ? 'yes' : 'no'} · waiting for input: ${settings.onIdle ? 'yes' : 'no'}`,
    `Desktop: ${settings.desktop}${channel === undefined ? '' : ` (terminal channel: ${channel})`} · sound: ${settings.sound}`,
    `Phone: ${phoneLine}`,
    ...(lastSent === null ? [] : [`Last: ${lastSent.title}: ${lastSent.body} (via ${lastSent.via.join(', ')})`]),
    'Change these in /config, under clawd-notify. /notify test tries every channel.',
  ].join('\n')
}

async function test($: Engine, settings: Settings): Promise<string> {
  const note: Note = {
    kind: 'done',
    title: `Claude is done · ${await projectName($)}`,
    body: 'This is a test from clawd-notify.',
    isForPhone: true,
  }
  const r = await deliver($, settings, note, true)
  const badUrl = settings.phoneUrl !== '' && !isPhoneUrl(settings.phoneUrl) ? ' The phone URL is not a valid http(s) URL.' : ''
  return r.via.length > 0
    ? `Sent through: ${r.via.join(', ')}.${badUrl}`
    : `Nothing could be sent: no terminal notification channel, no notify-send or osascript, no sound player, and no phone URL.${badUrl}`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'notify',
      description: 'clawd-notify: status, "test" to try every channel, "off" / "on" for this session',
      argumentHint: '[test|off|on]',
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    later($, settings, turnNote(settings, e, await projectName($)))
    return answer
  })

  on('classic.Notification', async ($, e, next) => {
    later($, settings, engineNote(settings, e, await projectName($)))
    return next(e)
  })

  on('command.run', { command: 'notify' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      await update($, isMuted, () => arg === 'off')
      return { text: arg === 'off' ? 'clawd-notify is muted for this session.' : 'clawd-notify is on.' }
    }
    if (arg === 'test') return { text: await test($, settings) }
    return { text: await status($, settings) }
  })
}
