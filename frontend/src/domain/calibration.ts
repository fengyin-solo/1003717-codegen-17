import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 仪器检定领域：列表、详情、巡检待办共用同一套口径，保证“返回后还是同一结论”。
// 停用仪器在所有提示口径中排除；旧记录缺有效期按检定日期 + 检定周期估算并标记待补。

export const CALIBRATION_KEY = 'calibration'
export const INSPECTION_KEY = 'inspection'
export const RULES_STORAGE_KEY = 'hydrology-monitor-station:calibration-rules'
export const MIGRATION_STORAGE_KEY = 'hydrology-monitor-station:calibration-migrated'

export const STATUS_PENDING = '待送检'
export const STATUS_IN_TRANSIT = '送检中'
export const STATUS_QUALIFIED = '已合格'
export const STATUS_UNQUALIFIED = '不合格'
export const STATUS_RETIRED = '已停用'

export const CONCLUSION_QUALIFIED = '合格'
export const CONCLUSION_UNQUALIFIED = '不合格'
export const CONCLUSION_MISSING = '待补'

export const ACTION_SUBMIT = '送出检定'
export const ACTION_PASS = '确认合格'
export const ACTION_FAIL = '标记不合格'
export const ACTION_RETIRE = '停用仪器'
export const ACTION_REACTIVATE = '重新启用'
export const ACTION_SUPPLEMENT = '补录有效期'

export type CalibrationView = 'all' | 'expiring' | 'unqualified' | 'checklist'
export type Conclusion = '合格' | '不合格' | '待补'

export type CalibrationRules = {
  // 距有效期不足该天数即视为临期（含已过期）
  nearExpiryDays: number
  // 旧记录缺有效期时，按检定日期 + 该月数估算
  defaultValidMonths: number
}

export type CalibRow = {
  id: number
  recordNo: string
  instrumentNo: string
  instrumentName: string
  site: string
  agency: string
  calibratedOn: string | null
  validUntil: string | null
  // true 表示有效期由系统按旧记录规则估算，需人工补录
  estimated: boolean
  conclusion: Conclusion
  status: string
  retired: boolean
  inTransit: boolean
  expired: boolean
  nearExpiry: boolean
  daysLeft: number | null
  // 按当前口径推导出的当前结论/状态（列表与详情统一使用）
  currentStatus: string
  // 按当前口径是否需要再送检（停用 / 送检中除外）
  needSubmit: boolean
  // 资料不齐（结论待补或有效期为估算值）
  needSupplement: boolean
}

export type ServiceResult = { ok: boolean; message: string }

export const DEFAULT_RULES: CalibrationRules = { nearExpiryDays: 30, defaultValidMonths: 12 }

export const DEFAULT_SITE = '未分配站点'

// ---------- 日期工具（按“天”比较，不受时分秒影响） ----------

export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const [year, month, day] = text.split('-').map((part) => Number(part))
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return text
}

export function todayText(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addMonths(text: string, months: number): string {
  const [year, month, day] = text.split('-').map((part) => Number(part))
  const target = new Date(year, month - 1 + months, day)
  const y = target.getFullYear()
  const m = String(target.getMonth() + 1).padStart(2, '0')
  const d = String(target.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function daysBetween(fromText: string, toText: string): number {
  const [fy, fm, fd] = fromText.split('-').map((part) => Number(part))
  const [ty, tm, td] = toText.split('-').map((part) => Number(part))
  const from = new Date(fy, fm - 1, fd).getTime()
  const to = new Date(ty, tm - 1, td).getTime()
  return Math.round((to - from) / 86400000)
}

// ---------- 规则读写 ----------

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(num)))
}

export function loadRules(): CalibrationRules {
  const fallback = { ...DEFAULT_RULES }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  try {
    const raw = window.localStorage.getItem(RULES_STORAGE_KEY)
    if (!raw) {
      return fallback
    }
    const parsed = JSON.parse(raw) as Partial<CalibrationRules>
    return {
      nearExpiryDays: clampInt(parsed.nearExpiryDays, DEFAULT_RULES.nearExpiryDays, 1, 365),
      defaultValidMonths: clampInt(parsed.defaultValidMonths, DEFAULT_RULES.defaultValidMonths, 1, 120),
    }
  } catch {
    return fallback
  }
}

