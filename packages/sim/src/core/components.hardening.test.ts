/**
 * @module @zona/sim/core/components.hardening.test
 *
 * УСИЛЕННЫЙ гейт доменных SoA-компонентов (задача 1.2, D-019) — надстройка над
 * `components.test.ts`. Закрывает дыры, найденные QA:
 *  - границы ТИПОВ колонок (f32 дробные/огромные, ui32 до 2^32-1, ui8 0..255 и
 *    усечение, eid) round-trip БИТ-В-БИТ против НЕЗАВИСИМО посчитанного округления
 *    (а не против того же самого singleton-массива — тавтология исходного теста);
 *  - человек целиком (все данные + тег Human) round-trip; колонки НЕЗАВИСИМЫ по eid;
 *  - WorldClock как singleton (один носитель) переживает round-trip;
 *  - D-024 зануление на РЕАЛЬНОМ Health (исходный тест покрывал только Needs);
 *  - ТЕГ + данные + ResourceStore на одной сущности (труп с лутом) не конфликтуют;
 *  - reuse eid для ТЕГА: труп умер, eid переиспользован — новый носитель НЕ
 *    наследует членство (destroyEntity снимает тег; иначе «труп из воздуха»);
 *  - freelist: оборот рождений/смертей НЕ растит пик eid → 4096 держит Фазу 1;
 *  - таксономия TaskKind: коды APPEND-ONLY, плотные, ui8; фиксируем текущий набор
 *    и явно отмечаем, что GO_HOME отдельным кодом НЕ выделен (движение домой —
 *    через Position.dest→Home.loc, семантику 1.8 закрепляет behavior-engineer).
 *
 * Все компоненты — модульные singleton'ы: каждый тест берёт свежий мир (eid с 1) и
 * ВСЕГДА addComponent перед чтением (add зануляет слот, D-024), поэтому значения
 * прошлых тестов не протекают.
 */

import { describe, it, expect } from 'vitest';
import type { Seed } from '@zona/shared';
import { createSimWorld, destroyEntity } from './world';
import {
  spawnEntity,
  addComponent,
  hasComponent,
  queryEntities,
  type ComponentRef,
} from './ecs';
import {
  WORLD_CAPACITY,
  TaskKind,
  WEATHER_CODE,
  Position,
  Needs,
  Health,
  Task,
  Skills,
  Home,
  Animal,
  WorldClock,
  Human,
  Corpse,
  Alive,
} from './components';
import { serialize, deserialize, hashSnapshot } from './snapshot';

/** Нетипизированный доступ к колонкам компонента (запись/чтение полей по eid). */
function cols(ref: ComponentRef): Record<string, { [i: number]: number }> {
  return ref as unknown as Record<string, { [i: number]: number }>;
}

/** Тип поля колонки — для НЕЗАВИСИМОГО (не через тот же массив) расчёта округления. */
type Ft = 'f32' | 'ui32' | 'ui8' | 'eid';

/** Значение, каким его ХРАНИТ типизированный массив: единственный источник правды round-trip. */
function coerce(type: Ft, v: number): number {
  switch (type) {
    case 'f32':
      return Math.fround(v);
    case 'ui32':
    case 'eid':
      return v >>> 0; // усечение до Uint32
    case 'ui8':
      return v & 0xff; // усечение до Uint8
  }
}

// Ширины полей КАЖДОГО компонента (зеркало схем в components.ts). Держим здесь,
// чтобы независимо посчитать «как это ляжет в SoA» и сверить с round-trip.
const FIELD_TYPES: Record<string, Record<string, Ft>> = {
  // causality-поля (D-030, 1.2b) — в КОНЦЕ, ui32 (moveCause/lethalCause/causeEvent).
  position: { loc: 'ui32', dest: 'ui32', etaTicks: 'f32', moveCause: 'ui32' },
  needs: { hunger: 'f32', thirst: 'f32', fatigue: 'f32', fear: 'f32' },
  health: { hp: 'f32', lethalCause: 'ui32' },
  task: { kind: 'ui8', targetLoc: 'ui32', targetEid: 'eid', startedTick: 'ui32', causeEvent: 'ui32' },
  skills: { shooting: 'f32', survival: 'f32', stealth: 'f32' },
  home: { loc: 'ui32' },
  animal: { species: 'ui8', herd: 'ui32' },
  worldclock: { weather: 'ui8', weatherSince: 'ui32' },
};

