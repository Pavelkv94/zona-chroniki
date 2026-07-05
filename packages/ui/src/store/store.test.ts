/**
 * Тесты ZUSTAND-стора наблюдателя (задача 4.0, D-077/D-078). Читается как «пульт
 * наблюдателя»: входящие сообщения воркера реконструируют мир, команды наблюдателя
 * уходят в мост правильными посылками. Живой Worker НЕ поднимается — мост (`WorkerClient`)
 * замокан, проверяем ОТПРАВЛЕННЫЕ команды и применение `WorkerToUi` к состоянию.
 *
 * ── ГРАНИЦА (D-077) ─────────────────────────────────────────────────────────
 * `createWorkerClient` замокан: стор думает, что говорит с воркером, а мы ловим все
 * `post(UiToWorker)`. Так тестируем ЛОГИКУ стора (что за команда, с какими полями),
 * не касаясь транспорта/bitecs.
 *
 * ── ЗАКОН №8 ────────────────────────────────────────────────────────────────
 * Команды влияют лишь на темп/паузу/шаг/инспекцию — проверяем именно ЭТО (setSpeed=0
 * = пауза, step шлёт ровно N, inspect несёт eid), содержимое тиков стор не трогает.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  EntityId,
  EntityKind,
  EntityView,
  FactionId,
  LocationId,
  Seed,
  SimEvent,
  SnapshotJSON,
  Tick,
  UiToWorker,
  WorldView,
} from '@zona/shared';

// Мост замокан ДО импорта стора (vi.mock hoisted). Общий буфер отправленных команд —
// через vi.hoisted, чтобы фабрика мока видела его без TDZ-ловушек хойстинга.
const bridge = vi.hoisted(() => ({ posted: [] as UiToWorker[], terminated: 0 }));
vi.mock('../bridge/worker-client', () => ({
  createWorkerClient: (_onMessage: (msg: unknown) => void) => ({
    post: (msg: UiToWorker) => {
      bridge.posted.push(msg);
    },
    terminate: () => {
      bridge.terminated += 1;
    },
  }),
}));

import { useUiStore, __resetWorkerClientForTest } from './store';

/** Свежий вид мира с заданными сущностями. */
function view(tick: number, weather: number, entities: EntityView[]): WorldView {
  const sorted = [...entities].sort((a, b) => (a.eid as number) - (b.eid as number));
  let humans = 0;
  let animals = 0;
  let corpses = 0;
  for (const e of sorted) {
    if (e.kind === 'human') humans++;
    else if (e.kind === 'animal') animals++;
    else if (e.kind === 'corpse') corpses++;
  }
  return {
    day: Math.floor(tick / 1440),
    tick: tick as Tick,
    weather,
    entities: sorted,
    population: { humans, animals, corpses },
  };
}

function ev(eid: number, over: Partial<EntityView> = {}): EntityView {
  return {
    eid: eid as EntityId,
    kind: 'human' as EntityKind,
    faction: 'loners' as FactionId,
    loc: 1 as LocationId,
    dest: null,
    etaTicks: 0,
    hpFrac: 1,
    task: null,
    inCombat: false,
    carrying: false,
    alive: true,
    ...over,
  };
}

function simEvent(id: number, tick = 1): SimEvent {
  return {
    id: id as never,
    tick: tick as Tick,
    type: 'sim/tickStarted',
    causedBy: null,
    payload: { tick: tick as Tick },
  } as SimEvent;
}

const FRESH = {
  view: null,
  log: [],
  detail: null,
  selectedEid: null,
  speed: 0,
  paused: true,
  stats: null,
  lastSnapshot: null,
  connected: false,
} as const;

beforeEach(() => {
  __resetWorkerClientForTest();
  bridge.posted.length = 0;
  bridge.terminated = 0;
  useUiStore.setState({ ...FRESH });
});

