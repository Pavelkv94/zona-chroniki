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

/** Летописная запись `chronicle/recorded` (для буфера летописи, задача 4.4). */
function chronicleEvent(id: number, day = 0, tick = day * 1440 + 1): SimEvent {
  return {
    id: id as never,
    tick: tick as Tick,
    type: 'chronicle/recorded',
    causedBy: (id - 1) as never,
    payload: {
      eventId: (id - 1) as never,
      day,
      significance: 0.8,
      kind: 'entity/died',
      subjects: ['e:5'],
    },
  } as SimEvent;
}

const FRESH = {
  view: null,
  log: [],
  chronicleLog: [],
  names: {},
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

describe('applyMessage: буфер летописи — переживает шум эфира (задача 4.4)', () => {
  it('logDelta извлекает chronicle/recorded в отдельный буфер chronicleLog', () => {
    useUiStore.getState().applyMessage({
      type: 'logDelta',
      events: [simEvent(1), chronicleEvent(2), simEvent(3), chronicleEvent(4, 1)],
    });
    // Общий лог держит ВСЕ события; буфер летописи — только записи chronicle/recorded.
    expect(useUiStore.getState().log.map((e) => e.id as number)).toEqual([1, 2, 3, 4]);
    expect(useUiStore.getState().chronicleLog.map((e) => e.id as number)).toEqual([2, 4]);
  });

  it('шум эфира вытесняет записи из ОКНА лога, но НЕ из буфера летописи', () => {
    // Одна летописная запись, затем заливаем 1200 радио-подобных событий (эфир).
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [chronicleEvent(1)] });
    const flood: SimEvent[] = [];
    for (let i = 2; i <= 1201; i++) flood.push(simEvent(i));
    useUiStore.getState().applyMessage({ type: 'logDelta', events: flood });

    // Из общего окна (LOG_WINDOW=1000) летописная запись id=1 давно вытеснена…
    expect(useUiStore.getState().log.some((e) => (e.id as number) === 1)).toBe(false);
    // …а в буфере летописи она ЖИВА (эфир туда не попадает).
    expect(useUiStore.getState().chronicleLog.map((e) => e.id as number)).toEqual([1]);
  });

  it('буфер летописи — кольцевой (CHRONICLE_WINDOW=500): держит последние записи', () => {
    const many: SimEvent[] = [];
    for (let i = 1; i <= 600; i++) many.push(chronicleEvent(i, i));
    useUiStore.getState().applyMessage({ type: 'logDelta', events: many });
    const buf = useUiStore.getState().chronicleLog;
    expect(buf.length).toBe(500);
    expect(buf.at(0)?.id as number).toBe(101); // 1..100 вытеснены
    expect(buf.at(-1)?.id as number).toBe(600);
  });

  it('кольцо летописи точно на границе: 501-я запись вытесняет 1-ю (cap=500)', () => {
    // Заливаем РОВНО 500 записей — буфер полон, ничего не вытеснено.
    const full: SimEvent[] = [];
    for (let i = 1; i <= 500; i++) full.push(chronicleEvent(i, i));
    useUiStore.getState().applyMessage({ type: 'logDelta', events: full });
    expect(useUiStore.getState().chronicleLog.length).toBe(500);
    expect(useUiStore.getState().chronicleLog.at(0)?.id as number).toBe(1);

    // 501-я запись выталкивает самую старую (id=1); окно держит [2..501].
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [chronicleEvent(501, 501)] });
    const buf = useUiStore.getState().chronicleLog;
    expect(buf.length).toBe(500);
    expect(buf.some((e) => (e.id as number) === 1)).toBe(false); // 1-я вытеснена
    expect(buf.at(0)?.id as number).toBe(2);
    expect(buf.at(-1)?.id as number).toBe(501);
  });

  it('буфер летописи хранит записи в порядке прихода через несколько дельт', () => {
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [chronicleEvent(2), simEvent(3)] });
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [simEvent(4), chronicleEvent(5, 1)] });
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [chronicleEvent(7, 2)] });
    expect(useUiStore.getState().chronicleLog.map((e) => e.id as number)).toEqual([2, 5, 7]);
  });

  it('logDelta без летописных записей НЕ трогает буфер летописи (тот же массив)', () => {
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [chronicleEvent(1)] });
    const before = useUiStore.getState().chronicleLog;
    useUiStore.getState().applyMessage({ type: 'logDelta', events: [simEvent(2), simEvent(3)] });
    expect(useUiStore.getState().chronicleLog).toBe(before); // ссылка не менялась (нет ре-рендера)
  });

  it('init чистит буфер летописи под новый мир', () => {
    useUiStore.setState({ chronicleLog: [chronicleEvent(1)] });
    useUiStore.getState().init(42 as Seed);
    expect(useUiStore.getState().chronicleLog).toEqual([]);
  });
});

describe('applyMessage: индекс имён — кэш дельтой (D-081)', () => {
  it('names мержит дельту в кэш (новые eid добавляются, прежние сохраняются)', () => {
    useUiStore.getState().applyMessage({
      type: 'names',
      names: { 5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' } },
    });
    useUiStore.getState().applyMessage({
      type: 'names',
      names: { 6: { first: 'Пётр', last: 'Волков', nickname: '' } },
    });
    expect(useUiStore.getState().names).toEqual({
      5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
      6: { first: 'Пётр', last: 'Волков', nickname: '' },
    });
  });

  it('пустая дельта names — no-op (кэш не трогается)', () => {
    useUiStore.getState().applyMessage({
      type: 'names',
      names: { 5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' } },
    });
    const before = useUiStore.getState().names;
    useUiStore.getState().applyMessage({ type: 'names', names: {} });
    expect(useUiStore.getState().names).toBe(before); // та же ссылка (no-op)
  });

  it('init чистит кэш имён под новый мир', () => {
    useUiStore.setState({ names: { 5: { first: 'A', last: 'B', nickname: '' } } });
    useUiStore.getState().init(42 as Seed);
    expect(useUiStore.getState().names).toEqual({});
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

  it('clearSelection обнуляет выбор/деталь и НЕ шлёт команду воркеру (read-only, закон №8/D-076)', () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().inspect(9 as EntityId); // наблюдатель выбрал сущность (ушёл inspect)
    // Воркер ответил деталью (симулируем прилетевший detail).
    useUiStore.setState({
      detail: {
        eid: 9 as EntityId,
        kind: 'human' as EntityKind,
        faction: 'loners' as FactionId,
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
    bridge.posted.length = 0;

    // Закрытие инспектора: чистое обнуление выбора/детали, БЕЗ касания мира.
    useUiStore.getState().clearSelection();
    expect(useUiStore.getState().selectedEid).toBeNull();
    expect(useUiStore.getState().detail).toBeNull();
    expect(bridge.posted).toEqual([]); // воркеру ничего — тик мира не трогаем (read-only)
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