/**
 * Пишет `raw` в КАЖДОЕ поле компонента `name`/`ref`, round-trip через ГЛОБАЛЬНЫЙ
 * реестр, и сверяет БИТ-В-БИТ: восстановленное значение колонки === НЕЗАВИСИМО
 * посчитанное `coerce(type, raw)` (не тот же массив), плюс равенство хэшей.
 */
function roundTripFields(name: string, ref: ComponentRef, raw: Record<string, number>): void {
  const types = FIELD_TYPES[name] as Record<string, Ft>;
  const w = createSimWorld(101 as Seed);
  const e = spawnEntity(w.ecs);
  addComponent(w.ecs, ref, e);
  const c = cols(ref);
  for (const [f, v] of Object.entries(raw)) c[f]![e] = v;

  const snap1 = serialize(w);
  const w2 = deserialize(snap1);
  const snap2 = serialize(w2);
  expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1));
  expect(hasComponent(w2.ecs, ref, e)).toBe(true);

  // Восстановленное значение в singleton-колонке === эталон округления типа.
  const c2 = cols(ref);
  for (const [f, v] of Object.entries(raw)) {
    expect(c2[f]![e]).toBe(coerce(types[f] as Ft, v));
  }
  // И снапшот несёт именно эти (округлённые) значения по объявленному порядку полей.
  const col = snap1.components[name] as unknown as {
    eids: number[];
    fields: Record<string, number[]>;
  };
  expect(col.eids).toEqual([e]);
  for (const [f, v] of Object.entries(raw)) {
    expect(col.fields[f]).toEqual([coerce(types[f] as Ft, v)]);
  }
}

describe('границы ТИПОВ колонок — round-trip бит-в-бит (D-018/D-019, закон №8)', () => {
  const U32_MAX = 0xffffffff; // 4294967295
  const U8_MAX = 0xff; // 255

  it('Position: ui32-максимум в loc/dest, дробный+огромный f32 в etaTicks', () => {
    roundTripFields('position', Position, { loc: U32_MAX, dest: 0, etaTicks: 0.1 });
    // 2^24+1 не представимо в f32 → округляется к 2^24; round-trip хранит округлённое.
    roundTripFields('position', Position, { loc: 1, dest: U32_MAX, etaTicks: 16777217 });
  });

  it('Needs: полный диапазон 0..1 плюс «шумные» дроби f32', () => {
    roundTripFields('needs', Needs, { hunger: 0, thirst: 1, fatigue: 0.1, fear: 0.9999999 });
    roundTripFields('needs', Needs, { hunger: 1 / 3, thirst: 2 / 3, fatigue: 0.333333, fear: 0.000001 });
  });

  it('Health: hp у границ f32 (0, крошечное, близко к max f32)', () => {
    roundTripFields('health', Health, { hp: 0 });
    roundTripFields('health', Health, { hp: 3.4028235e38 }); // ~f32 max
    roundTripFields('health', Health, { hp: 1e-30 });
  });

  it('Task: ui8-максимум в kind, ui32-максимум в targetLoc/startedTick, eid-ссылка', () => {
    roundTripFields('task', Task, {
      kind: U8_MAX,
      targetLoc: U32_MAX,
      targetEid: 4000000000, // большой eid-указатель (Uint32)
      startedTick: U32_MAX,
    });
    // eid==0 = «нет цели» (валидная ссылка-ноль): не теряется.
    roundTripFields('task', Task, { kind: TaskKind.SLEEP, targetLoc: 0, targetEid: 0, startedTick: 0 });
  });

  it('Skills: единица и дроби f32 во всех трёх полях', () => {
    roundTripFields('skills', Skills, { shooting: 1, survival: 0.123456, stealth: 0.999999 });
  });

  it('Home: ui32-максимум в loc', () => {
    roundTripFields('home', Home, { loc: U32_MAX });
  });

  it('Animal: ui8-максимум species, ui32-максимум herd', () => {
    roundTripFields('animal', Animal, { species: U8_MAX, herd: U32_MAX });
  });

  it('WorldClock: ui8 weather до 255, ui32-максимум weatherSince', () => {
    roundTripFields('worldclock', WorldClock, { weather: U8_MAX, weatherSince: U32_MAX });
  });

  it('ui8 УСЕКАЕТ детерминированно (запись 256/257 → 0/1) и это переживает round-trip', () => {
    // Документируем: колонка ui8 хранит value & 0xFF. Систем это не касается (kind в
    // [0..6]), но фиксируем усечение как детерминированное — не «мусор из воздуха».
    roundTripFields('task', Task, { kind: 256, targetLoc: 0, targetEid: 0, startedTick: 0 }); // →0
    roundTripFields('animal', Animal, { species: 257, herd: 0 }); // →1
  });
});

