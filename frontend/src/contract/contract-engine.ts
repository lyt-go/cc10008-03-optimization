/**
 * 发布版事件参数契约引擎（纯函数，不依赖浏览器与持久化，可直接被 Node 脚本验证）。
 *
 * 优化点对应关系：
 * - 影响范围最小化：{@link computeImpact} 只挑出引用了变化参数的事件，其余事件复用旧完整结果。
 * - 局部重建：{@link rebuildContracts} 未变化的事件定义继续复用原契约对象与版本，覆盖率不漂移。
 * - 差异项去重：{@link diffContracts} 用稳定 diffId 记账，重复重算不会重复追加。
 * - 版本冲突仲裁：{@link detectVersionConflict} + narrow/expand 两种仲裁，各自产出明细。
 */
import type { EntryRow } from '../data/types'
import type {
  AffectedEventRefreshDetail,
  ContractDiff,
  ContractParameter,
  ContractPublication,
  CrossVersionBackfillDetail,
  EventDefinition,
  EventParameterContract,
  ParameterDefinition,
} from './contract-types'

const EVENT_CODE = '事件编号'
const EVENT_NAME = '事件名称'
const EVENT_CATEGORY = '事件类别'
const EVENT_PARAMS = '参数定义'
const PARAM_CODE = '参数编号'
const PARAM_NAME = '参数名称'
const PARAM_TYPE = '参数类型'
const PARAM_ENUM = '枚举范围'
const PARAM_OWNER = '所属事件'
const PARAM_SOURCE = '数据来源'
const PARAM_ANON = '匿名化处理'
const PARAM_VERSION = '版本号'

/** 逗号/中文逗号/分号/空白都算引用分隔符。 */
function splitRefs(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function dedupeOrdered(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item)
      result.push(item)
    }
  }
  return result
}

/** 事件定义处理点①：把事件规范模块的行数据归一化成契约引擎的事件定义视图。 */
export function normalizeEvents(rows: EntryRow[]): EventDefinition[] {
  return rows.map((row) => ({
    eventCode: String(row[EVENT_CODE] ?? ''),
    eventName: String(row[EVENT_NAME] ?? ''),
    category: String(row[EVENT_CATEGORY] ?? ''),
    paramRefs: dedupeOrdered(splitRefs(row[EVENT_PARAMS])),
    status: String(row.status ?? ''),
  }))
}

/** 事件定义处理点②：把参数字典模块的行数据归一化成参数定义视图。 */
export function normalizeParameters(rows: EntryRow[]): ParameterDefinition[] {
  return rows.map((row) => ({
    paramCode: String(row[PARAM_CODE] ?? ''),
    paramName: String(row[PARAM_NAME] ?? ''),
    paramType: String(row[PARAM_TYPE] ?? ''),
    enumRange: String(row[PARAM_ENUM] ?? ''),
    ownerEvents: dedupeOrdered(splitRefs(row[PARAM_OWNER])),
    source: String(row[PARAM_SOURCE] ?? ''),
    anonymization: String(row[PARAM_ANON] ?? ''),
    version: String(row[PARAM_VERSION] ?? ''),
    status: String(row.status ?? ''),
  }))
}

/** 稳定字符串哈希（FNV-1a 32 位），相同内容永远得到相同契约版本。 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 契约内容指纹：只由事件规范引用 + 参数字典内容决定，与刷新次数无关。 */
export function contractFingerprint(
  event: EventDefinition,
  parameters: Map<string, ParameterDefinition>,
): string {
  const payload = event.paramRefs.map((code) => {
    const param = parameters.get(code)
    if (!param) {
      return `${code}#missing`
    }
    return [
      code,
      param.paramName,
      param.paramType,
      param.enumRange,
      param.source,
      param.anonymization,
      param.version,
      param.status,
    ].join('|')
  })
  return stableHash([event.eventCode, event.eventName, event.category, ...payload].join('::'))
}

function buildContractParameters(
  event: EventDefinition,
  parameters: Map<string, ParameterDefinition>,
): ContractParameter[] {
  return event.paramRefs.map((code) => {
    const param = parameters.get(code)
    return {
      paramCode: code,
      paramName: param?.paramName ?? '',
      paramType: param?.paramType ?? '',
      enumRange: param?.enumRange ?? '',
      source: param?.source ?? '',
      anonymization: param?.anonymization ?? '',
      version: param?.version ?? '',
      published: param?.status === '已发布',
      origin: 'paramdef' as const,
    }
  })
}

/** 事件定义处理点③：为单个事件构建一份完整契约（局部重建的最小单元）。 */
export function buildEventContract(
  event: EventDefinition,
  parameters: Map<string, ParameterDefinition>,
  rebuiltInPublication: number,
): EventParameterContract {
  const contractParams = buildContractParameters(event, parameters)
  const publishedCount = contractParams.filter((item) => item.published).length
  const coverage = contractParams.length === 0 ? 0 : publishedCount / contractParams.length
  return {
    eventCode: event.eventCode,
    eventName: event.eventName,
    category: event.category,
    parameters: contractParams,
    coverage,
    contractVersion: contractFingerprint(event, parameters),
    specOrigin: 'eventspec',
    rebuiltInPublication,
  }
}

