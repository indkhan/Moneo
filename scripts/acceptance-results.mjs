import assert from "node:assert/strict";

export function assertRequiredResults(runner, report) {
  if (runner === "vitest") {
    assert(report.success === true && report.numTotalTests > 0 && report.numFailedTests === 0 && report.numPendingTests === 0,
      "Required unit/DB acceptance failed, was empty or skipped");
  } else {
    const stats = report.stats;
    assert(stats && stats.expected > 0 && stats.skipped === 0 && stats.unexpected === 0 && stats.flaky === 0,
      "Required browser acceptance failed, was empty, flaky or skipped");
  }
}
