/**
 * @module @zona/sim/systems/animals.test
 *
 * Гейт системы Animals (задача 1.9, B.1). Покрывает:
 *  - ПАСТЬБА/ПИТЬЁ: голодное животное в кормной локации → hunger падает; в бедной —
 *    слабо; питьё только у воды; при регулярной пастьбе не вымирает за 10 дней;
 *  - БЕГСТВО: пугливый (олень) с ЖИВЫМ человеком в contacts → departure в
 *    безопаснейшего соседа; непугливый (кабан) НЕ бежит; мёртвый eid в contacts не
 *    ломает (existsEntity, D-029);
 *  - РАЗМНОЖЕНИЕ ПРИЧИННОЕ: на племенном тике при size<reproCap И forage>порога →
 *    РОВНО одно animal/born (новорождённый с Animal/Position/Needs/Health/Alive); при
 *    size>=reproCap ИЛИ forage<=порога → НЕТ рождения. НЕ «X%»: варьируя ТОЛЬКО
 *    состояние (size/forage) — рождение появляется/исчезает детерминированно; два
 *    прогона идентичны;
 *  - ПОПУЛЯЦИЯ: за 10 дней не взрывается (reproCap) и не вымирает (пастьба);
 *  - RESUME (P0): непрерывный ≡ split save/load по популяции И логу animal/born
 *    (доказано хэшем) — размножение stateless, без таймера на границе;
 *  - ИНВАРИАНТ: gestationTicks кратен шагу Animals (канарейка перебаланса).
 *
 * Компоненты — модульные singleton'ы (общие колонки по eid): миры в тестах идут
 * ПОСЛЕДОВАТЕЛЬНО; там, где миры делят eid, финал одного захватывается в примитивы/
 * строку-хэш ДО прогона следующего (как в weather.test/needs.test).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed, Tick, SimEvent } from '@zona/shared';
import { createSimWorld, destroyEntity, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, hasComponent, queryEntities } from '../core/ecs';
import { Animal, Position, Needs, Health, Alive, Human } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { getLocation, getSpecies, SPECIES, neighbors, edgeLen } from '../data/index';
import { TICKS_PER_DAY } from '../balance/time';
import { HEALTH_MAX, HUNGER_CRITICAL, THIRST_CRITICAL } from '../balance/needs';
import {
  ANIMAL_GRAZE_HUNGER_PER_TICK,
  ANIMAL_DRINK_THIRST_PER_TICK,
  REPRO_FORAGE_MIN,
  REPRO_MIN_HERD_IN_LOC,
  ANIMAL_NEWBORN_NEED,
} from '../balance/ecology';
import { Animals, herdPhaseTick, isBreedingTick } from './animals';
import { Needs as NeedsSystem } from './needs';
import { Movement } from './movement';

/** Виды (плотный индекс = species.json). */
const DEER = 0;
const BOAR = 1;

/** Шаг планировщика Animals (источник истины — сама система, не литерал 30). */
const STEP = Animals.schedule.every;

// ── Типизированные SoA-колонки для установки/чтения в тестах ──────────────────
const ANIM = Animal as unknown as { species: Uint8Array; herd: Uint32Array };
const POS = Position as unknown as {
  loc: Uint32Array;
  dest: Uint32Array;
  etaTicks: Float32Array;
  moveCause: Uint32Array;
};
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HP = Health as unknown as { hp: Float32Array };

/** Опции размещения животного. */
interface PlaceOpts {
  hunger?: number;
  thirst?: number;
  fatigue?: number;
}

/** Селит СТОЯЩЕЕ живое животное (Animal/Position/Needs/Health/Alive) в локации. */
function placeAnimal(
  world: SimWorld,
  species: number,
  herd: number,
  loc: number,
  opts: PlaceOpts = {},
): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Animal, eid);
  ANIM.species[eid] = species;
  ANIM.herd[eid] = herd;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит (D-019)
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = opts.hunger ?? ANIMAL_NEWBORN_NEED;
  NEED.thirst[eid] = opts.thirst ?? ANIMAL_NEWBORN_NEED;
  NEED.fatigue[eid] = opts.fatigue ?? ANIMAL_NEWBORN_NEED;
  NEED.fear[eid] = 0;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;
  addComponent(world.ecs, Alive, eid);
  return eid;
}

/** Селит человека (тег Human + Position) — для проверки бегства/угрозы. */
function placeHuman(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  return eid;
}

/** Планировщик с указанными системами (порядок регистрации = порядок исполнения). */
function scheduler(...systems: Parameters<ReturnType<typeof createScheduler>['register']>[0][]) {
  const s = createScheduler();
  for (const sys of systems) s.register(sys);
  return s;
}

/** Плоские строки animal/born (безопасно переносить между мирами). */
interface BornRow {
  eid: EntityId;
  herd: number;
  loc: number;
  tick: number;
  causedBy: number | null;
}
function bornRows(world: SimWorld): BornRow[] {
  return world.bus.log
    .filter((e): e is Extract<SimEvent, { type: 'animal/born' }> => e.type === 'animal/born')
    .map((e) => ({
      eid: e.payload.eid,
      herd: e.payload.herd,
      loc: e.payload.loc,
      tick: e.tick,
      causedBy: e.causedBy,
    }));
}

