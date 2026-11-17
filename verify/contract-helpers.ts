/**
 * 测试辅助：在 Node 里补齐 localStorage 垫片，并把契约存储 API 收敛成简单函数。
 */
class MemoryStorage {
  private map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
Object.assign(globalThis, {
  window: { localStorage: storage },
  localStorage: storage,
})

import { listRows, saveRows } from '../frontend/src/data/local-store'
import { SEED_ROWS } from '../frontend/src/data/seed'
import type { EntryRow } from '../frontend/src/data/types'
import {
  getContract,
  getCrossModuleReceipt,
  listContractDiffs,
  listContracts,
  listPublications,
  resetContracts,
  submitParameterChange,
  verifyNoDrift,
} from '../frontend/src/contract/contract-store'

export function reset(): void {
  resetContracts()
  for (const key of Object.keys(SEED_ROWS)) {
    saveRows(key, JSON.parse(JSON.stringify(SEED_ROWS[key])) as EntryRow[])
  }
  // 重新播种后清掉契约缓存，让基线按新数据重建。
  resetContracts()
}

export function updateParam(paramCode: string, patch: Record<string, string>): void {
  const current = listRows('paramdef')
  const index = current.findIndex((row) => String(row['参数编号']) === paramCode)
  if (index < 0) {
    throw new Error(`测试参数 ${paramCode} 不存在`)
  }
  const next = [...current]
  next[index] = { ...current[index], ...patch }
  saveRows('paramdef', next)
}

export function submit(input: {
  changedParamCodes: string[]
  idempotencyKey?: string
  mode?: 'narrow' | 'expand'
}) {
  return submitParameterChange(input)
}

export function listAllContracts() {
  return listContracts()
}

export function getLedger() {
  return listContractDiffs()
}

export function getPublications() {
  return listPublications()
}

export function getReceipt(eventCode: string) {
  return getCrossModuleReceipt(eventCode)
}

export function getOne(eventCode: string) {
  return getContract(eventCode)
}

export function checkNoDrift() {
  return verifyNoDrift()
}
