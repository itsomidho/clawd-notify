import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bannerProbes, isMacFocusOn, isNoServer, parseServer, platformFrom } from '../hooks/notes'

test('the platform, from uname or the Windows environment', () => {
  expect(platformFrom('Linux\n', undefined)).toBe('linux')
  expect(platformFrom('Darwin\n', undefined)).toBe('darwin')
  expect(platformFrom('MINGW64_NT-10.0-22631\n', undefined)).toBe('windows')
  expect(platformFrom(undefined, 'Windows_NT')).toBe('windows')
  expect(platformFrom('FreeBSD\n', undefined)).toBe('other')
})

test('the notification server, and when there is none', () => {
  expect(parseServer("('cinnamon', 'GNOME', '6.6.9', '1.2')\n")).toEqual({ name: 'cinnamon', vendor: 'GNOME' })
  expect(parseServer('garbage')).toBe(undefined)
  expect(isNoServer('Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Notifications was not provided by any .service files')).toBe(true)
  expect(isNoServer('gdbus: command not found')).toBe(false)
})

test('each server is asked its own Do Not Disturb, beside the spec-wide Inhibited', () => {
  const asked = (name: string, vendor = '') => bannerProbes({ name, vendor }).map(p => p.argv.slice(0, 3).join(' '))
  expect(asked('cinnamon', 'GNOME')).toEqual(['gdbus call --session', 'gsettings get org.cinnamon.desktop.notifications'])
  expect(asked('gnome-shell', 'GNOME')).toEqual(['gdbus call --session', 'gsettings get org.gnome.desktop.notifications'])
  expect(asked('Notification Daemon', 'MATE')[1]).toBe('gsettings get org.mate.NotificationDaemon')
  expect(asked('Xfce Notify Daemon', 'Xfce')[1]).toBe('xfconf-query -c xfce4-notifyd')
  expect(asked('dunst', 'knopwob')[1]).toBe('dunstctl is-paused')
  expect(asked('mako', 'emersion')[1]).toBe('makoctl mode')
  expect(asked('SwayNotificationCenter', 'Erik Reider')[1]).toBe('swaync-client --get-dnd --skip-wait')
  expect(asked('Plasma', 'KDE')).toEqual(['gdbus call --session'])
})

test('each probe reads its own answer', () => {
  const probe = (name: string, i: number) => bannerProbes({ name, vendor: '' })[i]!
  expect(probe('Plasma', 0).isHidden('(<true>,)\n')).toBe(true)
  expect(probe('Plasma', 0).isHidden('(<false>,)\n')).toBe(false)
  expect(probe('cinnamon', 1).isHidden('false\n')).toBe(true)
  expect(probe('cinnamon', 1).isHidden('true\n')).toBe(false)
  expect(probe('gnome-shell', 1).isHidden('false\n')).toBe(true)
  expect(probe('dunst', 1).isHidden('true\n')).toBe(true)
  expect(probe('mako', 1).isHidden('default\ndo-not-disturb\n')).toBe(true)
  expect(probe('mako', 1).isHidden('default\n')).toBe(false)
})

test("macOS Focus, from its assertions file", () => {
  expect(isMacFocusOn('{"data":[{"storeAssertionRecords":[{"assertionDetails":{}}]}]}')).toBe(true)
  expect(isMacFocusOn('{"data":[{}]}')).toBe(false)
  expect(isMacFocusOn('not json')).toBe(undefined)
})

// A Linux desktop whose answers the test sets: the server's name, and what
// each gsettings key or command says.
function desktop(on: On, server: string | null, answers: Record<string, string>) {
  on('session.root', () => ({ value: '/work/app' }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-channel' as const } }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const done = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'uname') return done('Linux\n')
    if (argv.includes('GetServerInformation')) {
      return server === null
        ? done('', 1, 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name was not provided by any .service files')
        : done(`('${server}', 'GNOME', '1', '1.2')\n`)
    }
    const key = Object.keys(answers).find(k => argv.includes(k))
    return key === undefined ? (argv.includes('Inhibited') ? done('', 1, 'No such property') : done('')) : done(answers[key]!)
  })
}

// The person typing `/notify test`; its origin and presentation are the engine's.
const run = async ($: Engine) => (await $.command.run({ command: 'notify', args: 'test' } as never)) as { text: string }

test('/notify test names Cinnamon banners turned off', async ($, on) => {
  desktop(on, 'cinnamon', { 'display-notifications': 'false\n' })
  const { text } = await run($)
  expect(text).toContain('Sent through: notify-send')
  expect(text).toContain("Cinnamon's notifications are turned off")
})

test('/notify test says nothing more when banners are on', async ($, on) => {
  desktop(on, 'cinnamon', { 'display-notifications': 'true\n' })
  const { text } = await run($)
  expect(text.includes('But:')).toBe(false)
})

test('/notify test names a missing notification service', async ($, on) => {
  desktop(on, null, {})
  const { text } = await run($)
  expect(text).toContain('No notification service is running')
})
