/*
Copyright 2022 ByteDance and/or its affiliates.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import run from 'lighthouse'
// @ts-expect-error
import defaultConfig from 'lighthouse/lighthouse-core/config/default-config'

import { NetworkRequests, WhiteScreen } from './audits'
import { ConsoleLogger, ReactProfiler, RequestInterception, Screencast } from './gatherers'

type KeyAuditName = 'first-contentful-paint' | 'interactive' | 'total-blocking-time' | 'largest-contentful-paint'

export const getNumericValue = (lhr: LH.Result, auditName: KeyAuditName) => lhr.audits[auditName]?.numericValue ?? NaN
export const getTTI = (lhr: LH.Result) => getNumericValue(lhr, 'interactive')

export const getScore = (lhr: LH.Result, auditName: KeyAuditName) => lhr.audits[auditName]?.score ?? NaN
export const getTBTScore = (lhr: LH.Result) => getScore(lhr, 'total-blocking-time')
export const getLCPScore = (lhr: LH.Result) => getScore(lhr, 'largest-contentful-paint')

export type MetricsRecord = {
  index: number
  lcp: number
  tbt: number
}

function getMedianValue(numbers: number[]) {
  const sorted = numbers.slice().sort((a, b) => a - b)
  if (sorted.length % 2 === 1) return sorted[(sorted.length - 1) / 2]
  const lowerValue = sorted[sorted.length / 2 - 1]
  const upperValue = sorted[sorted.length / 2]
  return (lowerValue + upperValue) / 2
}

function getMedianSortValue(value: number, median: number) {
  const distance = median - value
  return distance * distance
}

function filterToValidRuns(runs: MetricsRecord[], key: keyof MetricsRecord) {
  return runs.filter((run) => Number.isFinite(run[key]))
}

export function computeMedianRun(runs: MetricsRecord[]) {
  const runsWithLCP = filterToValidRuns(runs, 'lcp')

  if (!runsWithLCP.length) {
    return runs[0].index
  }

  const runsWithTBT = filterToValidRuns(runsWithLCP, 'tbt')
  if (runsWithTBT.length > 0 && runsWithTBT.length < 3) {
    return runsWithTBT[0].index
  }

  const medianLCP = getMedianValue(runsWithLCP.map((run) => run.lcp))
  const medianTBT = getMedianValue(runsWithTBT.map((run) => run.tbt))

  // Sort by proximity to the medians, breaking ties with the minimum TBT.
  const sortedByProximityToMedian = runsWithLCP.sort((a, b) => {
    const aLCP = a.lcp
    const aTBT = a.tbt
    const bLCP = b.lcp
    const bTBT = b.tbt
    const order = getMedianSortValue(aLCP, medianLCP) - getMedianSortValue(bLCP, medianLCP)

    if (aTBT && bTBT) {
      return order + getMedianSortValue(aTBT, medianTBT) - getMedianSortValue(bTBT, medianTBT)
    }

    return order
  })

  return sortedByProximityToMedian[0].index
}

export function runsNotExceedMedianBy(diffScore: number, runs: MetricsRecord[]) {
  const runsWithLCP = filterToValidRuns(runs, 'lcp')

  if (!runsWithLCP.length) {
    return runs
  }

  const runsWithTBT = filterToValidRuns(runsWithLCP, 'tbt')
  if (!runsWithTBT.length) {
    return runsWithTBT
  }

  const medianLCP = getMedianValue(runsWithLCP.map((run) => run.lcp))
  const medianTBT = getMedianValue(runsWithTBT.map((run) => run.tbt))

  return runsWithTBT.filter((run) => {
    const tbtPass = run.tbt - medianTBT <= diffScore && run.tbt - medianTBT >= -diffScore
    const lcpPass = run.lcp - medianLCP <= diffScore && run.lcp - medianLCP >= -diffScore
    return tbtPass && lcpPass
  })
}

export async function lighthouse(url?: string, { customFlags, ...flags }: LH.Flags = {}) {
  return run(
    url,
    {
      maxWaitForFcp: 30 * 1000,
      maxWaitForLoad: 45 * 1000,
      output: 'json',
      logLevel: 'info',
      ...flags,
    },
    {
      ...defaultConfig,
      passes: defaultConfig.passes.map((pass: LH.PerfseePassJson) => {
        pass = {
          ...pass,
          gatherers: [new RequestInterception(customFlags?.headers), new ConsoleLogger(), ...(pass.gatherers ?? [])],
        }

        if (pass.passName === 'defaultPass') {
          pass.gatherers?.push(Screencast)
          if (customFlags?.reactProfiling) {
            pass.gatherers?.push(new ReactProfiler())
          }
        }

        return pass
      }),
      audits: [...defaultConfig.audits, NetworkRequests, WhiteScreen],
      settings: {
        additionalTraceCategories: 'disabled-by-default-v8.cpu_profiler',
      },
    },
  )
}
