/**
 * 发布版事件参数契约存储与发布窗口控制。
 *
 * 发布窗口控制三件套：
 * 1. 幂等键：相同键的连续提交只写入一份增量发布，后到请求直接被拦住。
 * 2. 在途合并：同一发布窗口内命中相同受影响事件的刷新请求只保留一次有效重算，
 *    后到请求复用已校验结果，差异台账不会被重复追加。
 * 3. 内容签名：键不同但参数内容与已发布版本一致时同样跳过，覆盖率不随刷新漂移。
 */
import { listRows } from '../data/local-store'
import {
  buildEventContract,
  buildPublication,
  computeImpact,
  contractFingerprint,
  detectVersionConflict,
  diffContracts,
  mergeDiffLedger,
  normalizeEvents,
  normalizeParameters,
  rebuildContracts,
  snapshotVersion,
  stableHash,
} from './contract-engine'
import type {
  ContractDiff,
  ContractPublication,
  ContractReceipt,
  EventParameterContract,
  ParameterChangeResult,
} from './contract-types'

const STORAGE_KEY = 'behavior-event-trace-hub:event-param-contracts'
const BASELINE_KEY = 'baseline'

type ContractState = {
  contracts: EventParameterContract[]
  diffs: ContractDiff[]
  publications: ContractPublication[]
  nextPublicationId: number
  idempotencyKeys: string[]
  /** 每个参数最近一次进入发布时的内容签名，用于识别同版本重复提交。 */
  paramSignatures: Record<string, string>
}

type InflightJob = {
  key: string
  affectedCodes: string[]
  promise: Promise<ParameterChangeResult>
}

function paramSignature(input: {
  paramCode: string
  paramName: string
  paramType: string
  enumRange: string
  source: string
  anonymization: string
  version: string
  status: string
}): string {
  return stableHash(
    [
      input.paramCode,
      input.paramName,
      input.paramType,
      input.enumRange,
      input.source,
      input.anonymization,
      input.version,
      input.status,
    ].join('|'),
  )
}

function buildBaseline(): ContractState {
  const events = normalizeEvents(listRows('eventspec'))
  const parameters = normalizeParameters(listRows('paramdef'))
  const paramMap = new Map(parameters.map((item) => [item.paramCode, item]))
  const contracts = events.map((event) => buildEventContract(event, paramMap, 0))
  const signatures: Record<string, string> = {}
  for (const param of parameters) {
    signatures[param.paramCode] = paramSignature(param)
  }
  const contractMap = new Map(contracts.map((item) => [item.eventCode, item]))
  const baseline: ContractPublication = {
    publicationId: 0,
    idempotencyKey: BASELINE_KEY,
    changedParamCodes: [],
    affectedEventCodes: [],
    reusedEventCodes: contracts.map((item) => item.eventCode),
    mode: 'narrow',
    createdAt: new Date(0).toISOString(),
    snapshotVersion: snapshotVersion(contractMap),
  }
  return {
    contracts,
    diffs: [],
    publications: [baseline],
    nextPublicationId: 1,
    idempotencyKeys: [BASELINE_KEY],
    paramSignatures: signatures,
  }
}

function readState(): ContractState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return buildBaseline()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const baseline = buildBaseline()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline))
    return baseline
  }
  try {
    return JSON.parse(raw) as ContractState
  } catch {
    const baseline = buildBaseline()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline))
    return baseline
  }
}

