// @vitest-environment jsdom
/**
 * jsdom-smoke НАРРАТИВНОГО СЛОЯ карты (задача 4.7): MapCanvas рендерится и рисует оверлеи
 * на фиксированном WorldView + окне лога со СМЕРТЯМИ/БОЯМИ/РАДИО — без падения. Canvas 2D
 * замокан (jsdom его не даёт). Проверяем: динамический кадр рисует череп (fillText) и кольцо
 * вспышки (stroke); кнопка «следить» тумблерит презентационный `following` в сторе (закон №8:
 * команда воркеру НЕ шлётся). НЕ поднимает живой Worker — состояние стора выставляется прямо.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type {
  EntityId,
  EntityKind,
  EventId,
  FactionId,
  LocationId,
  SimEvent,
  Tick,
  WorldView,
} from '@zona/shared';
import MapCanvas from './MapCanvas';
import { useUiStore } from '../store/store';

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
    translate: bump('translate'),
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

const BASE_STATE = {
  detail: null,
  selectedEid: null,
  following: false,
  names: {},
  speed: 0,
  paused: true,
  stats: null,
  lastSnapshot: null,
  connected: false,
} as const;

/** Живой человек в узле 5 + труп в узле 3 (место недавней смерти). */
function viewWithCorpse(tick: number): WorldView {
  const mk = (
    eid: number,
    kind: EntityKind,
    loc: number,
    over: Partial<WorldView['entities'][number]> = {},
  ): WorldView['entities'][number] => ({
    eid: eid as EntityId,
    kind,
    faction: kind === 'human' ? ('loners' as FactionId) : null,
    loc: loc as LocationId,
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
    day: Math.floor(tick / 1440),
    tick: tick as Tick,
    weather: 0,
    entities: [mk(1, 'human', 5), mk(2, 'corpse', 3)],
    population: { humans: 1, animals: 0, corpses: 1 },
  };
}

/** Лог со смертью (узел 3) и завязкой боя (узел 5), обе свежие относительно tick. */
function narrativeLog(tick: number): SimEvent[] {
  return [
    {
      id: 1 as EventId,
      tick: tick as Tick,
      type: 'entity/died',
      causedBy: null,
      payload: { eid: 2 as EntityId, cause: 'combat' },
    },
    {
      id: 2 as EventId,
      tick: tick as Tick,
      type: 'corpse/created',
      causedBy: null,
      payload: { eid: 2 as EntityId, loc: 3 as LocationId, items: [] },
    },
    {
      id: 3 as EventId,
      tick: tick as Tick,
      type: 'encounter/started',
      causedBy: null,
      payload: { sides: [[1 as EntityId], [2 as EntityId]], loc: 5 as LocationId },
    },
  ];
}

describe('MapCanvas — нарративные оверлеи (jsdom smoke)', () => {
  const W = 800;
  const H = 600;
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
    useUiStore.setState({ ...BASE_STATE, view: viewWithCorpse(5000), log: narrativeLog(5000) });
  });

  afterEach(() => {
    cleanup();
    getContextSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Прокрутить ПОСЛЕДНИЙ поставленный rAF-кадр (динамический слой или тик тостов). */
  function driveAllFrames(): void {
    const cbs = [...rafCbs];
    act(() => {
      for (const cb of cbs) cb(16);
    });
  }

  it('рендерит без падения и рисует череп (fillText) + кольцо вспышки (stroke)', () => {
    render(<MapCanvas />);
    // Изолируем ДИНАМИЧЕСКИЙ кадр: обнуляем счётчики после статичной отрисовки графа.
    for (const k of Object.keys(calls)) delete calls[k];
    driveAllFrames();
    // Череп места смерти рисуется текстом-глифом.
    expect(calls.fillText ?? 0).toBeGreaterThan(0);
    // Кольцо вспышки боя (и обводки) — через stroke.
    expect(calls.stroke ?? 0).toBeGreaterThan(0);
    // Кадр не упал: холст очищен, что-то залито (глифы).
    expect(calls.clearRect ?? 0).toBeGreaterThan(0);
  });

  it('ПУСТОЙ лог → карта без оверлеев (динамический слой: ни черепа-текста, ни кольца вспышки)', () => {
    // Живой человек + труп, но лог пуст → нет entity/died и encounter/started для оверлеев.
    useUiStore.setState({ view: viewWithCorpse(5000), log: [] });
    render(<MapCanvas />);
    for (const k of Object.keys(calls)) delete calls[k];
    driveAllFrames();
    // Глифы кружков рисуются (arc+fill), но НИКАКОГО текста-черепа и НИКАКОГО кольца-вспышки.
    expect(calls.fill ?? 0).toBeGreaterThan(0); // граф/сущности живы
    expect(calls.fillText ?? 0).toBe(0); // черепа нет (нет смертей в окне)
    expect(calls.stroke ?? 0).toBe(0); // вспышки боя нет (нет encounter в окне)
  });

  it('стопка смертей на одном узле → рисуется счётчик «×N» (fillText: череп + счётчик)', () => {
    // Две свежие смерти в узле 3 → маркер count=2 → drawDeathMarker рисует глиф-череп И «×2».
    const stacked: SimEvent[] = [
      { id: 1 as EventId, tick: 5000 as Tick, type: 'entity/died', causedBy: null, payload: { eid: 2 as EntityId, cause: 'combat' } },
      { id: 2 as EventId, tick: 5000 as Tick, type: 'corpse/created', causedBy: null, payload: { eid: 2 as EntityId, loc: 3 as LocationId, items: [] } },
      { id: 3 as EventId, tick: 5000 as Tick, type: 'entity/died', causedBy: null, payload: { eid: 8 as EntityId, cause: 'combat' } },
      { id: 4 as EventId, tick: 5000 as Tick, type: 'corpse/created', causedBy: null, payload: { eid: 8 as EntityId, loc: 3 as LocationId, items: [] } },
    ];
    useUiStore.setState({ view: viewWithCorpse(5000), log: stacked });
    render(<MapCanvas />);
    for (const k of Object.keys(calls)) delete calls[k];
    driveAllFrames();
    // Один узел смерти, но ДВА fillText: символ черепа + строка «×2».
    expect(calls.fillText ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('старая смерть/бой (за окном затухания) → оверлеи ПОГАСЛИ (0 skull-fillText / 0 flash-stroke)', () => {
    // Тот же лог с tick 5000, но мир далеко в будущем (3 суток спустя) — окна затухания
    // черепа/вспышки пусты. Труп-глиф рисуется fill'ом (без fillText/stroke), поэтому
    // счётчики скула (fillText) и вспышки боя (stroke) на динамичном слое ОБЯЗАНЫ быть 0 —
    // как в кейсе «нет смертей» (стр. 180-181). Доказывает погасание, а не только «не упало».
    useUiStore.setState({ view: viewWithCorpse(5000 + 1440 * 3), log: narrativeLog(5000) });
    render(<MapCanvas />);
    for (const k of Object.keys(calls)) delete calls[k];
    driveAllFrames();
    expect(calls.fillText ?? 0).toBe(0); // черепа нет — смерть за пределами суток
    expect(calls.stroke ?? 0).toBe(0); // вспышки нет — бой за пределами flashTicks
  });

  it('кнопка «следить»: disabled без выбора; тумблерит following при выбранной сущности', () => {
    const { getByTestId } = render(<MapCanvas />);
    const btn = getByTestId('map-follow') as HTMLButtonElement;
    // Нет выбора → кнопка неактивна, клик ничего не меняет.
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(useUiStore.getState().following).toBe(false);

    // Выбираем сущность → кнопка активна, клик включает слежение (презентация, закон №8).
    act(() => useUiStore.setState({ selectedEid: 1 as EntityId }));
    expect((getByTestId('map-follow') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByTestId('map-follow'));
    expect(useUiStore.getState().following).toBe(true);
    // Повторный клик — выключает.
    fireEvent.click(getByTestId('map-follow'));
    expect(useUiStore.getState().following).toBe(false);
  });

  it('слежение включено → статичный граф панорамируется (CSS-transform ≠ пусто)', () => {
    useUiStore.setState({ selectedEid: 1 as EntityId, following: true });
    const { getByTestId } = render(<MapCanvas />);
    driveAllFrames();
    driveAllFrames(); // пара кадров — камера отошла от нуля (rAF-догон)
    const staticCanvas = getByTestId('map-canvas').querySelectorAll('canvas')[0] as HTMLCanvasElement;
    // Центрирование выбранной сдвинуло камеру → статичный слой получил ненулевой translate.
    expect(staticCanvas.style.transform).toContain('translate');
  });
});
