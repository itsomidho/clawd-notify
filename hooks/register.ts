import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { NotifySent } from '../types'
import {
  SERVER_INFO,
  bannerProbes,
  engineNote,
  isMacFocusOn,
  isNoServer,
  isPhoneUrl,
  parseServer,
  platformFrom,
  linuxPlayers,
  phoneRequest,
  readSettings,
  soundFile,
  systemCommands,
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

// What one channel came to: how it went out, or why it did not.
type Outcome = { via?: string; problem?: string }

async function detectPlatform($: Engine): Promise<Platform> {
  let uname: string | undefined
  try {
    uname = (await $.process.run(['uname', '-s'], { timeoutMs: 3000 })).stdout
  } catch {
    uname = undefined
  }
  let os: string | undefined
  try {
    os = await $.env.get('OS')
  } catch {
    os = undefined
  }
  return platformFrom(uname, os)
}

function platformOf($: Engine): Promise<Platform> {
  platform ??= detectPlatform($)
  return platform
}

// Runs a command; on failure, says why in a few words.
async function run($: Engine, argv: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    if (r.exitCode === 0) return undefined
    const said = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? ''
    return `${argv[0]} exited ${r.exitCode}${said === '' ? '' : `: ${said.slice(0, 120)}`}`
  } catch (error) {
    return `${argv[0]} could not run${error instanceof Error ? `: ${error.message.slice(0, 80)}` : ''}`
  }
}

// Tries each command in turn; the first that works is the one used.
async function firstThatRuns($: Engine, commands: string[][]): Promise<Outcome> {
  const problems: string[] = []
  for (const argv of commands) {
    const problem = await run($, argv)
    if (problem === undefined) return { via: argv[0] }
    problems.push(problem)
  }
  return { problem: problems.length > 0 ? problems.join('; ') : 'no command for this platform' }
}

// A command's standard output, or undefined where it failed or is missing.
async function output($: Engine, argv: string[]): Promise<{ stdout: string; stderr: string; isOk: boolean } | undefined> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 5000 })
    return { stdout: r.stdout, stderr: r.stderr, isOk: r.exitCode === 0 }
  } catch {
    return undefined
  }
}

// Why the desktop would not show a notification it accepted, in a sentence
// each: Do Not Disturb, Focus, banners turned off, or no server at all.
async function hiddenBy($: Engine, settings: Settings, via: readonly string[]): Promise<string[]> {
  if (settings.desktop === 'off') return []
  const os = await platformOf($)
  if (os === 'linux') {
    const info = await output($, SERVER_INFO)
    if (info === undefined) return []
    if (!info.isOk) {
      return isNoServer(info.stderr) ? ['No notification service is running on your desktop, so nothing can show.'] : []
    }
    const server = parseServer(info.stdout)
    if (server === undefined) return []
    const found: string[] = []
    for (const probe of bannerProbes(server)) {
      const r = await output($, probe.argv)
      if (r !== undefined && r.isOk && probe.isHidden(r.stdout)) found.push(probe.reason)
    }
    return [...new Set(found)].map(reason => `Your desktop hides notifications: ${reason}.`)
  }
  if (os === 'darwin') {
    const found: string[] = []
    let home: string | undefined
    try {
      home = await $.env.get('HOME')
    } catch {
      home = undefined
    }
    if (home !== undefined) {
      try {
        const json = String(await $.fs.read(`${home}/Library/DoNotDisturb/DB/Assertions.json`))
        if (isMacFocusOn(json) === true) found.push('A Focus mode is on, so macOS holds notifications back: turn it off in Control Center.')
      } catch {
        // Not readable (permissions, an older macOS): no answer.
      }
    }
    if (via.includes('osascript')) {
      found.push('macOS shows these as from "Script Editor": if none appeared, allow Script Editor in System Settings → Notifications.')
    }
    return found
  }
  if (os === 'windows') {
    return ['On Windows, clawd-notify can only notify through your terminal, and cannot check Focus Assist: if nothing appeared, check that Focus Assist is off and that your terminal may notify.']
  }
  return []
}