/**
 * 影响范围计算：只有「引用了变化参数」的事件才需要重算。
 * 未命中的事件继续使用原有完整结果，不进入本次发布。
 */
export function computeImpact(
  events: EventDefinition[],
  changedParamCodes: string[],
): { affected: EventDefinition[]; affectedCodes: string[]; reusedCodes: string[] } {
  const changed = new Set(changedParamCodes)
  const affected = events.filter((event) => event.paramRefs.some((code) => changed.has(code)))
  const affectedCodes = affected.map((event) => event.eventCode)
  const affectedSet = new Set(affectedCodes)
  const reusedCodes = events
    .map((event) => event.eventCode)
    .filter((code) => !affectedSet.has(code))
  return { affected, affectedCodes, reusedCodes }
}

/**
 * 检测迟到参数更正：提交的参数版本与事件当前契约登记的版本不一致即冲突。
 * 基线契约（rebuiltInPublication === 0）不算发布窗口冲突，只有历史增量发布过的契约才参与仲裁。
 */
export function detectVersionConflict(
  affectedEvents: EventDefinition[],
  parameters: Map<string, ParameterDefinition>,
  previousContracts: Map<string, EventParameterContract>,
  changedParamCodes: string[],
): Map<string, Map<string, { fromVersion: string; toVersion: string }>> {
  const changed = new Set(changedParamCodes)
  const conflicts = new Map<string, Map<string, { fromVersion: string; toVersion: string }>>()
  for (const event of affectedEvents) {
    const previous = previousContracts.get(event.eventCode)
    if (!previous || previous.rebuiltInPublication === 0) {
      continue
    }
    const perEvent = new Map<string, { fromVersion: string; toVersion: string }>()
    for (const code of event.paramRefs) {
      if (!changed.has(code)) {
        continue
      }
      const previousParam = previous.parameters.find((item) => item.paramCode === code)
      const nextParam = parameters.get(code)
      const fromVersion = previousParam?.version ?? ''
      const toVersion = nextParam?.version ?? ''
      if (fromVersion !== toVersion) {
        perEvent.set(code, { fromVersion, toVersion })
      }
    }
    if (perEvent.size > 0) {
      conflicts.set(event.eventCode, perEvent)
    }
  }
  return conflicts
}

/**
 * 参数字典局部重建发布版事件参数契约。
 * - narrow：仅重建受影响事件（默认，按受影响事件缩小重算）。
 * - expand：受影响事件之外，把同样登记了冲突参数版本的事件一起补算（按参数版本扩展补算）。
 * 未变化的事件定义继续复用旧契约对象与契约版本。
 */
export function rebuildContracts(input: {
  events: EventDefinition[]
  parameters: Map<string, ParameterDefinition>
  previousContracts: Map<string, EventParameterContract>
  changedParamCodes: string[]
  publicationId: number
  mode: 'narrow' | 'expand'
  conflicts: Map<string, Map<string, { fromVersion: string; toVersion: string }>>
}): {
  contracts: Map<string, EventParameterContract>
  refreshDetails: AffectedEventRefreshDetail[]
  backfillDetails: CrossVersionBackfillDetail[]
  rebuiltCodes: string[]
  reusedCodes: string[]
} {
  const { events, parameters, previousContracts, changedParamCodes, publicationId, mode, conflicts } =
    input
  const { affected, affectedCodes } = computeImpact(events, changedParamCodes)
  const rebuiltSet = new Set(affectedCodes)
  const backfillDetails: CrossVersionBackfillDetail[] = []

  if (mode === 'expand') {
    // 按参数版本扩展补算分两步：
    // 1) 受影响事件内每个冲突参数版本对都登记一条跨版本兼容补算明细；
    // 2) 参数字典侧登记了归属、但事件规范未直接引用该参数的事件，一并纳入重算窗口补算。
    for (const [eventCode, perEvent] of conflicts) {
      for (const [paramCode, versions] of perEvent) {
        backfillDetails.push({
          eventCode,
          paramCode,
          fromVersion: versions.fromVersion,
          toVersion: versions.toVersion,
          reason: 'late-param-correction',
        })
      }
    }
    const conflictParams = new Set<string>()
    for (const perEvent of conflicts.values()) {
      for (const code of perEvent.keys()) {
        conflictParams.add(code)
      }
    }
    for (const paramCode of conflictParams) {
      const param = parameters.get(paramCode)
      if (!param) {
        continue
      }
      for (const ownerEventCode of param.ownerEvents) {
        if (rebuiltSet.has(ownerEventCode)) {
          continue
        }
        const ownerEvent = events.find((event) => event.eventCode === ownerEventCode)
        if (!ownerEvent) {
          continue
        }
        rebuiltSet.add(ownerEventCode)
        const versions = [...conflicts.values()]
          .map((perEvent) => perEvent.get(paramCode))
          .find((item): item is { fromVersion: string; toVersion: string } => Boolean(item))
        backfillDetails.push({
          eventCode: ownerEventCode,
          paramCode,
          fromVersion: versions?.fromVersion ?? '',
          toVersion: versions?.toVersion ?? param.version,
          reason: 'late-param-correction',
        })
      }
    }
  }

  const contracts = new Map<string, EventParameterContract>()
  const refreshDetails: AffectedEventRefreshDetail[] = []
  const reusedCodes: string[] = []

  for (const event of events) {
    const previous = previousContracts.get(event.eventCode)
    if (!rebuiltSet.has(event.eventCode)) {
      // 未变化的事件定义继续复用原有完整结果（同一对象、同一契约版本）。
      if (previous) {
        contracts.set(event.eventCode, previous)
        reusedCodes.push(event.eventCode)
      } else {
        contracts.set(event.eventCode, buildEventContract(event, parameters, publicationId))
      }
      continue
    }
    const next = buildEventContract(event, parameters, publicationId)
    contracts.set(event.eventCode, next)
    const changedParams = event.paramRefs.filter((code) =>
      changedParamCodes.includes(code),
    )
    refreshDetails.push({
      eventCode: event.eventCode,
      previousContractVersion: previous?.contractVersion ?? '',
      nextContractVersion: next.contractVersion,
      changedParams,
      reused: false,
    })
  }

  return {
    contracts,
    refreshDetails,
    backfillDetails,
    rebuiltCodes: [...rebuiltSet],
    reusedCodes,
  }
}