// 保存规则即“规则调整”，随后按新口径重算所有未停用仪器（送检中流程不打断）。
export function saveRules(next: CalibrationRules): CalibrationRules {
  const rules: CalibrationRules = {
    nearExpiryDays: clampInt(next.nearExpiryDays, DEFAULT_RULES.nearExpiryDays, 1, 365),
    defaultValidMonths: clampInt(next.defaultValidMonths, DEFAULT_RULES.defaultValidMonths, 1, 120),
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules))
  }
  recomputeActive(rules)
  return rules
}

export function resetRules(): CalibrationRules {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(RULES_STORAGE_KEY)
  }
  return saveRules({ ...DEFAULT_RULES })
}

// ---------- 旧记录规整：缺有效期 -> 估算并标记待补；非标准结论 -> 待补 ----------

export function normalizeConclusion(value: unknown): Conclusion {
  const text = String(value ?? '').trim()
  if (!text) {
    return CONCLUSION_MISSING
  }
  if (text.includes('不合格') || text.includes('不合规')) {
    return CONCLUSION_UNQUALIFIED
  }
  if (text.includes('合格')) {
    return CONCLUSION_QUALIFIED
  }
  return CONCLUSION_MISSING
}

export function normalizeSite(value: unknown): string {
  const text = String(value ?? '').trim()
  return text && !text.includes('样例') ? text : DEFAULT_SITE
}

// 返回规整后的有效期与“是否估算”标记。旧记录缺有效期：有检定日期则按周期估算，都没有则待补。
export function resolveValidity(
  rawValidUntil: unknown,
  rawCalibratedOn: unknown,
  rules: CalibrationRules,
): { validUntil: string | null; estimated: boolean } {
  const explicit = parseDate(rawValidUntil)
  if (explicit) {
    return { validUntil: explicit, estimated: false }
  }
  const calibratedOn = parseDate(rawCalibratedOn)
  if (calibratedOn) {
    return { validUntil: addMonths(calibratedOn, rules.defaultValidMonths), estimated: true }
  }
  return { validUntil: null, estimated: true }
}

export function deriveRow(row: EntryRow, rules: CalibrationRules, today = todayText()): CalibRow {
  const status = String(row.status ?? '')
  const retired = status === STATUS_RETIRED
  const inTransit = status === STATUS_IN_TRANSIT
  const calibratedOn = parseDate(row['检定日期'])
  const { validUntil, estimated } = resolveValidity(row['有效期至'], row['检定日期'], rules)
  const conclusion = normalizeConclusion(row['检定结论'])

  const daysLeft = validUntil ? daysBetween(today, validUntil) : null
  const expired = validUntil !== null && daysLeft !== null && daysLeft < 0
  const nearExpiry = !retired && !inTransit && validUntil !== null && daysLeft !== null && daysLeft <= rules.nearExpiryDays
  const needSubmit =
    !retired && !inTransit && (conclusion === CONCLUSION_UNQUALIFIED || nearExpiry || validUntil === null)
  const needSupplement = conclusion === CONCLUSION_MISSING || estimated

  let currentStatus = status
  if (retired) {
    currentStatus = STATUS_RETIRED
  } else if (inTransit) {
    currentStatus = STATUS_IN_TRANSIT
  } else if (conclusion === CONCLUSION_UNQUALIFIED) {
    currentStatus = STATUS_UNQUALIFIED
  } else if (needSubmit) {
    currentStatus = STATUS_PENDING
  } else {
    currentStatus = STATUS_QUALIFIED
  }

  return {
    id: Number(row.id),
    recordNo: String(row['记录编号'] ?? ''),
    instrumentNo: String(row['仪器编号'] ?? ''),
    instrumentName: String(row['仪器名称'] ?? ''),
    site: normalizeSite(row['使用站点']),
    agency: String(row['检定单位'] ?? ''),
    calibratedOn,
    validUntil,
    estimated,
    conclusion,
    status,
    currentStatus,
    retired,
    inTransit,
    expired,
    nearExpiry,
    daysLeft,
    needSubmit,
    needSupplement,
  }
}

export function readCalibration(rules: CalibrationRules = loadRules()): CalibRow[] {
  return listRows(CALIBRATION_KEY).map((row) => deriveRow(row, rules))
}

// 统一排序口径：有效期升期（越早越靠前），检定结论（不合格优先），再按使用站点。
export function compareCalib(a: CalibRow, b: CalibRow): number {
  if (a.validUntil !== b.validUntil) {
    if (a.validUntil === null) return 1
    if (b.validUntil === null) return -1
    return a.validUntil < b.validUntil ? -1 : 1
  }
  const order: Record<Conclusion, number> = { 不合格: 0, 待补: 1, 合格: 2 }
  if (order[a.conclusion] !== order[b.conclusion]) {
    return order[a.conclusion] - order[b.conclusion]
  }
  return a.site.localeCompare(b.site, 'zh-Hans-CN')
}

