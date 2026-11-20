import { useState } from 'react';
import type { FormEvent } from 'react';
import { AmountKeypadField } from '../components/AmountKeypadField';
import { formatCentsDisplay } from '../components/AmountText';
import type { Db } from '../db/driver';
import {
  transferAccountOptions, transferBalanceChanges, updateTransfer,
} from '../db/repos/transfers';
import type { TransferEditData } from '../db/repos/transfers';
import { formatCents, parseAmountToCents } from '../domain/money';
import type { Account } from '../domain/types';

function TransferAccountField({ side, accounts, value, busy, invalid, onChange }: {
  side: 'from' | 'to';
  accounts: readonly Account[];
  value: string;
  busy: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const id = `transfer-edit-${side}`;
  const unavailable = !accounts.some(account => account.id === value);
  return (
    <div className="add-field">
      <label htmlFor={id} className="add-label">{side === 'from' ? '转出账户' : '转入账户'}</label>
      <select
        id={id}
        className="add-account"
        value={value}
        disabled={busy}
        aria-invalid={invalid || undefined}
        onChange={event => onChange(event.target.value)}
      >
        {unavailable && <option value={value} disabled>账户不可用</option>}
        {accounts.map(account => (
          <option key={account.id} value={account.id}>
            {account.name}{account.archivedAt !== null ? '（已归档）' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TransferEditForm({ data, db, busy, setBusy, onSaved }: {
  data: TransferEditData;
  db: Db | null;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onSaved: () => void;
}) {
  // Retain what the user originally opened if a later revision refreshes balances.
  const [original] = useState(data.pair);
  const [amount, setAmount] = useState(() => formatCents(original.amountCents));
  const [fromAccountId, setFromAccountId] = useState(original.fromAccountId);
  const [toAccountId, setToAccountId] = useState(original.toAccountId);
  const [note, setNote] = useState(original.note);
  const [showProblems, setShowProblems] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fromOptions = transferAccountOptions(data.accounts, original.fromAccountId);
  const toOptions = transferAccountOptions(data.accounts, original.toAccountId);
  const sameAccount = fromAccountId === toAccountId;
  const fromUnavailable = !fromOptions.some(account => account.id === fromAccountId);
  const toUnavailable = !toOptions.some(account => account.id === toAccountId);
  const amountCents = parseAmountToCents(amount);
  const draft = amountCents === null || sameAccount || fromUnavailable || toUnavailable
    ? null : { amountCents, fromAccountId, toAccountId, note };
  const changes = draft === null ? [] : transferBalanceChanges(original, draft, data.balances);
  const problem = sameAccount ? '转出和转入必须使用不同账户。'
    : fromUnavailable || toUnavailable ? '请选择可用的账户。'
    : amountCents === null && showProblems ? '请输入大于零、最多两位小数的金额。'
    : changes === null ? '无法精确计算余额变化，请检查转账金额。' : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || busy) return;
    setShowProblems(true);
    if (draft === null || changes === null) return;

    setBusy(true);
    setSaveError(null);
    try {
      await updateTransfer(db, original, draft, data.balances);
    } catch (error) {
      setSaveError(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      setBusy(false);
      return;
    }
    onSaved();
  };

  return (
    <form className="add-form transfer-edit" onSubmit={handleSubmit}>
      <div className="add-field add-field--amount">
        <label className="add-label" htmlFor="transfer-edit-amount">金额</label>
        <AmountKeypadField id="transfer-edit-amount" value={amount} disabled={busy}
          invalid={showProblems && amountCents === null}
          onChange={value => { setAmount(value); setSaveError(null); }} />
      </div>
      <p className="txn-edit-date">
        日期：<time dateTime={original.date}>{original.date}</time>（不可修改）
      </p>
      <TransferAccountField side="from" accounts={fromOptions} value={fromAccountId} busy={busy}
        invalid={sameAccount || fromUnavailable}
        onChange={value => { setFromAccountId(value); setSaveError(null); }} />
      <TransferAccountField side="to" accounts={toOptions} value={toAccountId} busy={busy}
        invalid={sameAccount || toUnavailable}
        onChange={value => { setToAccountId(value); setSaveError(null); }} />
      <div className="txn-edit-note">
        <label className="add-label" htmlFor="transfer-edit-note">备注</label>
        <input id="transfer-edit-note" className="txn-edit-note__input" type="text"
          autoComplete="off" placeholder="备注（可不填）" value={note} disabled={busy}
          onChange={event => { setNote(event.target.value); setSaveError(null); }} />
      </div>
      {changes !== null && changes.length > 0 && (
        <section className="transfer-edit-preview" aria-labelledby="transfer-edit-preview-title">
          <h2 id="transfer-edit-preview-title">账户余额变化</h2>
          <dl>
            {changes.map(change => (
              <div key={change.accountId}>
                <dt>{data.accounts.find(account => account.id === change.accountId)?.name}</dt>
                <dd>
                  <span>当前 {formatCentsDisplay(change.beforeCents)}</span>
                  <span>保存后 {formatCentsDisplay(change.afterCents)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {(problem ?? saveError) !== null && (
        <p className="add-note add-note--error" role="alert">{problem ?? saveError}</p>
      )}
      <button className="add-submit" type="submit" disabled={busy || db === null}>
        {busy ? '正在保存…' : '保存修改'}
      </button>
    </form>
  );
}
