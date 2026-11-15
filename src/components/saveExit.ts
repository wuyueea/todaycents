/**
 * Coordinates "leave this form" with an in-flight save.
 *
 * While saving, the form must stay mounted until the write settles: closing it
 * early would hide a commit that still lands, and a retry could then write the
 * same entry twice. Every exit path (scrim, close button, back/Escape, route
 * link) goes through this guard; once the save settles the guard is recreated
 * with saving=false and leaving works normally.
 */
export interface SaveExit {
  readonly canLeave: boolean;
  requestLeave(): void;
}

export function createSaveExit(saving: boolean, leave: () => void): SaveExit {
  return {
    canLeave: !saving,
    requestLeave: () => {
      if (saving) return;
      leave();
    },
  };
}
