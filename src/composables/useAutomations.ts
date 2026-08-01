import { ref } from 'vue'
import {
  createAutomation,
  deleteAutomation,
  getAutomations,
  resolveAutomationProposal,
  runAutomationNow,
  updateAutomation,
  updateAutomationRun,
} from '../api/automations'
import { subscribeInPageRpcNotifications } from '../api/codexRpcClient'
import type { AutomationDraft, AutomationSnapshot } from '../types/automations'

const emptySnapshot = (): AutomationSnapshot => ({
  tasks: [],
  runs: [],
  proposals: [],
  schemaVersion: 2,
  version: 0,
  updatedAtIso: '',
})

export function useAutomations() {
  const snapshot = ref<AutomationSnapshot>(emptySnapshot())
  const isLoading = ref(false)
  const error = ref('')
  let unsubscribe: (() => void) | null = null

  function applySnapshot(next: AutomationSnapshot): AutomationSnapshot {
    if (next.version >= snapshot.value.version) snapshot.value = next
    return snapshot.value
  }

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = ''
    try {
      applySnapshot(await getAutomations())
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : 'Failed to load scheduled tasks.'
    } finally {
      isLoading.value = false
    }
  }

  function start(): void {
    if (unsubscribe) return
    unsubscribe = subscribeInPageRpcNotifications((notification) => {
      if (notification.method !== 'codexui/automations/updated') return
      const next = notification.params as AutomationSnapshot
      if (!next || !Array.isArray(next.tasks) || !Array.isArray(next.runs)) return
      applySnapshot(next)
    })
    void refresh()
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function mutate(operation: () => Promise<AutomationSnapshot>): Promise<AutomationSnapshot> {
    error.value = ''
    try {
      return applySnapshot(await operation())
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : 'Scheduled task update failed.'
      throw caught
    }
  }

  return {
    snapshot,
    isLoading,
    error,
    refresh,
    start,
    stop,
    create: (draft: AutomationDraft) => mutate(() => createAutomation(draft)),
    update: (id: string, changes: Partial<AutomationDraft>) => mutate(() => updateAutomation(id, changes)),
    remove: (id: string) => mutate(() => deleteAutomation(id)),
    runNow: async (id: string) => {
      const next = await mutate(() => runAutomationNow(id))
      window.setTimeout(() => void refresh(), 350)
      return next
    },
    resolveProposal: (id: string, accept: boolean) =>
      mutate(() => resolveAutomationProposal(id, accept)),
    updateRun: (id: string, changes: { unread?: boolean; archived?: boolean }) =>
      mutate(() => updateAutomationRun(id, changes)),
  }
}
