<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">
          维护仪器检定记录，提供临期与不合格仪器视图，按有效期、检定结论和使用站点排列并生成送检清单；已停用仪器不再提示。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记仪器检定记录</button>
        <button class="btn" type="button" :disabled="acting" @click="recalculate">按新口径重算</button>
        <button class="btn" type="button" @click="exportRows">导出仪器检定清单</button>
        <button v-if="view === 'delivery'" class="btn" type="button" @click="exportDelivery">导出送检清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="view-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: view === tab.key }"
        type="button"
        @click="switchView(tab.key)"
      >
        {{ tab.label }}（{{ tabCounts[tab.key] }}）
      </button>
    </nav>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="String(item.row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '提醒级别'" class="level-badge" :class="`level-${item.level}`">
              {{ item.level }}
            </span>
            <template v-else>{{ cellText(item, column) }}</template>
          </td>
          <td>{{ item.row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(item)">详情</button>
            <button
              class="link"
              type="button"
              :disabled="acting || !canDispatch(item)"
              @click="dispatch(item)"
            >
              送出检定
            </button>
            <template v-if="view === 'all'">
              <button class="link" type="button" :disabled="acting" @click="runAction('确认合格', item)">
                确认合格
              </button>
              <button class="link" type="button" :disabled="acting" @click="runAction('标记不合格', item)">
                标记不合格
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="columns.length + 2" class="empty-state">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="detail-mask" @click.self="closeDetail">
      <div class="detail-panel">
        <h3>仪器检定详情 · {{ detail.row['记录编号'] }}</h3>
        <p class="detail-level">
          提醒级别：
          <span class="level-badge" :class="`level-${detail.level}`">{{ detail.level }}</span>
        </p>
        <dl>
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailValue(field) }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.row.status }}</dd>
          <dt>核查建议</dt>
          <dd>{{ adviceOf(detail.level) }}</dd>
        </dl>
        <div class="page-actions">
          <button class="btn" type="button" @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条记录 · {{ viewLabel }}</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  dispatchInstrument,
  downloadDeliveryList,
  downloadEntries,
  getInstrumentDetail,
  instrumentTabCounts,
  listInstruments,
  recalibrateInstruments,
  runAction as applyAction,
} from '@/api/local-service'
import { LEVEL_ADVICE } from '@/data/calibration-rules'
import type { InstrumentEval, InstrumentLevel, InstrumentView } from '@/data/types'

const MODULE_KEY = 'calibration'
const statuses = ['待送检', '送检中', '已合格', '不合格', '已停用']
const tabs: { key: InstrumentView; label: string }[] = [
  { key: 'all', label: '全部记录' },
  { key: 'expiring', label: '临期仪器' },
  { key: 'unqualified', label: '不合格仪器' },
  { key: 'delivery', label: '送检清单' },
]
const allColumns = [
  '记录编号',
  '仪器编号',
  '仪器名称',
  '使用站点',
  '检定单位',
  '检定日期',
  '有效期至',
  '检定结论',
  '提醒级别',
  '剩余天数',
]
const deliveryColumns = ['仪器编号', '仪器名称', '使用站点', '检定结论', '有效期至', '剩余天数', '提醒级别', '核查建议']
const detailFields = [
  '记录编号',
  '仪器编号',
  '仪器名称',
  '使用站点',
  '检定单位',
  '检定日期',
  '有效期至',
  '有效期来源',
  '剩余天数',
  '检定结论',
  '检定状态',
  '重算时间',
]

const view = ref<InstrumentView>('all')
const items = ref<InstrumentEval[]>([])
const allItems = ref<InstrumentEval[]>([])
const tabCounts = ref<Record<InstrumentView, number>>({ all: 0, expiring: 0, unqualified: 0, delivery: 0 })
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const acting = ref(false)
const detail = ref<InstrumentEval | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ['记录编号', '仪器编号', '仪器名称']

const columns = computed(() => (view.value === 'delivery' ? deliveryColumns : allColumns))
const viewLabel = computed(() => tabs.find((tab) => tab.key === view.value)?.label ?? '')
const emptyText = computed(() => {
  if (view.value === 'delivery') return '当前没有需要送检的仪器'
  if (view.value === 'expiring') return '暂无临期或逾期仪器'
  if (view.value === 'unqualified') return '暂无不合格仪器'
  return '暂无仪器检定数据，可先登记仪器检定记录'
})
const stats = computed(() => [
  { label: '临期仪器', value: allItems.value.filter((item) => item.level === '临期').length },
  { label: '已过期仪器', value: allItems.value.filter((item) => item.level === '已过期').length },
  { label: '不合格仪器', value: allItems.value.filter((item) => item.level === '不合格').length },
  { label: '送检中流程', value: allItems.value.filter((item) => String(item.row.status) === '送检中').length },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allItems.value.filter((item) => String(item.row.status) === status).length,
  })),
)

function adviceOf(level: InstrumentLevel): string {
  return LEVEL_ADVICE[level]
}

function cellText(item: InstrumentEval, column: string): string {
  if (column === '有效期至') {
    if (!item.validUntil) return '待补'
    return item.validSource === '估算' ? `${item.validUntil}（估算）` : item.validUntil
  }
  if (column === '剩余天数') {
    return item.daysLeft === null ? '—' : `${item.daysLeft} 天`
  }
  if (column === '核查建议') {
    return adviceOf(item.level)
  }
  const value = item.row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function detailValue(field: string): string {
  if (!detail.value) return '—'
  if (field === '有效期至') return cellText(detail.value, '有效期至')
  if (field === '剩余天数') return cellText(detail.value, '剩余天数')
  if (field === '有效期来源') return detail.value.validSource
  const value = detail.value.row[field]
  return value === undefined || value === '' ? '—' : String(value)
}

function canDispatch(item: InstrumentEval): boolean {
  const status = String(item.row.status)
  return status !== '送检中' && status !== '已停用'
}

function switchView(next: InstrumentView) {
  view.value = next
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(MODULE_KEY)
}

function exportDelivery() {
  downloadDeliveryList()
}

function openCreate() {
  errorMessage.value = '仪器检定记录登记入口尚未接入审批流'
}

function openDetail(item: InstrumentEval) {
  // 详情重新走服务层取数，与列表同一口径，返回后结论保持一致
  detail.value = getInstrumentDetail(Number(item.row.id))
}

function closeDetail() {
  detail.value = null
}

function dispatch(item: InstrumentEval) {
  if (acting.value) return
  acting.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = dispatchInstrument(Number(item.row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
  } finally {
    acting.value = false
  }
}

function runAction(action: string, item: InstrumentEval) {
  if (acting.value) return
  acting.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = applyAction(MODULE_KEY, Number(item.row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
  } finally {
    acting.value = false
  }
}

function recalculate() {
  if (acting.value) return
  acting.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = recalibrateInstruments()
    noticeMessage.value = result.message
    reload()
  } finally {
    acting.value = false
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listInstruments(view.value, filters.value)
    items.value = payload.items
    total.value = payload.total
    allItems.value = listInstruments('all').items
    tabCounts.value = instrumentTabCounts()
    if (detail.value) {
      detail.value = getInstrumentDetail(Number(detail.value.row.id))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '仪器检定列表读取失败'
  }
}

onMounted(reload)
</script>
