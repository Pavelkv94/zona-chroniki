/**
 * @module @zona/sim/phase1-gate.test
 *
 * ЗАКРЫВАЮЩИЙ ГЕЙТ ФАЗЫ 1 (задача 1.13; ретаргетирован на конвейер Фазы 2 в
 * 2.16a/D-064). Доказывает, что СОБРАННЫЙ живой мир (worldgen + все системы
 * канонического конвейера, тот же путь, что headless-CLI) выполняет
 * скорректированный DoD Фазы 1 (D-043):
 *
 *   0 idle · каждая смерть объяснима полной цепочкой causedBy до корня ·
 *   детерминизм (2× один seed) · resume (save/load ≡ непрерывный) ·
 *   инвариант порядка систем (D-032) · целостность прогона.
 *
 * Выживаемость людей и популяция животных — НЕ критерий pass/fail (D-043:
 * принятая высокая смертность — балансовая проблема Фазы 2). Здесь они лишь
 * измеряются для отчёта здоровья мира (docs/reports/phase1-gate.md).
 *
 * Тесты читаются как СЦЕНАРИИ жизни Зоны, а не как проверки полей: «за 10 дней
 * ни один сталкер не завис без дела», «каждая смерть прослеживается до корня»,
 * «мясо берётся только с туш, патроны только тратятся».
 *
 * ── Почему в @zona/sim, а не в headless ──────────────────────────────────────
 * Инварианты мира (0 idle, отсутствие телепортов, целостность инвентаря) требуют
 * ЗАГЛЯНУТЬ ВНУТРЬ ECS-состояния (queryEntities/hasComponent, компоненты
 * Human/Alive/Task/Needs), а эти обёртки — внутренние для пакета (index.ts их не
 * реэкспортирует). Поэтому гейт живёт внутри @zona/sim. Путь сборки мира —
 * ТОЧНО тот же, что в headless CLI (createSimWorld → worldgen →
 * registerPhase2Systems → scheduler.run), поэтому гейт стоит на настоящем
 * конвейере (Фаза 2, 17 систем, D-064), а не на фикстуре.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from './core/world';
import { worldgen } from './worldgen';
import { createScheduler, type Scheduler } from './core/scheduler';
import { registerPhase2Systems, PHASE2_SYSTEMS } from './pipeline';
import { serialize, deserialize, hashSnapshot } from './core/snapshot';
import { queryEntities, hasComponent, allEntities } from './core/ecs';
import { Human, Alive, Animal, Task, Needs, Position } from './core/components';
import { TICKS_PER_DAY } from './balance/time';
import { edgeLen, SPECIES, getSettlements } from './data/index';
import { STALKER_COUNT, BANDIT_COUNT, SETTLEMENT_RESIDENTS } from './balance/worldgen';

/**
 * Стартовое число живых людей мира (задача 2.16b, D-065):
 *   • 20 сталкеров-одиночек (Кордон);
 *   • BANDIT_COUNT бандитов в логове (фракция bandits predatory ⇒ ROB);
 *   • на КАЖДОЕ поселение: 1 торговец (2.2, D-051) + SETTLEMENT_RESIDENTS резидентов.
 * Все — Human+Alive, поэтому все входят в старт-население гейта. Поля/поселения — НЕ
 * Human (в счётчик не входят).
 */
const HUMANS_AT_START =
  STALKER_COUNT + BANDIT_COUNT + getSettlements().length * (1 + SETTLEMENT_RESIDENTS);

