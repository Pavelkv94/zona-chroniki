/**
 * Тесты ГРАНИЦЫ postMessage (задача 4.0, D-077): всё, что пересекает мост Sim⇄UI,
 * обязано быть PLAIN — только JSON-примитивы/массивы/объекты, НИ ФУНКЦИЙ, НИ классов,
 * НИ Map/Set, НИ bitecs-структур (закон №5). Дополняет round-trip-тест: тот проверяет
 * «равно после JSON», этот — «внутри нет НЕ-plain значений» (round-trip молча ВЫБРАСЫВАЕТ
 * функции, поэтому обходим дерево и ловим их явно) и уникальность дискриминанта `type`.
 */

import { describe, it, expect } from 'vitest';
import type {
  EntityId,
  EntityView,
  EntityDetail,
  LocationId,
  Seed,
  SimEvent,
  SnapshotJSON,
  Tick,
  UiToWorker,
  WorkerToUi,
  WorldView,
} from '@zona/shared';

const entity: EntityView = {
  eid: 7 as EntityId,
  kind: 'human',
  faction: 'loners',
  loc: 2 as LocationId,
  dest: 3 as LocationId,
  etaTicks: 12,
  hpFrac: 0.8,
  task: 5,
  inCombat: true,
  carrying: true,
  alive: true,
};

const worldView: WorldView = {
  day: 1,
  tick: 1500 as Tick,
  weather: 2,
  entities: [entity],
  population: { humans: 1, animals: 0, corpses: 0 },
};

const detail: EntityDetail = {
  eid: 7 as EntityId,
  kind: 'human',
  faction: 'loners',
  loc: 2 as LocationId,
  needs: { hunger: 10, thirst: 20, fatigue: 5, fear: 0 },
  hp: 80,
  inventory: [['bread', 2]],
  money: 100,
  memory: [],
  relations: [],
  fame: 3,
  recentEvents: [],
};

const snapshot: SnapshotJSON = {
  version: 1,
  seed: 42 as Seed,
  tick: 1500 as Tick,
  rngState: 12345,
  eventSeq: 9,
  ecsIndex: [1, 2, 3],
  entities: [7 as EntityId],
  resources: {},
  components: {},
  eventLog: [],
};

const event: SimEvent = {
  id: 1 as never,
  tick: 1500 as Tick,
  type: 'sim/tickStarted',
  causedBy: null,
  payload: { tick: 1500 as Tick },
} as SimEvent;

const uiToWorker: UiToWorker[] = [
  { type: 'init', seed: 42 as Seed },
  { type: 'init', seed: 42 as Seed, snapshot },
  { type: 'setSpeed', ticksPerRealSecond: 600 },
  { type: 'setSpeed', ticksPerRealSecond: 0 },
  { type: 'step', ticks: 4 },
  { type: 'inspect', eid: 7 as EntityId },
  { type: 'requestSnapshot' },
];

const workerToUi: WorkerToUi[] = [
  { type: 'view', view: worldView },
  {
    type: 'viewDelta',
    tick: 1501 as Tick,
    day: 1,
    weather: 2,
    changed: [entity],
    removed: [9 as EntityId],
  },
  { type: 'logDelta', events: [event] },
  { type: 'names', names: { 5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' } } },
  { type: 'detail', detail },
  { type: 'detail', detail: null },
  { type: 'snapshot', data: snapshot, seed: 42 as Seed, tick: 1500 as Tick },
  { type: 'stats', tick: 1500 as Tick, entityCount: 1, tickMs: 0.42 },
];

/**
 * Рекурсивно доказать, что значение PLAIN: примитив/null/массив/обычный объект. Любая
 * функция, класс с нетривиальным прототипом, Map/Set → провал (не переживёт postMessage
 * как данные, либо утечёт движок — нарушение закона №5). Возвращает путь до нарушителя.
 */
function findNonPlain(value: unknown, path = '$'): string | null {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return null;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
    return `${path}: ${t}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = findNonPlain(value[i], `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  // Объект: прототип обязан быть Object.prototype или null (не класс, не Map/Set).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `${path}: не-plain объект (${proto?.constructor?.name ?? 'unknown'})`;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const bad = findNonPlain(v, `${path}.${k}`);
    if (bad) return bad;
  }
  return null;
}

describe('граница postMessage: только PLAIN-значения (D-077, закон №5)', () => {
  for (const m of uiToWorker) {
    it(`UI→Worker '${m.type}' — plain, без функций/классов/Map`, () => {
      expect(findNonPlain(m)).toBeNull();
    });
  }
  for (const m of workerToUi) {
    it(`Worker→UI '${m.type}' — plain, без функций/классов/Map`, () => {
      expect(findNonPlain(m)).toBeNull();
    });
  }

  it('НЕ-plain значение детектор ловит (самопроверка стража)', () => {
    // Функция и class-инстанс должны отлавливаться — иначе страж бесполезен.
    expect(findNonPlain({ f: () => 1 })).toBe('$.f: function');
    expect(findNonPlain({ m: new Map() })).toContain('не-plain объект');
  });
});

describe('дискриминант type уникален внутри каждого направления', () => {
  it('UiToWorker: все type различны', () => {
    const types = uiToWorker.map((m) => m.type);
    // init встречается дважды (init/init+snapshot) — считаем УНИКАЛЬНЫЕ значения union.
    const unique = new Set(types);
    expect([...unique].sort()).toEqual(['init', 'inspect', 'requestSnapshot', 'setSpeed', 'step']);
  });

  it('WorkerToUi: все type различны и покрыты образцами', () => {
    const types = workerToUi.map((m) => m.type);
    const unique = new Set(types);
    expect([...unique].sort()).toEqual(['detail', 'logDelta', 'names', 'snapshot', 'stats', 'view', 'viewDelta']);
    // detail представлен дважды (detail|null) — но это ОДИН дискриминант.
    expect(types.filter((t) => t === 'detail').length).toBe(2);
  });
});