describe('человек целиком (данные + тег Human) round-trip; колонки НЕЗАВИСИМЫ', () => {
  it('Position+Needs+Health+Task+Skills+Home+Human переживают save/load вместе', () => {
    const w = createSimWorld(202 as Seed);
    const e = spawnEntity(w.ecs);
    for (const ref of [Position, Needs, Health, Task, Skills, Home]) addComponent(w.ecs, ref, e);
    addComponent(w.ecs, Human, e); // тег на той же сущности, что и данные
    cols(Position)['loc']![e] = 4;
    cols(Position)['dest']![e] = 9;
    cols(Position)['etaTicks']![e] = 6.5;
    cols(Needs)['hunger']![e] = 0.2;
    cols(Health)['hp']![e] = 55;
    cols(Task)['kind']![e] = TaskKind.HUNT;
    cols(Task)['targetEid']![e] = 999;
    cols(Skills)['shooting']![e] = 0.8;
    cols(Home)['loc']![e] = 3;

    const snap = serialize(w);
    const w2 = deserialize(snap);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
    for (const ref of [Position, Needs, Health, Task, Skills, Home, Human]) {
      expect(hasComponent(w2.ecs, ref, e)).toBe(true);
    }
    // Тег Human лежит рядом с данными и не «съедает» их: значения на месте.
    expect(cols(Task)['kind']![e]).toBe(TaskKind.HUNT);
    expect(cols(Home)['loc']![e]).toBe(3);
  });

  it('eids колонок независимы: у человека Needs, у зверя Animal — списки не смешиваются', () => {
    const w = createSimWorld(203 as Seed);
    const human = spawnEntity(w.ecs);
    const beast = spawnEntity(w.ecs);
    // Общее — Position и Health; различающее — Needs (только человек), Animal (только зверь).
    addComponent(w.ecs, Position, human);
    addComponent(w.ecs, Health, human);
    addComponent(w.ecs, Needs, human);
    addComponent(w.ecs, Human, human);
    addComponent(w.ecs, Position, beast);
    addComponent(w.ecs, Health, beast);
    addComponent(w.ecs, Animal, beast);
    cols(Animal)['species']![beast] = 1;

    const snap = serialize(w);
    const colOf = (n: string) => (snap.components[n] as unknown as { eids: number[] }).eids;
    expect(colOf('position')).toEqual([human, beast]); // оба
    expect(colOf('health')).toEqual([human, beast]); // оба
    expect(colOf('needs')).toEqual([human]); // только человек
    expect(colOf('animal')).toEqual([beast]); // только зверь
    expect(colOf('human')).toEqual([human]);

    const w2 = deserialize(snap);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
    // Членство восстановлено ровно по колонкам: зверь НЕ стал человеком и наоборот.
    expect(hasComponent(w2.ecs, Needs, beast)).toBe(false);
    expect(hasComponent(w2.ecs, Animal, human)).toBe(false);
    expect(hasComponent(w2.ecs, Human, beast)).toBe(false);
  });
});

describe('WorldClock как SINGLETON (один носитель) переживает round-trip (D-019)', () => {
  it('единственная сущность-мир несёт часы; погода и weatherSince сохраняются', () => {
    const w = createSimWorld(204 as Seed);
    const world = spawnEntity(w.ecs); // сущность-мир (её в 1.3 создаёт worldgen)
    // Плюс пара НЕ-носителей часов — чтобы убедиться, что singleton не «размазался».
    const npc1 = spawnEntity(w.ecs);
    const npc2 = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, npc1);
    addComponent(w.ecs, Human, npc2);
    addComponent(w.ecs, WorldClock, world);
    cols(WorldClock)['weather']![world] = WEATHER_CODE.storm;
    cols(WorldClock)['weatherSince']![world] = 720;

    const snap = serialize(w);
    const clockCol = snap.components['worldclock'] as unknown as { eids: number[] };
    expect(clockCol.eids).toEqual([world]); // ровно один носитель — singleton

    const w2 = deserialize(snap);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
    expect(hasComponent(w2.ecs, WorldClock, world)).toBe(true);
    expect(hasComponent(w2.ecs, WorldClock, npc1)).toBe(false);
    expect(cols(WorldClock)['weather']![world]).toBe(WEATHER_CODE.storm);
    expect(cols(WorldClock)['weatherSince']![world]).toBe(720);
  });
});

