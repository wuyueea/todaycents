import { describe, expect, it, vi } from 'vitest';

import { createSaveExit } from '../../src/components/saveExit';

describe('createSaveExit', () => {
  it('allows leaving when nothing is in flight', () => {
    const leave = vi.fn();
    const exit = createSaveExit(false, leave);

    expect(exit.canLeave).toBe(true);
    exit.requestLeave();

    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('swallows the leave request while saving', () => {
    const leave = vi.fn();
    const exit = createSaveExit(true, leave);

    expect(exit.canLeave).toBe(false);
    exit.requestLeave();

    expect(leave).not.toHaveBeenCalled();
  });
});
