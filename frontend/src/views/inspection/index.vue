<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护站点巡检记录，并联动仪器检定：临期、过期、不合格与缺有效期的在用仪器会在此生成仪器核查待办（停用仪器不提示）。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.cls">{{ item.value }}</strong>
      </article>
    </div>

    <div class="detail-box instrument-box">
      <div class="instrument-head">
        <h3>仪器核查待办（按使用站点）</h3>
        <div class="page-actions">
          <button class="btn primary" type="button" :disabled="!instrumentTodos.length" @click="addAllTodos">
            全部生成巡检待办
          </button>
        </div>
      </div>
      <p class="page-desc">口径与仪器检定的送检清单一致：未停用、无在途流程的仪器才提示；同一仪器只生成一条待办，重复提交只生效一次。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>仪器编号</th>
            <th>仪器名称</th>
            <th>使用站点</th>
            <th>有效期至</th>
            <th>检定结论</th>
            <th>核查原因</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in instrumentTodos" :key="row.id">
            <td>{{ row.instrumentNo }}</td>
            <td>{{ row.instrumentName }}</td>
            <td>{{ row.site }}</td>
            <td>
              {{ row.validUntil ?? '待补' }}
              <span v-if="row.estimated" class="tag tag-warn">估算·待补</span>
            </td>
            <td><span class="tag" :class="conclusionClass(row.conclusion)">{{ row.conclusion }}</span></td>
            <td>{{ reason(row) }}</td>
            <td>
              <button class="link" type="button" @click="addTodo(row)">
                {{ isTodoAdded(row) ? '待办已生成' : '生成核查待办' }}
              </button>
            </td>
          </tr>
          <tr v-if="!instrumentTodos.length">
            <td colspan="7" class="empty-state">暂无需要核查的仪器，停用与送检中的仪器不会提示</td>
          </tr>
        </tbody>
      </table>
    </div>

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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-instrument': isInstrumentRow(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检记录数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录</span>
      <span v-if="infoMessage" class="success-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  addAllInstrumentCheckTodos,
  addInstrumentCheckTodo,
  instrumentCheckTodos,
  type CalibRow,
} from '@/domain/calibration'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
const columns = ['记录编号', '站点编号', '巡检日期', '巡检人员', '检查项目', '发现问题', '处理措施', '巡检状态']
const actions = ['完成巡检', '报告故障', '确认处置']
const statuses = ['待巡检', '已巡检', '发现故障', '已处置']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const tick = ref(0)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const instrumentTodos = computed(() => {
  void tick.value
  return instrumentCheckTodos()
})

const pendingInspectionCount = computed(() => rows.value.filter((row) => String(row.status) === '待巡检').length)
const instrumentAddedCount = computed(
  () => rows.value.filter((row) => String(row['检查项目'] ?? '').includes('仪器核查')).length,
)

const stats = computed(() => [
  { label: '待巡检记录', value: pendingInspectionCount.value, cls: '' },
  { label: '待核查仪器', value: instrumentTodos.value.length, cls: 'stat-warn' },
  { label: '已生成仪器核查待办', value: instrumentAddedCount.value, cls: '' },
  { label: '待处置故障', value: rows.value.filter((row) => String(row.status) === '发现故障').length, cls: 'stat-bad' },
])

function conclusionClass(conclusion: string): string {
  if (conclusion === '合格') return 'tag-ok'
  if (conclusion === '不合格') return 'tag-bad'
  return 'tag-warn'
}

function reason(row: CalibRow): string {
  if (row.conclusion === '不合格') return '上次检定不合格，需复查'
  if (row.validUntil === null) return '缺有效期，需现场核查检定情况'
  if (row.expired) return '检定已过期，需尽快送检'
  return '检定临期，需安排送检'
}

function isInstrumentRow(row: EntryRow): boolean {
  return String(row['检查项目'] ?? '').includes('仪器核查')
}

function isTodoAdded(row: CalibRow): boolean {
  return listRows(meta.key).some(
    (item) =>
      String(item['检查项目'] ?? '').includes('仪器核查') &&
      String(item['仪器编号'] ?? '') === row.instrumentNo &&
      String(item.status) === '待巡检',
  )
}

function addTodo(row: CalibRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = addInstrumentCheckTodo(row)
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    infoMessage.value = result.message
  }
  tick.value += 1
  reload()
}

function addAllTodos() {
  errorMessage.value = ''
  infoMessage.value = ''
  const { added, skipped } = addAllInstrumentCheckTodos()
  infoMessage.value = `已生成 ${added} 条仪器核查待办${skipped ? `，跳过 ${skipped} 条已存在的待办` : ''}`
  tick.value += 1
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  tick.value += 1
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检记录列表读取失败'
  }
}

onMounted(reload)
</script>
