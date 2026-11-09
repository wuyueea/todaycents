import type { Db } from '../db/driver';
import { createTag, listTags } from '../db/repos/tags';
import type { Tag } from '../db/repos/tags';

/** The outcome of an inline create: a selectable live tag, or a sentence. */
export interface PickedTagCreate {
  tag: Tag | null;
  error: string | null;
}

/**
 * The entry sheet's create step, separated from the input so it can be tested
 * without a browser.
 *
 * createTag owns trim, length and duplicate handling. The only decision added
 * here is visibility: an archived duplicate comes back as an error rather than
 * being attached silently, because the sheet cannot show an archived chip and
 * setTxnTags refuses to add one to a row that did not carry it.
 */
export async function createTagForPicker(
  db: Db,
  rawName: string
): Promise<PickedTagCreate> {
  try {
    const id = await createTag(db, rawName);
    const fresh = await listTags(db, { includeArchived: true });
    const tag = fresh.find(candidate => candidate.id === id);
    if (tag === undefined) return { tag: null, error: '新建失败：找不到刚建的标签' };
    if (tag.archivedAt !== null) {
      return {
        tag: null,
        error: `「${tag.name}」在已归档里，恢复后才能再选。`,
      };
    }
    return { tag, error: null };
  } catch (reason) {
    return {
      tag: null,
      error: `新建失败：${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}
