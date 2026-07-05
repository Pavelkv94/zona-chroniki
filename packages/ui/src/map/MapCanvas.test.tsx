// @vitest-environment jsdom
/**
 * jsdom smoke-тест карты (задача 4.2, DoD) + юниты чистого размещения глифов.
 * НЕ поднимает живой Worker: состояние стора выставляется напрямую (детерминированный
 * вход). Canvas 2D-контекст замокан (jsdom его не реализует) — проверяем, что рендер
 * ВЫЗЫВАЕТ рисующие методы контекста и не падает на фиксированном WorldView.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { EntityId, EntityKind, FactionId, LocationId, Tick, WorldView } from '@zona/shared';
import MapCanvas, { computePlacements } from './MapCanvas';
import { VISUAL_CONFIG, nodeLayout } from './visual-config';
import { layoutToPixels } from './geometry';
import { useUiStore } from '../store/store';

// ── Мок 2D-контекста: записывает вызовы, глотает присваивания стилей ──────────
function makeCtxMock(): { ctx: Record<string, unknown>; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const bump = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const ctx: Record<string, unknown> = {
    clearRect: bump('clearRect'),
    fillRect: bump('fillRect'),
    beginPath: bump('beginPath'),
    arc: bump('arc'),
    fill: bump('fill'),
    stroke: bump('stroke'),
    moveTo: bump('moveTo'),
    lineTo: bump('lineTo'),
    closePath: bump('closePath'),
    setTransform: bump('setTransform'),
    fillText: bump('fillText'),
    save: bump('save'),
    restore: bump('restore'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  return { ctx, calls };
}

function fixedView(): WorldView {
  const mk = (
    eid: number,
    kind: EntityKind,
    over: Partial<WorldView['entities'][number]> = {},
  ): WorldView['entities'][number] => ({
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
    ...over,
  });
  return {
    day: 3,
    tick: 4325 as Tick,
    weather: 2,
    entities: [
      mk(1, 'human'),
      mk(2, 'human', { hpFrac: 0.3 }), // ранен
      mk(3, 'animal', { loc: 2 as LocationId }),
      mk(4, 'human', { loc: 0 as LocationId, dest: 1 as LocationId, etaTicks: 20 }), // в пути
      mk(5, 'corpse'),
      mk(6, 'human', { task: 0, inCombat: true, carrying: true }), // спит+бой+груз (модификаторы)
    ],
    population: { humans: 4, animals: 1, corpses: 1 },
  };
}

describe('computePlacements — размещение/интерполяция/кластеризация', () => {
  it('интерполяция вдоль ребра loc→dest по etaTicks (t=0→loc, t=1→dest)', () => {
    const tracker = new Map<number, { dest: number; maxEta: number }>();
    const w = 800;
    const h = 600;
    const from = layoutToPixels(nodeLayout(VISUAL_CONFIG, 0)!, w, h, 40);
    const to = layoutToPixels(nodeLayout(VISUAL_CONFIG, 1)!, w, h, 40);

    const moving = (eta: number): WorldView =>
      ({
        day: 0,
        tick: 0 as Tick,
        weather: 0,
        entities: [
          {
            eid: 4 as EntityId,
            kind: 'human',
            faction: 'loners' as FactionId,
            loc: 0 as LocationId,
            dest: 1 as LocationId,
            etaTicks: eta,
            hpFrac: 1,
            task: null,
            inCombat: false,
            carrying: false,
            alive: true,
          },
        ],
        population: { humans: 1, animals: 0, corpses: 0 },
      }) as WorldView;

    // Первый снапшот задаёт полную длину перехода (maxEta=40) → t=0 → в loc.
    const p0 = computePlacements(moving(40), w, h, tracker);
    expect(p0[0]!.target.x).toBeCloseTo(from.x, 6);
    expect(p0[0]!.target.y).toBeCloseTo(from.y, 6);
    // Прибыл (eta=0) → t=1 → в dest.
    const p1 = computePlacements(moving(0), w, h, tracker);
    expect(p1[0]!.target.x).toBeCloseTo(to.x, 6);
    expect(p1[0]!.target.y).toBeCloseTo(to.y, 6);
    // Середина.
    const tracker2 = new Map<number, { dest: number; maxEta: number }>();
    computePlacements(moving(40), w, h, tracker2);
    const pm = computePlacements(moving(20), w, h, tracker2);
    expect(pm[0]!.target.x).toBeCloseTo((from.x + to.x) / 2, 6);
  });

  it('одиночка без цели стоит РОВНО в узле своей локации (без смещения кластера)', () => {
    const loc = 5;
    const view: WorldView = {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [
        {
          eid: 42 as EntityId,
          kind: 'human' as EntityKind,
          faction: 'loners' as FactionId,
          loc: loc as LocationId,
          dest: null,
          etaTicks: 0,
          hpFrac: 1,
          task: null,
          inCombat: false,
          carrying: false,
          alive: true,
        },
      ],
      population: { humans: 1, animals: 0, corpses: 0 },
    };
    const node = layoutToPixels(nodeLayout(VISUAL_CONFIG, loc)!, 800, 600, 40);
    const [p] = computePlacements(view, 800, 600, new Map());
    expect(p!.target.x).toBeCloseTo(node.x, 6);
    expect(p!.target.y).toBeCloseTo(node.y, 6);
  });

  it('кластеризация: несколько стационарных в одном узле раскиданы (не совпадают)', () => {
    const view: WorldView = {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [1, 2, 3].map((eid) => ({
        eid: eid as EntityId,
        kind: 'human' as EntityKind,
        faction: 'loners' as FactionId,
        loc: 5 as LocationId,
        dest: null,
        etaTicks: 0,
        hpFrac: 1,
        task: null,
        inCombat: false,
        carrying: false,
        alive: true,
      })),
      population: { humans: 3, animals: 0, corpses: 0 },
    };
    const placements = computePlacements(view, 800, 600, new Map());
    const pts = placements.map((p) => `${p.target.x.toFixed(3)},${p.target.y.toFixed(3)}`);
    expect(new Set(pts).size).toBe(3); // все три позиции различны
  });

  it('модификаторы прокидываются: ранен/спит/груз/бой/труп', () => {
    const placements = computePlacements(fixedView(), 800, 600, new Map());
    const byEid = new Map(placements.map((p) => [p.eid, p]));
    expect(byEid.get(2)!.wounded).toBe(true);
    expect(byEid.get(5)!.alive).toBe(false);
    expect(byEid.get(6)!.sleeping).toBe(true);
    expect(byEid.get(6)!.carrying).toBe(true);
    expect(byEid.get(6)!.inCombat).toBe(true);
  });
});

describe('MapCanvas — jsdom smoke (фиксированный WorldView)', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let calls: Record<string, number>;

  beforeEach(() => {
    const mock = makeCtxMock();
    calls = mock.calls;
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(mock.ctx as unknown as CanvasRenderingContext2D);
    useUiStore.setState({
      view: fixedView(),
      log: [],
      detail: null,
      selectedEid: null,
      speed: 0,
      paused: true,
      stats: null,
      lastSnapshot: null,
      connected: false,
    });
  });

  afterEach(() => {
    cleanup();
    getContextSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('рендерит без падения и вызывает рисующие методы контекста (статичный слой)', () => {
    render(<MapCanvas />);
    // Статичный слой (граф) рисуется синхронно в effect ресайза:
    expect(calls.fillRect ?? 0).toBeGreaterThan(0); // фон
    expect(calls.stroke ?? 0).toBeGreaterThan(0); // рёбра/узлы
    expect(calls.fillText ?? 0).toBeGreaterThan(0); // имена локаций
  });

  it('HUD показывает день/погоду/население из стора', () => {
    const { getByTestId } = render(<MapCanvas />);
    const text = getByTestId('map-canvas').textContent ?? '';
    expect(text).toContain('День 3');
    expect(text).toContain('дождь');
    expect(text).toContain('население 6');
  });
});

// ── Базовое состояние стора (детерминированный вход без живого воркера) ────────
const BASE_STATE = {
  log: [],
  detail: null,
  selectedEid: null,
  speed: 0,
  paused: true,
  stats: null,
  lastSnapshot: null,
  connected: false,
} as const;

/** Один стационарный человек в узле `loc` — предсказуемая экранная позиция глифа. */
function oneHumanAt(eid: number, loc: number): WorldView {
  return {
    day: 1,
    tick: 600 as Tick,
    weather: 0,
    entities: [
      {
        eid: eid as EntityId,
        kind: 'human',
        faction: 'loners' as FactionId,
        loc: loc as LocationId,
        dest: null,
        etaTicks: 0,
        hpFrac: 1,
        task: null,
        inCombat: false,
        carrying: false,
        alive: true,
      },
    ],
    population: { humans: 1, animals: 0, corpses: 0 },
  };
}

