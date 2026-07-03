/**
 * @module @zona/sim/core/determinism.test
 *
 * ИНТЕГРАЦИОННЫЙ ГЕЙТ ДЕТЕРМИНИЗМА (задача 0.7, закрывает Фазу 0).
 *
 * Юнит-гейты 0.2–0.5 уже доказали детерминизм КАЖДОГО кирпича по отдельности
 * (планировщик, PRNG, шина, сериализация). Этот файл доказывает то же на УРОВНЕ
 * СОБРАННОГО ЯДРА: набор реальных «живущих» систем прогоняется планировщиком, и
 * проверяется, что одинаковый seed рождает побитово одинаковую историю (закон
 * №8), а разный seed — другую. Без такого гейта фаза «зелёная» по частям, но
 * недоказанная как целое.
 *
 * ── Почему фейк-системы, а не пустой прогон ─────────────────────────────────
 * CLI Фазы 0 гоняет ПУСТЫЕ тики (systems ещё нет), поэтому его лог пуст и гейт
 * на нём был бы бессмысленным («детерминированно ничего не произошло»). Здесь мы
 * подсовываем планировщику 4 фейк-системы разной частоты/фазы, которые РЕАЛЬНО
 * порождают историю: рождают и хоронят сущностей (freelist задействован), пишут
 * ресурсы (имена/числа), публикуют события с `causedBy` (в т.ч. цепочки), тянут
 * `ctx.rng` (физиология). Системы детерминированы: единственные входы — состояние
 * мира и seeded PRNG, никакого `Date.now`/`Math.random` (закон №8, №2).
 *
 * Это ФИКСТУРЫ теста, а не продакшн-симуляция: их задача — нагрузить все каналы
 * недетерминизма (спавн/удаление eid, форки rng по тикам, причинные цепочки на
 * шине, сериализация живого мира), чтобы гейт ловил регресс детерминизма ядра.
 *
 * Покрытие:
 *  - ТЕСТ A  — воспроизводимость: seed=42 дважды → идентичный лог и хэш; лог не
 *              пуст; сущности спавнились и умирали (reuse eid); цепочки causedBy
 *              полные (каждая причина существует, обрыв в null, без циклов).
 *  - ТЕСТ B  — чувствительность к seed: seed=43 отличается от seed=42.
 *  - ТЕСТ C  — resume: 1000 тиков непрерывно === 500 + save/load + 500 (хэш+лог).
 *  - ТЕСТ D  — порядок регистрации: независимые системы коммутируют (одинаковый
 *              хэш при перестановке), а системы, делящие шину, — нет (порядок
 *              регистрации есть детерминированный tie-break, закон №8/D-006).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, JsonValue, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from './world';
import { destroyEntity } from './world';
import { spawnEntity, allEntities } from './ecs';
import { createScheduler, type Scheduler } from './scheduler';
import type { System, SystemCtx } from './system';
import { serialize, deserialize, hashSnapshot } from './snapshot';

// ─────────────────────────────────────────────────────────────────────────────
// Балансовые константы ФИКСТУР (не продакшн-баланс; живут здесь ради читаемости).
// Подобраны так, чтобы за 1000 тиков популяция дошла до потолка и держалась
// у него через постоянные смерти/рождения → freelist eid реально гоняется.
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL_POP = 5; // сколько поселенцев живёт до первого тика
const POP_CAP = 12; // потолок популяции (выше — не рождаем)
const POP_FLOOR = 3; // ниже — не убиваем (мир не должен вымереть)
const DEATH_PRESSURE = 0.5; // множитель смертности от тесноты (физиология)
const RUN_TICKS = 1000; // горизонт гейта

/** Полные имена поселенцев (закон №4: у NPC есть имя-фамилия, даже в фикстуре). */
const NAMES: readonly string[] = [
  'Аркадий Стрелок',
  'Борис Меченый',
  'Виктор Хмурый',
  'Глеб Кабан',
  'Демьян Тихий',
  'Ефим Сыч',
  'Захар Леший',
  'Игнат Болотный',
];

/** Ключи ресурсов, которые пишут фикстуры. */
const R_NAME = 'name';
const R_BORN = 'born';
const R_VITALITY = 'vitality';
const R_MUTATIONS = 'mutations';

