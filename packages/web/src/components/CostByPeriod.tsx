import type { CostBucket } from "../api/types.js";
import { formatUsd } from "../lib/money.js";
import { EmptyState } from "./states.js";

/** Period (day/week) cost aggregation table (M5 DoD #2). */
export function CostByPeriod({ buckets }: { buckets: CostBucket[] }) {
  if (buckets.length === 0) {
    return <EmptyState message="No cost data yet" />;
  }
  return (
    <table className="cost-table">
      <caption className="cost-table-caption">Cost by period</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Cost</th>
          <th scope="col">Tokens</th>
          <th scope="col">Executions</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.periodStart}>
            <td>{b.periodStart.slice(0, 10)}</td>
            <td>{formatUsd(b.costUsd)}</td>
            <td>{b.totalTokens}</td>
            <td>{b.traceCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
