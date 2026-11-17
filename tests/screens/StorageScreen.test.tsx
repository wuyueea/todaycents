import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { StorageView } from '../../src/screens/StorageScreen';
import type { FolderStatus } from '../../src/storage/folder';

function render(status: FolderStatus | null, available = true) {
  return renderToString(<MemoryRouter>
    <StorageView status={status} available={available} busy={false} notice={null} error={null}
      onChoose={() => {}} onOpen={() => {}} onClear={() => {}} />
  </MemoryRouter>);
}

describe('StorageView', () => {
  it('shows no actions while checking the directory', () => {
    const html = render(null);
    expect(html).toContain('正在读取备份目录');
    expect(html).not.toContain('<button');
  });

  it('offers one local directory picker and explains the cache fallback', () => {
    const html = render({ folder: null, needsReselection: false });
    expect(html).toContain('选择文件夹');
    expect(html).toContain('自动副本只写入缓存');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('asks an upgraded or revoked installation to select again', () => {
    const html = render({ folder: null, needsReselection: true });
    expect(html).toContain('请重新选择');
    expect(html).toContain('已有备份留在原处');
    expect(html).not.toContain('打开文件夹');
  });

  it('offers replace, open and revoke for a selected folder', () => {
    const html = render({ folder: { name: '合成目录' }, needsReselection: false });
    for (const word of ['合成目录', '更换文件夹', '打开文件夹', '取消目录授权']) expect(html).toContain(word);
  });

  it('offers no fake folder control when the native plugin is missing', () => {
    const html = render({ folder: null, needsReselection: false }, false);
    expect(html).toContain('无法选择本机备份目录');
    expect(html).not.toContain('<button');
  });
});
