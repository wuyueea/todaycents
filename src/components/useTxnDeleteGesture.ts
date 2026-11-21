import { useRef, useState } from 'react';
import { useLongPressDrag } from './useLongPressDrag';
import type { DragPoint } from './useLongPressDrag';

interface Drag {
  description: string;
  transfer: boolean;
  point: DragPoint;
  over: boolean;
}

function rowAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest('[data-txn-delete-action]')) return null;
  return target.closest<HTMLElement>('[data-txn-delete-row]');
}

export function useTxnDeleteGesture(
  active: boolean,
  page: string,
  onDrop: (row: HTMLElement) => void
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  const over = (point: DragPoint) => {
    const box = zoneRef.current?.getBoundingClientRect();
    return box !== undefined &&
      point.x >= box.left && point.x <= box.right &&
      point.y >= box.top && point.y <= box.bottom;
  };

  useLongPressDrag(active, page, {
    findSource: rowAt,
    onLift(row, point) {
      row.setAttribute('data-delete-dragging', '');
      setDrag({
        description: row.dataset.txnDeleteRow ?? '',
        transfer: row.hasAttribute('data-transfer-group'),
        point,
        over: false,
      });
    },
    onMove(point) {
      const inside = over(point);
      setDrag(current => current && { ...current, point, over: inside });
    },
    onDrop(row, point) {
      if (over(point)) onDrop(row);
    },
    onEnd(row) {
      row.removeAttribute('data-delete-dragging');
      setDrag(null);
    },
  });

  return { drag, zoneRef };
}