// ─────────────────────────────────────────────────────────────────────────────
// Фикстуры-системы: РАЗНАЯ частота/фаза, реально меняют мир и пишут историю.
// Каждая детерминирована — читает состояние мира и свой `ctx.rng`, и всё.
// ─────────────────────────────────────────────────────────────────────────────

/** Живые поселенцы, отсортированы по eid (детерминизм обхода, закон №8). */
function settlers(w: SimWorld): readonly EntityId[] {
  return allEntities(w.ecs);
}

/**
 * `census` (every 5) — «сердцебиение» летописи: раз в 5 тиков публикует КОРНЕВОЕ
 * событие цепочки (`causedBy: null`) с текущей популяцией. Служит якорем, к
 * которому потом цепляются реактивные системы прошлого тика.
 */
const census: System = {
  name: 'census',
  schedule: { every: 5 },
  update(ctx: SystemCtx): void {
    // Корень причинной цепочки тика: сердцебиение летописи (causedBy: null).
    ctx.bus.publish({
      type: 'sim/tickStarted',
      causedBy: null,
      payload: { tick: ctx.tick },
    });
  },
};

/**
 * `birth` (every 3) — рождение. Давление рождения падает с ростом популяции
 * (причинность от состояния), rng — только физиология (кого назвать, с какой
 * живучестью). Публикует ДВУХЗВЕННУЮ цепочку в одном тике: корень `tickStarted`
 * и следствие `snapshotTaken (causedBy: корень)` — гарантированный ненулевой
 * causedBy.
 */
const birth: System = {
  name: 'birth',
  schedule: { every: 3 },
  update(ctx: SystemCtx): void {
    const pop = settlers(ctx.world).length;
    if (pop >= POP_CAP) return;
    // Давление рождения = свободная ёмкость / потолок; чем теснее — тем реже.
    const room = (POP_CAP - pop) / POP_CAP;
    if (ctx.rng.next() >= room) return;

    const e = spawnEntity(ctx.world.ecs);
    ctx.world.resources.set(R_NAME, e, ctx.rng.pick(NAMES));
    ctx.world.resources.set(R_BORN, e, ctx.tick);
    ctx.world.resources.set(R_VITALITY, e, ctx.rng.int(30, 100));

    const root = ctx.bus.publish({
      type: 'sim/tickStarted',
      causedBy: null,
      payload: { tick: ctx.tick },
    });
    ctx.bus.publish({
      type: 'sim/snapshotTaken',
      causedBy: root,
      payload: { hash: `born:${String(e)}` },
    });
  },
};

/**
 * `death` (every 7, phase 2) — смертность. Хоронит СТАРЕЙШЕГО (min `born`, при
 * равенстве меньший eid) когда мир не на грани вымирания; давление растёт с
 * теснотой. `destroyEntity` освобождает eid → freelist, который потом
 * переиспользует `birth` (доказательство reuse — в ТЕСТЕ A).
 */
const death: System = {
  name: 'death',
  schedule: { every: 7, phase: 2 },
  update(ctx: SystemCtx): void {
    const alive = settlers(ctx.world);
    if (alive.length <= POP_FLOOR) return;
    const crowd = alive.length / POP_CAP;
    if (ctx.rng.next() >= crowd * DEATH_PRESSURE) return;

    // Старейший: минимальный born, tie-break — меньший eid (alive уже по eid).
    let victim = alive[0] as EntityId;
    let oldest = ctx.world.resources.get<number>(R_BORN, victim) ?? 0;
    for (const eid of alive) {
      const born = ctx.world.resources.get<number>(R_BORN, eid) ?? 0;
      if (born < oldest) {
        oldest = born;
        victim = eid;
      }
    }
    destroyEntity(ctx.world, victim);

    const root = ctx.bus.publish({
      type: 'sim/tickStarted',
      causedBy: null,
      payload: { tick: ctx.tick },
    });
    ctx.bus.publish({
      type: 'sim/snapshotTaken',
      causedBy: root,
      payload: { hash: `death:${String(victim)}` },
    });
  },
};

