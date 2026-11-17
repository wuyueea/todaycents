import { useEffect, useRef, useState } from 'react';
import { registerBackHandler } from './backButton';

type Point = { x: number; y: number };
type Source = { id: number; kind: 'touch' | 'pointer' };

interface Press {
  source: Source;
  element: HTMLElement;
  origin: Point;
  timer: number;
  armed: boolean;
}

interface Drag {
  description: string;
  transfer: boolean;
  point: Point;
  over: boolean;
}

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const rowSelector = '[data-txn-delete-row]';

function rowAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest('[data-txn-delete-action]')) return null;
  return target.closest<HTMLElement>(rowSelector);
}

function pointAt(event: Pick<MouseEvent, 'clientX' | 'clientY'>): Point {
  return { x: event.clientX, y: event.clientY };
}

function touchById(touches: TouchList, id: number): Touch | undefined {
  return Array.from(touches).find(touch => touch.identifier === id);
}

export function useTxnDeleteGesture(
  active: boolean,
  page: string,
  onDrop: (row: HTMLElement) => void
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDrag(null);
    if (!active) return;
    let press: Press | null = null;
    let suppressClick = false;

    function over(point: Point) {
      const box = zoneRef.current?.getBoundingClientRect();
      return box !== undefined &&
        point.x >= box.left && point.x <= box.right &&
        point.y >= box.top && point.y <= box.bottom;
    }

    function cancel() {
      if (press === null) return false;
      window.clearTimeout(press.timer);
      if (press.armed) {
        suppressClick = true;
        press.element.removeAttribute('data-delete-dragging');
        setDrag(null);
      }
      press = null;
      return true;
    }

    function start(event: Event, source: Source, origin: Point) {
      if (press !== null) return;
      suppressClick = false;
      const element = rowAt(event.target);
      if (element === null || document.visibilityState !== 'visible') return;
      const timer = window.setTimeout(() => {
        if (press?.element !== element || !element.isConnected) {
          cancel();
          return;
        }
        press.armed = true;
        element.setAttribute('data-delete-dragging', '');
        setDrag({
          description: element.dataset.txnDeleteRow ?? '',
          transfer: element.hasAttribute('data-transfer-group'),
          point: origin,
          over: false,
        });
      }, HOLD_MS);
      press = { source, element, origin, timer, armed: false };
    }

    function move(event: Event, point: Point) {
      if (press === null) return;
      if (!press.element.isConnected) {
        cancel();
        return;
      }
      if (!press.armed) {
        if (Math.hypot(point.x - press.origin.x, point.y - press.origin.y) > MOVE_TOLERANCE) cancel();
        return;
      }
      if (event.cancelable) event.preventDefault();
      setDrag(current => current && { ...current, point, over: over(point) });
    }

    function finish(event: Event, point: Point) {
      if (press === null) return;
      const { armed, element, origin } = press;
      const moved = Math.hypot(point.x - origin.x, point.y - origin.y) > MOVE_TOLERANCE;
      const dropped = armed && moved && element.isConnected && over(point);
      if (armed && event.cancelable) event.preventDefault();
      cancel();
      if (dropped) onDrop(element);
    }

    function touchStart(event: TouchEvent) {
      if (event.touches.length !== 1) {
        cancel();
        return;
      }
      const touch = event.changedTouches[0];
      if (touch) start(event, { kind: 'touch', id: touch.identifier }, pointAt(touch));
    }
    function touchMove(event: TouchEvent) {
      if (press?.source.kind !== 'touch') return;
      const touch = touchById(event.changedTouches, press.source.id);
      if (touch) move(event, pointAt(touch));
    }
    function touchEnd(event: TouchEvent) {
      if (press?.source.kind !== 'touch') return;
      const touch = touchById(event.changedTouches, press.source.id);
      if (touch) finish(event, pointAt(touch));
    }
    function pointerDown(event: PointerEvent) {
      if (event.pointerType !== 'touch' && event.isPrimary && event.button === 0) {
        start(event, { kind: 'pointer', id: event.pointerId }, pointAt(event));
      }
    }
    function trackedPointer(event: PointerEvent) {
      return press?.source.kind === 'pointer' && event.pointerId === press.source.id;
    }
    function pointerMove(event: PointerEvent) {
      if (!trackedPointer(event)) return;
      if (event.buttons === 0) cancel();
      else move(event, pointAt(event));
    }
    function pointerUp(event: PointerEvent) {
      if (trackedPointer(event)) finish(event, pointAt(event));
    }
    function pointerCancel(event: PointerEvent) {
      if (trackedPointer(event)) cancel();
    }
    function click(event: MouseEvent) {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
    function contextMenu(event: Event) {
      if (press !== null || rowAt(event.target) !== null) event.preventDefault();
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape' && cancel()) event.preventDefault();
    }

    const unsubscribeBack = registerBackHandler(cancel);
    const listeners = new AbortController();
    const capture = { capture: true, signal: listeners.signal };
    document.addEventListener('touchstart', touchStart, capture);
    // Leave native scrolling alone until the hold wins. A passive React
    // touchmove cannot stop scrolling once the user actually starts dragging.
    document.addEventListener('touchmove', touchMove, { ...capture, passive: false });
    document.addEventListener('touchend', touchEnd, { ...capture, passive: false });
    document.addEventListener('touchcancel', cancel, capture);
    document.addEventListener('pointerdown', pointerDown, capture);
    document.addEventListener('pointermove', pointerMove, capture);
    document.addEventListener('pointerup', pointerUp, capture);
    document.addEventListener('pointercancel', pointerCancel, capture);
    document.addEventListener('click', click, capture);
    document.addEventListener('contextmenu', contextMenu, capture);
    document.addEventListener('dragstart', contextMenu, capture);
    document.addEventListener('scroll', cancel, capture);
    document.addEventListener('visibilitychange', cancel, capture);
    document.addEventListener('keydown', keyboard, capture);
    // Cancel when the window loses focus. Android may blur the row itself
    // while producing contextmenu for the same long press.
    window.addEventListener('blur', cancel, { signal: listeners.signal });
    return () => {
      listeners.abort();
      unsubscribeBack();
      cancel();
    };
  }, [active, page, onDrop]);

  return { drag, zoneRef };
}