export function isExpiringView(row: CalibRow): boolean {
  return row.nearExpiry
}

export function isUnqualifiedView(row: CalibRow): boolean {
  // 已在送检流程中的不合格仪器不再重复提示
  return row.conclusion === CONCLUSION_UNQUALIFIED && !row.inTransit && !row.retired
}

export function isChecklistRow(row: CalibRow): boolean {
  return row.needSubmit
}

// 送检清单：同一仪器只保留一条有效流程（按仪器编号去重，取最急需送检的一条）。
export function buildChecklist(rows: CalibRow[]): CalibRow[] {
  const picked = new Map<string, CalibRow>()
  for (const row of rows.filter(isChecklistRow)) {
    const key = row.instrumentNo || `#${row.id}`
    const prev = picked.get(key)
    if (!prev || compareCalib(row, prev) < 0) {
      picked.set(key, row)
    }
  }
  return [...picked.values()].sort(compareCalib)
}

export type CalibrationFilter = {
  keyword?: string
  site?: string
}

export function listCalibrationViews(
  view: CalibrationView,
  rules: CalibrationRules = loadRules(),
  filter: CalibrationFilter = {},
): { items: CalibRow[]; total: number } {
  let items = readCalibration(rules)
  if (view === 'expiring') {
    items = items.filter(isExpiringView)
  } else if (view === 'unqualified') {
    items = items.filter(isUnqualifiedView)
  } else if (view === 'checklist') {
    items = buildChecklist(items)
  }
  const keyword = filter.keyword?.trim()
  if (keyword) {
    items = items.filter((row) =>
      [row.recordNo, row.instrumentNo, row.instrumentName, row.agency, row.site].some((field) =>
        field.includes(keyword),
      ),
    )
  }
  const site = filter.site?.trim()
  if (site) {
    items = items.filter((row) => row.site.includes(site))
  }
  items = [...items].sort(compareCalib)
  return { items, total: items.length }
}

// 列表与详情走同一个函数，结论口径天然一致。
export function getCalibrationRow(id: number, rules: CalibrationRules = loadRules()): CalibRow | null {
  return readCalibration(rules).find((row) => row.id === id) ?? null
}

// ---------- 写操作 ----------

function persist(rows: EntryRow[]): void {
  saveRows(CALIBRATION_KEY, rows)
}

function recomputeActive(rules: CalibrationRules): void {
  const rows = listRows(CALIBRATION_KEY)
  const next = rows.map((row) => {
    const view = deriveRow(row, rules)
    if (view.retired) {
      // 停用仪器：规则调整后也不再参与任何提示与重算
      return { ...row, status: STATUS_RETIRED, pending: false, abnormal: false }
    }
    if (view.inTransit) {
      // 已在送检流程中：流程未完成前不重算打断
      return { ...row, pending: true, abnormal: false }
    }
    // 基础状态只按检定结论落库；到期/临期产生的“待送检”由 currentStatus 与 pending 实时推导，
    // 避免新规则一来回把历史合格档案的状态改乱。从未检定（无有效期）的仪器落“待送检”。
    let target = STATUS_QUALIFIED
    if (view.conclusion === CONCLUSION_UNQUALIFIED) {
      target = STATUS_UNQUALIFIED
    } else if (view.validUntil === null) {
      target = STATUS_PENDING
    }
    return {
      ...row,
      status: target,
      '检定结论': view.conclusion,
      ...(view.validUntil ? { '有效期至': view.validUntil } : {}),
      pending: view.needSubmit,
      abnormal: view.conclusion === CONCLUSION_UNQUALIFIED,
    }
  })
  persist(next)
}

// 旧数据一次性迁移：按当前口径重算未停用仪器。
export function migrateLegacyRecords(rules: CalibrationRules = loadRules()): boolean {
  if (typeof window !== 'undefined' && window.localStorage) {
    if (window.localStorage.getItem(MIGRATION_STORAGE_KEY)) {
      return false
    }
    window.localStorage.setItem(MIGRATION_STORAGE_KEY, todayText())
  }
  recomputeActive(rules)
  return true
}

function notFound(id: number): ServiceResult {
  return { ok: false, message: `没有找到编号为 ${id} 的仪器检定记录` }
}

