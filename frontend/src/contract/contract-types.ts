/**
 * 发布版事件参数契约领域类型。
 *
 * 数据流：事件规范（eventspec，声明事件引用了哪些参数）
 *   -> 参数字典（paramdef，参数定义的标准化字典，携带参数版本号）
 *   -> 发布版事件参数契约（contract，按事件聚合的已发布完整契约）。
 */

/** 事件定义处理点：事件规范模块中参与契约构建的归一化视图。 */
export type EventDefinition = {
  eventCode: string
  eventName: string
  category: string
  /** 事件规范「参数定义」字段里引用的参数编号，按出现顺序去重。 */
  paramRefs: string[]
  status: string
}

/** 参数字典中单个参数定义的归一化视图。 */
export type ParameterDefinition = {
  paramCode: string
  paramName: string
  paramType: string
  enumRange: string
  /** 参数字典侧登记的归属事件，仅用于反向核对，不参与契约引用判定。 */
  ownerEvents: string[]
  source: string
  anonymization: string
  /** 参数版本号，迟到参数更正与并发刷新都按它做版本仲裁。 */
  version: string
  status: string
}

/** 契约里的单个参数项，来源保留为参数字典（paramdef）。 */
export type ContractParameter = {
  paramCode: string
  paramName: string
  paramType: string
  enumRange: string
  source: string
  anonymization: string
  version: string
  published: boolean
  /** 契约来源：始终指向参数字典模块，跨模块回执原样保留。 */
  origin: 'paramdef'
}

/** 已发布事件参数契约：一个事件对应一份完整契约。 */
export type EventParameterContract = {
  eventCode: string
  eventName: string
  category: string
  /** 契约内参数顺序与事件规范引用顺序一致。 */
  parameters: ContractParameter[]
  /** 已发布参数覆盖率：已发布参数项 / 引用参数项，0~1。 */
  coverage: number
  /** 契约版本：由契约内容指纹决定，内容不变则版本不变。 */
  contractVersion: string
  /** 事件规范来源，跨模块回执原样保留。 */
  specOrigin: 'eventspec'
  /** 该契约最近一次被局部重建的发布批次号；未变化的事件复用旧值。 */
  rebuiltInPublication: number
}

/** 参数契约差异项：记录某次发布相对上一份完整契约的变化。 */
export type ContractDiff = {
  /** 稳定差异编号：同一事件同一参数同一变化类型只保留一条，重复提交不会追加。 */
  diffId: string
  eventCode: string
  paramCode: string
  changeType: 'added' | 'removed' | 'version-changed' | 'publish-state-changed'
  fromVersion: string | null
  toVersion: string | null
  publicationId: number
}

/** 一份「增量更新的发布版事件参数契约数据」：每次有效重算只写一份。 */
export type ContractPublication = {
  publicationId: number
  /** 幂等键：相同幂等键的连续提交只保留第一份。 */
  idempotencyKey: string
  changedParamCodes: string[]
  /** 本次实际局部重建的事件（影响范围）。 */
  affectedEventCodes: string[]
  /** 未引用变化参数、直接复用旧完整结果的事件。 */
  reusedEventCodes: string[]
  mode: 'narrow' | 'expand'
  createdAt: string
  /** 本次发布后整套契约的版本锚点，读取时每次只对应这一份完整版本。 */
  snapshotVersion: string
}

/** 受影响事件局部刷新明细（narrow 仲裁产物）。 */
export type AffectedEventRefreshDetail = {
  eventCode: string
  previousContractVersion: string
  nextContractVersion: string
  changedParams: string[]
  reused: boolean
}

/** 跨版本参数兼容补算明细（expand 仲裁产物）。 */
export type CrossVersionBackfillDetail = {
  eventCode: string
  paramCode: string
  fromVersion: string
  toVersion: string
  /** 补算原因：参数版本晚于事件当前契约里登记的版本。 */
  reason: 'late-param-correction'
}

/** 参数字典局部重建提交结果。 */
export type ParameterChangeResult = {
  accepted: boolean
  message: string
  idempotent: boolean
  coalesced: boolean
  publicationId: number | null
  idempotencyKey: string
  affectedEventCodes: string[]
  reusedEventCodes: string[]
  mode: 'narrow' | 'expand'
  conflict: boolean
  refreshDetails: AffectedEventRefreshDetail[]
  backfillDetails: CrossVersionBackfillDetail[]
  contracts: EventParameterContract[]
  publication: ContractPublication | null
}

/** 跨模块回执：事件规范模块读取本模块产出的契约时返回。 */
export type ContractReceipt = {
  eventCode: string
  contractVersion: string
  coverage: number
  /** 埋点事件契约来源：事件规范。 */
  specOrigin: 'eventspec'
  /** 埋点事件契约里每个参数项的来源：参数字典。 */
  paramOrigin: 'paramdef'
  parameters: ContractParameter[]
  publicationId: number | null
}
