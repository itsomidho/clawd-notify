export type NotifySent = {
  kind: 'done' | 'error' | 'permission' | 'idle'
  title: string
  body: string
  at: number
  via: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-notify': {
      isMuted: boolean
      sent: number
      last: NotifySent | null
    }
  }
}
