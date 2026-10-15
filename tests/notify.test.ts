import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A Linux machine whose terminal has no notification channel: every command
// and fetch the plugin makes is recorded and succeeds.
function world(on: On, broken: readonly string[] = []) {
  const runs: string[][] = []
  const fetches: { url: string; body?: string; title?: string }[] = []
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? 'Linux\n' : ''
    const isBroken = broken.includes(e.argv[0] ?? '')
    const stderr = isBroken ? `${e.argv[0]}: symbol lookup error: undefined symbol` : ''
    return { value: { exitCode: isBroken ? 127 : 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-channel' as const } }))
  on('http.fetch', ($, e) => {
    fetches.push({ url: e.url, body: e.init?.body, title: e.init?.headers?.Title })
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  return { runs, fetches, clock }
}

const TURN = { answer: 'Fixed the login bug.', isAborted: false, turnId: 't1', reason: 'answer' as const }

test('a long turn: system notification and a chime, no phone for a short-ish turn', { options: { phoneUrl: 'https://ntfy.sh/t0pic' } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete({ ...TURN, durationMs: 60_000 })
  await w.clock.advance(1)
  const commands = w.runs.map(r => r[0])
  expect(commands).toContain('notify-send')
  expect(commands).toContain('paplay')
  expect(w.runs.find(r => r[0] === 'notify-send')?.slice(-2)).toEqual(['Claude is done · app', 'Fixed the login bug. (1m 00s)'])
  expect(w.fetches.length).toBe(0)
})

test('a quick turn notifies nothing', async ($, on) => {
  const w = world(on)
  await $.turn.complete({ ...TURN, durationMs: 5_000 })
  await w.clock.advance(1)
  expect(w.runs.filter(r => r[0] !== 'uname').length).toBe(0)
})

test('an approval request reaches the phone with high priority', { options: { phoneUrl: 'https://ntfy.sh/t0pic' } }, async ($, on) => {
  const w = world(on)
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  await w.clock.advance(1)
  expect(w.fetches).toEqual([{ url: 'https://ntfy.sh/t0pic', body: 'Claude needs your permission to use Bash', title: 'Claude needs your approval - app' }])
  expect(w.runs.some(r => r[0] === 'notify-send')).toBe(true)
})

test('sound off and desktop off leave only the phone', { options: { sound: 'none', desktop: 'off', phoneUrl: 'https://ntfy.sh/t0pic', phoneMinSeconds: 0 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete({ ...TURN, durationMs: 45_000 })
  await w.clock.advance(1)
  expect(w.runs.filter(r => r[0] !== 'uname').length).toBe(0)
  expect(w.fetches.length).toBe(1)
})

test('a broken notify-send falls back to gdbus', async ($, on) => {
  const w = world(on, ['notify-send'])
  await $.turn.complete({ ...TURN, durationMs: 60_000 })
  await w.clock.advance(1)
  const commands = w.runs.map(r => r[0])
  expect(commands).toContain('notify-send')
  expect(commands).toContain('gdbus')
  expect(w.runs.find(r => r[0] === 'gdbus')?.[12]).toBe("'Claude is done · app'")
})
