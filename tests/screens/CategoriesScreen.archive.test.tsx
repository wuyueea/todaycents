// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  inspect: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
}));

vi.mock('../../src/db/repos/categories', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/repos/categories')>(
    '../../src/db/repos/categories'
  );
  return {
    ...actual,
    inspectCategoryPurge: repo.inspect,
    archiveCategory: repo.archive,
    unarchiveCategory: repo.unarchive,
  };
});

const store = vi.hoisted(() => ({
  db: { fake: true } as const,
  data: {
    categories: [
      {
        id: 'c-sport',
        name: '运动',
        parentId: null,
        kind: 'expense' as const,
        sort: 1,
        archivedAt: null,
      },
      {
        id: 'c-badminton',
        name: '羽毛球',
        parentId: 'c-sport',
        kind: 'expense' as const,
        sort: 2,
        archivedAt: null,
      },
      {
        id: 'uncategorized',
        name: '未分类',
        parentId: null,
        kind: 'expense' as const,
        sort: 9999,
        archivedAt: null,
      },
    ] as Array<{
      id: string;
      name: string;
      parentId: string | null;
      kind: 'expense' | 'income';
      sort: number;
      archivedAt: string | null;
    }>,
    undo: null,
  },
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: store.db, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: false, error: null }),
}));

import CategoriesScreen from '../../src/screens/CategoriesScreen';

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function renderScreen(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/settings/categories']}>
        <CategoriesScreen />
      </MemoryRouter>
    );
  });
  await flush();
}

async function waitFor<T extends Element>(find: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = find();
    if (found !== null) return found;
    await flush();
  }
  throw new Error('没有等到目标元素');
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll('button')].find(button =>
      (button.textContent ?? '').includes(text)
    ) ?? null
  );
}

async function openArchiveConfirmation(): Promise<void> {
  await renderScreen();
  const menu = await waitFor(() => document.querySelector<HTMLButtonElement>('[aria-label="运动的菜单"]'));
  await click(menu);
  const archive = await waitFor(() => {
    const button = buttonWithText('连同 1 个二级分类一起收起');
    return button !== null && !button.disabled ? button : null;
  });
  await click(archive);
  await waitFor(() => document.querySelector('[role="dialog"]'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  repo.inspect.mockResolvedValue({
    purgeable: false,
    archived: false,
    liveTxnCount: 0,
    txnCount: 0,
    deletedTxnCount: 0,
    templateCount: 0,
    liveChildCount: 1,
    childCount: 1,
    hintCount: 0,
  });
  repo.archive.mockReset();
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('CategoriesScreen archive confirmation', () => {
  it('asks before archiving a root with live children, then reports the child count', async () => {
    repo.archive.mockResolvedValue({ archivedChildCount: 1 });
    await openArchiveConfirmation();

    expect(document.body.textContent).toContain('「运动」下还有 1 个未归档的二级分类');
    expect(document.body.textContent).toContain('恢复一级分类时，这些二级分类不会自动回来');

    const confirm = await waitFor(() => document.querySelector<HTMLButtonElement>('.sheet__primary'));
    await click(confirm);

    await waitFor(() => document.querySelector('[role="dialog"]') === null ? document.body : null);
    expect(repo.archive).toHaveBeenCalledWith({ fake: true }, 'c-sport');
    expect(document.querySelector('.toast')?.textContent).toContain('已归档「运动」及 1 个二级分类');
  });

  it('closes the confirmation on failure so the error toast is visible', async () => {
    repo.archive.mockRejectedValue(new Error('磁盘已满'));
    await openArchiveConfirmation();

    const confirm = await waitFor(() => document.querySelector<HTMLButtonElement>('.sheet__primary'));
    await click(confirm);

    await waitFor(() => document.querySelector('[role="dialog"]') === null ? document.body : null);
    expect(document.body.textContent).toContain('归档失败：磁盘已满');
  });

  it('does not promise visibility when restoring a child under an archived parent', async () => {
    store.data.categories = [
      {
        id: 'c-sport',
        name: '运动',
        parentId: null,
        kind: 'expense' as const,
        sort: 1,
        archivedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        id: 'c-badminton',
        name: '羽毛球',
        parentId: 'c-sport',
        kind: 'expense' as const,
        sort: 2,
        archivedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        id: 'uncategorized',
        name: '未分类',
        parentId: null,
        kind: 'expense' as const,
        sort: 9999,
        archivedAt: null,
      },
    ];
    repo.unarchive.mockResolvedValue(undefined);
    await renderScreen();

    const childRow = await waitFor(() =>
      document.querySelector<HTMLElement>('[data-category-id="c-badminton"]')
    );
    const restore = childRow.querySelector<HTMLButtonElement>('.category-row__restore');
    expect(restore).not.toBeNull();
    await click(restore!);

    await waitFor(() => (document.querySelector('.toast') === null ? null : document.body));
    const toast = document.querySelector('.toast')?.textContent ?? '';
    expect(repo.unarchive).toHaveBeenCalledWith({ fake: true }, 'c-badminton');
    expect(toast).toContain('已恢复「羽毛球」');
    expect(toast).toContain('一级分类「运动」还在已归档');
    expect(toast).toContain('恢复「运动」后它才会重新出现在记账选择里');
    expect(toast).not.toContain('它重新出现在记账选择里。');
  });
});
