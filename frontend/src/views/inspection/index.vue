<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护巡检记录，围绕记录编号、站点编号、巡检日期、巡检人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">仪器核查待办：{{ instrumentChecks.length }}</span>
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
        <tr v-for="row in rows" :key="String(row.id)">
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

    <section class="instrument-checks">
      <h3 class="section-sub">仪器核查待办（{{ instrumentChecks.length }}）</h3>
      <p class="page-desc">
        来自仪器检定的临期、已过期、不合格与待补有效期仪器，按有效期、检定结论和使用站点排列；已停用仪器不再提示。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>仪器编号</th>
            <th>仪器名称</th>
            <th>使用站点</th>
            <th>提醒级别</th>
            <th>有效期至</th>
            <th>剩余天数</th>
            <th>核查建议</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in instrumentChecks" :key="String(item.row.id)">
            <td>{{ item.instrumentNo || '—' }}</td>
            <td>{{ item.row['仪器名称'] || '—' }}</td>
            <td>{{ item.station || '—' }}</td>
            <td>
              <span class="level-badge" :class="`level-${item.level}`">{{ item.level }}</span>
            </td>
            <td>{{ item.validUntil || '待补' }}</td>
            <td>{{ item.daysLeft === null ? '—' : `${item.daysLeft} 天` }}</td>
            <td>{{ adviceOf(item.level) }}</td>
          </tr>
          <tr v-if="!instrumentChecks.length">
            <td colspan="7" class="empty-state">暂无仪器核查待办</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listInstrumentChecks,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { LEVEL_ADVICE } from '@/data/calibration-rules'
import type { EntryRow, InstrumentEval, InstrumentLevel } from '@/data/types'

const meta = moduleMeta('inspection')
const columns = ["记录编号", "站点编号", "巡检日期", "巡检人员", "检查项目", "发现问题", "处理措施", "巡检状态"]
const actions = ["完成巡检", "报告故障", "确认处置"]
const statuses = ["待巡检", "已巡检", "发现故障", "已处置"]
const stats = [{"label": "本月巡检次数", "value": 0}, {"label": "已巡检站点", "value": 0}, {"label": "待处置故障", "value": 0}]

const rows = ref<EntryRow[]>([])
const instrumentChecks = ref<InstrumentEval[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function adviceOf(level: InstrumentLevel): string {
  return LEVEL_ADVICE[level]
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
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    instrumentChecks.value = listInstrumentChecks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检记录列表读取失败'
  }
}

onMounted(reload)
</script>