/**
 * Интерактив карты (DoD 4.2): клик по глифу → `store.inspect(eid)` с ПРАВИЛЬНЫМ eid,
 * наведение → тултип, уход курсора → тултип гаснет. Динамический слой рисуется в rAF,
 * который заполняет хит-кандидаты; в jsdom rAF нет — перехватываем колбэк и «крутим»
 * один кадр вручную, затем шлём DOM-события в точку глифа. Позиция детерминирована:
 * одиночка стоит РОВНО в узле локации (layoutToPixels), холст в jsdom — 800×600.
 */
describe('MapCanvas — интерактив: клик→inspect, наведение→тултип', () => {
  const W = 800;
  const H = 600;
  const PAD = 40;
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let rafCbs: FrameRequestCallback[];

  beforeEach(() => {
    const mock = makeCtxMock();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(mock.ctx as unknown as CanvasRenderingContext2D);
    rafCbs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafCbs.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    useUiStore.setState({ ...BASE_STATE, view: oneHumanAt(7, 5) });
  });

  afterEach(() => {
    cleanup();
    getContextSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Прокрутить один динамический кадр (заполняет хит-кандидаты позициями глифов). */
  function driveFrame(): void {
    const cb = rafCbs[rafCbs.length - 1];
    if (cb !== undefined) act(() => cb(16));
  }

  /** Экранная позиция узла локации (там же стоит одиночка). */
  function nodePx(loc: number) {
    return layoutToPixels(nodeLayout(VISUAL_CONFIG, loc)!, W, H, PAD);
  }

  it('клик по глифу → inspect(eid) с ПРАВИЛЬНЫМ eid; клик мимо → тишина', () => {
    const { getByTestId } = render(<MapCanvas />);
    driveFrame(); // заполнить хит-кандидаты позицией глифа

    const inspectSpy = vi.fn();
    useUiStore.setState({ inspect: inspectSpy });
    const container = getByTestId('map-canvas');
    const px = nodePx(5);

    fireEvent.click(container, { clientX: px.x, clientY: px.y });
    expect(inspectSpy).toHaveBeenCalledTimes(1);
    expect(inspectSpy).toHaveBeenCalledWith(7);

    // Клик в пустоту (далеко от единственного глифа) — inspect НЕ дёргается снова.
    fireEvent.click(container, { clientX: px.x + 300, clientY: px.y + 200 });
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('наведение на глиф → тултип с видом; уход курсора → тултип исчезает', () => {
    const { getByTestId } = render(<MapCanvas />);
    driveFrame();
    const container = getByTestId('map-canvas');
    const px = nodePx(5);

    fireEvent.mouseMove(container, { clientX: px.x, clientY: px.y });
    // Тултип показывает ВИД сущности (человек) — HUD слово 'человек' не содержит.
    expect(container.textContent ?? '').toContain('человек');

    fireEvent.mouseMove(container, { clientX: px.x + 300, clientY: px.y + 200 });
    expect(container.textContent ?? '').not.toContain('человек');

    fireEvent.mouseLeave(container);
    expect(container.textContent ?? '').not.toContain('человек');
  });
});

/**
 * Робастность подачи (DoD 4.2): пустой и отсутствующий `WorldView` не роняют карту.
 * Пустой мир рисует ТОЛЬКО статичный слой (узлы+рёбра+имена); динамический кадр не
 * добавляет ни одного глифа. `view === null` (до init) — тоже без падения.
 */
describe('MapCanvas — пустой/нулевой мир', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let calls: Record<string, number>;
  let rafCbs: FrameRequestCallback[];

  beforeEach(() => {
    const mock = makeCtxMock();
    calls = mock.calls;
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(mock.ctx as unknown as CanvasRenderingContext2D);
    rafCbs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafCbs.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    getContextSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function driveFrame(): void {
    const cb = rafCbs[rafCbs.length - 1];
    if (cb !== undefined) act(() => cb(16));
  }

  function emptyView(): WorldView {
    return {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [],
      population: { humans: 0, animals: 0, corpses: 0 },
    };
  }

  it('пустой WorldView → статичный граф нарисован, без падения', () => {
    useUiStore.setState({ ...BASE_STATE, view: emptyView() });
    render(<MapCanvas />);
    // Статичный слой: фон + узлы (обводка) + имена локаций.
    expect(calls.fillRect ?? 0).toBeGreaterThan(0);
    expect(calls.stroke ?? 0).toBeGreaterThan(0);
    expect(calls.fillText ?? 0).toBeGreaterThan(0);
  });

  it('пустой WorldView → динамический кадр не рисует ни одного глифа', () => {
    useUiStore.setState({ ...BASE_STATE, view: emptyView() });
    render(<MapCanvas />);
    // Изолируем ДИНАМИЧЕСКИЙ кадр: обнуляем счётчики после статичной отрисовки.
    for (const k of Object.keys(calls)) delete calls[k];
    driveFrame();
    // Кадр очистил холст, но глифов (кружков/заливок) нет — мир пуст.
    expect(calls.clearRect ?? 0).toBeGreaterThan(0);
    expect(calls.arc ?? 0).toBe(0);
    expect(calls.fill ?? 0).toBe(0);
  });

  it('число глифовых заливок динамического кадра растёт с числом сущностей', () => {
    // 1 человек.
    useUiStore.setState({ ...BASE_STATE, view: oneHumanAt(1, 5) });
    render(<MapCanvas />);
    for (const k of Object.keys(calls)) delete calls[k];
    driveFrame();
    const oneFills = calls.fill ?? 0;
    expect(oneFills).toBeGreaterThan(0); // хотя бы один круг-глиф

    // Много людей в разных узлах.
    const many: WorldView = {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [1, 2, 3, 4, 5].map((eid) => ({
        eid: eid as EntityId,
        kind: 'human' as EntityKind,
        faction: 'loners' as FactionId,
        loc: eid as LocationId,
        dest: null,
        etaTicks: 0,
        hpFrac: 1,
        task: null,
        inCombat: false,
        carrying: false,
        alive: true,
      })),
      population: { humans: 5, animals: 0, corpses: 0 },
    };
    useUiStore.setState({ view: many });
    for (const k of Object.keys(calls)) delete calls[k];
    driveFrame();
    expect(calls.fill ?? 0).toBeGreaterThan(oneFills); // больше сущностей → больше заливок
  });

  it('view === null (до init) → карта рендерится без падения (только статичный слой)', () => {
    useUiStore.setState({ ...BASE_STATE, view: null });
    const { getByTestId } = render(<MapCanvas />);
    driveFrame(); // кадр с v===null просто пропускается, без throw
    expect(calls.fillRect ?? 0).toBeGreaterThan(0); // фон статичного слоя есть
    expect((getByTestId('map-canvas').textContent ?? '')).toContain('население 0');
  });
});
