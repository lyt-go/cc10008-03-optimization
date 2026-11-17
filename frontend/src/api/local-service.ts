import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  getContract,
  getCoverageSummary,
  getCrossModuleReceipt,
  inspectDataFlow,
  listContractDiffs,
  listContracts,
  listPublications,
  resetContracts,
  submitParameterChange,
  verifyNoDrift,
} from '@/contract/contract-store'
import type {
  ContractReceipt,
  ParameterChangeResult,
} from '@/contract/contract-types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 发布版事件参数契约：参数字典 -> 局部重建 -> 增量发布，统一在服务层写状态。
// ---------------------------------------------------------------------------

const PARAM_FIELDS = [
  '参数名称',
  '参数类型',
  '枚举范围',
  '所属事件',
  '数据来源',
  '匿名化处理',
  '版本号',
] as const
type ParamPatch = Partial<Record<(typeof PARAM_FIELDS)[number], string>>

/**
 * 修改参数字典中的一个参数，并触发发布版事件参数契约的局部重建。
 * 页面不直接拼契约逻辑，只把参数补丁与幂等键交进来。
 */
export async function updateParameterDefinition(input: {
  paramCode: string
  patch: ParamPatch
  idempotencyKey?: string
  mode?: 'narrow' | 'expand'
}): Promise<ParameterChangeResult> {
  const rows = listRows('paramdef')
  const index = rows.findIndex((row) => String(row['参数编号']) === input.paramCode)
  if (index < 0) {
    throw new Error(`参数字典中没有编号为 ${input.paramCode} 的参数定义`)
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...input.patch }
  saveRows('paramdef', next)
  return submitParameterChange({
    changedParamCodes: [input.paramCode],
    idempotencyKey: input.idempotencyKey,
    mode: input.mode,
  })
}

export function getEventParameterContracts() {
  return listContracts()
}

export function getEventParameterContract(eventCode: string) {
  return getContract(eventCode)
}

export function getContractDiffLedger() {
  return listContractDiffs()
}

export function getContractPublications() {
  return listPublications()
}

export function getContractCoverage() {
  return getCoverageSummary()
}

/** 跨模块回执：事件规范模块读取埋点事件契约，保留 eventspec/paramdef 双来源。 */
export function fetchContractReceipt(eventCode: string): ContractReceipt | null {
  return getCrossModuleReceipt(eventCode)
}

export function checkContractDrift() {
  return verifyNoDrift()
}

export function traceContractDataFlow() {
  return inspectDataFlow()
}

export function resetEventParameterContracts(): ActionResult {
  resetContracts()
  resetRows('paramdef')
  resetRows('eventspec')
  return { ok: true, message: '契约状态与事件规范/参数字典已回到示例基线' }
}
