// @vitest-environment jsdom
/**
 * jsdom smoke-тест каркаса (задача 4.0, DoD). App — ЧИСТЫЙ читатель стора: на
 * ФИКСИРОВАННОМ `WorldView` (без живого воркера/таймеров) он рендерит живые day/tick/
 * entityCount из стора без падения. Доказывает половину сквозного моста «view → render»
 * (вторую половину — «init → view» — обеспечивает воркер, интеграция вне unit-теста).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { EntityId, EntityKind, FactionId, LocationId, Tick, WorldView } from '@zona/shared';
import App from './App';
import { useUiStore } from './store/store';

function fixedView(): WorldView {
  const mk = (eid: number, kind: EntityKind): WorldView['entities'][number] => ({
    eid: eid as EntityId,
    kind,
    faction: kind === 'human' ? ('loners' as FactionId) : null,
    loc: 1 as LocationId,
    dest: null,
    etaTicks: 0,
    hpFrac: 1,
    task: null,
    inCombat: false,
    carrying: false,
    alive: kind !== 'corpse',
  });
  const entities = [mk(1, 'human'), mk(2, 'human'), mk(3, 'animal'), mk(4, 'animal'), mk(5, 'corpse')];
  return {
    day: 3,
    tick: 4325 as Tick, // день 3 (3*1440=4320) + 5 минут → 00:05
    weather: 2, // «дождь»
    entities,
    population: { humans: 2, animals: 2, corpses: 1 },
  };
}

describe('App — jsdom smoke (фиксированный WorldView)', () => {
  beforeEach(() => {
    // Выставляем состояние НАПРЯМУЮ — без живого воркера (детерминированный вход).
    useUiStore.setState({
      view: fixedView(),
      log: [],
      detail: null,
      selectedEid: null,
      speed: 0,
      paused: true,
      stats: { tick: 4325 as Tick, entityCount: 5, tickMs: 0.5 },
      lastSnapshot: null,
      connected: true,
    });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ view: null, log: [], stats: null, connected: false });
  });

  it('рендерит день/время/погоду из стора', () => {
    render(<App />);
    // День 3, 00:05, дождь — встречается на карте и на тайм-баре.
    expect(screen.getAllByText(/День 3 · 00:05 · дождь/).length).toBeGreaterThan(0);
  });

  it('рендерит число сущностей и сводку населения', () => {
    render(<App />);
    // HUD карты (4.2): «население 5 (люди 2 · звери 2 · трупы 1)».
    expect(screen.getByText(/люди 2 · звери 2 · трупы 1/)).toBeTruthy();
    expect(screen.getByText(/население 5/)).toBeTruthy();
    // Тайм-бар дублирует счётчик сущностей.
    expect(screen.getByText(/сущностей 5/)).toBeTruthy();
  });

  it('тайм-бар показывает паузу и активный мост', () => {
    render(<App />);
    expect(screen.getByText(/⏸ пауза/)).toBeTruthy();
    expect(screen.getByText(/мост: активен/)).toBeTruthy();
  });

  it('не падает при пустом виде (view === null)', () => {
    useUiStore.setState({ view: null });
    render(<App />);
    // Дефолты: День 0, сущностей 0.
    expect(screen.getAllByText(/День 0 · 00:00/).length).toBeGreaterThan(0);
  });
});