// 详情页可用动作与列表页完全一致。
export function availableActions(row: CalibRow): string[] {
  if (row.retired) {
    return [ACTION_REACTIVATE]
  }
  if (row.inTransit) {
    return [ACTION_PASS, ACTION_FAIL, ACTION_RETIRE]
  }
  return [ACTION_SUBMIT, ACTION_RETIRE, ...(row.estimated ? [ACTION_SUPPLEMENT] : [])]
}

function submitForCheck(row: CalibRow): ServiceResult | null {
  if (row.retired) {
    return { ok: false, message: '仪器已停用，不再安排送检' }
  }
  if (row.inTransit) {
    return { ok: false, message: '该仪器已在送检流程中，请勿重复送检' }
  }
  const duplicated = readCalibration().some(
    (item) => item.id !== row.id && item.instrumentNo && item.instrumentNo === row.instrumentNo && item.inTransit,
  )
  if (duplicated) {
    return { ok: false, message: `仪器 ${row.instrumentNo} 已有一条进行中的送检流程，请勿重复送检` }
  }
  return null
}

// 并发提交同一仪器时共用同一个 Promise，只有第一次真正生效，其余拿到同一结果。
const inflight = new Map<number, Promise<ServiceResult>>()

export function submitInstrument(id: number): Promise<ServiceResult> {
  const existing = inflight.get(id)
  if (existing) {
    return existing
  }
  const task = new Promise<ServiceResult>((resolve) => {
    // 留出并发窗口：双击或多标签同时提交也只会落库一次
    window.setTimeout(() => {
      const rows = listRows(CALIBRATION_KEY)
      const index = rows.findIndex((item) => Number(item.id) === id)
      if (index < 0) {
        resolve(notFound(id))
        return
      }
      const view = deriveRow(rows[index], loadRules())
      const blocked = submitForCheck(view)
      if (blocked) {
        resolve(blocked)
        return
      }
      const next = [...rows]
      next[index] = {
        ...rows[index],
        status: STATUS_IN_TRANSIT,
        '检定结论': view.conclusion === CONCLUSION_MISSING ? '' : view.conclusion,
        pending: true,
        abnormal: false,
      }
      persist(next)
      resolve({ ok: true, message: `仪器 ${view.instrumentNo} 已送出检定，进入「送检中」` })
    }, 300)
  }).then((result) => {
    inflight.delete(id)
    return result
  })
  inflight.set(id, task)
  return task
}

export function recordResult(id: number, qualified: boolean): ServiceResult {
  const rows = listRows(CALIBRATION_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return notFound(id)
  }
  const view = deriveRow(rows[index], loadRules())
  if (view.retired) {
    return { ok: false, message: '仪器已停用，不能再登记检定结论' }
  }
  if (!view.inTransit) {
    return { ok: false, message: '只有「送检中」的仪器才能登记检定结论' }
  }
  const rules = loadRules()
  const today = todayText()
  const conclusion = qualified ? CONCLUSION_QUALIFIED : CONCLUSION_UNQUALIFIED
  const validUntil = qualified ? addMonths(today, rules.defaultValidMonths) : view.validUntil
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: qualified ? STATUS_QUALIFIED : STATUS_UNQUALIFIED,
    '检定结论': conclusion,
    '检定日期': qualified ? today : (view.calibratedOn ?? today),
    '有效期至': validUntil ?? '',
    pending: !qualified,
    abnormal: !qualified,
  }
  persist(next)
  return {
    ok: true,
    message: qualified
      ? `检定合格，有效期至 ${validUntil}`
      : '已登记不合格结论，仪器进入待处置 / 再次送检清单',
  }
}

export function setRetired(id: number, retired: boolean): ServiceResult {
  const rows = listRows(CALIBRATION_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return notFound(id)
  }
  const next = [...rows]
  if (retired) {
    // 停用后从所有提示口径消失，并发中的待办也一并摘掉
    next[index] = { ...rows[index], status: STATUS_RETIRED, pending: false, abnormal: false }
    persist(next)
    return { ok: true, message: '仪器已停用，不再出现在送检与核查提示中' }
  }
  next[index] = { ...rows[index], status: STATUS_PENDING, pending: true, abnormal: false }
  persist(next)
  return { ok: true, message: '仪器已重新启用，按当前口径进入待送检队列' }
}

