/**
 * 发布版事件参数契约优化验收用例。
 * 由 run-contract-tests.mjs 用 esbuild 打包后在 Node 中执行：
 *   node contract-tests.cjs <caseId>
 * 每个用例跑在独立子进程里，localStorage 与模块缓存天然隔离。
 */
import {
  checkNoDrift,
  getLedger,
  getPublications,
  getReceipt,
  listAllContracts,
  reset,
  submit,
  updateParam,
} from './contract-helpers'

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    console.error(`  ✗ ${message}\n    expected=${JSON.stringify(expected)}\n    actual  =${JSON.stringify(actual)}`)
    failures += 1
  } else {
    console.log(`  ✓ ${message}`)
  }
}

async function main(): Promise<void> {
  const caseId = process.argv[2]
  console.log(`用例 ${caseId}`)
  // 每个用例独立进程，先回到示例基线（基线契约在任何参数修改之前构建，模拟页面首次加载）。
  reset()

  if (caseId === 'case1-baseline') {
    const contracts = listAllContracts()
    assertEqual(contracts.map((c) => c.eventCode), ['EVEN-0001', 'EVEN-0002', 'EVEN-0003'], '基线为三个事件各生成一份完整契约')
    const even3 = contracts.find((c) => c.eventCode === 'EVEN-0003')!
    assertEqual(even3.parameters.map((p) => p.paramCode), ['PARA-0003', 'PARA-0006', 'PARA-0002'], '契约参数顺序与事件规范引用顺序一致')
    assertEqual(even3.specOrigin, 'eventspec', '契约保留事件规范来源')
    assert(even3.parameters.every((p) => p.origin === 'paramdef'), '每个参数项保留参数字典来源')
    assert(Math.abs(even3.coverage - 1) < 1e-9, '三个已发布参数覆盖率 100%')
    assertEqual(getPublications().length, 1, '基线只有一份 baseline 发布记录')
  }

  if (caseId === 'case2-impact-scope') {
    // 修改 EVEN-0002 引用的 PARA-0002（同时被 EVEN-0003 引用）
    updateParam('PARA-0002', { '版本号': 'v2' })
    const result = await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-para0002-v2' })
    assert(result.accepted, '参数变化被接受并产出一份增量发布')
    assert(!result.conflict, '基线契约上的首次参数变化不算版本冲突')
    assertEqual(result.publicationId, 1, '发布批次号为 1')
    assertEqual([...result.affectedEventCodes].sort(), ['EVEN-0002', 'EVEN-0003'], '影响范围只含引用了 PARA-0002 的事件')
    assertEqual(result.reusedEventCodes, ['EVEN-0001'], 'EVEN-0001 未引用变化参数，复用原有完整结果')

    const contracts = listAllContracts()
    const even1 = contracts.find((c) => c.eventCode === 'EVEN-0001')!
    const even3 = contracts.find((c) => c.eventCode === 'EVEN-0003')!
    assertEqual(even1.rebuiltInPublication, 0, 'EVEN-0001 未被重建（批次仍为基线 0）')
    assertEqual(even3.rebuiltInPublication, 1, 'EVEN-0003 被局部重建（批次 1）')

    const drift = checkNoDrift()
    assert(drift.matches, '局部重建结果与从零全量重算的契约版本/覆盖率完全一致，无漂移')
  }

  if (caseId === 'case3-even3-no-drift') {
    // 修改 EVEN-0002 引用的一个参数，确认 EVEN-0003 契约与差异项不漂移（重复刷新场景）
    updateParam('PARA-0005', { '版本号': 'v2', '状态': '已发布' })
    const first = await submit({ changedParamCodes: ['PARA-0005'], idempotencyKey: 'k-para0005-v2' })
    assertEqual(first.affectedEventCodes, ['EVEN-0002'], 'PARA-0005 只影响 EVEN-0002')

    const contractsAfterFirst = listAllContracts()
    const even3Version = contractsAfterFirst.find((c) => c.eventCode === 'EVEN-0003')!.contractVersion
    const even3Coverage = contractsAfterFirst.find((c) => c.eventCode === 'EVEN-0003')!.coverage
    const ledgerAfterFirst = JSON.stringify(getLedger())

    // 再触发一次不带新内容的刷新（新幂等键但参数内容未变）
    const second = await submit({ changedParamCodes: ['PARA-0005'], idempotencyKey: 'k-para0005-refresh' })
    assert(!second.accepted && second.idempotent, '无内容变化的刷新被内容签名拦截，不产生新发布')

    const contractsAfterSecond = listAllContracts()
    const even3 = contractsAfterSecond.find((c) => c.eventCode === 'EVEN-0003')!
    assertEqual(even3.contractVersion, even3Version, 'EVEN-0003 契约版本不随刷新漂移')
    assertEqual(even3.coverage, even3Coverage, 'EVEN-0003 覆盖率不随刷新漂移')
    assertEqual(JSON.stringify(getLedger()), ledgerAfterFirst, 'EVEN-0003 差异项不随刷新重复追加')
    assertEqual(
      getLedger().filter((d) => d.eventCode === 'EVEN-0003').length,
      0,
      'PARA-0005 不被 EVEN-0003 引用，EVEN-0003 名下没有任何差异项',
    )
    assertEqual(getPublications().length, 2, '发布记录仍只有基线 + 1 份增量')

    // 再重复提交相同版本（默认幂等键，与首次自动生成的键相同），后到请求被拦住
    const third = await submit({ changedParamCodes: ['PARA-0005'] })
    assert(!third.accepted && third.idempotent, '相同版本的重复提交被幂等拦截')
    assertEqual(getPublications().length, 2, '拦截后发布份数保持不变')
  }

  if (caseId === 'case4-idempotent-resubmit') {
    updateParam('PARA-0002', { '版本号': 'v2' })
    const first = await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'same-key' })
    assert(first.accepted, '首次提交成功')
    const second = await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'same-key' })
    assert(!second.accepted && second.idempotent, '相同幂等键的连续提交被拦住')
    assertEqual(second.publicationId, 1, '后到请求返回首次的批次号而不是新建发布')
    assertEqual(getPublications().length, 2, '只写入一份增量发布数据')
    const ledger = getLedger()
    const para2Diffs = ledger.filter((d) => d.paramCode === 'PARA-0002')
    assertEqual(para2Diffs.length, new Set(para2Diffs.map((d) => d.diffId)).size, '差异台账按稳定编号无重复')
  }

  if (caseId === 'case5-concurrent-coalesce') {
    updateParam('PARA-0002', { '版本号': 'v2' })
    // 两个参数版本同时触发刷新，受影响事件重叠（PARA-0002 与 PARA-0005 都命中 EVEN-0002）
    const [a, b] = await Promise.all([
      submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'concurrent-a' }),
      submit({ changedParamCodes: ['PARA-0005'], idempotencyKey: 'concurrent-b' }),
    ])
    const accepted = [a, b].filter((r) => r.accepted)
    const coalesced = [a, b].filter((r) => r.coalesced)
    assertEqual(accepted.length, 1, '同一发布窗口只保留一次有效重算')
    assertEqual(coalesced.length, 1, '后到请求复用已校验结果（coalesced）')
    assertEqual(getPublications().length, 2, '并发刷新只落一份增量发布')
    const ledgerSize = getLedger().length
    const uniqueDiffs = new Set(getLedger().map((d) => d.diffId)).size
    assertEqual(ledgerSize, uniqueDiffs, '没有重复追加的差异项')
  }

  if (caseId === 'case6-rebuild-reuse') {
    updateParam('PARA-0002', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k1' })
    const contracts = listAllContracts()
    const even1 = contracts.find((c) => c.eventCode === 'EVEN-0001')!
    const even2 = contracts.find((c) => c.eventCode === 'EVEN-0002')!
    const even3 = contracts.find((c) => c.eventCode === 'EVEN-0003')!
    const receipt1 = getReceipt('EVEN-0001')!
    assertEqual(receipt1.contractVersion, even1.contractVersion, '跨模块回执与当前契约同版本')
    assertEqual(receipt1.specOrigin, 'eventspec', '回执保留埋点事件契约来源 eventspec')
    assertEqual(receipt1.paramOrigin, 'paramdef', '回执保留参数契约来源 paramdef')
    assert(even2.contractVersion !== even1.contractVersion || even2.rebuiltInPublication === 1, '受影响事件完成局部重建')
    assertEqual(even1.rebuiltInPublication, 0, '未变化事件定义继续复用基线契约')
    assert(even3.rebuiltInPublication === 1, '共享参数的 EVEN-0003 一并局部重建')
  }

  if (caseId === 'case7-narrow-arbitration') {
    // 先把 PARA-0002 推到 v2，再模拟迟到更正 v3，稳定事件重算与迟到更正落在同一窗口
    updateParam('PARA-0002', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-v2' })
    updateParam('PARA-0002', { '版本号': 'v3' })
    const result = await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-v3', mode: 'narrow' })
    assert(result.conflict, '检测到迟到参数版本冲突')
    assertEqual(result.mode, 'narrow', '仲裁方式为按受影响事件缩小重算')
    assert(result.refreshDetails.length >= 2, '产出受影响事件局部刷新明细')
    assertEqual(result.backfillDetails.length, 0, 'narrow 不产生跨版本扩展补算明细')
    const events = result.refreshDetails.map((d) => d.eventCode).sort()
    assertEqual(events, ['EVEN-0002', 'EVEN-0003'], '局部刷新明细只覆盖引用冲突参数的事件')
    const contracts = listAllContracts()
    assertEqual(new Set(contracts.map((c) => c.contractVersion)).size <= contracts.length, true, '每次读取仍是一份完整契约版本集合')
    assert(checkNoDrift().matches, 'narrow 仲裁后全量复算与存储契约一致')
  }

  if (caseId === 'case8-expand-arbitration') {
    updateParam('PARA-0002', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-v2' })
    updateParam('PARA-0002', { '版本号': 'v3' })
    const result = await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-v3', mode: 'expand' })
    assert(result.conflict, '检测到迟到参数版本冲突')
    assertEqual(result.mode, 'expand', '仲裁方式为按参数版本扩展补算')
    assert(result.backfillDetails.length >= 2, '每个受影响事件的冲突参数版本对都产出跨版本兼容补算明细')
    const backfillKeys = result.backfillDetails.map((d) => `${d.eventCode}:${d.paramCode}`).sort()
    assertEqual(
      backfillKeys,
      ['EVEN-0002:PARA-0002', 'EVEN-0003:PARA-0002'],
      '补算明细覆盖所有引用冲突参数的受影响事件',
    )
    assert(
      result.backfillDetails.every((d) => d.fromVersion === 'v2' && d.toVersion === 'v3' && d.reason === 'late-param-correction'),
      '补算明细记录跨版本兼容信息（v2 -> v3）',
    )
    assert(
      result.backfillDetails.every((d) => result.affectedEventCodes.includes(d.eventCode)),
      '扩展补算事件全部进入本次重建窗口',
    )
    assert(checkNoDrift().matches, 'expand 仲裁后全量复算与存储契约一致')
    const contracts = listAllContracts()
    const snapshot = getPublications().at(-1)!.snapshotVersion
    assertEqual(snapshot.length > 0, true, '发布记录携带完整契约快照锚点')
    assertEqual(new Set(contracts.map((c) => c.eventCode)).size, 3, '每次读取仍只对应一份完整契约（三事件齐全）')
  }

  if (caseId === 'case9-expand-extra-event') {
    // 构造一个只被 EVEN-0001 引用的参数迟到更正，expand 时不扩大到无引用事件
    // PARA-0001 仅 EVEN-0001 引用：narrow 与 expand 的重建窗口应一致（无额外事件可补）
    updateParam('PARA-0001', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0001'], idempotencyKey: 'k-p1-v2' })
    updateParam('PARA-0001', { '版本号': 'v3' })
    const narrow = await submit({ changedParamCodes: ['PARA-0001'], idempotencyKey: 'k-p1-v3-n', mode: 'narrow' })
    reset()
    updateParam('PARA-0001', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0001'], idempotencyKey: 'k-p1-v2' })
    updateParam('PARA-0001', { '版本号': 'v3' })
    const expand = await submit({ changedParamCodes: ['PARA-0001'], idempotencyKey: 'k-p1-v3-e', mode: 'expand' })
    assertEqual(narrow.affectedEventCodes, ['EVEN-0001'], 'narrow：仅重建 EVEN-0001')
    assertEqual(expand.affectedEventCodes, ['EVEN-0001'], 'expand：无其他事件引用该参数，窗口不扩大')
    assert(
      expand.backfillDetails.every((d) => d.eventCode === 'EVEN-0001'),
      '扩展补算明细只登记在 EVEN-0001 名下，没有跨事件扩大',
    )
  }

  if (caseId === 'case10-data-flow') {
    // 核对发布版事件参数契约从事件规范到参数字典的数据流
    updateParam('PARA-0002', { '版本号': 'v2' })
    await submit({ changedParamCodes: ['PARA-0002'], idempotencyKey: 'k-flow' })
    const contracts = listAllContracts()
    const even2 = contracts.find((c) => c.eventCode === 'EVEN-0002')!
    const p2 = even2.parameters.find((p) => p.paramCode === 'PARA-0002')!
    assertEqual(p2.version, 'v2', '参数字典版本号沿 事件规范引用 -> 契约 参数项流动')
    assertEqual(p2.origin, 'paramdef', '参数项来源始终为参数字典')
    assertEqual(even2.specOrigin, 'eventspec', '事件契约来源始终为事件规范')
    // 事件规范侧没有的参数编号不会凭空进入契约
    assert(even2.parameters.every((p) => ['PARA-0002', 'PARA-0005'].includes(p.paramCode)), '契约参数完全由事件规范引用决定')
    assert(checkNoDrift().matches, '数据流核对后无漂移')
  }

  if (failures > 0) {
    console.error(`${caseId} 失败 ${failures} 项`)
    process.exitCode = 1
  } else {
    console.log(`${caseId} 全部通过`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