function writeState(state: ContractState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

let cache: ContractState | null = null
const inflightJobs = new Map<string, InflightJob>()

function currentState(): ContractState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export type SubmitParameterChangeInput = {
  changedParamCodes: string[]
  idempotencyKey?: string
  mode?: 'narrow' | 'expand'
}

function defaultIdempotencyKey(changedParamCodes: string[]): string {
  return `param-change:${[...changedParamCodes].sort().join(',')}`
}

function blockedResult(
  key: string,
  message: string,
  state: ContractState,
  extra: { idempotent?: boolean; coalesced?: boolean; publicationId?: number | null; mode?: 'narrow' | 'expand' } = {},
): ParameterChangeResult {
  return {
    accepted: false,
    message,
    idempotent: extra.idempotent ?? false,
    coalesced: extra.coalesced ?? false,
    publicationId: extra.publicationId ?? null,
    idempotencyKey: key,
    affectedEventCodes: [],
    reusedEventCodes: state.contracts.map((item) => item.eventCode),
    mode: extra.mode ?? 'narrow',
    conflict: false,
    refreshDetails: [],
    backfillDetails: [],
    contracts: state.contracts,
    publication: null,
  }
}

/**
 * 参数字典变化入口：局部重建发布版事件参数契约。
 * 异步签名用于表达「发布请求」，内部重算过程是同步且串行安全的。
 */
export function submitParameterChange(
  input: SubmitParameterChangeInput,
): Promise<ParameterChangeResult> {
  const changedParamCodes = [...new Set(input.changedParamCodes)].filter(Boolean)
  if (changedParamCodes.length === 0) {
    return Promise.resolve(
      blockedResult(
        input.idempotencyKey ?? 'empty',
        '没有变化参数，未触发契约重算',
        currentState(),
      ),
    )
  }
  const key = input.idempotencyKey ?? defaultIdempotencyKey(changedParamCodes)
  const state = currentState()

  // 拦截点①：相同幂等键的连续提交只保留第一份。
  if (state.idempotencyKeys.includes(key)) {
    const previous = state.publications.find((item) => item.idempotencyKey === key) ?? null
    return Promise.resolve(
      blockedResult(
        key,
        '相同版本已提交过，增量发布只写入一份，后到请求已拦截',
        state,
        { idempotent: true, publicationId: previous?.publicationId ?? null },
      ),
    )
  }

  // 先按当前数据算出影响范围，用于在途合并判断。
  const events = normalizeEvents(listRows('eventspec'))
  const { affectedCodes } = computeImpact(events, changedParamCodes)

  // 拦截点②：同一发布窗口内已有覆盖这些事件的在途刷新，复用其已校验结果。
  const overlapping = [...inflightJobs.values()].find((job) =>
    job.affectedCodes.some((code) => affectedCodes.includes(code)),
  )
  if (overlapping) {
    return overlapping.promise.then((result) => ({
      ...result,
      // 后到请求本身不产生新的接受与写入，只复用已校验结果。
      accepted: false,
      coalesced: true,
      message: '同一发布窗口内已有有效重算，后到请求复用已校验结果，未重复追加差异项',
    }))
  }
  const sameKeyJob = inflightJobs.get(key)
  if (sameKeyJob) {
    return sameKeyJob.promise.then((result) => ({ ...result, accepted: false, coalesced: true }))
  }

  const promise = executeRecompute(key, changedParamCodes, input.mode ?? 'narrow')
  inflightJobs.set(key, { key, affectedCodes, promise })
  return promise.finally(() => {
    inflightJobs.delete(key)
  })
}

function executeRecompute(
  key: string,
  changedParamCodes: string[],
  mode: 'narrow' | 'expand',
): Promise<ParameterChangeResult> {
  try {
    const state = currentState()
    const events = normalizeEvents(listRows('eventspec'))
    const parameters = normalizeParameters(listRows('paramdef'))
    const paramMap = new Map(parameters.map((item) => [item.paramCode, item]))

    // 拦截点③：键不同但参数内容没有变化（同版本重复提交），不产生新发布。
    const realChanged = changedParamCodes.filter((code) => {
      const param = paramMap.get(code)
      if (!param) {
        return false
      }
      return state.paramSignatures[code] !== paramSignature(param)
    })
    if (realChanged.length === 0) {
      return Promise.resolve(
        blockedResult(key, '变化参数内容与已发布版本一致，跳过重复重算', state, {
          idempotent: true,
          mode,
        }),
      )
    }

    const previousMap = new Map(state.contracts.map((item) => [item.eventCode, item]))
    const { affected, affectedCodes, reusedCodes } = computeImpact(events, realChanged)
    const conflicts = detectVersionConflict(
      affected,
      paramMap,
      previousMap,
      realChanged,
    )

    const publicationId = state.nextPublicationId
    const rebuilt = rebuildContracts({
      events,
      parameters: paramMap,
      previousContracts: previousMap,
      changedParamCodes: realChanged,
      publicationId,
      mode,
      conflicts,
    })

    const incomingDiffs = diffContracts(
      previousMap,
      rebuilt.contracts,
      rebuilt.rebuiltCodes,
      publicationId,
    )
    const diffs = mergeDiffLedger(state.diffs, incomingDiffs)
    const nextContracts = [...rebuilt.contracts.values()]
    const publication = buildPublication({
      publicationId,
      idempotencyKey: key,
      changedParamCodes: realChanged,
      rebuiltCodes: rebuilt.rebuiltCodes,
      reusedCodes: rebuilt.reusedCodes,
      mode,
      contracts: rebuilt.contracts,
    })

    const nextSignatures = { ...state.paramSignatures }
    for (const code of realChanged) {
      const param = paramMap.get(code)
      if (param) {
        nextSignatures[code] = paramSignature(param)
      }
    }

    const nextState: ContractState = {
      contracts: nextContracts,
      diffs,
      publications: [...state.publications, publication],
      nextPublicationId: publicationId + 1,
      idempotencyKeys: [...state.idempotencyKeys, key],
      paramSignatures: nextSignatures,
    }
    writeState(nextState)

    return Promise.resolve({
      accepted: true,
      message:
        conflicts.size > 0
          ? `检测到参数版本冲突，已按${mode === 'narrow' ? '受影响事件缩小重算' : '参数版本扩展补算'}仲裁发布`
          : '参数字典局部重建完成，未变化事件继续复用原契约',
      idempotent: false,
      coalesced: false,
      publicationId,
      idempotencyKey: key,
      affectedEventCodes: rebuilt.rebuiltCodes,
      reusedEventCodes: rebuilt.reusedCodes.length > 0 ? rebuilt.reusedCodes : reusedCodes,
      mode,
      conflict: conflicts.size > 0,
      refreshDetails: rebuilt.refreshDetails,
      backfillDetails: rebuilt.backfillDetails,
      contracts: nextContracts,
      publication,
    })
  } catch (error) {
    return Promise.reject(error)
  }
}

/** 读取当前完整契约集：每次读取只对应一份完整契约版本（同一快照锚点）。 */
export function listContracts(): EventParameterContract[] {
  return currentState().contracts
}

export function getContract(eventCode: string): EventParameterContract | undefined {
  return currentState().contracts.find((item) => item.eventCode === eventCode)
}

export function listContractDiffs(): ContractDiff[] {
  return currentState().diffs
}

export function listPublications(): ContractPublication[] {
  return currentState().publications
}

export function getCoverageSummary(): {
  eventCount: number
  averageCoverage: number
  publishedParamCount: number
  totalParamCount: number
  snapshotVersion: string
} {
  const state = currentState()
  const allParams = state.contracts.flatMap((item) => item.parameters)
  const published = allParams.filter((item) => item.published).length
  const average =
    state.contracts.length === 0
      ? 0
      : state.contracts.reduce((sum, item) => sum + item.coverage, 0) / state.contracts.length
  return {
    eventCount: state.contracts.length,
    averageCoverage: average,
    publishedParamCount: published,
    totalParamCount: allParams.length,
    snapshotVersion: snapshotVersion(new Map(state.contracts.map((item) => [item.eventCode, item]))),
  }
}

/**
 * 跨模块回执：事件规范模块按事件编号读取埋点事件契约，
 * 事件契约来源（eventspec）与参数来源（paramdef）原样保留。
 */
export function getCrossModuleReceipt(eventCode: string): ContractReceipt | null {
  const contract = getContract(eventCode)
  if (!contract) {
    return null
  }
  return {
    eventCode: contract.eventCode,
    contractVersion: contract.contractVersion,
    coverage: contract.coverage,
    specOrigin: 'eventspec',
    paramOrigin: 'paramdef',
    parameters: contract.parameters,
    publicationId: contract.rebuiltInPublication,
  }
}

/**
 * 漂移自检：用当前事件规范 + 参数字典从零全量重算，
 * 与存储的局部重建结果逐事件核对契约版本与覆盖率。
 */
export function verifyNoDrift(): {
  matches: boolean
  snapshotVersion: string
  details: { eventCode: string; storedVersion: string; freshVersion: string; sameCoverage: boolean }[]
} {
  const state = currentState()
  const events = normalizeEvents(listRows('eventspec'))
  const parameters = normalizeParameters(listRows('paramdef'))
  const paramMap = new Map(parameters.map((item) => [item.paramCode, item]))
  const storedMap = new Map(state.contracts.map((item) => [item.eventCode, item]))
  const details = events.map((event) => {
    const stored = storedMap.get(event.eventCode)
    const fresh = buildEventContract(event, paramMap, stored?.rebuiltInPublication ?? 0)
    return {
      eventCode: event.eventCode,
      storedVersion: stored?.contractVersion ?? '',
      freshVersion: fresh.contractVersion,
      sameCoverage: stored ? Math.abs(stored.coverage - fresh.coverage) < 1e-9 : false,
    }
  })
  const freshMap = new Map(
    events.map((event) => [
      event.eventCode,
      buildEventContract(event, paramMap, storedMap.get(event.eventCode)?.rebuiltInPublication ?? 0),
    ]),
  )
  return {
    matches: details.every((item) => item.storedVersion === item.freshVersion && item.sameCoverage),
    snapshotVersion: snapshotVersion(freshMap),
    details,
  }
}

/** 仅供核对数据流：返回当前事件/参数归一化视图与每个事件的契约指纹。 */
export function inspectDataFlow(): {
  events: ReturnType<typeof normalizeEvents>
  parameters: ReturnType<typeof normalizeParameters>
  fingerprints: { eventCode: string; fingerprint: string }[]
} {
  const events = normalizeEvents(listRows('eventspec'))
  const parameters = normalizeParameters(listRows('paramdef'))
  const paramMap = new Map(parameters.map((item) => [item.paramCode, item]))
  return {
    events,
    parameters,
    fingerprints: events.map((event) => ({
      eventCode: event.eventCode,
      fingerprint: contractFingerprint(event, paramMap),
    })),
  }
}

export function resetContracts(): void {
  // 清掉缓存并移除持久化数据；下一次访问会基于当前事件规范/参数字典重建基线，
  // 避免基线在数据重新播种之前构建而持有过期的参数内容签名。
  cache = null
  inflightJobs.clear()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  // 立即按当前数据重建基线，保证后续第一次参数变化能被正确识别。
  cache = readState()
}

export function contractStorageKey(): string {
  return STORAGE_KEY
}
