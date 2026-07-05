/**
 * Тест СЕРИАЛИЗУЕМОСТИ Worker-протокола (задача 4.0, D-077). Всё, что пересекает
 * `postMessage`, обязано быть plain-JSON (закон №5: bitecs/классы/Map не течёт).
 * Здесь — JSON round-trip каждого варианта `UiToWorker`/`WorkerToUi`: сообщение
 * равно себе после `JSON.parse(JSON.stringify(...))`. Живой воркер/DOM не нужны.
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

function roundtrip<T>(msg: T): T {
  return JSON.parse(JSON.stringify(msg)) as T;
}

const sampleEntity: EntityView = {
  eid: 7 as EntityId,
  kind: 'human',
  faction: 'loners',
  loc: 2 as LocationId,
  dest: 3 as LocationId,
  etaTicks: 12,
  hpFrac: 0.8,
  task: 5,
  inCombat: false,
  carrying: true,
  alive: true,
};

const sampleView: WorldView = {
  day: 1,
  tick: 1500 as Tick,
  weather: 2,
  entities: [sampleEntity],
  population: { humans: 1, animals: 0, corpses: 0 },
};

const sampleDetail: EntityDetail = {
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

const sampleSnapshot: SnapshotJSON = {
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

const sampleEvent: SimEvent = {
  id: 1 as never,
  tick: 1500 as Tick,
  type: 'sim/tickStarted',
  causedBy: null,
  payload: { tick: 1500 as Tick },
};

describe('UiToWorker — JSON round-trip', () => {
  const msgs: UiToWorker[] = [
    { type: 'init', seed: 42 as Seed },
    { type: 'init', seed: 42 as Seed, snapshot: sampleSnapshot },
    { type: 'setSpeed', ticksPerRealSecond: 600 },
    { type: 'setSpeed', ticksPerRealSecond: 0 },
    { type: 'step', ticks: 1 },
    { type: 'inspect', eid: 7 as EntityId },
    { type: 'requestSnapshot' },
  ];
  for (const m of msgs) {
    it(`сериализуем: ${m.type}`, () => {
      expect(roundtrip(m)).toEqual(m);
    });
  }
});

describe('WorkerToUi — JSON round-trip', () => {
  const msgs: WorkerToUi[] = [
    { type: 'view', view: sampleView },
    {
      type: 'viewDelta',
      tick: 1501 as Tick,
      day: 1,
      weather: 2,
      changed: [sampleEntity],
      removed: [9 as EntityId],
    },
    { type: 'logDelta', events: [sampleEvent] },
    { type: 'names', names: { 5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' } } },
    { type: 'detail', detail: sampleDetail },
    { type: 'detail', detail: null },
    { type: 'snapshot', data: sampleSnapshot, seed: 42 as Seed, tick: 1500 as Tick },
    { type: 'stats', tick: 1500 as Tick, entityCount: 1, tickMs: 0.42 },
  ];
  for (const m of msgs) {
    it(`сериализуем: ${m.type}`, () => {
      expect(roundtrip(m)).toEqual(m);
    });
  }
});