describe('applyMessage: реконструкция вида (D-078)', () => {
  it('view кладёт полный WorldView как есть', () => {
    const v = view(10, 1, [ev(1), ev(2)]);
    useUiStore.getState().applyMessage({ type: 'view', view: v });
    expect(useUiStore.getState().view).toEqual(v);
  });

  it('viewDelta применяется поверх текущего вида (applyDelta) — сталкер прошёл ребро', () => {
    const first = view(10, 0, [ev(1, { loc: 1 as LocationId }), ev(2)]);
    useUiStore.getState().applyMessage({ type: 'view', view: first });

    // Сталкер 1 перешёл в локацию 3; 2 — без изменений; ждём реконструкцию next.
    const next = view(11, 0, [ev(1, { loc: 3 as LocationId }), ev(2)]);
    useUiStore.getState().applyMessage({
      type: 'viewDelta',
      tick: 11 as Tick,
      day: 0,
      weather: 0,
      changed: [ev(1, { loc: 3 as LocationId })],
      removed: [],
    });
    expect(useUiStore.getState().view).toEqual(next);
  });

  it('viewDelta БЕЗ базового вида игнорируется (ждём полный view)', () => {
    // view === null — дельта некорректна, состояние не меняется.
    useUiStore.getState().applyMessage({
      type: 'viewDelta',
      tick: 5 as Tick,
      day: 0,
      weather: 0,
      changed: [ev(1)],
      removed: [],
    });
    expect(useUiStore.getState().view).toBeNull();
  });

  it('viewDelta с removed убирает сущность и пересчитывает население', () => {
    const first = view(10, 0, [ev(1), ev(2, { kind: 'animal' as EntityKind, faction: null })]);
    useUiStore.getState().applyMessage({ type: 'view', view: first });
    useUiStore.getState().applyMessage({
      type: 'viewDelta',
      tick: 12 as Tick,
      day: 0,
      weather: 0,
      changed: [],
      removed: [2 as EntityId],
    });
    const v = useUiStore.getState().view;
    expect(v?.entities.map((e) => e.eid as number)).toEqual([1]);
    expect(v?.population).toEqual({ humans: 1, animals: 0, corpses: 0 });
  });
});

describe('applyMessage: окно лога — кольцевой буфер (D-078, LOG_WINDOW=1000)', () => {
  it('logDelta дописывает события в хвост, порядок сохранён', () => {
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [simEvent(1), simEvent(2)] });
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [simEvent(3)] });
    expect(useUiStore.getState().log.map((e) => e.id as number)).toEqual([1, 2, 3]);
  });

  it('пустой logDelta — no-op (лог не трогается)', () => {
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [simEvent(1)] });
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [] });
    expect(useUiStore.getState().log.map((e) => e.id as number)).toEqual([1]);
  });

  it('переполнение окна вытесняет СТАРЫЕ события (держим последние 1000)', () => {
    // Заливаем 1200 событий двумя порциями — окно должно держать хвост [201..1200].
    const first: SimEvent[] = [];
    for (let i = 1; i <= 700; i++) first.push(simEvent(i));
    const second: SimEvent[] = [];
    for (let i = 701; i <= 1200; i++) second.push(simEvent(i));

    useUiStore.getState().applyMessage({ type: 'logDelta', events: first });
    useUiStore.getState().applyMessage({ type: 'logDelta', events: second });

    const log = useUiStore.getState().log;
    expect(log.length).toBe(1000);
    // Самое старое сохранённое — id 201 (1..200 вытеснены), самое новое — 1200.
    expect(log.at(0)?.id as number).toBe(201);
    expect(log.at(-1)?.id as number).toBe(1200);
  });
});

describe('applyMessage: detail / snapshot / stats', () => {
  it('detail кладёт EntityDetail и переносит null (снятие выделения)', () => {
    const detail = {
      eid: 7 as EntityId,
      kind: 'human' as EntityKind,
      faction: 'loners' as FactionId,
      loc: 2 as LocationId,
      needs: { hunger: 10, thirst: 20, fatigue: 5, fear: 0 },
      hp: 80,
      inventory: [],
      money: 100,
      memory: [],
      relations: [],
      fame: 3,
      recentEvents: [],
    };
    useUiStore.getState().applyMessage({ type: 'detail', detail });
    expect(useUiStore.getState().detail).toEqual(detail);
    useUiStore.getState().applyMessage({ type: 'detail', detail: null });
    expect(useUiStore.getState().detail).toBeNull();
  });

  it('stats обновляет телеметрию тайм-бара', () => {
    useUiStore.getState().applyMessage({ type: 'stats', tick: 500 as Tick, entityCount: 42, tickMs: 0.7 });
    expect(useUiStore.getState().stats).toEqual({ tick: 500, entityCount: 42, tickMs: 0.7 });
  });

  it('snapshot запоминается для сохранения (data/seed/tick)', () => {
    const data: SnapshotJSON = {
      version: 1,
      seed: 42 as Seed,
      tick: 500 as Tick,
      rngState: 1,
      eventSeq: 0,
      ecsIndex: [],
      entities: [],
      resources: {},
      components: {},
      eventLog: [],
    };
    useUiStore.getState().applyMessage({ type: 'snapshot', data, seed: 42 as Seed, tick: 500 as Tick });
    expect(useUiStore.getState().lastSnapshot).toEqual({ data, seed: 42, tick: 500 });
  });
});

