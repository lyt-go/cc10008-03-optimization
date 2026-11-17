<template>
  <section class="page" data-module="contract-center">
    <header class="page-head">
      <div>
        <h2>发布版事件参数契约</h2>
        <p class="page-desc">
          参数字典变化后按受影响事件局部重建契约，未引用变化参数的事件继续复用原有完整结果；
          连续提交按幂等键只保留一份增量发布。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runDriftCheck">漂移自检</button>
        <button class="btn ghost" type="button" @click="resetAll">回到基线</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="submitChange">
      <label class="filter-item">
        <span>参数编号</span>
        <select v-model="form.paramCode">
          <option value="" disabled>选择参数字典中的参数</option>
          <option v-for="param in parameters" :key="param.paramCode" :value="param.paramCode">
            {{ param.paramCode }} · {{ param.paramName }}（当前 {{ param.version }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>新版本号</span>
        <input v-model="form.version" placeholder="如 v2" />
      </label>
      <label class="filter-item">
        <span>参数类型</span>
        <input v-model="form.paramType" placeholder="留空表示不改类型" />
      </label>
      <label class="filter-item">
        <span>幂等键</span>
        <input v-model="form.idempotencyKey" placeholder="留空自动生成" />
      </label>
      <label class="filter-item">
        <span>冲突仲裁</span>
        <select v-model="form.mode">
          <option value="narrow">按受影响事件缩小重算</option>
          <option value="expand">按参数版本扩展补算</option>
        </select>
      </label>
      <button class="btn primary" type="submit">提交参数变化并局部重建</button>
    </form>

    <p v-if="message" class="status-legend">
      <span class="legend-item">{{ message }}</span>
      <span v-if="lastResult" class="legend-item">
        受影响事件：{{ lastResult.affectedEventCodes.join('、') || '无' }} ｜
        复用事件：{{ lastResult.reusedEventCodes.join('、') || '无' }}
      </span>
    </p>

    <h3 class="section-title">当前完整契约（每次读取对应同一份快照 {{ coverage.snapshotVersion }}）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>事件编号</th>
          <th>事件名称</th>
          <th>契约参数（来源：参数字典）</th>
          <th>已发布覆盖率</th>
          <th>契约版本</th>
          <th>最近重建批次</th>
          <th>跨模块回执</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="contract in contracts" :key="contract.eventCode">
          <td>{{ contract.eventCode }}</td>
          <td>{{ contract.eventName }}</td>
          <td>
            <span v-for="param in contract.parameters" :key="param.paramCode" class="param-chip">
              {{ param.paramCode }}@{{ param.version || '空' }}
              <em :class="param.published ? 'pub-on' : 'pub-off'">
                {{ param.published ? '已发布' : '未发布' }}
              </em>
            </span>
          </td>
          <td>{{ (contract.coverage * 100).toFixed(1) }}%</td>
          <td>{{ contract.contractVersion }}</td>
          <td>#{{ contract.rebuiltInPublication }}</td>
          <td>
            <button class="link" type="button" @click="loadReceipt(contract.eventCode)">
              取回执（来源 {{ contract.specOrigin }}）
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="receipt" class="receipt-box">
      <h3 class="section-title">
        跨模块回执 · {{ receipt.eventCode }} · 契约版本 {{ receipt.contractVersion }}
      </h3>
      <p class="status-legend">
        <span class="legend-item">埋点事件契约来源：{{ receipt.specOrigin }}</span>
        <span class="legend-item">参数契约来源：{{ receipt.paramOrigin }}</span>
        <span class="legend-item">覆盖率：{{ (receipt.coverage * 100).toFixed(1) }}%</span>
        <span class="legend-item">发布批次：#{{ receipt.publicationId ?? 0 }}</span>
      </p>
      <ul class="receipt-list">
        <li v-for="param in receipt.parameters" :key="param.paramCode">
          {{ param.paramCode }}（{{ param.paramName }}，{{ param.paramType }}）版本 {{ param.version || '空' }}
          —— 来源 {{ param.origin }}
        </li>
      </ul>
    </div>

    <h3 class="section-title">差异台账（稳定差异编号去重，重复提交不追加）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>差异编号</th>
          <th>事件编号</th>
          <th>参数编号</th>
          <th>变化类型</th>
          <th>原版本</th>
          <th>新版本</th>
          <th>发布批次</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="diff in diffs" :key="diff.diffId">
          <td>{{ diff.diffId }}</td>
          <td>{{ diff.eventCode }}</td>
          <td>{{ diff.paramCode }}</td>
          <td>{{ diff.changeType }}</td>
          <td>{{ diff.fromVersion ?? '—' }}</td>
          <td>{{ diff.toVersion ?? '—' }}</td>
          <td>#{{ diff.publicationId }}</td>
        </tr>
        <tr v-if="!diffs.length">
          <td colspan="7" class="empty-state">暂无差异项</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">增量发布记录（连续提交只写入一份）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次</th>
          <th>幂等键</th>
          <th>变化参数</th>
          <th>局部重建事件</th>
          <th>复用事件</th>
          <th>仲裁方式</th>
          <th>快照版本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="publication in publications" :key="publication.publicationId">
          <td>#{{ publication.publicationId }}</td>
          <td>{{ publication.idempotencyKey }}</td>
          <td>{{ publication.changedParamCodes.join('、') || '基线' }}</td>
          <td>{{ publication.affectedEventCodes.join('、') || '—' }}</td>
          <td>{{ publication.reusedEventCodes.join('、') || '—' }}</td>
          <td>{{ publication.mode === 'narrow' ? '缩小重算' : '扩展补算' }}</td>
          <td>{{ publication.snapshotVersion }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，契约与参数字典分开持久化</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  checkContractDrift,
  fetchContractReceipt,
  getContractCoverage,
  getContractDiffLedger,
  getContractPublications,
  getEventParameterContracts,
  resetEventParameterContracts,
  traceContractDataFlow,
  updateParameterDefinition,
} from '@/api/local-service'
import type {
  ContractPublication,
  ContractReceipt,
  EventParameterContract,
  ParameterChangeResult,
} from '@/contract/contract-types'
import type { ContractDiff } from '@/contract/contract-types'

const contracts = ref<EventParameterContract[]>([])
const diffs = ref<ContractDiff[]>([])
const publications = ref<ContractPublication[]>([])
const receipt = ref<ContractReceipt | null>(null)
const message = ref('')
const errorMessage = ref('')
const lastResult = ref<ParameterChangeResult | null>(null)
const parameters = ref<{ paramCode: string; paramName: string; version: string }[]>([])

const form = reactive({
  paramCode: '',
  version: '',
  paramType: '',
  idempotencyKey: '',
  mode: 'narrow' as 'narrow' | 'expand',
})

const coverage = ref(getContractCoverage())
const stats = computed(() => [
  { label: '契约事件数', value: contracts.value.length },
  { label: '平均已发布覆盖率', value: `${(coverage.value.averageCoverage * 100).toFixed(1)}%` },
  { label: '差异项条数', value: diffs.value.length },
  { label: '增量发布份数', value: Math.max(publications.value.length - 1, 0) },
])

function reload() {
  contracts.value = getEventParameterContracts()
  diffs.value = getContractDiffLedger()
  publications.value = getContractPublications()
  coverage.value = getContractCoverage()
  const flow = traceContractDataFlow()
  parameters.value = flow.parameters.map((item) => ({
    paramCode: item.paramCode,
    paramName: item.paramName,
    version: item.version,
  }))
}

async function submitChange() {
  errorMessage.value = ''
  if (!form.paramCode) {
    errorMessage.value = '请先选择要修改的参数'
    return
  }
  try {
    const patch: Record<string, string> = {}
    if (form.version.trim()) {
      patch['版本号'] = form.version.trim()
    }
    if (form.paramType.trim()) {
      patch['参数类型'] = form.paramType.trim()
    }
    if (Object.keys(patch).length === 0) {
      errorMessage.value = '至少填写新版本号或新参数类型'
      return
    }
    const result = await updateParameterDefinition({
      paramCode: form.paramCode,
      patch,
      idempotencyKey: form.idempotencyKey.trim() || undefined,
      mode: form.mode,
    })
    lastResult.value = result
    message.value = result.message
    form.version = ''
    form.paramType = ''
    form.idempotencyKey = ''
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参数变化提交失败'
  }
}

function loadReceipt(eventCode: string) {
  receipt.value = fetchContractReceipt(eventCode)
}

function runDriftCheck() {
  const report = checkContractDrift()
  message.value = report.matches
    ? `漂移自检通过：局部重建结果与全量重算完全一致（快照 ${report.snapshotVersion}）`
    : '漂移自检发现契约版本或覆盖率不一致'
}

function resetAll() {
  resetEventParameterContracts()
  receipt.value = null
  lastResult.value = null
  message.value = '已回到示例基线'
  reload()
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  margin: 20px 0 8px;
  font-size: 15px;
}

.param-chip {
  display: inline-block;
  margin: 2px 6px 2px 0;
  padding: 2px 8px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 12px;
  font-size: 12px;
  white-space: nowrap;
}

.param-chip em {
  margin-left: 4px;
  font-style: normal;
}

.pub-on {
  color: #1a7f37;
}

.pub-off {
  color: #b26a00;
}

.receipt-box {
  margin: 12px 0;
  padding: 12px 16px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 8px;
}

.receipt-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
</style>
