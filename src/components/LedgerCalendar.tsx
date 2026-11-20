import { useState } from 'react';
import { formatMonthLabel, monthRange, weekdayIndex } from '../domain/date';
import { Sheet } from './Sheet';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export function LedgerCalendar({ monthKey, today, selectedDay, onClose, onMonth, onDay }: {
  monthKey: string;
  today: string;
  selectedDay: string | null;
  onClose: () => void;
  onMonth: (key: string) => void;
  onDay: (date: string) => void;
}) {
  const [year, setYear] = useState(monthKey.slice(0, 4));
  const [month, setMonth] = useState(Number(monthKey.slice(5, 7)));
  const [todayYear, todayMonth] = today.split('-');
  const yearProblem = !/^\d{4}$/.test(year) ? '请输入四位年份。'
    : year > todayYear ? '请选择本年或更早的年份。' : null;
  const lastMonth = year === todayYear ? Number(todayMonth) : 12;
  const visibleMonth = Math.min(month, lastMonth);
  const visibleKey = yearProblem === null ? `${year}-${String(visibleMonth).padStart(2, '0')}` : null;
  const monthLabel = visibleKey === null ? '' : formatMonthLabel(visibleKey);
  const range = visibleKey === null ? null : monthRange(visibleKey);
  const startColumn = range === null ? 0 : (weekdayIndex(range.start) + 6) % 7;
  const dayCount = range === null ? 0 : Number(range.end.slice(-2));

  return (
    <Sheet titleId="ledger-calendar-title" title="选择日期" className="ledger-calendar"
      panelClassName="ledger-calendar__panel" initialFocus="panel" onClose={onClose}>
      <form onSubmit={event => {
        event.preventDefault();
        if (visibleKey !== null) onMonth(visibleKey);
      }}>
        <div className="ledger-calendar__fields">
          <div className="ledger-calendar__field">
            <label htmlFor="ledger-calendar-year">年份</label>
            <input id="ledger-calendar-year" type="text" inputMode="numeric" maxLength={4} autoComplete="off" value={year}
              aria-invalid={yearProblem !== null || undefined}
              aria-describedby={yearProblem === null ? undefined : 'ledger-calendar-error'}
              onChange={event => setYear(event.target.value)} />
          </div>
          <div className="ledger-calendar__field">
            <label htmlFor="ledger-calendar-month">月份</label>
            <select id="ledger-calendar-month" value={visibleMonth} disabled={visibleKey === null}
              onChange={event => setMonth(Number(event.target.value))}>
              {Array.from({ length: lastMonth }, (_, index) => (
                <option key={index + 1} value={index + 1}>{index + 1}月</option>
              ))}
            </select>
          </div>
        </div>

        {yearProblem !== null && <p className="ledger-calendar__error" id="ledger-calendar-error" role="status">{yearProblem}</p>}
        {visibleKey !== null && (
          <div className="ledger-calendar__grid" role="group" aria-label={`${monthLabel}日历`}>
            {WEEK_LABELS.map(label => <span key={label} aria-hidden="true">{label}</span>)}
            {Array.from({ length: startColumn }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
            {Array.from({ length: dayCount }, (_, index) => {
              const day = index + 1;
              const date = `${visibleKey}-${String(day).padStart(2, '0')}`;
              return (
                <button key={date} type="button" aria-label={`${monthLabel}${day}日`}
                  aria-current={date === today ? 'date' : undefined} data-selected={date === selectedDay || undefined}
                  disabled={date > today} onClick={() => onDay(date)}>
                  {day}
                </button>
              );
            })}
          </div>
        )}

        <div className="ledger-calendar__actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" disabled={visibleKey === null}>查看整月</button>
        </div>
      </form>
    </Sheet>
  );
}