/** Число живых животных (носителей Animal+Alive). */
function animalCount(world: SimWorld): number {
  return queryEntities(world.ecs, [Animal, Alive]).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ИНВАРИАНТ: gestationTicks кратен шагу планировщика (канарейка перебаланса)
// ─────────────────────────────────────────────────────────────────────────────
describe('инвариант: gestationTicks кратен шагу Animals (племенной тик ловится due-тиком)', () => {
  it('для КАЖДОГО вида gestationTicks % Animals.schedule.every === 0', () => {
    expect(STEP).toBeGreaterThan(0);
    for (const s of SPECIES) {
      expect(s.gestationTicks % STEP, `вид ${s.key}`).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПАСТЬБА / ПИТЬЁ
// ─────────────────────────────────────────────────────────────────────────────
describe('пастьба и питьё (выживание, закон №1)', () => {
  it('голодное животное в КОРМНОЙ локации → hunger падает на GRAZE*forage*every', () => {
    const w = createSimWorld(1 as Seed);
    const richLoc = 4; // Дикая территория: forage 0.7, water true
    const eid = placeAnimal(w, DEER, 1, richLoc, { hunger: 50, thirst: 50 });
    scheduler(Animals).run(w, 1); // тик 0 — Animals due

    const forage = getLocation(richLoc as LocationId).forage;
    const expectedHunger = 50 - ANIMAL_GRAZE_HUNGER_PER_TICK * forage * STEP;
    expect(NEED.hunger[eid]).toBeCloseTo(expectedHunger, 4);
    expect(NEED.hunger[eid]!).toBeLessThan(50); // реально упал
  });

  it('в БЕДНОЙ локации пастьба слабая (forage мал → почти без восстановления)', () => {
    const w = createSimWorld(2 as Seed);
    const poorLoc = 9; // Саркофаг: forage 0.05, water false
    const eid = placeAnimal(w, DEER, 1, poorLoc, { hunger: 50, thirst: 50 });
    scheduler(Animals).run(w, 1);

    const forage = getLocation(poorLoc as LocationId).forage;
    const expectedHunger = 50 - ANIMAL_GRAZE_HUNGER_PER_TICK * forage * STEP;
    expect(NEED.hunger[eid]).toBeCloseTo(expectedHunger, 4);
    // Восстановление в бедной локации мало (< 1 единицы за шаг).
    expect(50 - (NEED.hunger[eid] as number)).toBeLessThan(1);
  });

  it('питьё ТОЛЬКО у воды: thirst падает при water, не меняется без воды', () => {
    // Водная локация (loc4 water true).
    const wet = createSimWorld(3 as Seed);
    const wetEid = placeAnimal(wet, DEER, 1, 4, { thirst: 50 });
    scheduler(Animals).run(wet, 1);
    const expectedThirst = 50 - ANIMAL_DRINK_THIRST_PER_TICK * STEP;
    expect(NEED.thirst[wetEid]).toBeCloseTo(expectedThirst, 4);

    // Безводная локация (loc9 water false) — thirst не трогается пастьбой.
    const dry = createSimWorld(3 as Seed);
    const dryEid = placeAnimal(dry, DEER, 1, 9, { thirst: 50 });
    scheduler(Animals).run(dry, 1);
    expect(NEED.thirst[dryEid]).toBe(50);
  });

  it('при регулярной пастьбе (Needs+Animals) не вымирает за 10 дней в кормном угодье', () => {
    const w = createSimWorld(4 as Seed);
    const herd = 1;
    const initial = 4;
    const eids: EntityId[] = [];
    for (let i = 0; i < initial; i++) eids.push(placeAnimal(w, DEER, herd, 4)); // loc4 forage+water
    scheduler(NeedsSystem, Animals).run(w, 10 * TICKS_PER_DAY);

    // Никто не умер от истощения: hp полное, нужды далеко от критических.
    for (const eid of eids) {
      expect(HP.hp[eid]!, `hp животного ${eid}`).toBeGreaterThan(0);
      expect(NEED.hunger[eid]!).toBeLessThan(HUNGER_CRITICAL);
      expect(NEED.thirst[eid]!).toBeLessThan(THIRST_CRITICAL);
    }
    // Не вымерло и не взорвалось: популяция между initial и reproCap.
    const cap = getSpecies(DEER).reproCap;
    expect(animalCount(w)).toBeGreaterThanOrEqual(initial);
    expect(animalCount(w)).toBeLessThanOrEqual(cap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// БЕГСТВО
// ─────────────────────────────────────────────────────────────────────────────
describe('бегство пугливых от людей (закон №2, D-029)', () => {
  it('олень (flees) с ЖИВЫМ человеком в contacts → departure в безопаснейшего соседа', () => {
    const w = createSimWorld(5 as Seed);
    const loc = 1; // Свалка: соседи 0(danger .05),2(.3),3(.45) → безопаснейший = 0
    const deer = placeAnimal(w, DEER, 1, loc);
    const human = placeHuman(w, loc);
    w.resources.set<readonly EntityId[]>('contacts', deer, [human]);

    scheduler(Animals).run(w, 1);

    // Ушёл в соседа 0 (min danger): dest != loc, транзит начат.
    expect(POS.dest[deer]).toBe(0);
    expect(POS.dest[deer]).not.toBe(loc);
    expect(POS.etaTicks[deer]!).toBeGreaterThan(0);
    // move/departed опубликован, moveCause проштампован (замкнёт arrived, D-030).
    const departed = w.bus.log.filter((e) => e.type === 'move/departed');
    expect(departed).toHaveLength(1);
    expect(POS.moveCause[deer]!).toBeGreaterThan(0);
  });

  it('кабан (flees:false) с человеком в contacts → НЕ бежит (стоит, пасётся)', () => {
    const w = createSimWorld(6 as Seed);
    const loc = 1;
    const boar = placeAnimal(w, BOAR, 1, loc, { hunger: 50 });
    const human = placeHuman(w, loc);
    w.resources.set<readonly EntityId[]>('contacts', boar, [human]);

    expect(getSpecies(BOAR).flees).toBe(false);
    scheduler(Animals).run(w, 1);

    expect(POS.dest[boar]).toBe(loc); // не тронулся с места
    expect(w.bus.log.filter((e) => e.type === 'move/departed')).toHaveLength(0);
    expect(NEED.hunger[boar]!).toBeLessThan(50); // вместо бегства — пасся
  });

  it('МЁРТВЫЙ eid в contacts не ломает и не считается человеком (existsEntity, D-029)', () => {
    const w = createSimWorld(7 as Seed);
    const loc = 1;
    const deer = placeAnimal(w, DEER, 1, loc, { hunger: 50 });
    // eid, который был жив и уже уничтожен → existsEntity=false.
    const ghost = spawnEntity(w.ecs);
    destroyEntity(w, ghost);
    w.resources.set<readonly EntityId[]>('contacts', deer, [ghost]);

    expect(() => scheduler(Animals).run(w, 1)).not.toThrow();
    // Живого человека в контактах нет → олень не бежит, пасётся.
    expect(POS.dest[deer]).toBe(loc);
    expect(NEED.hunger[deer]!).toBeLessThan(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// РАЗМНОЖЕНИЕ — ПРИЧИННОЕ
// ─────────────────────────────────────────────────────────────────────────────
describe('размножение ПРИЧИННОЕ (закон №2 — периодичность × пороги, НЕ «X% приплод»)', () => {
  const HERD = 1;
  const GEST = getSpecies(DEER).gestationTicks;
  const BREEDING_TICK = herdPhaseTick(HERD, GEST); // первый племенной тик стада

  it('herdPhaseTick кратен шагу и в [0, gestationTicks); isBreedingTick срабатывает на нём', () => {
    expect(BREEDING_TICK % STEP).toBe(0);
    expect(BREEDING_TICK).toBeGreaterThanOrEqual(0);
    expect(BREEDING_TICK).toBeLessThan(GEST);
    expect(isBreedingTick(BREEDING_TICK, HERD, GEST)).toBe(true);
    expect(isBreedingTick(BREEDING_TICK + STEP, HERD, GEST)).toBe(false); // не каждый due-тик
    expect(isBreedingTick(BREEDING_TICK + GEST, HERD, GEST)).toBe(true); // следующий цикл
  });

  it('на племенном тике при size<reproCap И forage>порога → РОВНО одно рождение', () => {
    const w = createSimWorld(10 as Seed);
    const loc = 4; // forage 0.7 > порога
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, loc); // 3 >= REPRO_MIN
    expect(3).toBeGreaterThanOrEqual(REPRO_MIN_HERD_IN_LOC);

    scheduler(Animals).run(w, BREEDING_TICK + 1); // включает племенной тик

    const born = bornRows(w);
    expect(born).toHaveLength(1); // РОВНО одно рождение на стадо за племенной тик
    expect(born[0]!.tick).toBe(BREEDING_TICK);
    expect(born[0]!.herd).toBe(HERD);
    expect(born[0]!.loc).toBe(loc);
    expect(born[0]!.causedBy).toBeNull(); // экологический порог — корень (закон №2)

    // Новорождённый — полноценное животное со всеми компонентами.
    const newborn = born[0]!.eid;
    expect(hasComponent(w.ecs, Animal, newborn)).toBe(true);
    expect(hasComponent(w.ecs, Position, newborn)).toBe(true);
    expect(hasComponent(w.ecs, Needs, newborn)).toBe(true);
    expect(hasComponent(w.ecs, Health, newborn)).toBe(true);
    expect(hasComponent(w.ecs, Alive, newborn)).toBe(true);
    expect(ANIM.species[newborn]).toBe(DEER);
    expect(ANIM.herd[newborn]).toBe(HERD);
    expect(POS.loc[newborn]).toBe(loc);
    expect(POS.dest[newborn]).toBe(loc); // стоит
    expect(HP.hp[newborn]).toBe(HEALTH_MAX);
    // Нужды НИЖЕ критических (D-027).
    expect(NEED.hunger[newborn]!).toBeLessThan(HUNGER_CRITICAL);
    expect(NEED.thirst[newborn]!).toBeLessThan(THIRST_CRITICAL);
    // Популяция выросла ровно на одного.
    expect(animalCount(w)).toBe(4);
  });

  it('НЕ «X%»: варьируя ТОЛЬКО size (>=reproCap) на том же тике — рождение ИСЧЕЗАЕТ', () => {
    const w = createSimWorld(10 as Seed);
    const loc = 4;
    const cap = getSpecies(DEER).reproCap;
    for (let i = 0; i < cap; i++) placeAnimal(w, DEER, HERD, loc); // локальная популяция = cap

    scheduler(Animals).run(w, BREEDING_TICK + 1);

    expect(bornRows(w)).toHaveLength(0); // потолок вида достигнут → нет приплода
    expect(animalCount(w)).toBe(cap);
  });

  it('НЕ «X%»: варьируя ТОЛЬКО forage (<=порога) на том же тике — рождение ИСЧЕЗАЕТ', () => {
    const w = createSimWorld(10 as Seed);
    const poorLoc = 9; // Саркофаг forage 0.05 <= REPRO_FORAGE_MIN
    expect(getLocation(poorLoc as LocationId).forage).toBeLessThanOrEqual(REPRO_FORAGE_MIN);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, poorLoc);

    scheduler(Animals).run(w, BREEDING_TICK + 1);

    expect(bornRows(w)).toHaveLength(0); // голодная земля не плодит
  });

  it('НЕ «X%»: одиночка (herdHere<2) не размножается — родителей-пары нет (закон №3)', () => {
    const w = createSimWorld(10 as Seed);
    placeAnimal(w, DEER, HERD, 4); // один в стаде
    scheduler(Animals).run(w, BREEDING_TICK + 1);
    expect(bornRows(w)).toHaveLength(0);
  });

  it('детерминизм: два прогона одного состояния → идентичный лог рождений', () => {
    function run(): BornRow[] {
      const w = createSimWorld(42 as Seed);
      for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, 4);
      scheduler(Animals).run(w, BREEDING_TICK + 1);
      return bornRows(w);
    }
    const a = run();
    const b = run();
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('нет преждевременного рождения: до племенного тика приплода нет', () => {
    const w = createSimWorld(11 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, 4);
    scheduler(Animals).run(w, BREEDING_TICK); // РОВНО до племенного тика (не включая)
    expect(bornRows(w)).toHaveLength(0);
  });

  // Перескок reproCap при синхронных co-located стадах покрыт отдельным блоком
  // «ИСПРАВЛЕНО (D-037)» ниже (фикс инкремента переписи в цикле по стадам).
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОПУЛЯЦИЯ ЗА 10 ДНЕЙ
// ─────────────────────────────────────────────────────────────────────────────
describe('популяция за 10 дней: не взрывается и не вымирает (детерминизм)', () => {
  function tenDays(seed: number): { count: number; hpOk: boolean } {
    const w = createSimWorld(seed as Seed);
    const herd = 1;
    const initial = 5;
    const eids: EntityId[] = [];
    for (let i = 0; i < initial; i++) eids.push(placeAnimal(w, DEER, herd, 4));
    scheduler(NeedsSystem, Animals, Movement).run(w, 10 * TICKS_PER_DAY);
    const hpOk = eids.every((e) => (HP.hp[e] as number) > 0);
    return { count: animalCount(w), hpOk };
  }

  it('за 10 дней популяция в [initial, reproCap], никто не погиб от истощения', () => {
    const r = tenDays(100);
    expect(r.hpOk).toBe(true);
    expect(r.count).toBeGreaterThanOrEqual(5); // не вымерло
    expect(r.count).toBeLessThanOrEqual(getSpecies(DEER).reproCap); // не взорвалось
  });

  it('детерминизм: два прогона одного seed → одинаковая итоговая популяция', () => {
    expect(tenDays(100).count).toBe(tenDays(100).count);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUME (P0): размножение stateless — непрерывный ≡ split save/load
// ─────────────────────────────────────────────────────────────────────────────
describe('RESUME (P0, закон №8): непрерывный ≡ split save/load (размножение без таймера)', () => {
  const HERD = 1;
  const GEST = getSpecies(DEER).gestationTicks;
  const BREEDING_TICK = herdPhaseTick(HERD, GEST);
  const N = BREEDING_TICK + 2 * STEP; // прогон охватывает племенной тик

  /** Собирает мир: 2 оленя в loc5, 1 отставший в loc4 (стадность → миграция+транзит). */
  function build(seed: number): SimWorld {
    const w = createSimWorld(seed as Seed);
    placeAnimal(w, DEER, HERD, 5); // loc5 Бар: water true, forage 0.25 > порога
    placeAnimal(w, DEER, HERD, 5);
    placeAnimal(w, DEER, HERD, 4); // отставший (мигрирует к большинству в loc5)
    return w;
  }

  it('непрерывный прогон ≡ split на середине: хэш и лог animal/born тождественны', () => {
    // Непрерывный эталон — захватываем в примитивы/строку ДО split (общий eid).
    const cont = build(7 as Seed);
    scheduler(NeedsSystem, Animals, Movement).run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contBorn = bornRows(cont);
    expect(contBorn).toHaveLength(1); // рождение реально произошло в горизонте
    expect(contBorn[0]!.tick).toBe(BREEDING_TICK);

    const MID = 3000; // до племенного тика (рождение случится ПОСЛЕ load)
    expect(MID).toBeLessThan(BREEDING_TICK);
    const split = build(7 as Seed);
    scheduler(NeedsSystem, Animals, Movement).run(split, MID);
    const resumed = deserialize(serialize(split));
    expect(resumed.tick).toBe(MID);
    scheduler(NeedsSystem, Animals, Movement).run(resumed, N - MID);

    // Байтовое совпадение состояния (популяция + Needs + транзит + eventSeq).
    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    // И явно: лог рождений идентичен (без дубля/пропуска на границе load).
    expect(bornRows(resumed)).toEqual(contBorn);
  });

  it('split РОВНО на племенном тике не даёт дубля и не теряет рождение', () => {
    const cont = build(8 as Seed);
    scheduler(NeedsSystem, Animals, Movement).run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contBorn = bornRows(cont);
    expect(contBorn).toHaveLength(1);

    const split = build(8 as Seed);
    scheduler(NeedsSystem, Animals, Movement).run(split, BREEDING_TICK); // сплит РОВНО перед тиком
    const resumed = deserialize(serialize(split));
    // На момент сплита рождения ещё не было (произойдёт на племенном тике после load).
    expect(bornRows(resumed)).toHaveLength(0);
    scheduler(NeedsSystem, Animals, Movement).run(resumed, N - BREEDING_TICK);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(bornRows(resumed)).toEqual(contBorn);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// НИЖЕ — усиление гейта (QA 1.9): матрица «племенной тик × состояние»,
// поведенческое доказательство «не X%», кап популяции, вымирание, resume на
// разных фазах, детерминизм бегства и краевые случаи, транзит животного,
// живучесть новорождённого, несколько стад, пустое стадо, найденный дефект капа.
// ═════════════════════════════════════════════════════════════════════════════

/** Устанавливает абсолютный тик мира (для точечных прогонов по племенным тикам). */
function setTick(w: SimWorld, t: number): void {
  w.tick = t as Tick;
}

/** Плоские строки move/departed и move/arrived (для проверки транзита животного). */
function moveEvents(world: SimWorld) {
  const departed = world.bus.log.filter(
    (e): e is Extract<SimEvent, { type: 'move/departed' }> => e.type === 'move/departed',
  );
  const arrived = world.bus.log.filter(
    (e): e is Extract<SimEvent, { type: 'move/arrived' }> => e.type === 'move/arrived',
  );
  return { departed, arrived };
}

// ─────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ ПЛЕМЕННОГО ТИКА: чистая функция состояния (herd, gestation), не rng
// ─────────────────────────────────────────────────────────────────────────────
describe('племенной тик — детерминированная функция (herd, gestation), не случайность', () => {
  it('для МНОГИХ стад phase кратна шагу, лежит в [0,gestation) и ловит рождение', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    for (let herd = 1; herd <= 64; herd++) {
      const phase = herdPhaseTick(herd, GEST);
      expect(phase % STEP, `стадо ${herd}`).toBe(0);
      expect(phase, `стадо ${herd}`).toBeGreaterThanOrEqual(0);
      expect(phase, `стадо ${herd}`).toBeLessThan(GEST);
      // На фазе — племенной тик; ровно за один шаг до/после — нет (не каждый due-тик).
      expect(isBreedingTick(phase, herd, GEST), `стадо ${herd} на фазе`).toBe(true);
      expect(isBreedingTick(phase + STEP, herd, GEST), `стадо ${herd} phase+STEP`).toBe(false);
      expect(isBreedingTick(phase + GEST, herd, GEST), `стадо ${herd} +gestation`).toBe(true);
      // До фазы племенных тиков нет (tick < phase).
      if (phase >= STEP) expect(isBreedingTick(phase - STEP, herd, GEST)).toBe(false);
    }
  });

  it('herdPhaseTick — чистая функция: тот же (herd,gest) → тот же результат', () => {
    const GEST = getSpecies(BOAR).gestationTicks;
    for (let herd = 1; herd <= 10; herd++) {
      expect(herdPhaseTick(herd, GEST)).toBe(herdPhaseTick(herd, GEST));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// МАТРИЦА: рождение = ПЛЕМЕННОЙ ТИК И все пороги состояния (закон №2)
// ─────────────────────────────────────────────────────────────────────────────
describe('матрица «племенной тик × пороги состояния» (причинность, не «X% приплод»)', () => {
  const HERD = 1;
  const GEST = getSpecies(DEER).gestationTicks;
  const BREEDING_TICK = herdPhaseTick(HERD, GEST);
  const RICH = 4; // forage 0.7 > REPRO_FORAGE_MIN
  const CAP = getSpecies(DEER).reproCap;

  /** Прогоняет ОДИН due-тик Animals на абсолютном тике `atTick` над готовым миром. */
  function tickAt(w: SimWorld, atTick: number): void {
    const s = createScheduler();
    s.register(Animals);
    setTick(w, atTick);
    s.tickOnce(w);
  }

  it('НЕ племенной, но due-тик (tick 0) при ВСЕХ порогах → рождения НЕТ', () => {
    // tick 0 — due для Animals (every 30, phase 0), но НЕ племенной для стада.
    expect(isBreedingTick(0, HERD, GEST)).toBe(false);
    const w = createSimWorld(200 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, RICH);
    tickAt(w, 0);
    expect(bornRows(w)).toHaveLength(0); // условия выполнены, но тик не племенной
    expect(animalCount(w)).toBe(3);
  });

  it('племенной тик + (size<cap, forage>thr, herd>=min) → РОВНО одно рождение', () => {
    const w = createSimWorld(201 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, RICH);
    tickAt(w, BREEDING_TICK);
    expect(bornRows(w)).toHaveLength(1);
    expect(animalCount(w)).toBe(4);
  });

  it('племенной тик, НО size>=cap → рождения НЕТ (локальный потолок вида)', () => {
    const w = createSimWorld(202 as Seed);
    for (let i = 0; i < CAP; i++) placeAnimal(w, DEER, HERD, RICH);
    tickAt(w, BREEDING_TICK);
    expect(bornRows(w)).toHaveLength(0);
    expect(animalCount(w)).toBe(CAP);
  });

  it('племенной тик, НО forage<=thr → рождения НЕТ (голодная земля)', () => {
    const POOR = 9; // Саркофаг forage 0.05 <= REPRO_FORAGE_MIN
    expect(getLocation(POOR as LocationId).forage).toBeLessThanOrEqual(REPRO_FORAGE_MIN);
    const w = createSimWorld(203 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, POOR);
    tickAt(w, BREEDING_TICK);
    expect(bornRows(w)).toHaveLength(0);
  });

  it('племенной тик, НО herdHere<min → рождения НЕТ (нет пары родителей, закон №3)', () => {
    const w = createSimWorld(204 as Seed);
    placeAnimal(w, DEER, HERD, RICH); // одиночка (< REPRO_MIN_HERD_IN_LOC)
    tickAt(w, BREEDING_TICK);
    expect(bornRows(w)).toHaveLength(0);
    expect(animalCount(w)).toBe(1);
  });

  it('большое стадо (8 особей) на племенном тике → всё равно РОВНО одно рождение', () => {
    const w = createSimWorld(205 as Seed);
    for (let i = 0; i < 8; i++) placeAnimal(w, DEER, HERD, RICH);
    tickAt(w, BREEDING_TICK);
    expect(bornRows(w)).toHaveLength(1); // не «по рождению на пару», а одно на стадо
    expect(animalCount(w)).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НЕ «X% ШАНС»: рождение НЕ зависит от seed (rng к факту рождения не причастен)
// ─────────────────────────────────────────────────────────────────────────────
describe('рождение НЕ зависит от seed → rng не участвует в факте приплода (закон №2)', () => {
  const HERD = 1;
  const GEST = getSpecies(DEER).gestationTicks;
  const BREEDING_TICK = herdPhaseTick(HERD, GEST);

  function runWithSeed(seed: number): BornRow[] {
    const w = createSimWorld(seed as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, 4);
    const s = createScheduler();
    s.register(Animals);
    setTick(w, BREEDING_TICK);
    s.tickOnce(w);
    return bornRows(w);
  }

  it('РАЗНЫЕ seed, одно состояние → идентичный лог рождений (не бросок кости)', () => {
    const a = runWithSeed(1);
    const b = runWithSeed(424242);
    const c = runWithSeed(999999999);
    expect(a).toHaveLength(1);
    expect(b).toEqual(a); // seed не влияет — значит rng не решает факт рождения
    expect(c).toEqual(a);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// КАП ПОПУЛЯЦИИ: много племенных циклов при обильном корме → стабилизация на cap
// ─────────────────────────────────────────────────────────────────────────────
describe('кап популяции: стадо не растёт бесконечно, стабилизируется на reproCap', () => {
  it('одиночное стадо через МНОГО племенных циклов упирается в reproCap и стоит на нём', () => {
    // Размножение stateless ⇒ прыгаем прямо по племенным тикам (без Needs, без
    // смертей): это и быстрее, и заодно доказывает независимость от промежуточных
    // тиков. Обилие корма (loc4) снимает голод из уравнения — растёт только приплод.
    const HERD = 1;
    const GEST = getSpecies(DEER).gestationTicks;
    const CAP = getSpecies(DEER).reproCap;
    const BREEDING_TICK = herdPhaseTick(HERD, GEST);

    const w = createSimWorld(300 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, 4);
    const s = createScheduler();
    s.register(Animals);

    let maxSeen = 3;
    // Прогоняем заведомо больше циклов, чем нужно на рост 3→cap (17 рождений).
    for (let cycle = 0; cycle < CAP + 5; cycle++) {
      setTick(w, BREEDING_TICK + cycle * GEST);
      s.tickOnce(w);
      const n = animalCount(w);
      maxSeen = Math.max(maxSeen, n);
      // ИНВАРИАНТ: одиночное стадо НИКОГДА не перескакивает cap.
      expect(n, `цикл ${cycle}`).toBeLessThanOrEqual(CAP);
    }
    // Реально дорос до потолка (а не застрял) и остановился РОВНО на cap.
    expect(maxSeen).toBe(CAP);
    expect(animalCount(w)).toBe(CAP);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ИСПРАВЛЕНО (D-037, найдено QA): два co-located стада ОДНОГО вида с общей фазой на
// ОБЩЕМ племенном тике больше НЕ перескакивают reproCap. Перепись speciesLoc
// ИНКРЕМЕНТИТСЯ после каждого рождения в цикле по стадам, поэтому следующее (по
// отсортированному herd) стадо того же вида в той же локации видит обновлённый счёт.
// Стада 2 и 1218 у оленя делят фазу 6780 (Knuth-хеш; phase не инъективна). Бывший
// `it.fails` (желаемый инвариант) переведён в обычный ЗЕЛЁНЫЙ регресс; характеризующий
// пин cap+1 инвертирован в «ровно одно рождение, популяция == cap».
// ─────────────────────────────────────────────────────────────────────────────
describe('ИСПРАВЛЕНО (D-037): синхронные co-located стада одного вида НЕ перескакивают reproCap', () => {
  it('популяция вида в локации НЕ превышает reproCap при общей фазе двух стад', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    const CAP = getSpecies(DEER).reproCap;
    const HERD_A = 2;
    const HERD_B = 1218;
    // Общая фаза ⇒ оба стада претендуют на приплод на одном племенном тике.
    const PHASE = herdPhaseTick(HERD_A, GEST);
    expect(herdPhaseTick(HERD_B, GEST)).toBe(PHASE);

    const w = createSimWorld(301 as Seed);
    const loc = 4; // forage 0.7 > порога
    // Ровно cap-1 = 19 особей вида в локации: 10 в стаде A, 9 в стаде B.
    for (let i = 0; i < 10; i++) placeAnimal(w, DEER, HERD_A, loc);
    for (let i = 0; i < CAP - 1 - 10; i++) placeAnimal(w, DEER, HERD_B, loc);
    expect(animalCount(w)).toBe(CAP - 1);

    const s = createScheduler();
    s.register(Animals);
    setTick(w, PHASE);
    s.tickOnce(w);

    // Инвариант держится: локальная популяция вида <= reproCap (перескока нет).
    expect(animalCount(w)).toBeLessThanOrEqual(CAP);
  });

  it('при cap-1 и двух синхронных стадах рождается РОВНО одно (второе видит cap → скип)', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    const CAP = getSpecies(DEER).reproCap;
    const PHASE = herdPhaseTick(2, GEST);
    const w = createSimWorld(302 as Seed);
    const loc = 4;
    for (let i = 0; i < 10; i++) placeAnimal(w, DEER, 2, loc);
    for (let i = 0; i < CAP - 1 - 10; i++) placeAnimal(w, DEER, 1218, loc);
    const s = createScheduler();
    s.register(Animals);
    setTick(w, PHASE);
    s.tickOnce(w);
    // РОВНО одно рождение (первое стадо по сорт. herd родило, второе увидело cap).
    expect(bornRows(w)).toHaveLength(1);
    expect(animalCount(w)).toBe(CAP); // 19 + 1 = 20 == cap (НЕ cap+1)
    // Детерминизм выбора «кто родил»: стада обходятся по возрастанию herd (2 < 1218),
    // поэтому родило стадо 2 — стабильно между прогонами.
    expect(bornRows(w)[0]!.herd).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ВЫМИРАНИЕ: без корма/воды стадо копит нужды (Needs 1.5) и гибнет (hp<=0)
// ─────────────────────────────────────────────────────────────────────────────
describe('вымирание в мёртвой зоне vs выживание в угодье (мортальность реальна)', () => {
  it('без пастьбы/воды (Саркофаг) стадо тает: Needs копит → hp падает <= 0', () => {
    const w = createSimWorld(400 as Seed);
    const deadZone = 9; // forage 0.05, water false
    const eids: EntityId[] = [];
    for (let i = 0; i < 3; i++) eids.push(placeAnimal(w, DEER, 1, deadZone));
    // 3 суток: жажда (нет воды) + голод (корма нет) добивают hp за порогом истощения.
    scheduler(NeedsSystem, Animals).run(w, 3 * TICKS_PER_DAY);
    for (const e of eids) {
      expect(HP.hp[e]!, `hp животного ${e} в мёртвой зоне`).toBeLessThanOrEqual(0);
    }
    // Смерти НЕ по «X% гибели»: нужды упёрлись в потолок (эмерджентная гибель).
    expect(NEED.thirst[eids[0]!]!).toBeGreaterThanOrEqual(THIRST_CRITICAL);
  });

  it('те же 3 суток в кормном+водном угодье (loc4) → hp полное (контраст)', () => {
    const w = createSimWorld(401 as Seed);
    const eids: EntityId[] = [];
    for (let i = 0; i < 3; i++) eids.push(placeAnimal(w, DEER, 1, 4));
    scheduler(NeedsSystem, Animals).run(w, 3 * TICKS_PER_DAY);
    for (const e of eids) {
      expect(HP.hp[e]!, `hp животного ${e} в угодье`).toBe(HEALTH_MAX);
      expect(NEED.thirst[e]!).toBeLessThan(THIRST_CRITICAL);
      expect(NEED.hunger[e]!).toBeLessThan(HUNGER_CRITICAL);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// БЕГСТВО: детерминизм направления + краевые случаи (тупик, «окружён»)
// ─────────────────────────────────────────────────────────────────────────────
describe('бегство — детерминизм направления и краевые случаи', () => {
  it('из ТУПИКА Саркофаг (единственный сосед) бежит в этого соседа', () => {
    const w = createSimWorld(500 as Seed);
    const deadEnd = 9; // сосед только один — loc8
    const nb = neighbors(deadEnd as LocationId);
    expect(nb).toHaveLength(1);
    const deer = placeAnimal(w, DEER, 1, deadEnd);
    const human = placeHuman(w, deadEnd);
    w.resources.set<readonly EntityId[]>('contacts', deer, [human]);
    scheduler(Animals).run(w, 1);
    expect(POS.dest[deer]).toBe(nb[0]); // ушёл в единственного соседа (loc8)
    expect(moveEvents(w).departed).toHaveLength(1);
  });

  it('олень «окружён» людьми во всех соседях → не паникует/не застревает, идёт в min-danger соседа', () => {
    const w = createSimWorld(501 as Seed);
    const loc = 1; // соседи 0(.05),2(.3),3(.45)
    const deer = placeAnimal(w, DEER, 1, loc);
    // Человек co-located (угроза в contacts оленя) + люди во ВСЕХ соседях.
    const here = placeHuman(w, loc);
    for (const nb of neighbors(loc as LocationId)) placeHuman(w, nb);
    w.resources.set<readonly EntityId[]>('contacts', deer, [here]);
    // Бегство детерминировано СТАТИЧЕСКИМ danger соседа (не наличием там людей):
    // min danger сосед loc1 — это loc0 (0.05). Система не должна зависнуть.
    expect(() => scheduler(Animals).run(w, 1)).not.toThrow();
    expect(POS.dest[deer]).toBe(0); // ушёл в наименее опасного соседа, а не застыл
    expect(POS.dest[deer]).not.toBe(loc);
  });

  it('бегство ПРИОРИТЕТНЕЕ стадности: отставший олень с угрозой бежит от людей, не к стаду', () => {
    const w = createSimWorld(502 as Seed);
    // Стадо-большинство в loc2, отставший — в loc1 (его бы тянуло к loc2).
    placeAnimal(w, DEER, 1, 2);
    placeAnimal(w, DEER, 1, 2);
    const straggler = placeAnimal(w, DEER, 1, 1);
    const human = placeHuman(w, 1);
    w.resources.set<readonly EntityId[]>('contacts', straggler, [human]);
    scheduler(Animals).run(w, 1);
    // Если бы победила стадность — шаг к loc2; победило бегство — в min-danger loc0.
    expect(POS.dest[straggler]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// СТАДНОСТЬ: отставший стягивается к большинству (первый шаг Дейкстры)
// ─────────────────────────────────────────────────────────────────────────────
describe('стадность: отставший departure-ит к мажоритарной локации стада', () => {
  it('1 отставший в loc4 при большинстве в loc5 → шаг к loc5; большинство стоит', () => {
    const w = createSimWorld(510 as Seed);
    const a = placeAnimal(w, DEER, 1, 5, { hunger: 40 });
    const b = placeAnimal(w, DEER, 1, 5, { hunger: 40 });
    const straggler = placeAnimal(w, DEER, 1, 4);
    scheduler(Animals).run(w, 1);
    // Отставший ушёл первым шагом к большинству (edge 4-5 прямой → шаг = 5).
    expect(POS.dest[straggler]).toBe(5);
    const { departed } = moveEvents(w);
    expect(departed.map((e) => e.payload.eid)).toContain(straggler);
    // move/departed животного — корень причинной цепочки (экологический драйв).
    expect(departed.find((e) => e.payload.eid === straggler)!.causedBy).toBeNull();
    // Большинство осталось на месте и пасётся (dest==loc, голод упал).
    expect(POS.dest[a]).toBe(5);
    expect(POS.dest[b]).toBe(5);
    expect(NEED.hunger[a]!).toBeLessThan(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ТРАНЗИТ ЖИВОТНОГО: Animals ставит departure, Movement довозит, цепочка причин
// ─────────────────────────────────────────────────────────────────────────────
describe('движение животного: Animals(departure) + Movement(транзит) → прибытие без телепорта', () => {
  it('олень бежит из loc1: departed→arrived, loc меняется ТОЛЬКО по ребру, arrived.causedBy=departed', () => {
    const w = createSimWorld(520 as Seed);
    const from = 1;
    const deer = placeAnimal(w, DEER, 1, from);
    const human = placeHuman(w, from);
    w.resources.set<readonly EntityId[]>('contacts', deer, [human]);

    // Animals делает departure (tick 0), Movement везёт транзит до прибытия.
    // edgeLen(1,0)=40 ⇒ прибытие на tick 39; 45 тиков с запасом, до 2-го хопа (tick60) не дойдём.
    scheduler(Animals, Movement).run(w, 45);

    const { departed, arrived } = moveEvents(w);
    expect(departed).toHaveLength(1);
    expect(arrived).toHaveLength(1);
    const dep = departed[0]!;
    const arr = arrived[0]!;
    expect(dep.payload.eid).toBe(deer);
    expect(dep.payload.from).toBe(from);
    const to = dep.payload.to;
    expect(to).toBe(0); // наименее опасный сосед loc1

    // НЕТ ТЕЛЕПОРТА: прибытие — в СОСЕДА (ребро существует), позиция обновилась туда.
    expect(edgeLen(from as LocationId, to)).not.toBeUndefined();
    expect(arr.payload.at).toBe(to);
    expect(POS.loc[deer]).toBe(to);
    expect(POS.dest[deer]).toBe(to); // прибыл ⇒ снова «стоит»

    // ПРИЧИННОСТЬ (D-030): arrived.causedBy = id departed этого шага (moveCause).
    expect(arr.causedBy).toBe(dep.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НОВОРОЖДЁННЫЙ: реально живой участник — пасётся на СЛЕДУЮЩЕМ тике
// ─────────────────────────────────────────────────────────────────────────────
describe('новорождённый — живой участник симуляции (D-027), пасётся на следующем тике', () => {
  it('после рождения детёныш на след. Animals-тике пасётся (hunger падает от старта)', () => {
    const HERD = 1;
    const GEST = getSpecies(DEER).gestationTicks;
    const BREEDING_TICK = herdPhaseTick(HERD, GEST);
    const w = createSimWorld(600 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, HERD, 4);

    const s = createScheduler();
    s.register(Animals);
    // Племенной тик → рождение.
    setTick(w, BREEDING_TICK);
    s.tickOnce(w);
    const born = bornRows(w);
    expect(born).toHaveLength(1);
    const baby = born[0]!.eid;
    // Стартовые нужды детёныша — РОВНО заданный уровень (ниже критич., D-027).
    expect(NEED.hunger[baby]).toBe(ANIMAL_NEWBORN_NEED);
    expect(NEED.hunger[baby]!).toBeLessThan(HUNGER_CRITICAL);
    expect(hasComponent(w.ecs, Alive, baby)).toBe(true);

    // СЛЕДУЮЩИЙ due-тик Animals (не племенной): детёныш пасётся → голод падает.
    setTick(w, BREEDING_TICK + STEP);
    expect(isBreedingTick(BREEDING_TICK + STEP, HERD, GEST)).toBe(false);
    s.tickOnce(w);
    expect(NEED.hunger[baby]!).toBeLessThan(ANIMAL_NEWBORN_NEED); // реально живёт и ест
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НЕСКОЛЬКО СТАД: независимые племенные тики, по одному рождению на стадо
// ─────────────────────────────────────────────────────────────────────────────
describe('несколько стад одновременно: независимые фазы, одно рождение на стадо на тик', () => {
  it('стада 1 и 2 плодятся на СВОИХ тиках; каждое — ровно одно рождение в своей локации', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    const PHASE1 = herdPhaseTick(1, GEST); // 7230
    const PHASE2 = herdPhaseTick(2, GEST); // 6780
    expect(PHASE1).not.toBe(PHASE2); // фазы РАЗНЫЕ (Knuth-хеш рассеивает)

    const w = createSimWorld(700 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, 1, 4); // стадо 1 в loc4
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, 2, 2); // стадо 2 в loc2 (forage 0.6)

    // Прогон охватывает ОБА племенных тика (6780 и 7230).
    const upper = Math.max(PHASE1, PHASE2) + 1;
    scheduler(Animals).run(w, upper);

    const born = bornRows(w);
    expect(born).toHaveLength(2); // по одному на стадо
    const byHerd = new Map(born.map((r) => [r.herd, r]));
    // Стадо 2 родило РАНЬШЕ (его фаза меньше), в своей локации loc2.
    expect(byHerd.get(2)!.tick).toBe(PHASE2);
    expect(byHerd.get(2)!.loc).toBe(2);
    // Стадо 1 — на своём тике, в loc4.
    expect(byHerd.get(1)!.tick).toBe(PHASE1);
    expect(byHerd.get(1)!.loc).toBe(4);
  });

  it('на тике стада 2 (раньше) стадо 1 ещё НЕ плодится (фазы независимы)', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    const PHASE2 = herdPhaseTick(2, GEST);
    const w = createSimWorld(701 as Seed);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, 1, 4);
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, 2, 2);
    const s = createScheduler();
    s.register(Animals);
    setTick(w, PHASE2);
    s.tickOnce(w);
    const born = bornRows(w);
    expect(born).toHaveLength(1); // ТОЛЬКО стадо 2
    expect(born[0]!.herd).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПУСТОЕ СТАДО: все умерли → нет родителей → нет рождения (закон №3)
// ─────────────────────────────────────────────────────────────────────────────
describe('пустое стадо (все особи мертвы) → рождения НЕТ (нет родителей, закон №3)', () => {
  it('вымершее стадо не рожает на своём племенном тике (нет в переписи живых)', () => {
    const GEST = getSpecies(DEER).gestationTicks;
    const PHASE_DEAD = herdPhaseTick(1, GEST); // 7230
    const PHASE_ALIVE = herdPhaseTick(3, GEST); // 14010 — позже, в окно не попадёт

    const w = createSimWorld(800 as Seed);
    const doomed: EntityId[] = [];
    for (let i = 0; i < 3; i++) doomed.push(placeAnimal(w, DEER, 1, 4));
    // Второе стадо — живой «свидетель», чтобы система работала, но НЕ плодилась в окне.
    for (let i = 0; i < 3; i++) placeAnimal(w, DEER, 3, 2);
    expect(PHASE_ALIVE).toBeGreaterThan(PHASE_DEAD);

    // Истребляем стадо 1 ДО его племенного тика (единый путь удаления, C-6).
    for (const e of doomed) destroyEntity(w, e);

    scheduler(Animals).run(w, PHASE_DEAD + 1); // проходим тик 7230
    // Ни одного рождения: стадо 1 вымерло (нет родителей), стадо 3 ещё не в фазе.
    expect(bornRows(w)).toHaveLength(0);
    // В мире живо ровно стадо 3 (3 особи) — приплода из воздуха не возникло.
    expect(animalCount(w)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUME на РАЗНЫХ ФАЗАХ (P0): split за тик до, РОВНО на, за тик после + двойной
// ─────────────────────────────────────────────────────────────────────────────
describe('RESUME на разных фазах границы: split ≡ непрерывный по популяции И логу born', () => {
  const HERD = 1;
  const GEST = getSpecies(DEER).gestationTicks;
  const BREEDING_TICK = herdPhaseTick(HERD, GEST);
  const N = BREEDING_TICK + 2 * STEP;

  function build(seed: number): SimWorld {
    const w = createSimWorld(seed as Seed);
    placeAnimal(w, DEER, HERD, 5);
    placeAnimal(w, DEER, HERD, 5);
    placeAnimal(w, DEER, HERD, 4); // отставший → миграция+транзит на границе
    return w;
  }

  /** Эталон непрерывного прогона: хэш и лог born, захваченные в примитивы. */
  function reference(seed: number): { hash: string; born: BornRow[] } {
    const cont = build(seed);
    scheduler(NeedsSystem, Animals, Movement).run(cont, N);
    return { hash: hashSnapshot(serialize(cont)), born: bornRows(cont) };
  }

  /** Прогон со split в `splitAt`: save/load, затем дотягиваем до N. */
  function resumed(seed: number, splitAt: number): SimWorld {
    const w = build(seed);
    scheduler(NeedsSystem, Animals, Movement).run(w, splitAt);
    const r = deserialize(serialize(w));
    expect(r.tick).toBe(splitAt);
    scheduler(NeedsSystem, Animals, Movement).run(r, N - splitAt);
    return r;
  }

  it('split ЗА ШАГ ДО племенного тика ≡ непрерывный', () => {
    const ref = reference(11);
    expect(ref.born).toHaveLength(1);
    const r = resumed(11, BREEDING_TICK - STEP);
    expect(hashSnapshot(serialize(r))).toBe(ref.hash);
    expect(bornRows(r)).toEqual(ref.born);
  });

  it('split ЗА ШАГ ПОСЛЕ племенного тика (рождение уже в логе) ≡ непрерывный, без дубля', () => {
    const ref = reference(12);
    const splitAt = BREEDING_TICK + STEP;
    const w = build(12);
    scheduler(NeedsSystem, Animals, Movement).run(w, splitAt);
    // На момент save рождение УЖЕ произошло — оно обязано быть в снапшоте лога.
    expect(bornRows(w)).toHaveLength(1);
    const r = deserialize(serialize(w));
    expect(bornRows(r)).toHaveLength(1); // лог пережил load — не потерян и не задвоен
    scheduler(NeedsSystem, Animals, Movement).run(r, N - splitAt);
    expect(hashSnapshot(serialize(r))).toBe(ref.hash);
    expect(bornRows(r)).toEqual(ref.born); // по-прежнему ровно одно рождение
  });

  it('ДВОЙНОЙ save/load вокруг племенного тика ≡ непрерывный (граница выдерживает повтор)', () => {
    const ref = reference(13);
    const w = build(13);
    // save/load #1 — до тика.
    scheduler(NeedsSystem, Animals, Movement).run(w, BREEDING_TICK - STEP);
    const r1 = deserialize(serialize(w));
    // save/load #2 — сразу после тика (рождение случилось между загрузками).
    scheduler(NeedsSystem, Animals, Movement).run(r1, 2 * STEP);
    const r2 = deserialize(serialize(r1));
    scheduler(NeedsSystem, Animals, Movement).run(r2, N - (BREEDING_TICK + STEP));
    expect(hashSnapshot(serialize(r2))).toBe(ref.hash);
    expect(bornRows(r2)).toEqual(ref.born);
  });
});