describe('команды воркеру формируются верно (закон №8: только темп/шаг/инспекция)', () => {
  it('init поднимает мост, чистит окно и шлёт init{seed}', () => {
    // Предзагрязняем состояние — init обязан его сбросить под новый мир.
    useUiStore.setState({ log: [simEvent(1)], detail: null, selectedEid: 9 as EntityId });
    useUiStore.getState().init(42 as Seed);
    expect(useUiStore.getState().connected).toBe(true);
    expect(useUiStore.getState().log).toEqual([]);
    expect(useUiStore.getState().selectedEid).toBeNull();
    expect(bridge.posted).toEqual([{ type: 'init', seed: 42 }]);
  });

  it('init со снапшотом несёт snapshot в команде (resume)', () => {
    const snapshot: SnapshotJSON = {
      version: 1,
      seed: 7 as Seed,
      tick: 100 as Tick,
      rngState: 5,
      eventSeq: 2,
      ecsIndex: [],
      entities: [],
      resources: {},
      components: {},
      eventLog: [],
    };
    useUiStore.getState().init(7 as Seed, snapshot);
    expect(bridge.posted).toEqual([{ type: 'init', seed: 7, snapshot }]);
  });

  it('setSpeed>0 снимает паузу и шлёт setSpeed{ticksPerRealSecond}', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().setSpeed(600);
    expect(useUiStore.getState().speed).toBe(600);
    expect(useUiStore.getState().paused).toBe(false);
    expect(bridge.posted).toEqual([{ type: 'setSpeed', ticksPerRealSecond: 600 }]);
  });

  it('setSpeed(0) и pause() = пауза, темп 0', () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().setSpeed(600);
    bridge.posted.length = 0;
    useUiStore.getState().pause();
    expect(useUiStore.getState().paused).toBe(true);
    expect(useUiStore.getState().speed).toBe(0);
    expect(bridge.posted).toEqual([{ type: 'setSpeed', ticksPerRealSecond: 0 }]);
  });

  it('отрицательный темп нормализуется в 0 (пауза)', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().setSpeed(-5);
    expect(useUiStore.getState().speed).toBe(0);
    expect(useUiStore.getState().paused).toBe(true);
    expect(bridge.posted).toEqual([{ type: 'setSpeed', ticksPerRealSecond: 0 }]);
  });

  it('step(N>0) шлёт step{ticks:N}; step(0/отриц.) — ничего', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().step(3);
    useUiStore.getState().step(0);
    useUiStore.getState().step(-1);
    expect(bridge.posted).toEqual([{ type: 'step', ticks: 3 }]);
  });

  it('inspect выделяет eid и шлёт inspect{eid}', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().inspect(11 as EntityId);
    expect(useUiStore.getState().selectedEid).toBe(11);
    expect(bridge.posted).toEqual([{ type: 'inspect', eid: 11 }]);
  });

  it('requestSnapshot шлёт requestSnapshot', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().requestSnapshot();
    expect(bridge.posted).toEqual([{ type: 'requestSnapshot' }]);
  });

  it('команды ДО init не падают (моста нет — тихо игнорируются)', () => {
    // client === null: setSpeed меняет локальное состояние, но post не летит (нет краша).
    expect(() => {
      useUiStore.getState().setSpeed(100);
      useUiStore.getState().step(2);
      useUiStore.getState().inspect(1 as EntityId);
      useUiStore.getState().requestSnapshot();
    }).not.toThrow();
    expect(bridge.posted).toEqual([]);
    // Локальное состояние темпа всё же обновилось.
    expect(useUiStore.getState().speed).toBe(100);
  });
});
