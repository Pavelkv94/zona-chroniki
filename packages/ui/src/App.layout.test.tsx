// @vitest-environment jsdom
/**
 * jsdom-тест МАКЕТА каркаса (задача 4.0, DoD): App рисует ЧЕТЫРЕ области GDD §11 —
 * КАРТА | РАДИОЭФИР | ЛЕТОПИСЬ/ИНСПЕКТОР | ТАЙМ-БАР — и держит их плейсхолдеры (панели
 * наполнят 4.2–4.7). Дополняет App.test.tsx (значения из стора): тут — присутствие
 * структуры и заглушек на ФИКСИРОВАННОМ виде, без живого воркера/таймеров.
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
  return {
    day: 2,
    tick: 2880 as Tick,
    weather: 0,
    entities: [mk(1, 'human'), mk(2, 'animal')],
    population: { humans: 1, animals: 1, corpses: 0 },
  };
}

describe('App — четыре области макета и плейсхолдеры (DoD 4.0)', () => {
  beforeEach(() => {
    useUiStore.setState({
      view: fixedView(),
      log: [],
      detail: null,
      selectedEid: null,
      speed: 60,
      paused: false,
      stats: { tick: 2880 as Tick, entityCount: 2, tickMs: 0.3 },
      lastSnapshot: null,
      connected: true,
    });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ view: null, log: [], stats: null, connected: false });
  });

  it('присутствуют заголовки всех четырёх областей', () => {
    render(<App />);
    // Карта, Радиоэфир, Летопись/Инспектор — заголовки панелей.
    expect(screen.getByText(/Карта/)).toBeTruthy();
    expect(screen.getByText(/Радиоэфир/)).toBeTruthy();
    expect(screen.getByText(/Летопись \/ Инспектор/)).toBeTruthy();
  });

  it('панели-заглушки несут TODO будущих задач (4.4/4.5–4.6); карта — уже холст (4.2)', () => {
    render(<App />);
    // Карта реализована (задача 4.2): вместо TODO — Canvas-компонент.
    expect(screen.getByTestId('map-canvas')).toBeTruthy();
    expect(screen.queryByText(/TODO 4.2/)).toBeNull();
    expect(screen.getByText(/TODO 4.4/)).toBeTruthy();
    expect(screen.getByText(/TODO 4.5–4.6/)).toBeTruthy();
  });

  it('тайм-бар: активный темп (не пауза) и присутствие моста', () => {
    render(<App />);
    // speed=60, не на паузе → «▶ ×60»; мост активен.
    expect(screen.getByText(/▶ ×60/)).toBeTruthy();
    expect(screen.getByText(/мост: активен/)).toBeTruthy();
    // Телеметрия мс/кадр из stats присутствует.
    expect(screen.getByText(/0\.3 мс\/кадр/)).toBeTruthy();
  });

  it('мост не подключён → тайм-бар это показывает', () => {
    useUiStore.setState({ connected: false });
    render(<App />);
    expect(screen.getByText(/мост: не подключён/)).toBeTruthy();
  });
});
