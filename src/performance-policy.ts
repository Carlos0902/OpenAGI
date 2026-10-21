/** Shared policy for discovery, planning, execution and independent acceptance. */
export const performanceInstructions = `Performance work exists to remove concrete, evidenced heavyweight algorithms, redundant work or avoidable resource use while preserving working behavior. Do not invent minimum percentage improvements, latency/p95/FPS budgets or benchmark targets. Prefer a small reversible algorithmic or caching correction supported by actual code; archive speculative tuning when no meaningful inefficiency is demonstrated. Never put numeric performance targets into required test assertions or configured check exit codes; use separate observational reports. Measurements are observations, not delivery gates: record results and limitations honestly without requiring any numeric improvement. Existing system-generated numeric performance targets must be interpreted as nonblocking measurements. Functional correctness, meaningful tests, absence of regressions and concrete removal of the identified inefficiency remain required. Do not add prerequisite optimization projects solely to manufacture a benchmark. Distinguish structural properties of the algorithm from arbitrary performance KPIs.`;

/** Legacy numerical performance targets cannot silently remain release gates. */
export function quantitativePerformanceTarget(criterion: string): boolean {
  const performance = /性能|耗时|延迟|响应时间|帧率|渲染|写入|performance|latency|response time|frame rate|render|throughput|\b(?:cpu|fps|p\d{2})\b|\b(?:dom|memory)\s+(?:writes?|usage)\b/i.test(criterion);
  const metric = /\d+(?:\.\d+)?\s*[%％]|百分之\s*\d|\bp\d{2}\b|(?:至少|不超过|低于|小于|达到|at least|at most|under|below|<=|>=)\s*\d+(?:\.\d+)?\s*(?:毫秒|秒|ms\b|seconds?\b|fps\b|bytes?\b|[kmg]b\b)/i.test(criterion);
  return performance && metric;
}