describe('D-024 зануление на РЕАЛЬНОМ Health при reuse eid (симметрия к Needs)', () => {
  it('reuse eid: новый носитель Health без записи = 0 hp, не hp покойника', () => {
    const w = createSimWorld(205 as Seed);
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, Health, dead);
    cols(Health)['hp']![dead] = 73.5;
    destroyEntity(w, dead); // массив всё ещё держит 73.5 в слоте

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // eid переиспользован — иначе тест не про ghost
    addComponent(w.ecs, Health, reborn); // без записи — полагаемся на зануление
    expect(cols(Health)['hp']![reborn]).toBe(0);

    const snap = serialize(w);
    const col = snap.components['health'] as unknown as { eids: number[]; fields: { hp: number[] } };
    expect(col.fields.hp).toEqual([0]); // в снапшот попал чистый носитель
  });
});

describe('ТЕГ + данные + ResourceStore на одной сущности (труп с лутом) не конфликтуют', () => {
  it('Corpse-тег + Position + инвентарь в ResourceStore — всё переживает round-trip', () => {
    const w = createSimWorld(206 as Seed);
    const body = spawnEntity(w.ecs);
    addComponent(w.ecs, Corpse, body); // тег
    addComponent(w.ecs, Position, body); // данные-компонент
    cols(Position)['loc']![body] = 12;
    // «Холодный» инвентарь трупа — в ResourceStore (D-007), НЕ в SoA.
    w.resources.set('loot', body, { items: ['bread', 'ammo'], money: 50 });

    const snap = serialize(w);
    expect((snap.components['corpse'] as unknown as { eids: number[] }).eids).toEqual([body]);
    expect((snap.components['position'] as unknown as { eids: number[] }).eids).toEqual([body]);

    const w2 = deserialize(snap);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
    expect(hasComponent(w2.ecs, Corpse, body)).toBe(true);
    expect(hasComponent(w2.ecs, Position, body)).toBe(true);
    expect(cols(Position)['loc']![body]).toBe(12);
    // Инвентарь трупа восстановлен один-в-один (предметы не из воздуха, закон №3).
    expect(w2.resources.get('loot', body)).toEqual({ items: ['bread', 'ammo'], money: 50 });
  });
});

describe('reuse eid для ТЕГА: покойник не «завещает» членство новому носителю (закон №3)', () => {
  it('труп умер, eid переиспользован — reborn НЕ несёт Corpse/Human/Alive без нового addComponent', () => {
    const w = createSimWorld(207 as Seed);
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, dead);
    addComponent(w.ecs, Corpse, dead);
    addComponent(w.ecs, Alive, dead);
    expect(hasComponent(w.ecs, Corpse, dead)).toBe(true);
    destroyEntity(w, dead); // ЕДИНАЯ точка удаления: снимает и ECS-членство, и ресурсы

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // тот же eid из freelist — проверяем именно наследование
    // Ни один тег НЕ протёк: свежая сущность чиста, пока систему её не пометит.
    expect(hasComponent(w.ecs, Human, reborn)).toBe(false);
    expect(hasComponent(w.ecs, Corpse, reborn)).toBe(false);
    expect(hasComponent(w.ecs, Alive, reborn)).toBe(false);
    // И запрос по тегу reborn не выдаёт (нет «трупа из воздуха»).
    expect(queryEntities(w.ecs, [Corpse])).toEqual([]);
  });

  it('снятие тега переживает save/load: снапшот НЕ воскрешает членство покойника', () => {
    const w = createSimWorld(208 as Seed);
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, Corpse, dead);
    destroyEntity(w, dead);
    const reborn = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, reborn); // reborn — живой человек, НЕ труп
    const snap = serialize(w);
    // В снапшоте нет ключа corpse (носителей ноль) — тег не пишется.
    expect(snap.components['corpse']).toBeUndefined();
    const w2 = deserialize(snap);
    expect(hasComponent(w2.ecs, Corpse, reborn)).toBe(false);
    expect(hasComponent(w2.ecs, Human, reborn)).toBe(true);
  });
});