/**
 * `mutation` (every 2, phase 1) — физиология + КРОСС-ТИКОВАЯ причинная цепочка.
 * Тычет случайного (по rng) живого поселенца, инкрементируя счётчик мутаций
 * (число из состояния, не из воздуха). Если на ПРОШЛОМ тике что-то произошло —
 * цепляет своё событие к первому событию прошлого тика (`causedBy` через границу
 * тика). Так рождаются цепочки длиной ≥ 3: mutation@t → birth-child@(t-1) →
 * birth-root@(t-1) → null.
 */
const mutation: System = {
  name: 'mutation',
  schedule: { every: 2, phase: 1 },
  update(ctx: SystemCtx): void {
    const alive = settlers(ctx.world);
    if (alive.length === 0) return;
    const target = alive[ctx.rng.int(0, alive.length)] as EntityId;
    const prev = ctx.world.resources.get<number>(R_MUTATIONS, target) ?? 0;
    ctx.world.resources.set(R_MUTATIONS, target, prev + 1);

    // Причина — ПОСЛЕДНЕЕ (максимальный id) событие прошлого тика. Оно часто
    // само является следствием (snapshotTaken causedBy root), поэтому цепочка
    // получает глубину >= 2: mutation@t → child@(t-1) → root@(t-1) → null.
    const yesterday = ctx.bus.at((ctx.tick - 1) as Tick);
    const cause: EventId | null =
      yesterday.length > 0 ? (yesterday[yesterday.length - 1] as SimEvent).id : null;
    ctx.bus.publish({
      type: 'sim/snapshotTaken',
      causedBy: cause,
      payload: { hash: `mut:${String(target)}:${String(prev + 1)}` },
    });
  },
};

/** Полный набор фикстур в каноничном порядке регистрации. */
function coreFixtures(): readonly System[] {
  return [census, birth, mutation, death];
}

/**
 * Заселяет свежий мир `INITIAL_POP` поселенцами ДО прогона. Детерминировано:
 * имена/живучесть берутся из выделенного форка `world.rng.fork('genesis')`, а не
 * из времени, поэтому два мира с одним seed заселяются одинаково. Возвращает мир.
 */
function genesis(seed: number): SimWorld {
  const w = createSimWorld(seed as Seed);
  const rng = w.rng.fork('genesis');
  for (let i = 0; i < INITIAL_POP; i++) {
    const e = spawnEntity(w.ecs);
    w.resources.set(R_NAME, e, rng.pick(NAMES));
    w.resources.set(R_BORN, e, 0 as Tick);
    w.resources.set(R_VITALITY, e, rng.int(30, 100));
  }
  return w;
}

/** Строит планировщик с набором систем в заданном порядке. */
function schedulerOf(systems: readonly System[]): Scheduler {
  const s = createScheduler();
  for (const sys of systems) s.register(sys);
  return s;
}

/** Прогоняет заселённый seed на `ticks` тиков полным набором фикстур. */
function runGate(seed: number, ticks: number): SimWorld {
  const w = genesis(seed);
  schedulerOf(coreFixtures()).run(w, ticks);
  return w;
}

/** Нормализует событие до сравниваемого кортежа (id, tick, type, causedBy, payload). */
function normalize(log: readonly SimEvent[]): ReadonlyArray<Record<string, unknown>> {
  return log.map((e) => ({
    id: e.id,
    tick: e.tick,
    type: e.type,
    causedBy: e.causedBy,
    payload: e.payload,
  }));
}

/** Число «рождений»/«смертей» в логе — по префиксу payload.hash событий snapshotTaken. */
function countByPrefix(log: readonly SimEvent[], prefix: string): number {
  let n = 0;
  for (const e of log) {
    if (e.type === 'sim/snapshotTaken' && e.payload.hash.startsWith(prefix)) n++;
  }
  return n;
}

/** Высшая точка аллокатора eid (сколько всего слотов роздано) из снапшота. */
function maxIdOf(w: SimWorld): number {
  const idx = serialize(w).ecsIndex as { maxId: number };
  return idx.maxId;
}

