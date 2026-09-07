import type { HostFolderListing } from '../types/hostFolders'

export async function getHostFolders(path = '', showHidden = false, signal?: AbortSignal): Promise<HostFolderListing> {
  const query = new URLSearchParams({ path, showHidden: String(showHidden) })
  const response = await fetch(`/codex-api/host-folders?${query}`, { signal })
  const payload = await response.json().catch(() => null)
  if (response.status === 404 && payload?.error === 'Unknown CodexUI API route.') {
    throw new Error('The running CodexUI server does not support folder browsing yet. Restart the CodexUI service, then try again.')
  }
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not browse folders. Try again.')
  const data = payload?.data
  if (!data || typeof data.path !== 'string' || typeof data.homePath !== 'string'
    || (data.parentPath !== null && typeof data.parentPath !== 'string') || typeof data.truncated !== 'boolean'
    || !Array.isArray(data.folders) || data.folders.some((folder: unknown) => !folder || typeof folder !== 'object'
      || typeof (folder as Record<string, unknown>).name !== 'string' || typeof (folder as Record<string, unknown>).path !== 'string')) {
    throw new Error('Folder browsing is unavailable. Refresh CodexUI after its server has restarted.')
  }
  return data as HostFolderListing
}