// ─────────────────────────────────────────────────────────────────────────────
// ПАРАМЕТРЫ ГЕЙТА
// ─────────────────────────────────────────────────────────────────────────────
const GATE_DAYS = 10; // горизонт DoD Фазы 1
const GATE_TICKS = GATE_DAYS * TICKS_PER_DAY;
const SEEDS = [42, 7, 999] as const;
/**
 * День-1/seed-42 живой голден (D-042). Сборка мира тем же путём обязана дать его.
 * Пере-закреплён balance-analyst-сессией (Фаза 1, смягчение спирали смерти):
 * e04c0d77 → cb104eca. Пере-закреплён задачей 2.0 (D-045): ретрофит леджера
 * (item/consumed+item/harvested) добавил события в лог → cb104eca → cb104eca
 * (мир НЕ изменился, только длина лога событий). Пере-закреплён задачей 2.2:
 * worldgen добавил 2 поселения (склад/касса) + 2 торговца — новые носители в мире
 * и 2 лишних актёра сдвигают общий поток world.rng → cb104eca → 70e9e546.
 * Пере-закреплён задачей 2.6: TaskSelection выбирает TRADE → 70e9e546 → 165688eb.
 * Пере-закреплён задачей 2.16a (D-064): гейт стоит на РЕАЛЬНОМ конвейере, а он
 * переключён на registerPhase2Systems (17 систем) — оживают Economy/Trade/
 * PopulationInflux (поля/бандиты ещё не в worldgen ⇒ ArtifactSpawn/Search/Export/
 * RobberyMemory/MemoryDecay дремлют) → 165688eb → 675e1485. Пере-закреплён задачей
 * 2.16b (D-065): worldgen оживил ДРЕМЛЮЩИЕ петли (3 поля AnomalyField, 4 бандита
 * predatory, резиденты + assignJobs) — новые сущности сдвигают поток world.rng, а
 * все 17 систем реально работают → 675e1485 → 1d52f17d. Тот же голден, что cli.test
 * day1 seed42 (единый путь сборки, D-042). Перф-фиксы шины (2.16b) результат-тождественны.
 */
const GOLDEN_DAY1_SEED42 = '74211540'; // 2.16c/D-066: money-faucet калибровка (W.trade>W.search, EXPORT_PRICE_FACTOR 1.3) сдвинула историю с тика 0: 1d52f17d → 74211540
/** Максимальный выход мяса с одной туши среди видов — верхняя граница «мясо с туш». */
const MAX_MEAT_YIELD = Math.max(...SPECIES.map((s) => s.meatYield));

// Типизированная проекция колонки позиции (для инварианта «нет телепортов»).
const POS = Position as unknown as { loc: Uint32Array };

// ─────────────────────────────────────────────────────────────────────────────
// СБОРКА ЖИВОГО МИРА — тот же путь, что headless-CLI (D-042).
// ─────────────────────────────────────────────────────────────────────────────
function buildLive(seed: number): { world: SimWorld; scheduler: Scheduler } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase2Systems(scheduler);
  return { world, scheduler };
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

