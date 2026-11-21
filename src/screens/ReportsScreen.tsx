import { useEffect, useRef, useState } from 'react';
import { CachedFileList, useCachedFileFocus } from '../components/CachedFileList';
import type { CachedFileListProps } from '../components/CachedFileList';
import { ExportResultPanel } from '../components/ExportResultPanel';
import type { ExportFileNotice } from '../components/ExportResultPanel';
import type { Db } from '../db/driver';
import { monthReport, yearReport } from '../db/repos/reports';
import type {
  BudgetActual,
  MonthExtreme,
  MonthPoint,
  MonthReport,
  ReportCategory,
  YearReport,
} from '../db/repos/reports';
import { formatCentsDisplay } from '../components/AmountText';
import { ReportPie, sliceShade } from '../components/ReportPie';
import { ReportCategoryDetails } from '../components/ReportCategoryDetails';
import { useDb, useQuery } from '../store/useDb';
import { cachedReports, deviceBinaryFileWriter } from '../backup/device';
import type { CachedFile, ShareOutcome } from '../backup/device';
import { exportMonthWorkbook, exportYearWorkbook } from '../export/reportWorkbook';
import { exportToast } from '../backup/format';
import { formatMonthLabel, monthKeyOf, shiftMonthKey, todayLocalISO } from '../domain/date';

/**
 * 报表: the two questions a month (or a year) has to answer — where the money
 * went, and whether it stayed inside the budget.
 *
 * The screen is a pure renderer over one read from repositories/reports. It
 * never adds up a category, never divides a total and never writes: 月 and 年 are
 * the same two calls (monthReport / yearReport), the same pie and the same
 * twelve bars, with the year view adding the two ends of the year and the month
 * view adding the budget bars.
 *
 * The mode is screen state, not a route: switching 月/年 swaps the numbers
 * under the same heading. A snapshot from the other mode is treated as absent,
 * the way 统计 refuses to paint last month's figures under this month's title.
 */

/** Which period the screen is describing. */
export type ReportMode = 'month' | 'year';

/** One loaded month, keyed by the month it describes. */
export interface ReportsMonthData {
  kind: 'month';
  /** YYYY-MM, so a stale snapshot can be recognised. */
  key: string;
  report: MonthReport;
}

/** One loaded year, keyed by the year it describes. */
export interface ReportsYearData {
  kind: 'year';
  /** YYYY. */
  key: string;
  report: YearReport;
}

/** What the screen renders from: one month or one year, never both. */
export type ReportsData = ReportsMonthData | ReportsYearData;

/**
 * The screen's one query. The key is filled in from the selection rather than
 * read back from the report, so the view can drop a snapshot that belongs to
 * the other mode without a second render.
 */
export async function loadReportsData(
  db: Db,
  mode: ReportMode,
  monthKey: string,
  year: number
): Promise<ReportsData> {
  if (mode === 'month') {
    return { kind: 'month', key: monthKey, report: await monthReport(db, monthKey) };
  }
  return { kind: 'year', key: String(year), report: await yearReport(db, year) };
}

/** The month number of a YYYY-MM key, as the screen prints it. */
export function monthNumberOf(monthKey: string): number {
  return Number(monthKey.slice(5, 7));
}

/** The height of one bar, in percent of the plot, against the tallest month. */
export function barHeightPercent(cents: number, peakCents: number): number {
  if (peakCents <= 0 || cents <= 0) return 0;
  return Math.max(1, Math.round((cents / peakCents) * 100));
}

/** One bar's state: drawn solid, drawn as a past month, or left blank. */
export type BarState = 'current' | 'past' | 'zero' | 'future';

/**
 * A month that has not happened is blank, never a zero: a past month without
 * spending is a fact and gets its hairline, a future one has no answer yet.
 */
export function barStateOf(point: MonthPoint, highlightMonth: string): BarState {
  if (point.isFuture) return 'future';
  if (point.month === highlightMonth) return 'current';
  if (point.cents <= 0) return 'zero';
  return 'past';
}

export interface MonthlyBarsProps {
  /** January to December of the period's year. */
  points: readonly MonthPoint[];
  /** The one month drawn in solid ink; '' when none of them is "this month". */
  highlightMonth: string;
}

