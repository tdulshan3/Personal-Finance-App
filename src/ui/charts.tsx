"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * The app's charts: plain SVG, drawn at the size they are shown so their text stays 11–12 px.
 *
 * They follow the dataviz skill's specs: columns at most 24 px wide with a 4 px rounded end and a
 * 2 px surface gap; 2 px lines; one solid hairline grid; a legend for two or more series; a hover
 * and keyboard tooltip that lists every series at that point; and a hidden table carrying the same
 * figures for a screen reader. Text wears text colours, never the series colour.
 *
 * Numbers passed in are for geometry only. Every figure a reader sees arrives already formatted
 * by the caller from the ledger's own `Money`, so no arithmetic on money happens here.
 */

export type Series = {
  readonly key: string;
  readonly name: string;
  /** A CSS colour, normally one of the --chart-* tokens. */
  readonly color: string;
  readonly values: readonly number[];
  /** The formatted value at each point, for the tooltip and the table. */
  readonly texts: readonly string[];
  /** muted: a de-emphasised comparison line; dashed: a projection or threshold. */
  readonly style?: "solid" | "muted" | "dashed";
};

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(120, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Clean axis steps covering [min, max]: 0, 25K, 50K… — both ends rounded outward to a step. */
function ticksFor(min: number, max: number, count = 4): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10;
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round((last - first) / step) + 1 }, (_, index) => first + index * step);
}

export function Legend({ items }: { items: readonly { name: string; color: string; line?: boolean | undefined; dashed?: boolean | undefined }[] }) {
  return (
    <ul className="pfa-legend" aria-hidden="true">
      {items.map((item) => (
        <li key={item.name}>
          {item.line ? (
            <svg width="14" height="6" aria-hidden="true">
              <line x1="1" x2="13" y1="3" y2="3" stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={item.dashed ? "3 3" : undefined} />
            </svg>
          ) : (
            <span className="pfa-chart__swatch" style={{ background: item.color }} />
          )}
          {item.name}
        </li>
      ))}
    </ul>
  );
}

function Tip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: readonly { color: string; name: string; value: string }[] }) {
  // Keep the card inside the chart: flip to the left of the pointer near the right edge.
  const left = x > width - 170 ? Math.max(0, x - 162) : x + 12;
  return (
    <div className="pfa-chart__tip" style={{ left, top: Math.max(0, y) }} role="presentation">
      <div className="pfa-chart__tip-title">{title}</div>
      {rows.map((row) => (
        <div key={row.name} className="pfa-chart__tip-row">
          <span className="pfa-chart__key" style={{ background: row.color }} />
          <strong>{row.value}</strong>
          <span>{row.name}</span>
        </div>
      ))}
    </div>
  );
}

