import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  OPEN_FOLDER_UNAVAILABLE,
  StorageView,
  openFolderNote,
} from '../../src/screens/StorageScreen';
import type { FolderListing, StoredFolder } from '../../src/storage/folder';

function render(node: React.ReactElement): string {
  return renderToString(<MemoryRouter>{node}</MemoryRouter>).replace(/<!-- -->/g, '');
}

const FOLDER: StoredFolder = {
  path: '/storage/emulated/0/Documents/账本备份',
  name: '账本备份',
};

const BROWSER: FolderListing = {
  path: '/storage/emulated/0/Documents',
  parent: '/storage/emulated/0',
  dirs: [
    { name: '账本备份', path: '/storage/emulated/0/Documents/账本备份' },
    { name: '收据', path: '/storage/emulated/0/Documents/收据' },
  ],
};

const actions = {
  onRequestAccess: () => {},
  onChange: () => {},
  onOpen: () => {},
  onUp: () => {},
  onEnter: () => {},
  onChoose: () => {},
  onCancelBrowse: () => {},
};

const base = {
  folder: null,
  browser: null,
  busy: false,
  note: null,
  error: null,
  ...actions,
};

describe('StorageView', () => {
  it('shows only a checking line before the bridge answers', () => {
    const html = render(<StorageView access="checking" {...base} />);

    expect(html).toContain('<h1>存储</h1>');
    expect(html).toContain('正在检查权限');
    expect(html.match(/<button/g)).toBeNull();
  });

  // The state the owner sees after a fresh install: one way forward, the
  // system page where 「所有文件访问」 is switched on.
  it('shows one access button while storage access is missing', () => {
    const html = render(<StorageView access="denied" {...base} />);

    expect(html).toContain('允许访问存储');
    expect(html).toContain('需要「所有文件访问」');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('更改位置');
    expect(html).not.toContain('打开文件夹');
  });

  it('shows the current location and both granted actions', () => {
    const html = render(<StorageView {...base} access="granted" folder={FOLDER} />);

    expect(html).toContain('当前位置');
    expect(html).toContain('账本备份');
    expect(html).toContain(FOLDER.path);
    expect(html).toContain('更改位置');
    expect(html).toContain('打开文件夹');
    expect(html.match(/<button[^>]*disabled/g)).toBeNull();
  });

  it('keeps the cache + share fallback when no folder can be used', () => {
    const html = render(<StorageView {...base} access="granted" folder={null} />);

    expect(html).toContain('当前位置');
    expect(html).toContain('未设置');
    expect(html).toContain('当前文件夹不可用，导出会放进应用缓存');
    // 打开文件夹 has nothing to open; 更改位置 still does.
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(1);
  });

  it('lists directories and the 上一级 + 选这个文件夹 pair', () => {
    const html = render(
      <StorageView {...base} access="granted" folder={FOLDER} browser={BROWSER} />
    );

    expect(html).toContain(BROWSER.path);
    expect(html).toContain('上一级');
    expect(html).toContain('选这个文件夹');
    expect(html).toContain('账本备份');
    expect(html).toContain('收据');
    // Directories are in the order the bridge returned them.
    expect(html.indexOf('账本备份')).toBeLessThan(html.indexOf('收据'));
    expect(html.match(/<button[^>]*disabled/g)).toBeNull();
  });

  it('disables 上一级 at the shared-storage root', () => {
    const html = render(
      <StorageView
        {...base}
        access="granted"
        folder={FOLDER}
        browser={{ ...BROWSER, path: '/storage/emulated/0', parent: null }}
      />
    );

    const up = html.match(/<button[^>]*>上一级<\/button>/)?.[0] ?? '';
    expect(up).toContain('disabled');
  });

  it('shows the missing-file-manager sentence instead of crashing', () => {
    const html = render(
      <StorageView
        {...base}
        access="granted"
        folder={FOLDER}
        note={OPEN_FOLDER_UNAVAILABLE}
      />
    );

    expect(html).toContain('这台设备没有能打开文件夹的应用。');
    expect(html).toMatch(/role="status"/);
  });

  it('shows a failed choice as an alert, not a toast', () => {
    const html = render(
      <StorageView
        {...base}
        access="granted"
        folder={FOLDER}
        error="选择失败：这个文件夹不能写，请换一个。"
      />
    );

    expect(html).toContain('选择失败：这个文件夹不能写，请换一个。');
    expect(html).toMatch(/role="alert"/);
  });
});

describe('openFolderNote', () => {
  it('is silent when the file manager opened and speaks up when none exists', () => {
    expect(openFolderNote(true)).toBeNull();
    expect(openFolderNote(false)).toBe(OPEN_FOLDER_UNAVAILABLE);
  });
});