/** Сумма количества предмета `item` по ВСЕМ инвентарям мира (живые + трупы). */
function itemTotal(world: SimWorld, item: string): number {
  let sum = 0;
  const invs = world.resources.entries<ReadonlyArray<{ item: string; qty: number }>>('inventory');
  for (const [, inv] of invs) {
    for (const e of inv) if (e.item === item) sum += e.qty;
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОФИЛЬ ПРОГОНА: один tick-by-tick проход на seed, собирающий ВСЕ инварианты
// и метрики отчёта. describe-замыкание строит его один раз; it-блоки лишь
// утверждают против собранных данных (не гоняя мир заново на каждый it).
// ─────────────────────────────────────────────────────────────────────────────
interface Violation {
  readonly tick: Tick;
  readonly eid: EntityId;
  readonly detail: string;
}

interface Profile {
  readonly seed: number;
  readonly world: SimWorld;
  readonly log: readonly SimEvent[];
  readonly finalHash: string;
  /** Живой Human без Task на каком-либо тике (закон №4). Пусто — инвариант держится. */
  readonly idleViolations: readonly Violation[];
  /** Живой Human без Needs (контракт D-034). Пусто — держится. */
  readonly needsViolations: readonly Violation[];
  /** Смена Position.loc без соответствующего move/arrived или не по ребру (телепорт). */
  readonly teleportViolations: readonly Violation[];
  readonly deaths: readonly SimEvent[];
  readonly encountersResolved: readonly SimEvent[];
  readonly born: number;
  readonly humansStart: number;
  readonly humansEnd: number;
  readonly animalsStart: number;
  readonly animalsEnd: number;
  readonly ammoStart: number;
  readonly ammoEnd: number;
  /** ammo_9mm, внесённый новоприбывшими из-за Периметра (item/broughtIn, D-061). */
  readonly ammoBroughtIn: number;
  readonly meatStart: number;
  readonly meatEnd: number;
  /** Верхняя граница мяса, объяснимого тушами: суммарные жертвы × MAX_MEAT_YIELD. */
  readonly meatUpperBound: number;
  readonly deathBreakdown: Readonly<Record<string, number>>;
}

function runProfile(seed: number): Profile {
  const { world, scheduler } = buildLive(seed);
  const humansStart = queryEntities(world.ecs, [Human, Alive]).length;
  const animalsStart = queryEntities(world.ecs, [Animal, Alive]).length;
  const ammoStart = itemTotal(world, 'ammo_9mm');
  const meatStart = itemTotal(world, 'meat');

  const idleViolations: Violation[] = [];
  const needsViolations: Violation[] = [];
  const teleportViolations: Violation[] = [];
  const prevLoc = new Map<EntityId, number>();

  for (let t = 0; t < GATE_TICKS; t++) {
    scheduler.tickOnce(world);
    const T = t as Tick; // тик, который только что отработал

    // События ТОЛЬКО этого тика — через индекс шины bus.at(T) (перф, 2.16b: раньше
    // тут был скан всего растущего лога КАЖДЫЙ тик). Собираем move/arrived (телепорт-
    // чек) и population/arrived (грация новичкам, ниже) одним проходом.
    const arrivedThisTick = new Map<EntityId, number>();
    const bornThisTick = new Set<EntityId>();
    for (const ev of world.bus.at(T)) {
      if (ev.type === 'move/arrived') arrivedThisTick.set(ev.payload.eid, ev.payload.at);
      else if (ev.type === 'population/arrived') bornThisTick.add(ev.payload.eid as EntityId);
    }

    // ЗАКОН №4: каждый живой сталкер после тика ИМЕЕТ задачу И нужды. ИСКЛЮЧЕНИЕ —
    // НОВИЧОК, ПРИБЫВШИЙ ЭТИМ ТИКОМ (PopulationInflux, D-061): он спавнится ПОЗЖЕ
    // TaskSelection в тике (позиция 15 > 6), поэтому Task получит на СЛЕДУЮЩЕМ тике —
    // так же, как генезис-когорта получает Task на тике 0 (не «завис idle», а «только
    // что вошёл в Зону»). Один тик без Task у свежеприбывшего — не нарушение закона №4.
    const humans = queryEntities(world.ecs, [Human, Alive]);
    for (const eid of humans) {
      if (!hasComponent(world.ecs, Task, eid) && !bornThisTick.has(eid)) {
        idleViolations.push({ tick: T, eid, detail: 'Human+Alive без Task (idle)' });
      }
      if (!hasComponent(world.ecs, Needs, eid)) {
        needsViolations.push({ tick: T, eid, detail: 'Human+Alive без Needs (D-034)' });
      }
    }

    // НЕТ ТЕЛЕПОРТОВ: позиция меняется ТОЛЬКО через прибытие по ребру графа.
    for (const eid of allEntities(world.ecs)) {
      const cur = POS.loc[eid];
      const prev = prevLoc.get(eid);
      if (prev !== undefined && cur !== undefined && prev !== cur) {
        const arrivedAt = arrivedThisTick.get(eid);
        const alongEdge = edgeLen(prev as never, cur as never) !== undefined;
        if (arrivedAt !== cur) {
          teleportViolations.push({
            tick: T,
            eid,
            detail: `loc ${prev}→${cur} без move/arrived (arrived=${String(arrivedAt)})`,
          });
        } else if (!alongEdge) {
          teleportViolations.push({ tick: T, eid, detail: `loc ${prev}→${cur} не по ребру графа` });
        }
      }
      if (cur !== undefined) prevLoc.set(eid, cur);
    }
  }

  const log = world.bus.log;
  const deaths = log.filter((e): e is SimEvent & { type: 'entity/died' } => e.type === 'entity/died');
  const encountersResolved = log.filter((e) => e.type === 'encounter/resolved');
  const born = log.filter((e) => e.type === 'animal/born').length;

  // Патроны, ФИЗИЧЕСКИ ВНЕСЁННЫЕ из-за Периметра новоприбывшими (PopulationInflux,
  // D-051/D-061): каждый новичок несёт STARTING_INVENTORY с ammo_9mm, залежерённый
  // item/broughtIn. Это ЛЕГАЛЬНЫЙ приток (не «из воздуха») ⇒ верхняя граница ammo
  // на конце = старт + внесено (см. MUST-7). До 2.16b притока в 10 дней не было (0).
  let ammoBroughtIn = 0;
  for (const e of log) {
    if (e.type !== 'item/broughtIn') continue;
    const p = (e as SimEvent & { type: 'item/broughtIn' }).payload;
    for (const [item, qty] of p.items) if (item === 'ammo_9mm') ammoBroughtIn += qty;
  }

  const deathBreakdown: Record<string, number> = {};
  for (const d of deaths) {
    const cause = (d as SimEvent & { type: 'entity/died' }).payload.cause;
    deathBreakdown[cause] = (deathBreakdown[cause] ?? 0) + 1;
  }

  // Верхняя граница мяса из туш: все жертвы всех разрешённых столкновений.
  let totalCasualties = 0;
  for (const e of encountersResolved) {
    totalCasualties += (e as SimEvent & { type: 'encounter/resolved' }).payload.casualties.length;
  }

  return {
    seed,
    world,
    log,
    finalHash: hashSnapshot(serialize(world)),
    idleViolations,
    needsViolations,
    teleportViolations,
    deaths,
    encountersResolved,
    born,
    humansStart,
    humansEnd: queryEntities(world.ecs, [Human, Alive]).length,
    animalsStart,
    animalsEnd: queryEntities(world.ecs, [Animal, Alive]).length,
    ammoStart,
    ammoEnd: itemTotal(world, 'ammo_9mm'),
    ammoBroughtIn,
    meatStart,
    meatEnd: itemTotal(world, 'meat'),
    meatUpperBound: totalCasualties * MAX_MEAT_YIELD,
    deathBreakdown,
  };
}

/**
 * Проверяет причинную цепочку одного события: каждая `causedBy` указывает на
 * СУЩЕСТВУЮЩЕЕ событие, строго РАНЬШЕ (меньший id), без ЦИКЛОВ, обрыв только в
 * `null` (корень). Возвращает описание дефекта или null, если цепочка целостна.
 */
function chainDefect(event: SimEvent, byId: ReadonlyMap<EventId, SimEvent>): string | null {
  let cursor: SimEvent | undefined = event;
  const seen = new Set<EventId>();
  while (cursor && cursor.causedBy !== null) {
    if (seen.has(cursor.id)) return `цикл на id=${String(cursor.id)}`;
    seen.add(cursor.id);
    const parent = byId.get(cursor.causedBy);
    if (parent === undefined) {
      return `висячая ссылка: id=${String(cursor.id)} → ${String(cursor.causedBy)} (нет такого события)`;
    }
    if (cursor.causedBy >= cursor.id) {
      return `не монотонно: id=${String(cursor.id)} → ${String(cursor.causedBy)} (причина не раньше следствия)`;
    }
    cursor = parent;
  }
  return null; // дошли до корня (causedBy === null) без обрывов/циклов
}

// Профили строятся ОДИН раз на seed (модульный кэш): дорогие 10-дневные прогоны
// не повторяются между describe-блоками одного seed.
const PROFILES = new Map<number, Profile>();
function profileOf(seed: number): Profile {
  let p = PROFILES.get(seed);
  if (p === undefined) {
    p = runProfile(seed);
    PROFILES.set(seed, p);
  }
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════
// MUST-1 — ДЕТЕРМИНИЗМ: один seed → побитово одна история (закон №8).
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Детерминизм: 10 дней, два прогона одного seed идентичны', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const first = profileOf(seed);
      // Второй НЕЗАВИСИМЫЙ прогон тем же путём сборки.
      const { world: w2, scheduler: s2 } = buildLive(seed);
      s2.run(w2, GATE_TICKS);
      const secondHash = hashSnapshot(serialize(w2));

      it('идентичный hashSnapshot', () => {
        expect(secondHash).toBe(first.finalHash);
      });

      it('идентичный полный лог событий по (id, tick, type, causedBy, payload)', () => {
        expect(normalize(w2.bus.log)).toEqual(normalize(first.log));
      });

      it('история НЕ пуста и монотонна по EventId (гейт не холостой)', () => {
        expect(first.log.length).toBeGreaterThan(1000);
        for (let i = 1; i < first.log.length; i++) {
          expect(first.log[i]!.id).toBeGreaterThan(first.log[i - 1]!.id);
        }
      });
    });
  }

  it('разные seed → разная история (rng не декоративен, закон №2)', () => {
    const a = profileOf(42);
    const b = profileOf(7);
    expect(a.finalHash).not.toBe(b.finalHash);
    expect(normalize(a.log)).not.toEqual(normalize(b.log));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-2 — RESUME: save/load через ВЕСЬ конвейер ≡ непрерывный прогон.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Resume: split save/load ≡ непрерывный прогон (несколько горизонтов)', () => {
  // (seed, всего дней, точка сплита в днях) — сплит на НАПОЛНЕННОЙ середине.
  const CASES: ReadonlyArray<readonly [seed: number, totalDays: number, splitDays: number]> = [
    [42, GATE_DAYS, 4],
    [7, 6, 3],
    [999, 4, 1],
  ];

  for (const [seed, totalDays, splitDays] of CASES) {
    describe(`seed ${seed}: ${totalDays} дней, сплит на дне ${splitDays}`, () => {
      const totalTicks = totalDays * TICKS_PER_DAY;
      const splitTicks = splitDays * TICKS_PER_DAY;

      // Непрерывный эталон.
      const { world: cont, scheduler: contSched } = buildLive(seed);
      contSched.run(cont, totalTicks);

      // Расщеплённый: прогон → serialize → deserialize → добег НОВЫМ конвейером.
      const { world: half, scheduler: halfSched } = buildLive(seed);
      halfSched.run(half, splitTicks);
      const midLogLen = half.bus.log.length;
      const resumed = deserialize(serialize(half));
      const resumeSched = createScheduler();
      registerPhase2Systems(resumeSched);
      resumeSched.run(resumed, totalTicks - splitTicks);

      it('resume проходит по НАПОЛНЕННОЙ середине (не тривиальный пустой мир)', () => {
        expect(midLogLen).toBeGreaterThan(0);
        expect(half.tick).toBe(splitTicks);
      });

      it('идентичный hashSnapshot', () => {
        expect(hashSnapshot(serialize(resumed))).toBe(hashSnapshot(serialize(cont)));
      });

      it('идентичный лог событий по (id, tick, type, causedBy, payload)', () => {
        expect(normalize(resumed.bus.log)).toEqual(normalize(cont.bus.log));
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-3 — 0 IDLE (закон №4): ни одного живого сталкера без задачи/нужд за 10 дней.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · 0 idle: за 10 дней ни один живой сталкер не завис без задачи', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const p = profileOf(seed);

      it('ни одного Human+Alive без Task ни на одном тике (закон №4)', () => {
        expect(
          p.idleViolations,
          p.idleViolations.slice(0, 5).map((v) => `t=${v.tick} eid=${v.eid}: ${v.detail}`).join('; '),
        ).toEqual([]);
      });

      it('ни одного живого Human без Needs (контракт D-034)', () => {
        expect(p.needsViolations).toEqual([]);
      });

      it('мир реально жил: сталкеры/торговцы стартовали и события шли', () => {
        expect(p.humansStart).toBe(HUMANS_AT_START); // 20 сталкеров + торговцы (2.2)
        expect(p.log.length).toBeGreaterThan(1000);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-4 — ПРИЧИННОСТЬ СМЕРТЕЙ (закон №6, ядро DoD «смерти объяснимы»).
// КАЖДОЕ entity/died за прогон резолвится полной цепочкой causedBy до корня.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Смерти объяснимы: каждая entity/died прослеживается до корня', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const p = profileOf(seed);
      const byId = new Map<EventId, SimEvent>();
      for (const e of p.log) byId.set(e.id, e);

      it('за 10 дней случились реальные смерти (сценарий не пуст)', () => {
        expect(p.deaths.length).toBeGreaterThan(0);
      });

      it('НИ ОДНОЙ висячей ссылки / цикла: каждая цепочка смерти доходит до null', () => {
        const defects: string[] = [];
        for (const d of p.deaths) {
          const defect = chainDefect(d, byId);
          if (defect !== null) defects.push(`eid=${(d as never as { payload: { eid: number } }).payload.eid}: ${defect}`);
        }
        expect(defects, defects.slice(0, 5).join(' | ')).toEqual([]);
      });

      it('КАЖДАЯ смерть несёт ПРОСТАВЛЕННУЮ причину (causedBy !== null) — не «смерть из ниоткуда»', () => {
        // D-027: сталкеры стартуют ниже критических порогов, бой штампует lethalCause —
        // поэтому у каждой смерти есть событие-корень урона/истощения. causedBy===null
        // означал бы смерть без проштампованной причины (разрыв «смерти объяснимы»).
        const orphan = p.deaths.filter((d) => d.causedBy === null);
        expect(
          orphan.length,
          `смертей без причины: ${orphan.length} — ` +
            orphan.slice(0, 5).map((d) => `id=${d.id}`).join(', '),
        ).toBe(0);
      });

      it('причина смерти прослеживается к корню-физиологии/бою (needs/threshold или encounter/*)', () => {
        // Корень цепочки любой смерти обязан быть событием физиологии или боя, а не
        // случайным служебным событием: подтверждает, что метка cause авторитетна.
        for (const d of p.deaths) {
          let cursor: SimEvent | undefined = d;
          while (cursor && cursor.causedBy !== null) cursor = byId.get(cursor.causedBy);
          expect(cursor, `смерть id=${d.id} не имеет корня в логе`).toBeDefined();
          const rootType = cursor!.type;
          expect(
            ['needs/threshold', 'encounter/started', 'perception/spotted', 'task/selected'],
            `корень смерти id=${d.id} — неожиданный тип "${rootType}"`,
          ).toContain(rootType);
        }
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-5 — ПОРЯДОК СИСТЕМ (D-032): производитель штампа РАНЬШЕ потребителя.
// (Инвариант закреплён в pipeline.test.ts; здесь — проверка на РЕАЛЬНОЙ
//  регистрации живого конвейера гейта, чтобы гейт был самодостаточен.)
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Порядок систем: живой конвейер удовлетворяет стыки причинности (D-032)', () => {
  const { scheduler } = buildLive(42);
  const order = scheduler.systems().map((s) => s.name);
  const idx = (name: string): number => {
    const i = order.indexOf(name);
    expect(i, `система ${name} должна быть зарегистрирована`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('зарегистрированы ровно 17 систем Фазы 2 в каноническом порядке', () => {
    expect(order).toEqual(PHASE2_SYSTEMS.map((s) => s.name));
    expect(order.length).toBe(17);
  });

  it('производитель < потребитель на всех стыках Фазы 1+2 (D-032/D-064)', () => {
    // Стыки Фазы 1 (сохранены):
    expect(idx('Needs')).toBeLessThan(idx('Death'));
    expect(idx('Perception')).toBeLessThan(idx('TaskSelection'));
    expect(idx('Perception')).toBeLessThan(idx('Encounters'));
    expect(idx('Perception')).toBeLessThan(idx('Animals'));
    expect(idx('TaskSelection')).toBeLessThan(idx('Movement'));
    expect(idx('Encounters')).toBeLessThan(idx('Death'));
    expect(idx('Movement')).toBeLessThan(idx('TaskEffects'));
    expect(idx('Movement')).toBeLessThan(idx('Animals'));
    // Новые стыки Фазы 2 (D-064):
    expect(idx('ArtifactSpawn')).toBeLessThan(idx('TaskSelection'));
    expect(idx('TaskSelection')).toBeLessThan(idx('ArtifactSearch'));
    expect(idx('RobberyMemory')).toBeLessThan(idx('TaskSelection'));
    expect(idx('Movement')).toBeLessThan(idx('Trade'));
    expect(idx('Movement')).toBeLessThan(idx('ArtifactSearch'));
    expect(idx('Movement')).toBeLessThan(idx('Economy'));
    expect(idx('Economy')).toBeLessThan(idx('Export'));
    expect(idx('Weather')).toBe(0);
    expect(idx('Death')).toBe(order.length - 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-6 — НЕТ ТЕЛЕПОРТОВ (закон №8/№6): позиция меняется только по рёбрам графа
// и только через опубликованное move/arrived.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Нет телепортов: позиция меняется только по рёбрам через move/arrived', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ни одной смены Position.loc без прибытия по ребру`, () => {
      const p = profileOf(seed);
      expect(
        p.teleportViolations,
        p.teleportViolations.slice(0, 5).map((v) => `t=${v.tick} eid=${v.eid}: ${v.detail}`).join('; '),
      ).toEqual([]);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-7 — ЗАКОН №3: мясо только с туш, патроны только тратятся.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Закон №3: охота даёт мясо, ничего не берётся из воздуха', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const p = profileOf(seed);

      it('охота случилась: есть encounter/resolved с добычей (мясо реально добывается)', () => {
        const kills = p.encountersResolved.filter(
          (e) => (e as SimEvent & { type: 'encounter/resolved' }).payload.casualties.length > 0,
        );
        expect(kills.length).toBeGreaterThan(0);
      });

      it('патроны не из воздуха: ammo_9mm на конце ≤ старт + ВНЕСЁННОЕ притоком (D-061)', () => {
        // Патроны только УБЫВАЮТ (бой) ИЛИ прибывают ЛЕГАЛЬНО с новичками из-за
        // Периметра (item/broughtIn). Верхняя граница = старт + внесено притоком; выше
        // — значило бы эмиссию из воздуха (закон №3). С 2.16b приток оживил ammoBroughtIn.
        expect(p.ammoEnd).toBeLessThanOrEqual(p.ammoStart + p.ammoBroughtIn);
      });

      it('мясо появляется ТОЛЬКО с туш: старт=0, конец>0 и ≤ границы «жертвы × выход»', () => {
        expect(p.meatStart).toBe(0); // сталкеры входят в Зону без мяса (D-021)
        expect(p.meatEnd).toBeGreaterThan(0); // добыто охотой
        expect(p.meatEnd).toBeLessThanOrEqual(p.meatUpperBound); // всё объяснимо тушами
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST-8 — ЦЕЛОСТНОСТЬ: живой прогон не падает и воспроизводит день-1 голден.
// ═════════════════════════════════════════════════════════════════════════════
describe('MUST · Целостность: конвейер не падает и держит живой голден', () => {
  it('день-1/seed-42 через тот же путь сборки даёт голден 1d52f17d (D-065)', () => {
    const { world, scheduler } = buildLive(42);
    scheduler.run(world, TICKS_PER_DAY);
    expect(hashSnapshot(serialize(world))).toBe(GOLDEN_DAY1_SEED42);
  });

  it('10-дневный прогон завершается без исключений на всех seed', () => {
    for (const seed of SEEDS) {
      expect(() => profileOf(seed)).not.toThrow();
      expect(profileOf(seed).world.tick).toBe(GATE_TICKS);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ОТЧЁТ (ИНФОРМАЦИОННО, D-043 — НЕ влияет на pass/fail): метрики здоровья мира
// сведены в docs/reports/phase1-gate.md. Здесь лишь фиксируем, что показатели
// СОБИРАЮТСЯ и осмысленны (числа конечны), но НЕ ставим порогов выживаемости —
// высокая смертность принята продуктово (D-043), гейт по ней не краснеет.
// (@zona/sim не имеет доступа к console — закон №5 — печать отчёта живёт в .md.)
// ═════════════════════════════════════════════════════════════════════════════
describe('ОТЧЁТ · Метрики здоровья мира собираются (D-043: информационно, не критерий)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: показатели — конечные числа, выживаемость НЕ проваливает гейт`, () => {
      const p = profileOf(seed);
      for (const n of [p.humansEnd, p.animalsEnd, p.born, p.deaths.length, p.encountersResolved.length]) {
        expect(Number.isFinite(n)).toBe(true);
      }
      // D-043: выживаемость и популяция — ОТЧЁТ, не провал. Фиксируем лишь, что
      // они в физически возможных границах (не отрицательны, без взрыва).
      // 2.16c/D-066: верхняя граница СНЯТА с `humansStart` — Фаза 2 имеет ПРИТОК
      // (PopulationInflux, D-061), население ЗАКОННО растёт (особенно после калибровки
      // money-faucet: NPC докупают еду у поселений → меньше голодных смертей за 10-дневное
      // окно гейта). Оставляем лишь анти-ВЗРЫВНУЮ санити-границу (3× старта), чтобы
      // поймать настоящий runaway, но не путать здоровый рост с провалом (метрика — отчёт).
      expect(p.humansEnd).toBeGreaterThanOrEqual(0);
      expect(p.humansEnd).toBeLessThanOrEqual(p.humansStart * 3);
      expect(p.animalsEnd).toBeGreaterThanOrEqual(0);
    });
  }
});