/**
 * The twelve bars of the year.
 *
 * Heights are relative to the tallest month that has happened, so the shape of
 * the year is what the chart shows rather than the absolute amount. The axis
 * prints every other month plus the highlighted one, and nothing after it —
 * the same six numbers the prototype's axis carries.
 */
export function MonthlyBars({ points, highlightMonth }: MonthlyBarsProps) {
  const peakCents = points.reduce(
    (peak, point) => (point.isFuture ? peak : Math.max(peak, point.cents)),
    0
  );
  const summary = points
    .filter(point => !point.isFuture)
    .map(point => `${monthNumberOf(point.month)} 月 ${formatCentsDisplay(point.cents)}`)
    .join('，');

  return (
    <div className="reports-bars">
      <div className="reports-bars__plot" role="img" aria-label={`按月支出：${summary}`}>
        {points.map(point => {
          const state = barStateOf(point, highlightMonth);
          const drawn = state === 'past' || state === 'current';
          return (
            <span
              key={point.month}
              data-bar={point.month}
              className={`reports-bars__col reports-bars__col--${state}`}
              style={drawn ? { height: `${barHeightPercent(point.cents, peakCents)}%` } : undefined}
              aria-hidden="true"
            />
          );
        })}
      </div>
      <div className="reports-bars__axis" aria-hidden="true">
        {points.map((point, index) => {
          const show = !point.isFuture && (index % 2 === 0 || point.month === highlightMonth);
          return (
            <span className="reports-bars__tick" key={point.month}>
              {show ? String(index + 1) : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Where a budget bar is filled: the whole track once the budget is spent. */
export function budgetFillPercent(spentCents: number, budgetCents: number): number {
  if (budgetCents > 0) {
    return Math.min(100, Math.round((spentCents / budgetCents) * 1000) / 10);
  }
  return spentCents > 0 ? 100 : 0;
}

type ExportFeedback = { kind: 'notice' | 'error'; text: string };

export interface ReportsViewProps {
  mode: ReportMode;
  /** The month being described (YYYY-MM); also the month the series highlights. */
  monthKey: string;
  /** The year being described. */
  year: number;
  /** Today's month: the upper bound of the month picker and the future marker. */
  currentMonthKey: string;
  /** Today's year: the upper bound of the year stepper. */
  currentYear: number;
  /** The snapshot for this mode, or null while it loads (or belongs elsewhere). */
  data: ReportsData | null;
  error: Error | null;
  /**
   * Starts the .xlsx export. Undefined while the database is still opening, so
   * the entry is drawn but cannot claim to have saved anything yet.
   */
  onExport?: () => void;
  /** True while the workbook is being built or shared. */
  exporting?: boolean;
  feedback?: ExportFeedback | null;
  exportResult?: ExportFileNotice | null;
  onViewCached?: (fileName: string) => Promise<boolean>;
  cacheFocusRequest?: CachedFileListProps['focusRequest'];
  cachedFiles?: readonly CachedFile[];
  cacheReadFailed?: boolean;
  sharing?: boolean;
  onShareCached?(file: CachedFile): void;
  onModeChange(mode: ReportMode): void;
  onMonthChange(monthKey: string): void;
  onYearChange(year: number): void;
  onCategorySelect(category: ReportCategory): void;
}

/**
 * The whole screen as a pure function of one snapshot.
 *
 * Keeping the view separate is what lets the tests render the year without a
 * browser: the same component that opens on 月 can be shown on 年 by handing it
 * mode="year" and that year's snapshot.
 */
export function ReportsView({
  mode,
  monthKey,
  year,
  currentMonthKey,
  currentYear,
  data,
  error,
  onExport,
  exporting = false,
  feedback = null,
  exportResult = null,
  onViewCached,
  cacheFocusRequest,
  cachedFiles = [],
  cacheReadFailed = false,
  sharing = false,
  onShareCached,
  onModeChange,
  onMonthChange,
  onYearChange,
  onCategorySelect,
}: ReportsViewProps) {
  const isMonth = mode === 'month';
  const monthData = data !== null && data.kind === 'month' ? data.report : null;
  const yearData = data !== null && data.kind === 'year' ? data.report : null;
  const ready = isMonth ? monthData !== null : yearData !== null;

  const expenseCents = monthData?.expenseCents ?? yearData?.expenseCents ?? 0;
  const incomeCents = monthData?.incomeCents ?? yearData?.incomeCents ?? 0;
  const categories = monthData?.categories ?? yearData?.categories ?? [];
  const series = monthData?.monthlySeries ?? yearData?.monthlySeries ?? [];
  const budgets: readonly BudgetActual[] = monthData?.budgets ?? [];
  const hasUnrecordedBudgets = monthData?.hasUnrecordedBudgets ?? false;
  const busiest: MonthExtreme | null = yearData?.busiestMonth ?? null;
  const quietest: MonthExtreme | null = yearData?.quietestMonth ?? null;

  const atCurrentMonth = monthKey >= currentMonthKey;
  const atCurrentYear = year >= currentYear;
  const previousMonth = shiftMonthKey(monthKey, -1);
  const nextMonth = shiftMonthKey(monthKey, 1);

  return (
    <div className="reports-screen">
      <header className="reports-head">
        <h1>报表</h1>
        <div className="reports-seg" role="group" aria-label="月或年">
          <button
            type="button"
            className={isMonth ? 'reports-seg__item is-on' : 'reports-seg__item'}
            aria-pressed={isMonth}
            onClick={() => onModeChange('month')}
          >
            月
          </button>
          <button
            type="button"
            className={isMonth ? 'reports-seg__item' : 'reports-seg__item is-on'}
            aria-pressed={!isMonth}
            onClick={() => onModeChange('year')}
          >
            年
          </button>
        </div>
      </header>

      <div className="reports-period">
        <button
          className="reports-period__arrow"
          type="button"
          aria-label={isMonth ? '上个月' : '上一年'}
          onClick={() => {
            if (isMonth) onMonthChange(previousMonth);
            else onYearChange(year - 1);
          }}
        >
          ‹
        </button>
        <span className="reports-period__label num">
          {isMonth ? formatMonthLabel(monthKey) : `${year} 年`}
        </span>
        <button
          className="reports-period__arrow"
          type="button"
          aria-label={isMonth ? '下个月' : '下一年'}
          disabled={isMonth ? atCurrentMonth : atCurrentYear}
          onClick={() => {
            if (isMonth) {
              if (!atCurrentMonth) onMonthChange(nextMonth);
            } else if (!atCurrentYear) {
              onYearChange(year + 1);
            }
          }}
        >
          ›
        </button>
      </div>

      {!ready ? (
        data === null && error !== null ? (
          <p className="reports-note reports-note--error" role="alert">
            报表暂时打不开
          </p>
        ) : (
          <p className="reports-note" role="status">
            正在读取报表…
          </p>
        )
      ) : (
        <>
          <p className="reports-meta">
            <span>
              收入 <span className="num">{formatCentsDisplay(incomeCents)}</span>
            </span>
            <span>
              结余 <span className="num">{formatCentsDisplay(incomeCents - expenseCents)}</span>
            </span>
          </p>

          <section className="reports-card reports-card--pie" aria-label="钱去哪了">
            <div className="reports-card__head">
              <h2 className="reports-card__title">钱去哪了</h2>
              <span className="reports-card__hint">按一级分类</span>
            </div>
            {categories.length === 0 ? (
              <div className="reports-empty">
                <p className="reports-empty__title">
                  {isMonth ? '本月没有支出' : '这一年没有支出'}
                </p>
                <p className="reports-empty__note">没有支出，就没有饼可以画。</p>
              </div>
            ) : (
              <ReportPie
                categories={categories}
                top={categories.slice(0, 6)}
                totalCents={expenseCents}
              />
            )}
            <div className="reports-total">
              <span>支出合计</span>
              <strong className="num">{formatCentsDisplay(expenseCents)}</strong>
            </div>
          </section>

          {categories.length > 0 && (
            <section className="reports-card reports-rankings" aria-label="分类排行">
              {categories.map((row, index) => (
                <button
                  className="reports-rank"
                  key={row.categoryId}
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => onCategorySelect(row)}
                >
                  <span
                    className={`reports-rank__swatch reports-rank__swatch--${sliceShade(index)}`}
                    aria-hidden="true"
                  />
                  <span className="reports-rank__name">{row.name || '未命名分类'}</span>
                  <span className="reports-rank__amount num">
                    {formatCentsDisplay(row.cents)}
                  </span>
                  <span className="reports-rank__percent num">{row.percent}%</span>
                  <span className="reports-rank__arrow" aria-hidden="true" />
                </button>
              ))}
            </section>
          )}

          {!isMonth && (
            <section className="reports-card" aria-label="按月的支出">
              <h2 className="reports-card__title">按月的支出</h2>
              <MonthlyBars points={series} highlightMonth={currentMonthKey} />
            </section>
          )}

          {isMonth ? (
            <section className="reports-card" aria-label="预算对实际">
              <h2 className="reports-card__title">预算对实际</h2>
              {budgets.length > 0 && (
                <ul className="reports-budgets">
                  {budgets.map(budget => (
                    <li className="reports-budget" key={budget.accountId}>
                      <div className="reports-budget__head">
                        <span className="reports-budget__name">{budget.name}</span>
                        <span className="reports-budget__value num">
                          {`${formatCentsDisplay(budget.spentCents)} / ${formatCentsDisplay(
                            budget.budgetCents
                          )}`}
                        </span>
                      </div>
                      <div
                        className="reports-budget__track"
                        role="img"
                        aria-label={`${budget.name} 该月已用 ${formatCentsDisplay(
                          budget.spentCents
                        )} / 额度 ${formatCentsDisplay(budget.budgetCents)}`}
                      >
                        <div
                          className={
                            budget.over
                              ? 'reports-budget__fill reports-budget__fill--over'
                              : 'reports-budget__fill'
                          }
                          style={{
                            width: `${budgetFillPercent(
                              budget.spentCents,
                              budget.budgetCents
                            )}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {hasUnrecordedBudgets ? (
                <p className="reports-note">该月有账户的历史额度未记录。</p>
              ) : budgets.length === 0 && (
                <p className="reports-note">该月未设置账户额度。</p>
              )}
            </section>
          ) : (
            busiest !== null &&
            quietest !== null && (
              <section className="reports-card" aria-label="两头">
                <h2 className="reports-card__title">两头</h2>
                <ul className="reports-extremes">
                  <li className="reports-extreme">
                    <span className="reports-extreme__main">
                      <span className="reports-extreme__title">最贵的一个月</span>
                      <span className="reports-extreme__meta">
                        {`${monthNumberOf(busiest.month)} 月`}
                      </span>
                    </span>
                    <span className="reports-extreme__value num">
                      {formatCentsDisplay(busiest.cents)}
                    </span>
                  </li>
                  <li className="reports-extreme">
                    <span className="reports-extreme__main">
                      <span className="reports-extreme__title">最省的一个月</span>
                      <span className="reports-extreme__meta">
                        {`${monthNumberOf(quietest.month)} 月`}
                      </span>
                    </span>
                    <span className="reports-extreme__value num">
                      {formatCentsDisplay(quietest.cents)}
                    </span>
                  </li>
                </ul>
              </section>
            )
          )}

          <button
            type="button"
            className="reports-export"
            onClick={onExport}
            disabled={onExport === undefined || exporting || sharing}
          >
            {exporting
              ? '正在导出…'
              : isMonth
                ? '导出这个月为表格（.xlsx）'
                : '导出全年为表格（.xlsx）'}
          </button>
        </>
      )}
      {exportResult !== null && (
        <ExportResultPanel
          result={exportResult}
          cachedFiles={cachedFiles}
          onViewCached={onViewCached}
          busy={exporting || sharing}
        />
      )}
      {feedback !== null && (
        <p
          className={feedback.kind === 'error' ? 'reports-note reports-note--error' : 'reports-note'}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
      {cacheReadFailed && <p className="reports-note" role="status">暂时无法读取缓存报表。</p>}
      {onShareCached && (
        <CachedFileList
          files={cachedFiles}
          now={new Date()}
          busy={exporting || sharing}
          onShare={onShareCached}
          focusRequest={cacheFocusRequest}
          title="应用缓存中的报表"
        >
          <p className="backup-cache__note">
            系统可能清理这些文件。点「另存」打开系统分享，在目标应用确认保存。
          </p>
        </CachedFileList>
      )}
    </div>
  );
}

function shareFeedback(name: string, outcome: ShareOutcome): ExportFeedback {
  return {
    kind: 'notice',
    text: outcome === 'canceled'
      ? `已取消分享「${name}」。文件若仍在应用缓存，可在下方另存。`
      : `「${name}」已交给系统分享，请在目标应用确认是否保存。`,
  };
}

export default function ReportsScreen() {
  const currentMonthKey = monthKeyOf(todayLocalISO());
  const currentYear = Number(currentMonthKey.slice(0, 4));
  const [mode, setMode] = useState<ReportMode>('month');
  const [monthKey, setMonthKey] = useState(currentMonthKey);
  const [year, setYear] = useState(currentYear);
  const [categoryDetail, setCategoryDetail] = useState<{ category: ReportCategory; period: string | number } | null>(null);
  const [operation, setOperation] = useState<'export' | 'share' | null>(null);
  const operating = useRef(false);
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null);
  const [exportResult, setExportResult] = useState<ExportFileNotice | null>(null);
  const [cachedFiles, setCachedFiles] = useState<CachedFile[]>([]);
  const [cacheReadFailed, setCacheReadFailed] = useState(false);
  const [cacheRevision, setCacheRevision] = useState(0);
  const { db } = useDb();
  const cacheFocus = useCachedFileFocus(cachedReports.list, setCachedFiles);

  useEffect(() => {
    let current = true;
    cachedReports.list().then(
      files => {
        if (!current) return;
        setCachedFiles(files);
        setCacheReadFailed(false);
      },
      () => {
        if (!current) return;
        setCachedFiles([]);
        setCacheReadFailed(true);
      }
    );
    return () => { current = false; };
  }, [cacheRevision]);

  const query = useQuery<ReportsData>(
    database => loadReportsData(database, mode, monthKey, year),
    [mode, monthKey, year]
  );

  // A snapshot belonging to the other mode (or the other month) is as absent as
  // no snapshot at all: the heading must never sit above the wrong numbers.
  const key = mode === 'month' ? monthKey : String(year);
  const data =
    query.data !== null && query.data.kind === mode && query.data.key === key
      ? query.data
      : null;

  function handleModeChange(nextMode: ReportMode) {
    if (mode === 'month' && nextMode === 'year') {
      setYear(Number(monthKey.slice(0, 4)));
    }
    setMode(nextMode);
  }

  async function perform(kind: 'export' | 'share', action: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true;
    setOperation(kind);
    setFeedback(null);
    if (kind === 'export') {
      setExportResult(null);
      cacheFocus.clear();
    }
    try {
      await action();
    } catch (reason) {
      setFeedback({
        kind: 'error',
        text: `${kind === 'export' ? '导出失败' : '另存失败'}：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      operating.current = false;
      setOperation(null);
      setCacheRevision(revision => revision + 1);
    }
  }

  function handleExport() {
    if (db === null) return;
    const database = db;
    void perform('export', async () => {
      const result = mode === 'month'
        ? await exportMonthWorkbook(database, deviceBinaryFileWriter, monthKey)
        : await exportYearWorkbook(database, deviceBinaryFileWriter, year);
      if (result.kind === 'folder' || result.kind === 'download') {
        setExportResult({ ...result, text: exportToast(result) });
      } else {
        setExportResult({
          kind: 'cache',
          fileName: result.fileName,
          text: shareFeedback(result.fileName, result.kind === 'canceled' ? 'canceled' : 'shared').text,
        });
      }
    });
  }

  function handleShareCached(file: CachedFile) {
    void perform('share', async () => {
      setFeedback(shareFeedback(file.name, await cachedReports.share(file.name)));
    });
  }

  return (
    <>
      <ReportsView
        mode={mode}
        monthKey={monthKey}
        year={year}
        currentMonthKey={currentMonthKey}
        currentYear={currentYear}
        data={data}
        error={query.error}
        onExport={db === null ? undefined : handleExport}
        exporting={operation === 'export'}
        sharing={operation === 'share'}
        feedback={feedback}
        exportResult={exportResult}
        onViewCached={cacheFocus.locate}
        cacheFocusRequest={cacheFocus.focusRequest}
        cachedFiles={cachedFiles}
        cacheReadFailed={cacheReadFailed}
        onShareCached={handleShareCached}
        onModeChange={handleModeChange}
        onMonthChange={setMonthKey}
        onYearChange={setYear}
        onCategorySelect={category => setCategoryDetail({ category, period: mode === 'month' ? monthKey : year })}
      />
      {categoryDetail && <ReportCategoryDetails {...categoryDetail} onClose={() => setCategoryDetail(null)} />}
    </>
  );
}