// ─────────────────────────────────────────────────────────────────────────────
// ТЕСТ A — воспроизводимость: один seed → одна история (закон №8).
// ─────────────────────────────────────────────────────────────────────────────
describe('ТЕСТ A: два мира с seed=42 проживают побитово одну жизнь', () => {
  const w1 = runGate(42, RUN_TICKS);
  const w2 = runGate(42, RUN_TICKS);

  it('лог событий идентичен по (id, tick, type, causedBy, payload)', () => {
    expect(normalize(w1.bus.log)).toEqual(normalize(w2.bus.log));
  });

  it('хэш снапшота идентичен: hash(w1) === hash(w2)', () => {
    expect(hashSnapshot(serialize(w1))).toBe(hashSnapshot(serialize(w2)));
  });

  it('гейт не холостой: история НЕ пуста (системы-эмиттеры реально отработали)', () => {
    expect(w1.bus.log.length).toBeGreaterThan(0);
    // Ждём тысячи событий за 1000 тиков — иначе фикстуры молчат и гейт бессмыслен.
    expect(w1.bus.log.length).toBeGreaterThan(500);
  });

  it('жизнь и смерть случились: были и рождения, и похороны (freelist задействован)', () => {
    const births = countByPrefix(w1.bus.log, 'born:');
    const deaths = countByPrefix(w1.bus.log, 'death:');
    expect(births).toBeGreaterThan(0);
    expect(deaths).toBeGreaterThan(0);

    // Reuse eid: всего роздано слотов (maxId) СТРОГО меньше, чем суммарно
    // создано сущностей (стартовые + все рождённые). Значит `birth` доставал
    // eid из freelist, освобождённого `death`, а не только наращивал maxId.
    const totalSpawned = INITIAL_POP + births;
    expect(maxIdOf(w1)).toBeLessThan(totalSpawned);
  });

  it('популяция осталась в живом коридоре [POP_FLOOR, POP_CAP] — мир не вымер и не взорвался', () => {
    const pop = settlers(w1).length;
    expect(pop).toBeGreaterThanOrEqual(POP_FLOOR);
    expect(pop).toBeLessThanOrEqual(POP_CAP);
  });

  it('монотонность EventId: лог строго возрастает по id (порядок = порядок публикаций)', () => {
    const log = w1.bus.log;
    for (let i = 1; i < log.length; i++) {
      expect((log[i] as SimEvent).id).toBeGreaterThan((log[i - 1] as SimEvent).id);
    }
  });

  it('цепочки причин ПОЛНЫЕ: каждая causedBy указывает на существующее событие, обрыв только в null, без циклов', () => {
    const log = w1.bus.log;
    const byId = new Map<EventId, SimEvent>();
    for (const e of log) byId.set(e.id, e);

    // Должны существовать НЕтривиальные цепочки (глубина >= 2), иначе causedBy
    // фиктивен. Заодно проверяем каждую цепочку на целостность.
    let deepChains = 0;
    for (const e of log) {
      let depth = 0;
      let cursor: SimEvent | undefined = e;
      const seen = new Set<EventId>();
      while (cursor && cursor.causedBy !== null) {
        // Причина обязана существовать в логе (никаких висячих ссылок из воздуха).
        expect(byId.has(cursor.causedBy)).toBe(true);
        // Причина обязана быть РАНЬШЕ следствия (монотонность причинности).
        expect(cursor.causedBy).toBeLessThan(cursor.id);
        // Никаких циклов: id по пути не повторяются.
        expect(seen.has(cursor.id)).toBe(false);
        seen.add(cursor.id);
        cursor = byId.get(cursor.causedBy);
        depth++;
      }
      if (depth >= 2) deepChains++;
    }
    expect(deepChains).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ТЕСТ B — чувствительность к seed: другой seed → другая физиология → другая
// история. Если бы seed не влиял, RNG был бы декоративным (нарушение №2/№8).
// ─────────────────────────────────────────────────────────────────────────────
describe('ТЕСТ B: seed=43 проживает ДРУГУЮ жизнь, чем seed=42', () => {
  const a = runGate(42, RUN_TICKS);
  const b = runGate(43, RUN_TICKS);

  it('хэш снапшота отличается (rng другой → другая физиология рождений/смертей)', () => {
    expect(hashSnapshot(serialize(a))).not.toBe(hashSnapshot(serialize(b)));
  });

  it('лог событий отличается (иная последовательность рождений/смертей/мутаций)', () => {
    expect(normalize(a.bus.log)).not.toEqual(normalize(b.bus.log));
  });

  it('но КАЖДЫЙ seed по-прежнему воспроизводим сам по себе (не хаос)', () => {
    expect(hashSnapshot(serialize(runGate(43, RUN_TICKS)))).toBe(
      hashSnapshot(serialize(b)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ТЕСТ C — resume в составе гейта: непрерывный прогон === прогон через save/load
// на длинном горизонте с теми же фикстурами (интеграция с 0.5b).
// ─────────────────────────────────────────────────────────────────────────────
describe('ТЕСТ C: 1000 тиков непрерывно === 500 + save/load + 500', () => {
  // Непрерывный эталон.
  const cont = runGate(42, RUN_TICKS);

  // Расщеплённый: 500 тиков → serialize → deserialize → ещё 500 НОВЫМ
  // планировщиком (тем же набором систем) на восстановленном мире.
  const half = genesis(42);
  schedulerOf(coreFixtures()).run(half, RUN_TICKS / 2);
  const resumed = deserialize(serialize(half));
  schedulerOf(coreFixtures()).run(resumed, RUN_TICKS / 2);

  it('хэш совпадает: сохранение и загрузка не сдвигают историю', () => {
    expect(hashSnapshot(serialize(resumed))).toBe(hashSnapshot(serialize(cont)));
  });

  it('лог событий совпадает по (id, tick, type, causedBy, payload)', () => {
    expect(normalize(resumed.bus.log)).toEqual(normalize(cont.bus.log));
  });

  it('resume прошёл именно по НАПОЛНЕННОЙ середине (не тривиальный пустой мир)', () => {
    // На середине уже есть накопленный лог и eid могли переиспользоваться —
    // значит resume проверяется на реальном, а не свежесозданном состоянии.
    expect(half.bus.log.length).toBeGreaterThan(0);
    expect(half.tick).toBe(RUN_TICKS / 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ТЕСТ D — порядок регистрации как ЕДИНСТВЕННЫЙ детерминированный tie-break
// (закон №8/D-006). Независимые системы коммутируют; делящие шину — нет.
// ─────────────────────────────────────────────────────────────────────────────
describe('ТЕСТ D: порядок регистрации детерминирован и осмыслен', () => {
  // Две НЕЗАВИСИМЫЕ системы: пишут в РАЗНЫЕ ресурсные ключи, событий не шлют,
  // сущностей не трогают — гонки между ними невозможны, эффект коммутативен.
  const alpha: System = {
    name: 'alpha',
    schedule: { every: 1 },
    update(ctx) {
      const e = allEntities(ctx.world.ecs)[0];
      if (e !== undefined) ctx.world.resources.set('alpha', e, ctx.tick);
    },
  };
  const beta: System = {
    name: 'beta',
    schedule: { every: 1 },
    update(ctx) {
      const e = allEntities(ctx.world.ecs)[0];
      if (e !== undefined) ctx.world.resources.set('beta', e, ctx.tick * 2);
    },
  };

  it('независимые системы КОММУТИРУЮТ: порядок регистрации не меняет хэш', () => {
    const wAB = genesis(42);
    schedulerOf([alpha, beta]).run(wAB, 100);
    const wBA = genesis(42);
    schedulerOf([beta, alpha]).run(wBA, 100);
    expect(hashSnapshot(serialize(wBA))).toBe(hashSnapshot(serialize(wAB)));
  });

  it('системы, делящие ШИНУ, — НЕ коммутируют: порядок задаёт нумерацию событий (и это стабильно)', () => {
    // birth и death обе публикуют события; их относительный порядок регистрации
    // определяет, кто получит меньший EventId в общий тик → лог различается.
    // Это НЕ баг: порядок регистрации — сознательный детерминированный tie-break
    // (D-006). Фиксируем, что он влияет И что каждый порядок воспроизводим.
    const fwd = genesis(42);
    schedulerOf([census, birth, mutation, death]).run(fwd, 300);
    const rev = genesis(42);
    schedulerOf([death, mutation, birth, census]).run(rev, 300);
    expect(normalize(rev.bus.log)).not.toEqual(normalize(fwd.bus.log));

    // ...и оба порядка сами по себе детерминированы (повтор даёт то же самое).
    const fwd2 = genesis(42);
    schedulerOf([census, birth, mutation, death]).run(fwd2, 300);
    expect(normalize(fwd2.bus.log)).toEqual(normalize(fwd.bus.log));
  });
});