// 补录有效期：旧记录估算值被正式替换，不再标记待补。
export function supplementValidity(id: number, validUntil: string): ServiceResult {
  const parsed = parseDate(validUntil)
  if (!parsed) {
    return { ok: false, message: '请填写正确的有效期（YYYY-MM-DD）' }
  }
  const rows = listRows(CALIBRATION_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return notFound(id)
  }
  const next = [...rows]
  next[index] = { ...rows[index], '有效期至': parsed }
  persist(next)
  // 补录后按新口径重算一次
  recomputeActive(loadRules())
  return { ok: true, message: `有效期已补录为 ${parsed}，并按当前口径重新判定` }
}

export async function runCalibrationAction(id: number, action: string): Promise<ServiceResult> {
  const row = getCalibrationRow(id)
  if (!row) {
    return notFound(id)
  }
  switch (action) {
    case ACTION_SUBMIT:
      // 送出检定是异步落库：并发提交同一仪器时只生效一次
      return submitInstrument(id)
    case ACTION_PASS:
      return recordResult(id, true)
    case ACTION_FAIL:
      return recordResult(id, false)
    case ACTION_RETIRE:
      return setRetired(id, true)
    case ACTION_REACTIVATE:
      return setRetired(id, false)
    default:
      return { ok: false, message: `仪器检定没有登记「${action}」这个动作` }
  }
}

// ---------- 巡检待办联动 ----------

export function instrumentCheckTodos(rules: CalibrationRules = loadRules()): CalibRow[] {
  // 巡检核查口径与送检清单一致：未停用、无在途流程、确有问题的仪器
  return buildChecklist(readCalibration(rules))
}

function instrumentTodoExists(rows: EntryRow[], row: CalibRow): boolean {
  return rows.some((item) => {
    const project = String(item['检查项目'] ?? '')
    const target = String(item['仪器编号'] ?? '')
    return project.includes('仪器核查') && target === row.instrumentNo && String(item.status) === '待巡检'
  })
}

export function addInstrumentCheckTodo(row: CalibRow): ServiceResult {
  const rows = listRows(INSPECTION_KEY)
  if (instrumentTodoExists(rows, row)) {
    return { ok: false, message: `仪器 ${row.instrumentNo} 的核查待办已存在` }
  }
  const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const reason = row.conclusion === CONCLUSION_UNQUALIFIED
    ? '上次检定不合格，需复查'
    : row.validUntil === null
      ? '缺有效期，需现场核查检定情况'
      : row.expired
        ? '检定已过期，需尽快送检'
        : '检定临期，需安排送检'
  const next: EntryRow = {
    id: nextId,
    status: '待巡检',
    pending: true,
    abnormal: false,
    '记录编号': `INSP-INSTR-${String(nextId).padStart(4, '0')}`,
    '站点编号': row.site,
    '巡检日期': todayText(),
    '巡检人员': '待分派',
    '检查项目': `仪器核查｜${row.instrumentName}（${row.instrumentNo}）`,
    '发现问题': reason,
    '处理措施': '现场核查仪器状态并跟进送检',
    '巡检状态': '待巡检',
    '仪器编号': row.instrumentNo,
  }
  saveRows(INSPECTION_KEY, [...rows, next])
  return { ok: true, message: `已为仪器 ${row.instrumentNo} 新增一条巡检核查待办` }
}

export function addAllInstrumentCheckTodos(): { added: number; skipped: number } {
  let added = 0
  let skipped = 0
  // addInstrumentCheckTodo 每次都基于最新存储判重，连续新增也不会落出重复待办
  for (const row of instrumentCheckTodos()) {
    const result = addInstrumentCheckTodo(row)
    if (result.ok) {
      added += 1
    } else {
      skipped += 1
    }
  }
  return { added, skipped }
}

// ---------- 导出送检清单 CSV ----------

export function buildChecklistCsv(): string {
  const header = ['序号', '记录编号', '仪器编号', '仪器名称', '使用站点', '检定单位', '有效期至', '检定结论', '核查原因']
  const lines = [header.join(',')]
  buildChecklist(readCalibration()).forEach((row, index) => {
    const reason = row.conclusion === CONCLUSION_UNQUALIFIED
      ? '检定不合格'
      : row.validUntil === null
        ? '缺有效期待补'
        : row.expired
          ? '已过期'
          : `${row.daysLeft ?? 0}天后到期`
    const cells = [
      String(index + 1),
      row.recordNo,
      row.instrumentNo,
      row.instrumentName,
      row.site,
      row.agency,
      row.validUntil ?? '待补',
      row.conclusion,
      reason,
    ].map((cell) => `"${cell.replace(/"/g, '""')}"`)
    lines.push(cells.join(','))
  })
  return `﻿${lines.join('\n')}`
}
