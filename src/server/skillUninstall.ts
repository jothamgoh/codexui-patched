import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export type InstalledSkillPath = {
  name?: string
  path?: string
  scope?: string
}

export type ResolveSkillUninstallTargetOptions = {
  defaultSkillsRoot: string
  installedSkills: InstalledSkillPath[]
  name: string
  requestedPath?: string
}

export class SkillUninstallTargetError extends Error {
  constructor(message = 'Skill uninstall target is not an installed user skill') {
    super(message)
    this.name = 'SkillUninstallTargetError'
  }
}

function normalizeSkillName(value: string): string {
  const name = value.trim()
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new SkillUninstallTargetError('Skill name must be a single non-hidden directory name')
  }
  return name
}

function skillDirectoryFromPath(value: string): string {
  const normalized = resolve(value)
  return basename(normalized).toLowerCase() === 'skill.md'
    ? dirname(normalized)
    : normalized
}

function addUniquePath(paths: string[], value: string): void {
  if (!paths.includes(value)) paths.push(value)
}

async function validateTargetUnderRoots(target: string, roots: string[]): Promise<string> {
  let targetInfo
  try {
    targetInfo = await lstat(target)
  } catch {
    throw new SkillUninstallTargetError('Installed skill directory was not found')
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new SkillUninstallTargetError('Skill uninstall target must be a real directory')
  }

  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(target)
  } catch {
    throw new SkillUninstallTargetError('Installed skill directory could not be resolved')
  }

  let allowed = false
  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(root)
      if (canonicalTarget !== canonicalRoot && dirname(canonicalTarget) === canonicalRoot) {
        allowed = true
        break
      }
    } catch {
      // Ignore missing or inaccessible roots; another recognized root may match.
    }
  }
  if (!allowed) {
    throw new SkillUninstallTargetError()
  }

  try {
    const manifestInfo = await stat(join(canonicalTarget, 'SKILL.md'))
    if (!manifestInfo.isFile()) throw new Error('not a file')
  } catch {
    throw new SkillUninstallTargetError('Skill uninstall target does not contain SKILL.md')
  }

  return canonicalTarget
}

export async function resolveSkillUninstallTarget(
  options: ResolveSkillUninstallTargetOptions,
): Promise<string> {
  const name = normalizeSkillName(options.name)
  const defaultRoot = resolve(options.defaultSkillsRoot)
  const candidates: string[] = []
  const allowedRoots: string[] = [defaultRoot]

  addUniquePath(candidates, join(defaultRoot, name))

  for (const skill of options.installedSkills) {
    if (skill.scope !== 'user' || skill.name?.trim() !== name || !skill.path?.trim()) continue
    const skillDirectory = skillDirectoryFromPath(skill.path)
    addUniquePath(candidates, skillDirectory)
    addUniquePath(allowedRoots, dirname(skillDirectory))
  }

  let target: string
  if (options.requestedPath?.trim()) {
    const requestedTarget = skillDirectoryFromPath(options.requestedPath)
    const matchedCandidate = candidates.find((candidate) => candidate === requestedTarget)
    if (!matchedCandidate) throw new SkillUninstallTargetError()
    target = matchedCandidate
  } else {
    target = join(defaultRoot, name)
  }

  return validateTargetUnderRoots(target, allowedRoots)
}
