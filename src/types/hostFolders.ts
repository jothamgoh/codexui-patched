export type HostFolderListing = {
  path: string
  parentPath: string | null
  homePath: string
  folders: Array<{ name: string; path: string }>
  truncated: boolean
}
