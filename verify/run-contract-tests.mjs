#!/usr/bin/env node
/**
 * 契约优化验收入口：
 * 1. 用 frontend 自带的 esbuild 把 TS 用例打包成 CJS（解析 @ 无关的相对路径）。
 * 2. 每个用例在独立子进程执行，localStorage/模块缓存互不污染。
 * 运行：node run-contract-tests.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '/workspace/frontend/node_modules/esbuild/lib/main.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '.build')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const cases = [
  'case1-baseline',
  'case2-impact-scope',
  'case3-even3-no-drift',
  'case4-idempotent-resubmit',
  'case5-concurrent-coalesce',
  'case6-rebuild-reuse',
  'case7-narrow-arbitration',
  'case8-expand-arbitration',
  'case9-expand-extra-event',
  'case10-data-flow',
]

await build({
  entryPoints: [join(here, 'contract-tests.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(outDir, 'contract-tests.cjs'),
})

let failed = 0
for (const caseId of cases) {
  const result = spawnSync(process.execPath, [join(outDir, 'contract-tests.cjs'), caseId], {
    cwd: here,
    encoding: 'utf8',
  })
  process.stdout.write(result.stdout)
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  if (result.status !== 0) {
    failed += 1
    console.error(`--> ${caseId} 进程退出码 ${result.status}`)
  }
}

rmSync(outDir, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\n验收未通过：${failed}/${cases.length} 个用例失败`)
  process.exit(1)
}
console.log(`\n全部 ${cases.length} 个验收用例通过`)
void pathToFileURL
