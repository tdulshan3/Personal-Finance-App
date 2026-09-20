import type { ReactNode } from "react";

/**
 * Charts as plain SVG, rendered on the server.
 *
 * No chart library: the app is served from a phone, these three shapes are a few dozen lines each,
 * and server-rendered SVG means a live refresh redraws them with no client code at all.
 *
 * buildspec.md §13: charts need "text summaries". Every chart here takes already-formatted strings
 * for its labels, carries an `aria-label` that states the conclusion rather than describing the
 * picture, and is always accompanied on the page by the same figures as text. Numbers passed in are
 * for geometry only — money arithmetic never happens here.
 */

export const CHART_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)",
  "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)",
] as const;

export const chartColor = (index: number): string => CHART_COLORS[index % CHART_COLORS.length]!;

/** Income beside spending, one pair per month. */
export function FlowBars({
  months,
  summary,
}: {
  months: readonly { label: string; income: number; spending: number; incomeText: string; spendingText: string }[];
  summary: string;
}) {
  const width = 640;
  const height = 200;
  const pad = { top: 12, bottom: 4, left: 4, right: 4 };
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.spending]));
  const slot = (width - pad.left - pad.right) / Math.max(months.length, 1);
  const bar = Math.min(28, slot * 0.3);
  const plot = height - pad.top - pad.bottom;
  const scale = (value: number) => (Math.max(value, 0) / max) * plot;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} style={{ width: "100%", height: "auto", display: "block" }}>
        {[0.25, 0.5, 0.75, 1].map((line) => (
          <line key={line} x1={pad.left} x2={width - pad.right} y1={pad.top + plot * (1 - line)} y2={pad.top + plot * (1 - line)} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4" opacity="0.6" />
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plot} y2={pad.top + plot} stroke="var(--border)" strokeWidth="1" />
        {months.map((month, index) => {
          const centre = pad.left + slot * index + slot / 2;
          const incomeHeight = scale(month.income);
          const spendingHeight = scale(month.spending);
          return (
            <g key={month.label + index}>
              <rect x={centre - bar - 2} y={pad.top + plot - incomeHeight} width={bar} height={incomeHeight} rx="5" fill="var(--chart-income)">
                <title>{`${month.label}: income ${month.incomeText}`}</title>
              </rect>
              <rect x={centre + 2} y={pad.top + plot - spendingHeight} width={bar} height={spendingHeight} rx="5" fill="var(--chart-spending)">
                <title>{`${month.label}: spending ${month.spendingText}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      {/* Month names are real text, not SVG: scaled with the drawing they shrank to 7px on a phone. */}
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(months.length, 1)}, minmax(0, 1fr))`, padding: "6px 0 0", fontSize: "var(--font-footnote)", color: "var(--text-secondary)", textAlign: "center" }}>
        {months.map((month, index) => (
          <span key={month.label + index}>{month.label}</span>
        ))}
      </div>
    </div>
  );
}

/** Share of a total. Slices under a sliver are still drawn, so nothing recorded is invisible. */
export function Donut({
  slices,
  summary,
  children,
}: {
  slices: readonly { label: string; value: number; color: string; text: string }[];
  summary: string;
  /** Centre content, e.g. the total. */
  children?: ReactNode;
}) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, slice) => sum + Math.max(slice.value, 0), 0);
  let offset = 0;

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: "220px", aspectRatio: "1", margin: "0 auto" }}>
      <svg viewBox="0 0 100 100" role="img" aria-label={summary} style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--surface-sunken)" strokeWidth="12" />
        {total > 0
          ? slices.map((slice, index) => {
              const length = Math.max((Math.max(slice.value, 0) / total) * circumference, 0.8);
              const dash = `${Math.max(length - 1.2, 0.4)} ${circumference}`;
              const node = (
                <circle key={slice.label + index} cx="50" cy="50" r={radius} fill="none" stroke={slice.color} strokeWidth="12" strokeDasharray={dash} strokeDashoffset={-offset} strokeLinecap="butt">
                  <title>{`${slice.label}: ${slice.text}`}</title>
                </circle>
              );
              offset += length;
              return node;
            })
          : null}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", padding: "22%" }}>{children}</div>
    </div>
  );
}

/** Running total through the period, against the previous period as a dashed line. */
export function TrendLine({
  current,
  previous,
  summary,
}: {
  current: readonly number[];
  previous: readonly number[];
  summary: string;
}) {
  const width = 640;
  const height = 160;
  const pad = 6;
  const length = Math.max(current.length, previous.length, 2);
  const max = Math.max(1, ...current, ...previous);
  const x = (index: number) => pad + (index / (length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const path = (values: readonly number[]) => values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const last = current.length - 1;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} preserveAspectRatio="none" style={{ width: "100%", height: "140px", display: "block" }}>
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-spending)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--chart-spending)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {previous.length > 1 ? <path d={path(previous)} fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeDasharray="5 6" opacity="0.7" vectorEffect="non-scaling-stroke" /> : null}
      {current.length > 1 ? (
        <>
          <path d={`${path(current)} L${x(last).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`} fill="url(#trend-fill)" />
          <path d={path(current)} fill="none" stroke="var(--chart-spending)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      ) : null}
    </svg>
  );
}
