import { useRef, useState } from 'react';
import { useLongPressDrag } from './useLongPressDrag';
import type { DragPoint } from './useLongPressDrag';

export interface ReorderInsertion {
  id: string;
  edge: 'before' | 'after';
}

interface DropPosition extends ReorderInsertion {
  markerId: string;
}

interface DragPreview {
  sourceId: string;
  name: string;
  point: DragPoint;
  insertion: DropPosition | null;
}

interface DragSession extends Omit<DragPreview, 'insertion'> {
  list: HTMLElement;
  group: string | undefined;
  frame: number | null;
}

const SCROLL_EDGE_PX = 72;
const MAX_SCROLL_STEP_PX = 16;

export function reorderedIds(
  previous: readonly string[],
  sourceId: string,
  insertion: ReorderInsertion
): string[] | null {
  const from = previous.indexOf(sourceId);
  const ids = previous.filter(id => id !== sourceId);
  const anchor = ids.indexOf(insertion.id);
  if (from < 0 || anchor < 0) return null;
  const to = anchor + (insertion.edge === 'after' ? 1 : 0);
  if (from === to) return null;
  ids.splice(to, 0, sourceId);
  return ids;
}

function dropPosition({ list, group, sourceId }: DragSession, point: DragPoint): DropPosition | null {
  const listBounds = list.getBoundingClientRect();
  if (point.x < listBounds.left || point.x > listBounds.right) return null;

  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-reorder-item]'));
  const tails = new Map(rows.map(row => [row.dataset.reorderTailFor, row]));
  const siblings = rows.filter(row => row.dataset.reorderGroup === group);
  if (siblings.length < 2) return null;
  const endOf = (row: HTMLElement) => tails.get(row.dataset.reorderItem) ?? row;
  const top = group === undefined ? listBounds.top : siblings[0].getBoundingClientRect().top;
  const bottom = group === undefined ? listBounds.bottom : endOf(siblings.at(-1)!).getBoundingClientRect().bottom;
  if (point.y < top || point.y > bottom) return null;

  let last: HTMLElement | undefined;
  for (const row of siblings) {
    const id = row.dataset.reorderItem!;
    if (id === sourceId) continue;
    const rowTop = row.getBoundingClientRect().top;
    const rowBottom = endOf(row).getBoundingClientRect().bottom;
    if (point.y < (rowTop + rowBottom) / 2) return { id, markerId: id, edge: 'before' };
    last = row;
  }
  return last === undefined ? null : {
    id: last.dataset.reorderItem!,
    markerId: endOf(last).dataset.reorderItem!,
    edge: 'after',
  };
}

function autoScrollStep(list: HTMLElement, point: DragPoint): number {
  const box = list.getBoundingClientRect();
  if (point.x < box.left || point.x > box.right || point.y < 0 || point.y > window.innerHeight) return 0;
  if (point.y < SCROLL_EDGE_PX && box.top < 0) {
    return -Math.ceil((1 - point.y / SCROLL_EDGE_PX) * MAX_SCROLL_STEP_PX);
  }
  const distanceBottom = window.innerHeight - point.y;
  if (distanceBottom < SCROLL_EDGE_PX && box.bottom > window.innerHeight) {
    return Math.ceil((1 - distanceBottom / SCROLL_EDGE_PX) * MAX_SCROLL_STEP_PX);
  }
  return 0;
}

export function useReorderGesture(
  active: boolean,
  page: string,
  onInsert: (sourceId: string, insertion: ReorderInsertion) => void
) {
  const session = useRef<DragSession | null>(null);
  const [drag, setDrag] = useState<DragPreview | null>(null);

  function updatePreview(current: DragSession) {
    const { sourceId, name, point } = current;
    const insertion = dropPosition(current, point);
    setDrag(previous =>
      previous?.point === point &&
      previous.insertion?.markerId === insertion?.markerId &&
      previous.insertion?.edge === insertion?.edge
        ? previous
        : { sourceId, name, point, insertion }
    );
  }

  function scrollFrame() {
    const current = session.current;
    if (current === null) return;
    current.frame = null;
    const step = autoScrollStep(current.list, current.point);
    if (step === 0) return;
    const previousY = window.scrollY;
    window.scrollBy({ top: step, behavior: 'instant' });
    if (window.scrollY === previousY) return;
    updatePreview(current);
    current.frame = window.requestAnimationFrame(scrollFrame);
  }

  useLongPressDrag(active, page, {
    allowScrollWhileDragging: true,
    findSource(target) {
      if (!(target instanceof Element) || target.closest('[data-reorder-ignore]')) return null;
      return target.closest<HTMLElement>('[data-reorder-handle]');
    },
    onLift(handle, point) {
      const item = handle.closest<HTMLElement>('[data-reorder-item]');
      const list = handle.closest<HTMLElement>('[data-reorder-list]');
      if (item?.dataset.reorderItem === undefined || list === null) return;
      const current = {
        list,
        group: item.dataset.reorderGroup,
        sourceId: item.dataset.reorderItem,
        name: handle.dataset.reorderHandle ?? '',
        point,
        frame: null,
      };
      session.current = current;
      updatePreview(current);
    },
    onMove(point) {
      const current = session.current;
      if (current === null) return;
      current.point = point;
      updatePreview(current);
      if (current.frame === null && autoScrollStep(current.list, point) !== 0) {
        current.frame = window.requestAnimationFrame(scrollFrame);
      }
    },
    onDrop(_handle, point) {
      const current = session.current;
      if (current === null) return;
      const insertion = dropPosition(current, point);
      if (insertion !== null) onInsert(current.sourceId, insertion);
    },
    onEnd() {
      const frame = session.current?.frame;
      if (frame != null) window.cancelAnimationFrame(frame);
      session.current = null;
      setDrag(null);
    },
  });

  return drag;
}
