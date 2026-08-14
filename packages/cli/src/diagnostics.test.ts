import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectInfo, runDoctor } from './diagnostics.js'
import { resolvePascalPaths } from './paths.js'

test('doctor reports corrupt managed state instead of crashing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascal-cli-doctor-'))
  try {
    const paths = resolvePascalPaths({ PASCAL_HOME: path.join(root, 'home') })
    await mkdir(paths.run, { recursive: true })
    await writeFile(paths.currentRuntime, '{not-json')

    const checks = await runDoctor(paths)

    expect(checks).toContainEqual(expect.objectContaining({ id: 'runtime', status: 'fail' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('info creates private local storage on a fresh home', async () => {
  // POSIX permission bits (mode & 0o077) are meaningless on Windows — the
  // mode read back from stat() does not reflect the mkdir mode argument.
  if (process.platform === 'win32') return
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascal-cli-info-'))
  try {
    const paths = resolvePascalPaths({ PASCAL_HOME: path.join(root, 'home') })

    await collectInfo(paths)

    expect((await stat(paths.root)).mode & 0o077).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
