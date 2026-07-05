// @vitest-environment jsdom
/**
 * jsdom-тест МАКЕТА каркаса (задача 4.0, DoD): App рисует ЧЕТЫРЕ области GDD §11 —
 * КАРТА | РАДИОЭФИР | ЛЕТОПИСЬ/ИНСПЕКТОР | ТАЙМ-БАР — и держит их плейсхолдеры (панели
 * наполнят 4.2–4.7). Дополняет App.test.tsx (значения из стора): тут — присутствие
 * структуры и заглушек на ФИКСИРОВАННОМ виде, без живого воркера/таймеров.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { EntityDetail, EntityId, EntityKind, FactionId, LocationId, Tick, WorldView } from '@zona/shared';
import App from './App';
import { useUiStore } from './store/store';

/** Минимальная валидная деталь выбранной сущности (для авто-перехода на инспектор). */
function selectedDetail(eid: number): EntityDetail {
  return {
    eid: eid as EntityId,
    kind: 'human',
    faction: 'loners' as FactionId,
    name: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
    loc: 1 as LocationId,
    needs: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 },
    hp: 100,
    inventory: [],
    money: 0,
    memory: [],
    relations: [],
    fame: 0,
    recentEvents: [],
  };
}

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
    // Карта, Радиоэфир — заголовки панелей; область летописи/инспектора теперь вкладки.
    expect(screen.getByText(/Карта/)).toBeTruthy();
    expect(screen.getByText(/Радиоэфир/)).toBeTruthy();
    expect(screen.getByTestId('tab-chronicle')).toBeTruthy();
    expect(screen.getByTestId('tab-inspector')).toBeTruthy();
  });

  it('карта (4.2)/радиоэфир (4.3)/летопись (4.4)/инспектор (4.5) реализованы (не заглушки)', () => {
    render(<App />);
    // Карта реализована (задача 4.2): вместо TODO — Canvas-компонент.
    expect(screen.getByTestId('map-canvas')).toBeTruthy();
    expect(screen.queryByText(/TODO 4.2/)).toBeNull();
    // Радиоэфир реализован (задача 4.3): вместо TODO — панель RadioLog.
    expect(screen.getByTestId('radio-log')).toBeTruthy();
    // Инспектор (4.5) присутствует как вкладка; по умолчанию активна летопись (4.4, ChronicleLog).
    expect(screen.getByTestId('tab-inspector')).toBeTruthy();
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();
    // Летопись — уже НЕ заглушка (задача 4.4): TODO-подписи 4.4 не осталось.
    expect(screen.queryByText(/TODO 4.4/)).toBeNull();
  });

  it('вкладки: по умолчанию летопись; выбор сущности авто-переключает на инспектор; клик возвращает', () => {
    render(<App />);
    // Старт — вкладка летописи (заглушка 4.4), инспектора не видно.
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();
    expect(screen.queryByTestId('inspector')).toBeNull();

    // Выбор сущности (клик на карте/в эфире → detail+selectedEid) авто-переводит на инспектор.
    act(() => {
      useUiStore.setState({
        selectedEid: 1 as EntityId,
        detail: {
          eid: 1 as EntityId,
          kind: 'human',
          faction: 'loners' as FactionId,
          name: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
          loc: 1 as LocationId,
          needs: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 },
          hp: 100,
          inventory: [],
          money: 0,
          memory: [],
          relations: [],
          fame: 0,
          recentEvents: [],
        },
      });
    });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    expect(screen.queryByTestId('chronicle-log')).toBeNull();

    // Ручной клик по вкладке «Летопись» возвращает заглушку (выбор не блокирует навигацию).
    fireEvent.click(screen.getByTestId('tab-chronicle'));
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();
  });

  it('вкладки: выбор ДРУГОЙ сущности с летописи снова форсит инспектор (авто-переход на ФРОНТ выбора)', () => {
    render(<App />);

    // Выбрали сущность 1 → авто-инспектор; наблюдатель вручную ушёл на летопись.
    act(() => {
      useUiStore.setState({ selectedEid: 1 as EntityId, detail: selectedDetail(1) });
    });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-chronicle'));
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();

    // Клик по НОВОЙ сущности (eid 1 → 2) — новый фронт выбора: инспектор всплывает сам.
    act(() => {
      useUiStore.setState({ selectedEid: 2 as EntityId, detail: selectedDetail(2) });
    });
    expect(screen.getByTestId('inspector')).toBeTruthy();
    expect(screen.queryByTestId('chronicle-log')).toBeNull();
  });

  it('вкладки: повторный клик по УЖЕ выбранной сущности не выдёргивает с летописи', () => {
    render(<App />);

    // Выбор 1 → инспектор; уходим на летопись.
    act(() => {
      useUiStore.setState({ selectedEid: 1 as EntityId, detail: selectedDetail(1) });
    });
    fireEvent.click(screen.getByTestId('tab-chronicle'));
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();

    // Тот же eid прилетел снова (обновилась деталь, выбор НЕ сменился) — фронта нет,
    // наблюдатель остаётся на летописи (иначе он не смог бы её читать при живом выборе).
    act(() => {
      useUiStore.setState({ detail: { ...selectedDetail(1), hp: 50 } });
    });
    expect(screen.getByTestId('chronicle-log')).toBeTruthy();
    expect(screen.queryByTestId('inspector')).toBeNull();
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
