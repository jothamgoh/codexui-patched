import { opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { HostFolderListing } from '../types/hostFolders'

export class HostFolderError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}

/** Browse one host directory. This never opens files or creates project state. */
export async function listHostFolders(pathValue = '', showHidden = false, homePath = homedir()): Promise<HostFolderListing> {
  const input = pathValue.trim()
  const requested = !input || input === '~' ? homePath
    : input.startsWith('~/') || input.startsWith('~\\') ? join(homePath, input.slice(2)) : input
  if (!isAbsolute(requested) || requested.includes('\0')) throw new HostFolderError('Enter a full folder path, or start from Home.', 400)
  try {
    const path = await realpath(requested)
    if (!(await stat(path)).isDirectory()) throw new HostFolderError('Choose a folder, not a file.', 400)
    const folders: HostFolderListing['folders'] = []
    let inspected = 0
    let truncated = false
    for await (const entry of await opendir(path)) {
      if (++inspected > 10_000) { truncated = true; break }
      if (!showHidden && entry.name.startsWith('.')) continue
      const entryPath = join(path, entry.name)
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(entryPath).then((info) => info.isDirectory(), () => false))
      if (!directory) continue
      if (folders.length === 500) { truncated = true; break }
      folders.push({ name: entry.name, path: entryPath })
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parentPath = dirname(path)
    return { path, parentPath: parentPath === path ? null : parentPath, homePath, folders, truncated }
  } catch (error) {
    if (error instanceof HostFolderError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw new HostFolderError('CodexUI cannot read this folder. Choose another folder or check its permissions on the computer.', 403)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HostFolderError('This folder is unavailable. Choose another folder or check the path.', 404)
    throw new HostFolderError('Could not read this folder. Try again.', 500)
  }
}
