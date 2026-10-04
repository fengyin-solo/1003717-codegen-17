<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">按有效期、检定结论与使用站点跟踪临期与不合格仪器，生成送检清单；停用仪器不再提示，规则调整后按新口径重算未停用仪器。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="toggleRules">{{ rulesOpen ? '收起规则设置' : '检定规则设置' }}</button>
        <button class="btn primary" type="button" @click="exportRows">
          {{ view === 'checklist' ? '导出送检清单' : '导出仪器检定清单' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.cls">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="rulesOpen" class="rule-panel" @submit.prevent="applyRules">
      <label class="filter-item">
        <span>临期阈值（天，含已过期）</span>
        <input v-model.number="store.rulesDraft.nearExpiryDays" type="number" min="1" max="365" />
      </label>
      <label class="filter-item">
        <span>默认检定周期（月，用于估算旧记录有效期）</span>
        <input v-model.number="store.rulesDraft.defaultValidMonths" type="number" min="1" max="120" />
      </label>
      <button class="btn primary" type="submit">保存并按新口径重算</button>
      <button class="btn ghost" type="button" @click="restoreRules">恢复默认规则</button>
      <span class="rule-tip">重算只覆盖未停用仪器；送检中的流程不打断，已停用仪器不参与。旧记录缺有效期时按检定日期 + 周期估算并标记待补。</span>
    </form>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab-item"
        :class="{ active: view === tab.key }"
        @click="switchView(tab.key)"
      >
        {{ tab.label }}<span class="tab-count">{{ tab.count }}</span>
      </button>
    </nav>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="store.keyword" placeholder="记录编号 / 仪器编号 / 名称 / 检定单位" />
      </label>
      <label class="filter-item">
        <span>使用站点</span>
        <input v-model="store.site" placeholder="按使用站点检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>到期情况</th>
          <th>当前结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ 'row-retired': row.retired }">
          <td><RouterLink class="link" :to="`/calibration/${row.id}`">{{ row.recordNo || '—' }}</RouterLink></td>
          <td>{{ row.instrumentNo || '—' }}</td>
          <td>{{ row.instrumentName || '—' }}</td>
          <td>{{ row.site }}</td>
          <td>{{ row.agency || '—' }}</td>
          <td>{{ row.calibratedOn ?? '—' }}</td>
          <td>
            {{ row.validUntil ?? '待补' }}
            <span v-if="row.estimated" class="tag tag-warn" title="旧记录缺有效期，按检定日期与默认周期估算">估算·待补</span>
          </td>
          <td>
            <span class="tag" :class="conclusionClass(row.conclusion)">{{ row.conclusion }}</span>
            <span v-if="row.needSupplement && row.conclusion === '待补'" class="tag tag-warn">结论待补</span>
          </td>
          <td>
            <span class="tag" :class="statusClass(row)">{{ row.currentStatus }}</span>
            <span class="due-text" :class="dueClass(row)">{{ dueText(row) }}</span>
          </td>
          <td class="row-actions">
            <RouterLink class="link" :to="`/calibration/${row.id}`">详情</RouterLink>
            <button
              v-for="action in actionList(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busy.has(row.id)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条记录{{ view === 'checklist' ? '（同一仪器仅保留一条有效流程）' : '' }}</span>
      <span v-if="infoMessage" class="success-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv, downloadEntries } from '@/api/local-service'
import {
  ACTION_RETIRE,
  ACTION_SUBMIT,
  ACTION_SUPPLEMENT,
  addMonths,
  availableActions,
  buildChecklistCsv,
  listCalibrationViews,
  loadRules,
  migrateLegacyRecords,
  readCalibration,
  resetRules,
  runCalibrationAction,
  saveRules,
  submitInstrument,
  supplementValidity,
  type CalibRow,
  type CalibrationView,
} from '@/domain/calibration'
import { useCalibrationStore } from '@/stores/calibration'

const store = useCalibrationStore()

const columns = ['记录编号', '仪器编号', '仪器名称', '使用站点', '检定单位', '检定日期', '有效期至', '检定结论']

const rows = ref<CalibRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const busy = ref(new Set<number>())

const view = computed(() => store.view)
const rules = computed(() => store.rules)
const rulesOpen = computed(() => store.rulesOpen)

const allRows = computed(() => readCalibration(rules.value))
const checklistCount = computed(() => {
  const ids = new Set<number>()
  for (const row of allRows.value) {
    if (row.needSubmit) ids.add(row.id)
  }
  return ids.size
})

const stats = computed(() => [
  { label: '待送检仪器', value: allRows.value.filter((row) => row.needSubmit).length, cls: '' },
  { label: `临期与过期（${rules.value.nearExpiryDays}天内）`, value: allRows.value.filter((row) => row.nearExpiry).length, cls: 'stat-warn' },
  { label: '不合格仪器', value: allRows.value.filter((row) => row.conclusion === '不合格' && !row.inTransit && !row.retired).length, cls: 'stat-bad' },
  { label: '已停用（不提示）', value: allRows.value.filter((row) => row.retired).length, cls: 'stat-muted' },
])

const tabs = computed(() => [
  { key: 'all' as CalibrationView, label: '全部仪器', count: allRows.value.length },
  { key: 'expiring' as CalibrationView, label: '临期与过期', count: allRows.value.filter((row) => row.nearExpiry).length },
  { key: 'unqualified' as CalibrationView, label: '不合格', count: allRows.value.filter((row) => row.conclusion === '不合格' && !row.inTransit && !row.retired).length },
  { key: 'checklist' as CalibrationView, label: '送检清单', count: checklistCount.value },
])

const emptyText = computed(() => {
  switch (view.value) {
    case 'expiring':
      return '没有临期或已过期的在用仪器'
    case 'unqualified':
      return '没有待处置的不合格仪器（停用与送检中的不重复提示）'
    case 'checklist':
      return '送检清单为空：没有需要送检的在用仪器'
    default:
      return '暂无仪器检定数据'
  }
})

function actionList(row: CalibRow): string[] {
  return availableActions(row)
}

function conclusionClass(conclusion: string): string {
  if (conclusion === '合格') return 'tag-ok'
  if (conclusion === '不合格') return 'tag-bad'
  return 'tag-warn'
}

function statusClass(row: CalibRow): string {
  if (row.retired) return 'tag-muted'
  if (row.inTransit) return 'tag-info'
  if (row.currentStatus === '不合格') return 'tag-bad'
  if (row.needSubmit) return 'tag-warn'
  return 'tag-ok'
}

function dueText(row: CalibRow): string {
  if (row.retired) return '已停用'
  if (row.inTransit) return '送检流程进行中'
  if (row.validUntil === null) return '缺有效期，待补'
  if (row.expired) return `已过期 ${Math.abs(row.daysLeft ?? 0)} 天`
  if (row.daysLeft !== null && row.daysLeft <= rules.value.nearExpiryDays) return `还剩 ${row.daysLeft} 天`
  return `还剩 ${row.daysLeft ?? 0} 天`
}

function dueClass(row: CalibRow): string {
  if (row.retired) return 'tag-muted'
  if (row.expired) return 'tag-bad'
  if (row.nearExpiry) return 'tag-warn'
  return ''
}

function switchView(next: CalibrationView) {
  errorMessage.value = ''
  infoMessage.value = ''
  store.setView(next)
  reload()
}

function resetFilters() {
  store.setKeyword('')
  store.setSite('')
  reload()
}

function toggleRules() {
  store.setRulesOpen(!store.rulesOpen)
}

function applyRules() {
  errorMessage.value = ''
  const next = saveRules({ ...store.rulesDraft })
  store.applyRules(next)
  const activeCount = readCalibration(next).filter((row) => !row.retired).length
  infoMessage.value = `规则已保存，已按新口径重算 ${activeCount} 台未停用仪器`
  reload()
}

function restoreRules() {
  errorMessage.value = ''
  const next = resetRules()
  store.applyRules(next)
  infoMessage.value = '已恢复默认规则（临期 30 天、检定周期 12 个月）并重算'
  reload()
}

function exportRows() {
  if (view.value === 'checklist') {
    downloadCsv('仪器送检清单.csv', buildChecklistCsv())
    return
  }
  downloadEntries('calibration')
}

async function runAction(action: string, row: CalibRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === ACTION_SUPPLEMENT) {
    const prefill = row.validUntil ?? addMonths(row.calibratedOn ?? new Date().toISOString().slice(0, 10), rules.value.defaultValidMonths)
    const input = window.prompt(`为仪器 ${row.instrumentNo} 补录有效期（YYYY-MM-DD）`, prefill)
    if (input === null) return
    const result = supplementValidity(row.id, input.trim())
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    infoMessage.value = result.message
    reload()
    return
  }
  if (action === ACTION_SUBMIT) {
    busy.value.add(row.id)
    try {
      const result = await submitInstrument(row.id)
      if (!result.ok) {
        errorMessage.value = result.message
      } else {
        infoMessage.value = result.message
      }
    } finally {
      busy.value.delete(row.id)
    }
    reload()
    return
  }
  const result = await runCalibrationAction(row.id, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  if (action === ACTION_RETIRE) {
    infoMessage.value = '仪器已停用，各入口的送检与核查提示均不再包含该仪器'
  }
  reload()
}

function reload() {
  try {
    const payload = listCalibrationViews(view.value, rules.value, {
      keyword: store.keyword,
      site: store.site,
    })
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '仪器检定列表读取失败'
  }
}

onMounted(() => {
  // 旧记录首次进入时按当前口径重算一次（缺有效期估算、停用仪器排除）
  migrateLegacyRecords(loadRules())
  store.refreshRules()
  reload()
})
</script>