function DataTable({ caption, labels, series }: { caption: string; labels: readonly string[]; series: readonly Series[] }) {
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {series.map((s) => (
            <th key={s.key} scope="col">{s.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((label, index) => (
          <tr key={label + index}>
            <th scope="row">{label}</th>
            {series.map((s) => (
              <td key={s.key}>{s.texts[index] ?? ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One rounded-top column: square at the baseline, 4 px radius at the data end. */
function columnPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return "";
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** Grouped columns, one group per period: income beside spending, month by month. */
export function ColumnChart({
  summary,
  labels,
  series,
  tick,
  height = 180,
}: {
  /** The conclusion, for the accessible name. */
  summary: string;
  labels: readonly string[];
  series: readonly Series[];
  /** Formats a y-axis value, e.g. compact money. */
  tick: (value: number) => string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const [active, setActive] = useState<number | null>(null);
  const axis = 44;
  const bottom = 22;
  const top = 8;
  const plotWidth = Math.max(40, width - axis);
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = ticksFor(0, max);
  const ceiling = ticks[ticks.length - 1] || 1;
  const band = plotWidth / Math.max(labels.length, 1);
  const columnWidth = Math.min(24, Math.max(4, (band * 0.62 - 2 * (series.length - 1)) / Math.max(series.length, 1)));
  const groupWidth = columnWidth * series.length + 2 * (series.length - 1);
  const y = (value: number) => top + plotHeight - (Math.max(value, 0) / ceiling) * plotHeight;

  return (
    <div className="pfa-chart" ref={ref}>
      {series.length > 1 ? <Legend items={series.map((s) => ({ name: s.name, color: s.color }))} /> : null}
      <svg width={width} height={height} role="img" aria-label={summary} onPointerLeave={() => setActive(null)}>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={axis} x2={width} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" strokeWidth="1" />
            <text x={axis - 6} y={y(value) + 4} textAnchor="end">{tick(value)}</text>
          </g>
        ))}
        {labels.map((label, index) => {
          const start = axis + band * index + (band - groupWidth) / 2;
          return (
            <g key={label + index}>
              {series.map((s, si) => {
                const value = s.values[index] ?? 0;
                const x = start + si * (columnWidth + 2);
                return <path key={s.key} d={columnPath(x, y(value), columnWidth, y(0) - y(value))} fill={s.color} opacity={active === null || active === index ? 1 : 0.55} />;
              })}
              <text x={axis + band * index + band / 2} y={height - 6} textAnchor="middle">{label}</text>
              {/* The whole band is the hit target, much larger than the columns. */}
              <rect
                data-hit=""
                x={axis + band * index}
                y={top}
                width={band}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                aria-label={`${label}: ${series.map((s) => `${s.name} ${s.texts[index] ?? ""}`).join(", ")}`}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      {active !== null ? (
        <Tip
          x={axis + band * active + band / 2}
          y={top + 20}
          width={width}
          title={labels[active] ?? ""}
          rows={series.map((s) => ({ color: s.color, name: s.name, value: s.texts[active] ?? "" }))}
        />
      ) : null}
      <DataTable caption={summary} labels={labels} series={series} />
    </div>
  );
}

/**
 * Lines over a shared run of days, with a crosshair that snaps to the nearest day and lists every
 * series there. The first solid series gets a 10% wash and an end dot; a `threshold` draws one
 * labelled reference line (a buffer, a limit).
 */
export function LineChart({
  summary,
  labels,
  series,
  tick,
  axisLabels,
  threshold,
  height = 180,
  footer,
}: {
  summary: string;
  /** One label per point, for the tooltip and the table ("22 Oct"). */
  labels: readonly string[];
  series: readonly Series[];
  tick: (value: number) => string;
  /** The few labels under the x-axis: index → text. */
  axisLabels: readonly { index: number; text: string }[];
  threshold?: { value: number; label: string } | undefined;
  height?: number;
  footer?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, "");
  const axis = 48;
  const top = 10;
  const bottom = 22;
  const plotWidth = Math.max(40, width - axis - 8);
  const plotHeight = height - top - bottom;
  const count = Math.max(...series.map((s) => s.values.length), 2);
  const all = series.flatMap((s) => s.values).concat(threshold ? [threshold.value] : []);
  const ticks = ticksFor(Math.min(0, ...all), Math.max(1, ...all));
  const low = ticks[0] ?? 0;
  const high = ticks[ticks.length - 1] ?? 1;
  const x = (index: number) => axis + (index / (count - 1)) * plotWidth;
  const y = (value: number) => top + plotHeight - ((value - low) / (high - low || 1)) * plotHeight;
  const path = (values: readonly number[]) => values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const primary = series.find((s) => (s.style ?? "solid") === "solid");

  const pick = (clientX: number, element: SVGSVGElement) => {
    const box = element.getBoundingClientRect();
    const ratio = (clientX - box.left - axis) / plotWidth;
    setActive(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };

  return (
    <div className="pfa-chart" ref={ref}>
      {series.length > 1 || threshold ? (
        <Legend
          items={[
            ...series.map((s) => ({ name: s.name, color: s.color, line: true, dashed: s.style === "dashed" })),
            ...(threshold ? [{ name: threshold.label, color: "var(--chart-alert)", line: true, dashed: true }] : []),
          ]}
        />
      ) : null}
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setActive((current) => Math.max(0, Math.min(count - 1, (current ?? (e.key === "ArrowLeft" ? count : -1)) + (e.key === "ArrowLeft" ? -1 : 1))));
        }}
        style={{ touchAction: "pan-y" }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={primary?.color ?? "transparent"} stopOpacity="0.12" />
            <stop offset="100%" stopColor={primary?.color ?? "transparent"} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={axis} x2={axis + plotWidth} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" strokeWidth="1" />
            <text x={axis - 6} y={y(value) + 4} textAnchor="end">{tick(value)}</text>
          </g>
        ))}
        {threshold ? <line x1={axis} x2={axis + plotWidth} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--chart-alert)" strokeWidth="1.5" strokeDasharray="4 4" /> : null}
        {primary && primary.values.length > 1 ? (
          <path d={`${path(primary.values)}L${x(primary.values.length - 1)},${y(Math.max(low, 0))}L${x(0)},${y(Math.max(low, 0))}Z`} fill={`url(#${gradient})`} />
        ) : null}
        {series.map((s) =>
          s.values.length > 1 ? (
            <path
              key={s.key}
              d={path(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.style === "dashed" ? "5 4" : undefined}
              opacity={s.style === "muted" ? 0.9 : 1}
            />
          ) : null,
        )}
        {primary && primary.values.length > 0 ? (
          <circle cx={x(primary.values.length - 1)} cy={y(primary.values[primary.values.length - 1]!)} r="4" fill={primary.color} stroke="var(--chart-surface)" strokeWidth="2" />
        ) : null}
        {axisLabels.map(({ index, text }) => (
          <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index >= count - 1 ? "end" : "middle"}>{text}</text>
        ))}
        {active !== null ? (
          <g pointerEvents="none">
            <line x1={x(active)} x2={x(active)} y1={top} y2={top + plotHeight} stroke="var(--chart-text-secondary)" strokeWidth="1" />
            {series.map((s) =>
              s.values[active] !== undefined ? <circle key={s.key} cx={x(active)} cy={y(s.values[active]!)} r="4" fill={s.color} stroke="var(--chart-surface)" strokeWidth="2" /> : null,
            )}
          </g>
        ) : null}
      </svg>
      {active !== null ? (
        <Tip
          x={x(active)}
          y={top}
          width={width}
          title={labels[active] ?? ""}
          rows={series.filter((s) => s.texts[active] !== undefined).map((s) => ({ color: s.color, name: s.name, value: s.texts[active]! }))}
        />
      ) : null}
      {footer}
      <DataTable caption={summary} labels={labels} series={series} />
    </div>
  );
}

/** Ranked horizontal bars with their values written out: where the money went. */
export function BarList({
  rows,
  label,
  income = false,
}: {
  rows: readonly { key: string; name: ReactNode; value: string; share: number; href?: string | undefined }[];
  /** Accessible name of the list. */
  label: string;
  income?: boolean;
}) {
  const top = Math.max(...rows.map((row) => row.share), 0.0001);
  return (
    <ul className="pfa-bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key} className="pfa-bars__row" data-income={income ? "" : undefined}>
          <span className="pfa-bars__name">{row.href ? <a href={row.href}>{row.name}</a> : row.name}</span>
          <span className="pfa-bars__value">
            {row.value} · {Math.round(row.share * 100)}%
          </span>
          <span className="pfa-bars__track" aria-hidden="true">
            <span className="pfa-bars__fill" style={{ width: `${Math.max(1, (row.share / top) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
