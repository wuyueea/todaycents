import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  PROJECT_PICKER_FOOTNOTE,
  ProjectPicker,
  ProjectSheet,
  projectSelectionLabel,
} from '../../src/components/ProjectPicker';
import type { Project } from '../../src/db/repos/projects';

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    status: 'active',
    budgetCents: null,
    startedDate: null,
    archivedDate: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const TRIP = project({ id: 'p-trip', name: '国庆去成都', budgetCents: 200000 });
const MOVE = project({ id: 'p-move', name: '搬家' });
const OLD = project({
  id: 'p-old',
  name: '换手机',
  status: 'archived',
  archivedDate: '2026-08-31T00:00:00.000Z',
});

function renderPicker(
  projects: readonly Project[],
  value: string | null,
  valueLabel?: string
): string {
  return renderToString(
    <ProjectPicker
      projects={projects}
      value={value}
      valueLabel={valueLabel}
      onChange={() => {}}
    />
  ).replace(/<!-- -->/g, '');
}

function renderSheet(
  projects: readonly Project[],
  value: string | null,
  valueLabel?: string
): string {
  return renderToString(
    <ProjectSheet
      projects={projects}
      value={value}
      valueLabel={valueLabel}
      onSelect={() => {}}
      onClose={() => {}}
    />
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

describe('projectSelectionLabel', () => {
  it('names the chosen live project, and says 不归项目 when nothing is chosen', () => {
    expect(projectSelectionLabel([TRIP, MOVE], null)).toBe('不归项目');
    expect(projectSelectionLabel([TRIP, MOVE], TRIP.id)).toBe('国庆去成都');
  });

  it('keeps naming a project that is no longer selectable', () => {
    expect(projectSelectionLabel([TRIP], OLD.id, OLD.name)).toBe('换手机');
    // Without the caller's label there is nothing truthful to print.
    expect(projectSelectionLabel([TRIP], OLD.id)).toBe('不归项目');
  });
});

describe('ProjectPicker', () => {
  it('is one optional value row: 不归项目 until something is chosen', () => {
    const html = renderPicker([TRIP, MOVE], null);

    const trigger = openingTag(html, 'data-project-trigger');
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(html).toContain('>不归项目</button>');
    // The sheet is not rendered until the row is tapped.
    expect(html).not.toContain('role="dialog"');
  });

  it('names the chosen project on the row', () => {
    const html = renderPicker([TRIP, MOVE], TRIP.id);

    expect(openingTag(html, 'data-project-trigger')).toContain('aria-label="项目：国庆去成都"');
    expect(html).toContain('>国庆去成都</button>');
  });

  it('offers only live projects, plus one way back to 不归项目', () => {
    const html = renderSheet([TRIP, MOVE, OLD], MOVE.id);

    expect(html).toContain('现在：搬家');
    expect(html).toContain('data-project-id="p-trip"');
    expect(html).toContain('data-project-id="p-move"');
    // An archived project is not a choice any more.
    expect(html).not.toContain('data-project-id="p-old"');
    expect(openingTag(html, 'data-project-clear')).toContain('aria-pressed="false"');
    expect(html).toContain('>不归项目</button>');
    // The sheet no longer explains the data model.
    expect(PROJECT_PICKER_FOOTNOTE).toBe('');
  });

  it('marks the current project and lets 不归项目 be the current answer', () => {
    const chosen = renderSheet([TRIP, MOVE], TRIP.id);
    expect(openingTag(chosen, 'data-project-id="p-trip"')).toContain('aria-pressed="true"');
    expect(openingTag(chosen, 'data-project-id="p-move"')).toContain('aria-pressed="false"');

    const none = renderSheet([TRIP, MOVE], null);
    expect(openingTag(none, 'data-project-clear')).toContain('aria-pressed="true"');
    expect(none).toContain('现在：不归项目');
  });

  it('still offers 不归项目 when no project exists yet', () => {
    const html = renderSheet([], null);

    expect(html).toContain('还没有项目');
    expect(html).toContain('data-project-clear');
    expect(html).not.toContain('NaN');
  });

  it('names an archived current project in the sheet head without offering it', () => {
    const html = renderSheet([TRIP], OLD.id, OLD.name);

    expect(html).toContain('现在：换手机');
    expect(html).not.toContain('data-project-id="p-old"');
  });
});
