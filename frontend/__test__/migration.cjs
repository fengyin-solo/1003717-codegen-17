// 旧数据迁移验证：模拟老用户 localStorage 中是旧版样例数据。
const mkStorage = () => {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}
const storage = mkStorage()
globalThis.window = { localStorage: storage, setTimeout, clearTimeout }
globalThis.localStorage = storage

const legacyCalibration = [
  { id: 1, status: '待送检', pending: true, abnormal: false, '记录编号': 'CALI-0001', '仪器编号': 'CALI-0001', '仪器名称': '仪器检定样例1', '检定单位': '仪器检定样例1', '检定日期': '2026-09-01', '有效期至': '仪器检定样例1', '检定结论': '仪器检定样例1', '检定状态': '仪器检定样例1' },
  { id: 2, status: '送检中', pending: true, abnormal: true, '记录编号': 'CALI-0002', '仪器编号': 'CALI-0002', '仪器名称': '仪器检定样例2', '检定单位': '仪器检定样例2', '检定日期': '2026-09-02', '有效期至': '仪器检定样例2', '检定结论': '仪器检定样例2', '检定状态': '仪器检定样例2' },
  { id: 3, status: '已合格', pending: false, abnormal: false, '记录编号': 'CALI-0003', '仪器编号': 'CALI-0003', '仪器名称': '仪器检定样例3', '检定单位': '仪器检定样例3', '检定日期': '2026-09-03', '有效期至': '仪器检定样例3', '检定结论': '仪器检定样例3', '检定状态': '仪器检定样例3' },
]
const full = { ...require('./bundle.cjs').SEED_ROWS, calibration: legacyCalibration }
storage.setItem('hydrology-monitor-station:entries', JSON.stringify(full))

const bundle = require('./bundle.cjs')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) pass++
  else { fail++; console.error('FAIL:', name, extra) }
}

// 迁移前：旧状态原样，读视图时推导
let rows = bundle.readCalibration()
check('旧记录1有效期被估算为2027-09-01', rows.find(r => r.id === 1).validUntil === '2027-09-01', rows.find(r => r.id === 1).validUntil)
check('旧记录1标记估算待补', rows.find(r => r.id === 1).estimated === true)
check('旧记录1结论归待补', rows.find(r => r.id === 1).conclusion === '待补')
check('未来有效期未临期不需送检', rows.find(r => r.id === 1).needSubmit === false)
check('旧记录2保持送检中不重算', rows.find(r => r.id === 2).inTransit === true)
check('旧记录3估算有效期2027-09-03', rows.find(r => r.id === 3).validUntil === '2027-09-03')

// 首次迁移
const migrated = bundle.migrateLegacyRecords()
check('首次迁移返回true', migrated === true)
const persisted = bundle.listRows('calibration')
check('迁移后旧记录1状态改为已合格(未临期)', persisted.find(r => r.id === 1).status === '已合格')
check('迁移后旧记录1结论标准化为待补', persisted.find(r => r.id === 1)['检定结论'] === '待补')
check('迁移后旧记录1有效期写回估算值', persisted.find(r => r.id === 1)['有效期至'] === '2027-09-01')
check('迁移后旧记录1不再pending', persisted.find(r => r.id === 1).pending === false)
check('迁移后旧记录2仍是送检中', persisted.find(r => r.id === 2).status === '送检中')
check('迁移后旧记录2 abnormal被清掉(送检中不算异常)', persisted.find(r => r.id === 2).abnormal === false)
check('迁移后旧记录3已合格', persisted.find(r => r.id === 3).status === '已合格')

// 第二次迁移不重复
check('再次迁移返回false', bundle.migrateLegacyRecords() === false)

// 停用仪器迁移场景：加一条旧版停用且 pending=true（旧口径bug），再清迁移标记
storage.removeItem('hydrology-monitor-station:calibration-migrated')
const withRetired = [
  ...persisted,
  { id: 99, status: '已停用', pending: true, abnormal: true, '记录编号': 'CALI-0099', '仪器编号': 'YQ-OLD-99', '仪器名称': '老仪器', '使用站点': '老站', '检定单位': 'x', '检定日期': '2020-01-01', '有效期至': '不知道', '检定结论': '合格', '检定状态': '已停用' },
]
bundle.saveRows('calibration', withRetired)
bundle.migrateLegacyRecords()
const retiredAfter = bundle.listRows('calibration').find(r => r.id === 99)
check('停用仪器迁移后仍停用', retiredAfter.status === '已停用')
check('停用仪器迁移后 pending 清零', retiredAfter.pending === false)
check('停用仪器迁移后 abnormal 清零', retiredAfter.abnormal === false)
const retiredView = bundle.getCalibrationRow(99)
check('停用仪器不临期不送检', retiredView.nearExpiry === false && retiredView.needSubmit === false)
check('停用仪器估算了有效期但不提示', retiredView.validUntil === '2021-01-01' && retiredView.estimated === true)

// 迁移后保存新规则也不影响停用仪器
bundle.saveRules({ nearExpiryDays: 365, defaultValidMonths: 12 })
const retiredView2 = bundle.getCalibrationRow(99)
check('规则调整后停用仪器依然不提示', retiredView2.needSubmit === false && retiredView2.nearExpiry === false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
