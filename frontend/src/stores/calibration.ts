import { defineStore } from 'pinia'

import { loadRules, type CalibrationRules, type CalibrationView } from '@/domain/calibration'

// 列表 -> 详情 -> 返回 之间保留当前视图、检索条件与规则草稿，结论始终由领域实时推导。
export const useCalibrationStore = defineStore('calibration', {
  state: () => ({
    view: 'all' as CalibrationView,
    keyword: '',
    site: '',
    rules: loadRules(),
    rulesDraft: { ...loadRules() },
    rulesOpen: false,
  }),
  actions: {
    setView(view: CalibrationView) {
      this.view = view
    },
    setKeyword(value: string) {
      this.keyword = value
    },
    setSite(value: string) {
      this.site = value
    },
    setRulesOpen(open: boolean) {
      this.rulesOpen = open
      if (open) {
        this.rulesDraft = { ...this.rules }
      }
    },
    applyRules(next: CalibrationRules) {
      this.rules = { ...next }
      this.rulesDraft = { ...next }
      this.rulesOpen = false
    },
    refreshRules() {
      this.rules = loadRules()
      this.rulesDraft = { ...this.rules }
    },
  },
})