/** 契约差异记账：稳定 diffId 去重，同事件同参数同类型变化只保留一条。 */
export function diffContracts(
  previousContracts: Map<string, EventParameterContract>,
  nextContracts: Map<string, EventParameterContract>,
  rebuiltCodes: string[],
  publicationId: number,
): ContractDiff[] {
  const diffs: ContractDiff[] = []
  const push = (
    eventCode: string,
    paramCode: string,
    changeType: ContractDiff['changeType'],
    fromVersion: string | null,
    toVersion: string | null,
  ) => {
    diffs.push({
      diffId: stableHash([eventCode, paramCode, changeType].join('::')),
      eventCode,
      paramCode,
      changeType,
      fromVersion,
      toVersion,
      publicationId,
    })
  }

  for (const eventCode of rebuiltCodes) {
    const previous = previousContracts.get(eventCode)
    const next = nextContracts.get(eventCode)
    if (!next) {
      continue
    }
    const previousParams = new Map(previous?.parameters.map((item) => [item.paramCode, item]) ?? [])
    const nextParams = new Map(next.parameters.map((item) => [item.paramCode, item]))

    for (const [code, nextParam] of nextParams) {
      const previousParam = previousParams.get(code)
      if (!previousParam) {
        push(eventCode, code, 'added', null, nextParam.version || null)
      } else if (previousParam.version !== nextParam.version) {
        push(
          eventCode,
          code,
          'version-changed',
          previousParam.version || null,
          nextParam.version || null,
        )
      } else if (previousParam.published !== nextParam.published) {
        push(
          eventCode,
          code,
          'publish-state-changed',
          previousParam.version || null,
          nextParam.version || null,
        )
      }
    }
    for (const [code, previousParam] of previousParams) {
      if (!nextParams.has(code)) {
        push(eventCode, code, 'removed', previousParam.version || null, null)
      }
    }
  }
  return diffs
}

/** 合并差异台账：按稳定 diffId 去重，已存在的差异项不重复追加。 */
export function mergeDiffLedger(existing: ContractDiff[], incoming: ContractDiff[]): ContractDiff[] {
  const known = new Set(existing.map((item) => item.diffId))
  const merged = [...existing]
  for (const diff of incoming) {
    if (!known.has(diff.diffId)) {
      known.add(diff.diffId)
      merged.push(diff)
    }
  }
  return merged
}

/** 整套契约的版本锚点：每次读取只对应一份完整契约版本。 */
export function snapshotVersion(contracts: Map<string, EventParameterContract>): string {
  const ordered = [...contracts.values()]
    .map((contract) => `${contract.eventCode}=${contract.contractVersion}`)
    .sort()
  return stableHash(ordered.join('|'))
}

export function buildPublication(input: {
  publicationId: number
  idempotencyKey: string
  changedParamCodes: string[]
  rebuiltCodes: string[]
  reusedCodes: string[]
  mode: 'narrow' | 'expand'
  contracts: Map<string, EventParameterContract>
}): ContractPublication {
  return {
    publicationId: input.publicationId,
    idempotencyKey: input.idempotencyKey,
    changedParamCodes: input.changedParamCodes,
    affectedEventCodes: input.rebuiltCodes,
    reusedEventCodes: input.reusedCodes,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    snapshotVersion: snapshotVersion(input.contracts),
  }
}
