import { formatCentsDisplay } from './AmountText';
import { Sheet } from './Sheet';

export function UnusedRecordDeleteSheet({
  kind,
  name,
  balanceCents,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  kind: '项目' | '账户';
  name: string;
  balanceCents?: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      titleId="unused-record-delete-title"
      title={`删除${kind}`}
      initialFocus="last"
      canClose={() => !busy}
      onClose={onCancel}
    >
      <p className="sheet__text">彻底删除「{name}」？此操作无法撤销。</p>
      {balanceCents !== undefined && (
        <p className="sheet__note">
          此账户的余额记录 {formatCentsDisplay(balanceCents)} 元也会移除。
        </p>
      )}
      {error !== null && <p className="sheet__note" role="alert">{error}</p>}
      <button type="button" className="sheet__danger" disabled={busy} onClick={onConfirm}>
        确认删除
      </button>
      <button type="button" className="sheet__secondary" disabled={busy} onClick={onCancel}>
        取消
      </button>
    </Sheet>
  );
}
