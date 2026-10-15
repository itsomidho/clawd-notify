import { expect, test } from 'claude-code/testing'

import { duration, engineNote, gist, phoneRequest, readSettings, systemCommand, turnNote } from '../hooks/notes'

const s = readSettings({})
const turn = { answer: 'Done.', durationMs: 95_000, reason: 'answer', isAborted: false }

test('settings fall back to their defaults', () => {
  expect(s).toEqual({
    minSeconds: 30, onPermission: true, onIdle: false, desktop: 'auto', sound: 'chime', phoneUrl: '', phoneMinSeconds: 120,
  })
  expect(readSettings({ desktop: 'loud', minSeconds: -4 }).desktop).toBe('auto')
  expect(readSettings({ minSeconds: -4 }).minSeconds).toBe(30)
})

test('durations and the gist of an answer', () => {
  expect(duration(4_400)).toBe('4s')
  expect(duration(134_000)).toBe('2m 14s')
  expect(duration(3_900_000)).toBe('1h 05m')
  expect(gist('## Summary\n\n**Fixed** the `login` bug in [auth](src/auth.ts).\nMore.')).toBe('Fixed the login bug in auth.')
  expect(gist('```ts\nconst a = 1\n```\nDone.')).toBe('Done.')
  expect(gist('```ts\ncode\n```')).toBe('')
  expect(gist('x'.repeat(200)).length).toBe(140)
})

test('a turn notifies only when it ran long, ended by itself, on the main loop', () => {
  expect(turnNote(s, turn, 'app')).toEqual({ kind: 'done', title: 'Claude is done · app', body: 'Done. (1m 35s)', isForPhone: false })
  expect(turnNote(s, { ...turn, durationMs: 12_000 }, 'app')).toBe(null)
  expect(turnNote(s, { ...turn, isAborted: true }, 'app')).toBe(null)
  expect(turnNote(s, { ...turn, agentId: 'a1' }, 'app')).toBe(null)
  expect(turnNote(s, { ...turn, reason: 'error' }, 'app')?.kind).toBe('error')
  expect(turnNote(s, { ...turn, durationMs: 300_000 }, 'app')?.isForPhone).toBe(true)
  expect(turnNote(s, { ...turn, answer: '' }, 'app')?.body).toBe('Finished in 1m 35s.')
})

test("Claude Code's own notifications: approvals yes, idle by choice, mods' never", () => {
  const ask = { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }
  expect(engineNote(s, ask, 'app')?.kind).toBe('permission')
  expect(engineNote(s, ask, 'app')?.isForPhone).toBe(true)
  expect(engineNote(readSettings({ onPermission: false }), ask, 'app')).toBe(null)
  const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }
  expect(engineNote(s, idle, 'app')).toBe(null)
  expect(engineNote(readSettings({ onIdle: true }), idle, 'app')?.kind).toBe('idle')
  expect(engineNote(s, { notification_type: 'plugin_notification', message: 'x' }, 'app')).toBe(null)
})

test('system commands and the phone request', () => {
  const note = { kind: 'permission' as const, title: 'Claude needs your approval · app', body: 'Say "yes"', isForPhone: true }
  expect(systemCommand('linux', note)).toEqual(['notify-send', '--app-name=Claude Code', '--urgency=critical', note.title, note.body])
  expect(systemCommand('darwin', note)?.[2]).toBe('display notification "Say \\"yes\\"" with title "Claude needs your approval · app"')
  expect(systemCommand('other', note)).toBe(null)
  const req = phoneRequest(note)
  expect(req.headers.Title).toBe('Claude needs your approval - app')
  expect(req.headers.Priority).toBe('high')
  expect(req.body).toBe('Say "yes"')
})
