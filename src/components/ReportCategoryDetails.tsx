import { formatCentsDisplay } from './AmountText';
import { Sheet } from './Sheet';
import { reportCategoryExpenses, type ReportCategory } from '../db/repos/reports';
import { formatMonthLabel } from '../domain/date';
import { useQuery } from '../store/useDb';

interface ReportCategoryDetailsProps {
  category: ReportCategory;
  period: string | number;
  onClose: () => void;
}

export function ReportCategoryDetails({ category, period, onClose }: ReportCategoryDetailsProps) {
  const { data: expenses, error } = useQuery(
    db => reportCategoryExpenses(db, period, category.categoryId),
    [period, category.categoryId]
  );
  const periodLabel = typeof period === 'string' ? formatMonthLabel(period) : `${period} 年`;
  const title = category.name || '未命名分类';

  return (
    <Sheet
      titleId="report-detail-title"
      title={`${title}支出明细`}
      className="reports-detail"
      panelClassName="reports-detail__panel"
      meta={<button className="reports-detail__close" type="button" onClick={onClose}>关闭</button>}
      onClose={onClose}
    >
      <p className="reports-detail__period">{periodLabel}</p>
      {expenses === null ? (
        error ? <p role="alert">支出明细暂时打不开</p> : <p role="status">正在读取支出明细…</p>
      ) : (
        <>
          <div className="reports-total reports-detail__total">
            <span>{expenses.length} 笔支出合计</span>
            <strong className="num">{formatCentsDisplay(expenses.reduce((sum, expense) => sum + expense.cents, 0))}</strong>
          </div>
          {expenses.length > 0 ? (
            <div className="reports-detail__body" role="region" aria-label="支出流水" tabIndex={0}>
              <ul className="reports-detail__list">
                {expenses.map(expense => (
                  <li className="reports-detail__row" key={expense.id}>
                    <div>
                      <time dateTime={expense.occurredDate}>{expense.occurredDate}</time>
                      <div>{expense.categoryName ?? title} · {expense.accountName}</div>
                      {expense.note && <div className="reports-detail__note">{expense.note}</div>}
                    </div>
                    <strong className="num">{formatCentsDisplay(expense.cents)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="reports-note">这个期间没有该分类的支出</p>
          )}
        </>
      )}
    </Sheet>
  );
}