describe('ЁМКОСТЬ 4096 и freelist: оборот рождений/смертей не растит пик eid', () => {
  it('циклы spawn→destroy НЕ поднимают maxId: пик eid ограничен ОДНОВРЕМЕННО живыми', () => {
    // Риск: если бы eid не переиспользовались, длинный прогон (тысячи рождений за
    // 100 дней) исчерпал бы 4096. Проверяем bitecs-инвариант: пик eid = пик
    // ОДНОВРЕМЕННО живых, а не сумма рождений. Держим ~200 живых, но «прокручиваем»
    // 5000 рождений/смертей — заведомо больше 4096, будь eid монотонными.
    const w = createSimWorld(209 as Seed);
    const LIVE = 200;
    const CYCLES = 25; // 200 * 25 = 5000 рождений > 4096
    let peakEid = 0;
    let born = 0;
    for (let cyc = 0; cyc < CYCLES; cyc++) {
      const batch: number[] = [];
      for (let i = 0; i < LIVE; i++) {
        const e = spawnEntity(w.ecs) as unknown as number;
        born++;
        if (e > peakEid) peakEid = e;
        addComponent(w.ecs, Health, e as never); // не бросает — eid в пределах ёмкости
        batch.push(e);
      }
      for (const e of batch) destroyEntity(w, e as never); // всех в freelist
    }
    expect(born).toBe(LIVE * CYCLES); // 5000 рождений реально произошло
    // Пик eid остался у потолка одновременно-живых (+ служебные), далеко ниже 4096:
    // доказывает, что freelist переиспользует слоты и 4096 держит Фазу 1 на длинном
    // прогоне. Будь eid монотонны — peakEid был бы ~5000 и addComponent бросил бы.
    expect(peakEid).toBeLessThan(WORLD_CAPACITY);
    expect(peakEid).toBeLessThanOrEqual(LIVE + 8); // тесная граница на пик живых
  });

  it('монотонный спавн БЕЗ смертей упирается в потолок — 4096 не бесконечен (риск задокументирован)', () => {
    // Обратная сторона: без freelist (никто не умирает) 4096-й eid бросает. Это НЕ
    // сценарий Фазы 1 (пик ~450 при оборотах), но фиксирует, что ёмкость конечна и
    // падает ГРОМКО (RangeError), а не молча. Сигнал поднять WORLD_CAPACITY.
    const w = createSimWorld(210 as Seed);
    let last = 0;
    while (last < WORLD_CAPACITY) last = spawnEntity(w.ecs) as unknown as number;
    expect(() => addComponent(w.ecs, Health, WORLD_CAPACITY as never)).toThrow(/ёмкост/i);
  });
});

describe('таксономия TaskKind: append-only, плотная, ui8 (структура, не контент)', () => {
  it('текущий набор кодов зафиксирован и стабилен (append-only — новые в КОНЕЦ)', () => {
    // Снимок кодового пространства: перестановка/переиспользование сломает чтение
    // старых снапшотов (как порядок полей). Новые задачи 1.8 добавляют коды 7,8,…
    expect(Object.entries(TaskKind).sort((a, b) => a[1] - b[1])).toEqual([
      ['SLEEP', 0],
      ['EAT', 1],
      ['DRINK', 2],
      ['FORAGE', 3],
      ['HUNT', 4],
      ['REST', 5],
      ['FLEE', 6],
    ]);
  });

  it('коды плотные (0..N без дыр), уникальны и влезают в ui8', () => {
    const codes = Object.values(TaskKind).sort((a, b) => a - b);
    expect(new Set(codes).size).toBe(codes.length); // уникальны
    expect(codes[0]).toBe(0); // с нуля
    for (let i = 0; i < codes.length; i++) {
      expect(codes[i]).toBe(i); // плотные, без дыр
      expect(codes[i]).toBeLessThanOrEqual(0xff); // ui8
    }
  });

  it('покрыты 4 нужды + добыча еды; GO_HOME отдельным кодом НЕ выделен (наблюдение)', () => {
    // Нужды закрываются задачами: hunger→EAT, thirst→DRINK, fatigue→SLEEP/REST, fear→FLEE.
    for (const k of ['SLEEP', 'EAT', 'DRINK', 'FORAGE', 'HUNT', 'REST', 'FLEE'] as const) {
      expect(TaskKind[k]).toBeDefined();
    }
    // ЯВНО: GO_HOME/GO_TO как отдельного кода НЕТ. Движение к дому выражается не
    // видом задачи, а Position.dest=Home.loc (транзит без sentinel, D-019). Если
    // 1.8 решит, что «идти домой» — самостоятельная задача, код добавится в конец
    // (append-only). Тест страхует от МОЛЧАЛИВОГО появления такого кода в середине.
    expect((TaskKind as Record<string, number>)['GO_HOME']).toBeUndefined();
  });
});
