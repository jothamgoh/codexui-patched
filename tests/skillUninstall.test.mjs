import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const sourceUrl = new URL('../src/server/skillUninstall.ts', import.meta.url)
const {
  SkillUninstallTargetError,
  resolveSkillUninstallTarget,
} = await loadTypeScriptModule(sourceUrl)

async function makeSkill(root, name) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `# ${name}\n`)
  return directory
}

async function makeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-skill-uninstall-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const defaultRoot = join(directory, '.codex', 'skills')
  const alternateRoot = join(directory, '.agents', 'skills')
  await mkdir(defaultRoot, { recursive: true })
  await mkdir(alternateRoot, { recursive: true })
  return { directory, defaultRoot, alternateRoot }
}

test('allows a normal skill directory under the default Codex root', async (t) => {
  const { defaultRoot } = await makeFixture(t)
  const skillDirectory = await makeSkill(defaultRoot, 'example-skill')

  const target = await resolveSkillUninstallTarget({
    defaultSkillsRoot: defaultRoot,
    installedSkills: [],
    name: 'example-skill',
    requestedPath: join(skillDirectory, 'SKILL.md'),
  })

  assert.equal(target, await realpath(skillDirectory))
})

test('allows a listed user skill under an alternate user skill root', async (t) => {
  const { defaultRoot, alternateRoot } = await makeFixture(t)
  const skillDirectory = await makeSkill(alternateRoot, 'custom-skill')

  const target = await resolveSkillUninstallTarget({
    defaultSkillsRoot: defaultRoot,
    installedSkills: [{
      name: 'custom-skill',
      path: join(skillDirectory, 'SKILL.md'),
      scope: 'user',
    }],
    name: 'custom-skill',
    requestedPath: join(skillDirectory, 'SKILL.md'),
  })

  assert.equal(target, await realpath(skillDirectory))
})

test('rejects a browser-supplied path outside recognized skill roots', async (t) => {
  const { directory, defaultRoot } = await makeFixture(t)
  const unrelatedDirectory = await makeSkill(directory, 'unrelated')

  await assert.rejects(
    resolveSkillUninstallTarget({
      defaultSkillsRoot: defaultRoot,
      installedSkills: [],
      name: 'unrelated',
      requestedPath: unrelatedDirectory,
    }),
    SkillUninstallTargetError,
  )
})

test('rejects traversal and hidden internal skill names', async (t) => {
  const { defaultRoot } = await makeFixture(t)

  for (const name of ['../outside', '.system', 'folder/skill', 'folder\\skill']) {
    await assert.rejects(
      resolveSkillUninstallTarget({
        defaultSkillsRoot: defaultRoot,
        installedSkills: [],
        name,
      }),
      SkillUninstallTargetError,
    )
  }
})

test('rejects symlink escapes and non-skill directories', async (t) => {
  const { directory, defaultRoot } = await makeFixture(t)
  const outsideSkill = await makeSkill(directory, 'outside-skill')
  await symlink(outsideSkill, join(defaultRoot, 'linked-skill'))
  await mkdir(join(defaultRoot, 'not-a-skill'))

  await assert.rejects(
    resolveSkillUninstallTarget({
      defaultSkillsRoot: defaultRoot,
      installedSkills: [],
      name: 'linked-skill',
    }),
    SkillUninstallTargetError,
  )
  await assert.rejects(
    resolveSkillUninstallTarget({
      defaultSkillsRoot: defaultRoot,
      installedSkills: [],
      name: 'not-a-skill',
    }),
    SkillUninstallTargetError,
  )
})