async function system($: Engine, note: Note): Promise<Outcome> {
  return firstThatRuns($, systemCommands(await platformOf($), note))
}

async function terminal($: Engine, note: Note): Promise<Outcome & { isBell?: boolean }> {
  try {
    const r = await $.ui.notify(note.body, { title: note.title })
    if (!r.isSent) return { problem: `terminal: ${r.reason}` }
    channel = r.channel
    return r.channel === 'terminal_bell' ? { isBell: true, problem: 'terminal: a bell only' } : { via: r.channel }
  } catch (error) {
    return { problem: `terminal: ${error instanceof Error ? error.message.slice(0, 80) : 'refused'}` }
  }
}

async function desktop($: Engine, settings: Settings, note: Note): Promise<Outcome> {
  const mode = settings.desktop
  if (mode === 'off') return {}
  if (mode === 'system') return system($, note)
  // Claude Code already sends its own permission and idle notifications
  // through the terminal's channel; add the system's only where it has none.
  if (note.kind === 'permission' || note.kind === 'idle') {
    const hasChannel = channel !== undefined && channel !== 'terminal_bell'
    return mode === 'auto' && !hasChannel ? system($, note) : {}
  }
  const t = await terminal($, note)
  if (t.via !== undefined || mode === 'terminal') return t.isBell ? { via: 'bell' } : t
  const s = await system($, note)
  if (s.via !== undefined) return s
  return t.isBell ? { via: 'bell', problem: s.problem } : { problem: `${t.problem}; ${s.problem}` }
}

async function sound($: Engine, settings: Settings, note: Note): Promise<Outcome> {
  if (settings.sound === 'none') return {}
  const file = soundFile(note.kind)
  if ((await platformOf($)) === 'linux') {
    // The engine's player is macOS's afplay: on Linux, the desktop's own.
    const r = await firstThatRuns($, linuxPlayers(`${$.plugin.root}/${file}`))
    return r.via !== undefined ? { via: 'sound' } : { problem: `sound: ${r.problem}` }
  }
  try {
    await $.audio.play({ asset: file })
    return { via: 'sound' }
  } catch (error) {
    return { problem: `sound: ${error instanceof Error ? error.message.slice(0, 80) : 'could not play'}` }
  }
}

async function phone($: Engine, settings: Settings, note: Note): Promise<Outcome> {
  if (!note.isForPhone || settings.phoneUrl === '') return {}
  if (!isPhoneUrl(settings.phoneUrl)) return { problem: 'phone: the URL is not a valid http(s) URL' }
  try {
    const r = await $.http.fetch(settings.phoneUrl, phoneRequest(note))
    return r.ok ? { via: 'phone' } : { problem: `phone: the server answered ${r.status}` }
  } catch (error) {
    return { problem: `phone: ${error instanceof Error ? error.message.slice(0, 80) : 'could not connect'}` }
  }
}

async function deliver($: Engine, settings: Settings, note: Note, force = false): Promise<NotifySent & { problems: string[] }> {
  const outcomes: Outcome[] = []
  if (force || !(await read($, isMuted))) {
    outcomes.push(...(await Promise.all([desktop($, settings, note), sound($, settings, note), phone($, settings, note)])))
  }
  const via = outcomes.flatMap(o => (o.via === undefined ? [] : [o.via]))
  const problems = outcomes.flatMap(o => (o.problem === undefined ? [] : [o.problem]))
  const record: NotifySent = { kind: note.kind, title: note.title, body: note.body, at: await $.clock.now(), via }
  if (via.length > 0) {
    await update($, sent, n => n + 1)
    await update($, last, () => record)
  }
  return { ...record, problems }
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
  const lines = [r.via.length > 0 ? `Sent through: ${r.via.join(', ')}.` : 'Nothing could be sent.']
  if (r.problems.length > 0) lines.push('Not sent:', ...r.problems.map(p => `  ${p}`))
  const hidden = await hiddenBy($, settings, r.via)
  if (hidden.length > 0) lines.push('But:', ...hidden.map(h => `  ${h}`))
  if (settings.phoneUrl === '') lines.push('Phone: off (set a phone push URL in /config).')
  return lines.join('\n')
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
