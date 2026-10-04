<template>
  <section class="page" data-module="calibration-detail">
    <header class="page-head">
      <div>
        <h2>仪器检定详情</h2>
        <p class="page-desc">列表与详情展示同一结论；在此执行的操作与列表页完全等价。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="goBack">返回列表</button>
      </div>
    </header>

    <div v-if="!row" class="empty-state detail-box">没有找到该仪器检定记录，可能已被重置。</div>

    <template v-else>
      <div class="detail-grid">
        <article v-for="item in fields" :key="item.label" class="detail-item">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="detail-value">
            {{ item.value }}
            <span v-if="item.tag" class="tag" :class="item.tagClass">{{ item.tag }}</span>
          </strong>
        </article>
      </div>

      <div class="detail-box">
        <h3>当前判定（按现行口径实时计算）</h3>
        <p class="status-legend">
          <span class="legend-item">当前状态：<b :class="row.retired ? 'tag-muted' : ''">{{ row.currentStatus }}</b></span>
          <span class="legend-item">检定结论：<b>{{ row.conclusion }}</b></span>
          <span class="legend-item">{{ dueText }}</span>
          <span v-if="row.estimated" class="legend-item tag-warn">有效期为估算值，待补录</span>
          <span v-if="row.needSupplement && row.conclusion === '待补'" class="legend-item tag-warn">检定结论待补</span>
        </p>
        <p v-if="row.retired" class="page-desc">该仪器已停用，不再出现在送检清单、临期/不合格提示与巡检待办中。</p>
        <p v-else-if="row.inTransit" class="page-desc">送检流程进行中：请在拿到检定证书后登记合格或不合格结论。</p>
        <p v-else-if="checklistReason" class="page-desc">{{ checklistReason }}</p>
        <p v-else class="page-desc">仪器在检定有效期内，暂无送检要求。</p>
      </div>

      <div class="detail-box">
        <h3>执行操作</h3>
        <div class="row-actions detail-actions">
          <button
            v-for="action in availableActions(row)"
            :key="action"
            type="button"
            class="btn"
            :class="{ primary: action === '送出检定' }"
            :disabled="busy"
            @click="runAction(action)"
          >
            {{ action }}
          </button>
        </div>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <p v-if="infoMessage" class="success-text">{{ infoMessage }}</p>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  availableActions,
  getCalibrationRow,
  runCalibrationAction,
  submitInstrument,
  supplementValidity,
  ACTION_SUPPLEMENT,
  type CalibRow,
} from '@/domain/calibration'
import { useCalibrationStore } from '@/stores/calibration'

const route = useRoute()
const router = useRouter()
const store = useCalibrationStore()

const errorMessage = ref('')
const infoMessage = ref('')
const busy = ref(false)
const version = ref(0)

const id = Number(route.params.id)
const row = computed<CalibRow | null>(() => {
  void version.value
  return getCalibrationRow(id, store.rules)
})

const fields = computed(() => {
  const current = row.value
  if (!current) return []
  return [
    { label: '记录编号', value: current.recordNo || '—', tag: '', tagClass: '' },
    { label: '仪器编号', value: current.instrumentNo || '—', tag: '', tagClass: '' },
    { label: '仪器名称', value: current.instrumentName || '—', tag: '', tagClass: '' },
    { label: '使用站点', value: current.site, tag: '', tagClass: '' },
    { label: '检定单位', value: current.agency || '—', tag: '', tagClass: '' },
    { label: '检定日期', value: current.calibratedOn ?? '—', tag: '', tagClass: '' },
    {
      label: '有效期至',
      value: current.validUntil ?? '待补',
      tag: current.estimated ? '估算·待补' : '',
      tagClass: 'tag-warn',
    },
  ]
})

const dueText = computed(() => {
  const current = row.value
  if (!current) return ''
  if (current.retired) return '已停用'
  if (current.inTransit) return '送检中'
  if (current.validUntil === null) return '缺有效期'
  if (current.expired) return `已过期 ${Math.abs(current.daysLeft ?? 0)} 天`
  return `距到期 ${current.daysLeft ?? 0} 天`
})

const checklistReason = computed(() => {
  const current = row.value
  if (!current || !current.needSubmit) return ''
  if (current.conclusion === '不合格') return '上次检定结论为不合格，已列入送检清单并触发巡检核查。'
  if (current.validUntil === null) return '缺少有效期，按旧记录规则需补录并安排检定。'
  if (current.expired) return '检定已过期，已列入送检清单。'
  return `距有效期不足 ${store.rules.nearExpiryDays} 天，已列入送检清单。`
})

function goBack() {
  router.push({ path: '/calibration', query: { from: 'detail' } })
}

async function runAction(action: string) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === ACTION_SUPPLEMENT) {
    const current = row.value
    if (!current) return
    const input = window.prompt(`为仪器 ${current.instrumentNo} 补录有效期（YYYY-MM-DD）`, current.validUntil ?? '')
    if (input === null) return
    const result = supplementValidity(id, input.trim())
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    infoMessage.value = result.message
    version.value += 1
    return
  }
  busy.value = true
  try {
    const result =
      action === '送出检定' ? await submitInstrument(id) : await runCalibrationAction(id, action)
    if (!result.ok) {
      errorMessage.value = result.message
    } else {
      infoMessage.value = result.message
    }
    version.value += 1
  } finally {
    busy.value = false
  }
}
</script>
