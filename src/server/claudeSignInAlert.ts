import type { CustomNotification } from './webPushTurnNotifier.js'

/** Emitted by the Claude backend when saved sign-ins stop working. */
export const CLAUDE_SIGN_IN_EXPIRED_METHOD = 'codexui/claudeAccounts/signInExpired'

export type ClaudeSignInExpired = { accounts: Array<{ email: string; active: boolean }> }

/** The phone alert for saved Claude sign-ins that need signing in again. */
export function claudeSignInExpiredPush(params: ClaudeSignInExpired): CustomNotification | null {
  const { accounts } = params
  if (accounts.length === 0) return null
  const emails = accounts.map((account) => account.email).join(', ')
  const stopped = accounts.some((account) => account.active) ? ' Claude chats stop until you do or switch accounts.' : ''
  return {
    title: 'Claude sign-in expired',
    body: `Sign in to ${emails} again: Accounts, Add another account.${stopped}`,
    url: '/#/',
    tag: 'codexui-claude-sign-in',
  }
}
