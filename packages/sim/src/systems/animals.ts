/**
 * @module @zona/sim/systems/animals
 *
 * Система Animals (задача 1.9, B.1) — ЖИЗНЬ стад: пастьба/питьё (выживание),
 * бегство пугливых от людей, стадность (тяготение к своим) и ПРИЧИННОЕ
 * размножение. Общение — только через ECS-компоненты, «холодный» ResourceStore
 * (`contacts` от Perception 1.7) и шину событий с `causedBy` (закон №6): другие
 * системы Animals напрямую не зовёт.
 *
 * Главный тест закона №1: всё здесь работает БЕЗ игрока — стада пасутся, плодятся
 * и гибнут от истощения по состоянию мира, даже если ни одного человека нет.
 *
 * ── Что читает/пишет (только своё) ───────────────────────────────────────────
 * Читает Animal(species/herd), Position(loc/dest), Needs, `contacts` (ResourceStore),
 * СТАТИКУ локаций из data (forage/water/danger, соседи, граф). Пишет Needs (пастьба/
 * питьё уменьшают hunger/thirst), Position.dest/etaTicks/moveCause (departure бегства/
 * стадности) и СОЗДАЁТ новорождённых (spawnEntity + Animal/Position/Needs/Health/Alive).
 * Публикует `move/departed` (departure животного) и `animal/born` (приплод).
 *
 * ── ДВИЖЕНИЕ животных: departure здесь, транзит — Movement (1.4) ──────────────
 * У животных НЕТ компонента `Task` (Task — артефакт utility-AI людей, D-033;
 * TaskSelection/TaskEffects Human-gated и животных не касаются). Movement (1.4)
 * двигает по `Task.targetLoc` ТОЛЬКО стоящих носителей Task, НО его ветка «в пути»
 * (`dest !== loc`) — ВИДО-АГНОСТИЧНА: она декрементит etaTicks и публикует
 * `move/arrived` для ЛЮБОГО носителя Position. Поэтому чистый путь без дублирования
 * движка транзита и без порчи человеческой Task-машинерии:
 *   • Animals САМ делает «departure» стоящему животному, которому нужно уйти
 *     (бегство/стадность): ставит `Position.dest = соседний шаг`, `etaTicks = edgeLen`,
 *     публикует `move/departed {eid, from, to}` (causedBy: для БЕГСТВА —
 *     `perception/spotted` человека-угрозы через `Contact.spottedEvent`, 1.10a/D-030;
 *     для стадности — null, экологический драйв корень) и ШТАМПУЕТ его id в
 *     `Position.moveCause` (D-030), чтобы он дожил до прибытия;
 *   • per-tick декремент etaTicks и `move/arrived` (с `causedBy = moveCause`) делает
 *     уже существующая ветка «в пути» Movement (`every:1`) — Animals её НЕ дублирует.
 * Так цепочка каждого хопа замкнута: `move/departed → move/arrived` (departed — корень,
 * т.к. драйв экологический). departure животного — единственная «добавка» к движку
 * Movement, и она ЛЕГИТИМНО видо-специфична (причина departure — не `task/selected`).
 * Пока животное в пути (`dest !== loc`), Animals его НЕ трогает (не пасёт, не
 * перенаправляет) — им занимается Movement; новое решение принимается лишь когда
 * животное снова СТОИТ. Порядок в прогоне (канонический B.1, будет закреплён тестом
 * гейта 1.13): Perception < Animals (contacts producer<consumer, D-032) и Movement <
 * Animals — Animals идёт ПОСЛЕ Movement, поэтому departure животного декрементится
 * Movement лишь СО СЛЕДУЮЩЕГО тика ⇒ переход занимает ПОЛНЫЙ edgeLen (off-by-one нет,
 * как у Task-driven движения D-026).
 *
 * ── ПАСТЬБА/ПИТЬЁ (выживание, закон №1) ──────────────────────────────────────
 * Needs (1.5) растит животным hunger/thirst/fatigue каждый тик (как людям). Пастьба
 * компенсирует: у СТОЯЩЕГО животного `hunger -= GRAZE * loc.forage * every` (корм из
 * СРЕДЫ, закон №3), и `thirst -= DRINK * every` если `loc.water`. Ставки «за тик» ×
 * длительность шага `every:30` (balance/ecology, закон №7). В кормном/водном угодье
 * нужды держатся у нуля (не вымирают); в бедном/безводном — копятся → эмерджентная
 * гибель через урон истощения Needs (мортальность реальна, не «анти-спавн»). Fatigue
 * НЕ восстанавливаем (животные не спят в 1.9): она не летальна (Needs бьёт только
 * голодом/жаждой), максимум клампится — безвредно.
 *
 * ── БЕГСТВО пугливых (закон №2 — из состояния, D-029) ─────────────────────────
 * Пугливый вид (`getSpecies(species).flees === true`, олень): если в `contacts`
 * (Perception) есть ЖИВОЙ человек (валидируем `existsEntity` — контакт мог держать
 * мёртвый eid ≤1 тик, D-029 — И `hasComponent(Human)`) → departure в СОСЕДНЮЮ
 * локацию с наименьшим `danger` (детерминированно: min danger, tie — min id).
 * Непугливый (кабан, `flees:false`) НЕ бежит — стоит (агрессию к человеку разрулит
 * Encounter 1.10; здесь только «не убегаю»). rng НЕ используется: реакция
 * детерминирована наличием угрозы, а не «X% испугаться» (закон №2).
 * ПРИЧИННОСТЬ ЗАМКНУТА (ретрофит 1.10a, D-037 закрыт): departure бегства публикуется с
 * `causedBy = Contact.spottedEvent` человека-угрозы — id того `perception/spotted`,
 * что известил животное о человеке (форма contacts несёт `spottedEvent` по D-030).
 * Цепочка «человек двинулся → `move/*` → `perception/spotted` → олень бежит
 * (`move/departed.causedBy = spottedEvent`)» замкнута; при `spottedEvent === 0` (нет
 * id) — `null`. Стадность/приплод — законный корень (`null`) насовсем.
 *
 * ── СТАДНОСТЬ ────────────────────────────────────────────────────────────────
 * Отставшее (не в мажоритарной локации стада) стоящее животное departure'ит ПЕРВЫМ
 * шагом к локации, где сейчас БОЛЬШИНСТВО его стада (перепись текущего тика; tie —
 * меньший id локации). Детерминированно и просто; сойдясь, стадо стоит вместе.
 * Бегство приоритетнее стадности.
 *
 * ── РАЗМНОЖЕНИЕ — ПРИЧИННОЕ, БЕЗ ХРАНИМОГО ТАЙМЕРА (закон №2/№8) ───────────────
 * «Племенной тик» стада — ДЕТЕРМИНИРОВАННАЯ функция (tick, herd, species), БЕЗ
 * сериализуемого/рантайм-таймера (resume-safe): рождение возможно, когда
 * `tick >= phase(herd) && (tick - phase(herd)) % gestationTicks(species) === 0`, где
 * `phase(herd)` — стабильный сдвиг из id стада, КРАТНЫЙ шагу `every` и < gestation
 * (значит племенной тик всегда ловится due-тиком Animals; guard кратности
 * gestationTicks шагу — как канарейка Weather). На племенном тике рождение
 * происходит ТОЛЬКО ЕСЛИ выполнены ПОРОГИ СОСТОЯНИЯ (причинность, НЕ «X% приплод»):
 *   (1) локальная популяция вида в мажоритарной локации стада < `reproCap(species)`;
 *   (2) `loc.forage > REPRO_FORAGE_MIN` (голодная земля не кормит потомство);
 *   (3) в этой локации >= `REPRO_MIN_HERD_IN_LOC` особей стада (родители физически
 *       существуют, закон №3).
 * Не выполнены → НЕТ рождения в этот цикл (НЕ откладывается в таймер — просто
 * следующий племенной тик через gestation). Максимум ОДНО рождение на стадо за
 * племенной тик. Перепись видо-популяции ОБНОВЛЯЕТСЯ ПОСЛЕ каждого рождения в цикле
 * по стадам: `phase(herd)` не инъективна (хеш-коллизии фаз), поэтому два стада одного
 * вида в одной локации могут делить племенной тик — без инкремента оба прочли бы
 * устаревший счёт и перескочили `reproCap`. Инвариант «локальная популяция вида <=
 * reproCap» держится и при co-located синхронных стадах. rng на факт рождения НЕ
 * используется — это периодичность ×
 * пороги, а не бросок кости. Новорождённый: Animal(species, herd родителя),
 * Position(loc стада, стоит), Needs (ниже критич., D-027), Health (полное), тег
 * Alive; публикуется `animal/born {eid, herd, loc}` (causedBy: null — экологический
 * порог корень). Resume-безопасность: перепись строится из ЖИВЫХ животных
 * (восстанавливаются тождественно), формула stateless ⇒ непрерывный прогон ≡ split
 * save/load по популяции И логу `animal/born` (без дубля/пропуска на границе).
 *
 * ── Детерминизм (закон №8) ────────────────────────────────────────────────────
 * Обход животных — `queryEntities([Animal, Alive])` (сорт. по eid). Перепись стад/
 * видов — Map, но ИТЕРАЦИЯ только по ОТСОРТИРОВАННЫМ ключам (herd/loc по возрастанию).
 * rng НЕ используется вовсе (ни пастьба, ни бегство, ни рождение — всё арифметика/
 * пороги/периодичность). `phase(herd)` — фиксированная функция id, НЕ случайность.
 */

import type { Contact, EntityId, EventId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import {
  queryEntities,
  hasComponent,
  existsEntity,
  spawnEntity,
  addComponent,
  stampCause,
} from '../core/ecs';
import { Animal, Position, Needs, Health, Alive, Human } from '../core/components';
import { getSpecies, getLocation, neighbors, SPECIES } from '../data/index';
import { MAP_GRAPH, firstStep } from './pathfinding';
import { MIN_TRAVEL_TICKS } from '../balance/movement';
import { NEED_MAX, HEALTH_MAX } from '../balance/needs';
import {
  ANIMAL_GRAZE_HUNGER_PER_TICK,
  ANIMAL_DRINK_THIRST_PER_TICK,
  REPRO_FORAGE_MIN,
  REPRO_MIN_HERD_IN_LOC,
  ANIMAL_NEWBORN_NEED,
} from '../balance/ecology';

/** Ключ ResourceStore с контактами (пишет Perception 1.7, сорт. eid, D-023). */
const CONTACTS_KEY = 'contacts';

/**
 * Шаг планировщика Animals. Выбран `30` (полчаса игрового времени): экология не
 * требует по-тиковой реакции, а редкий шаг дешевле (бюджет 1.6 мс, D-006). Все
 * ставки нужд «за тик» домножаются на этот шаг (компенсация накопления Needs за
 * `every` тиков); племенной тик обязан ловиться due-тиком, поэтому gestationTicks
 * кратен ему (guard ниже — канарейка перебаланса, как Weather).
 */
const ANIMALS_CADENCE = 30;

/**
 * Множитель для хеш-сдвига фазы стада (Knuth multiplicative hashing, целочисленный,
 * ДЕТЕРМИНИРОВАННЫЙ). Это НЕ баланс и НЕ случайность (закон №2): фиксированная
 * функция id стада, рассеивающая фазы племенных тиков разных стад, чтобы они не
 * плодились синхронно. Часть алгоритма хеша — как константы mulberry32/FNV в rng.ts.
 */
const HERD_PHASE_HASH_MUL = 2654435761;

// ── Инвариант кратности (канарейка перебаланса, как Weather cadence) ──────────
//
// Племенной тик = `(tick - phase) % gestationTicks === 0`, а phase и tick кратны
// ANIMALS_CADENCE. Чтобы этот тик реально попадал на due-тик Animals, gestationTicks
// ОБЯЗАН быть кратен ANIMALS_CADENCE — иначе рождения молча никогда не случались бы
// (тик приплода пришёлся бы между запусками системы). Проверяем ВСЕ виды при
// загрузке модуля и падаем ГРОМКО, если контент/шаг рассинхронятся (закон №8).
for (const s of SPECIES) {
  if (s.gestationTicks % ANIMALS_CADENCE !== 0) {
    throw new Error(
      `Animals: gestationTicks вида "${s.key}" (${s.gestationTicks}) должен быть кратен ` +
        `шагу планировщика ${ANIMALS_CADENCE} (иначе племенной тик не попадёт на due-тик ` +
        `Animals и рождения не случатся). Правьте species.json или ANIMALS_CADENCE.`,
    );
  }
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const ANIM = Animal as unknown as { readonly species: Uint8Array; readonly herd: Uint32Array };
const POS = Position as unknown as {
  readonly loc: Uint32Array;
  readonly dest: Uint32Array;
  readonly etaTicks: Float32Array;
  readonly moveCause: Uint32Array;
};
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HP = Health as unknown as { hp: Float32Array };

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Детерминированный «фазовый сдвиг» племенного тика стада: КРАТНЫЙ `ANIMALS_CADENCE`
 * и лежащий в `[0, gestationTicks)`. Выведен из id стада мультипликативным хешем
 * (рассеивает фазы стад, чтобы приплод не был синхронным). ЭКСПОРТИРУЕТСЯ, чтобы
 * тесты вычисляли ожидаемый племенной тик из контракта, а не хардкодили его.
 * Это ФУНКЦИЯ, а не случайность (закон №2): (herd, gestationTicks) → фаза.
 */
export function herdPhaseTick(herd: number, gestationTicks: number): number {
  const steps = Math.floor(gestationTicks / ANIMALS_CADENCE); // >=1 (guard: gest>0, кратно)
  const h = Math.imul(herd >>> 0, HERD_PHASE_HASH_MUL) >>> 0;
  return (h % steps) * ANIMALS_CADENCE;
}

/**
 * true, если `tick` — «племенной тик» стада `herd` вида с `gestationTicks`:
 * `tick >= phase && (tick - phase) % gestationTicks === 0`. Детерминировано и
 * stateless (никакого хранимого таймера, resume-safe). ЭКСПОРТИРУЕТСЯ для тестов.
 */
export function isBreedingTick(tick: number, herd: number, gestationTicks: number): boolean {
  const phase = herdPhaseTick(herd, gestationTicks);
  if (tick < phase) return false;
  return (tick - phase) % gestationTicks === 0;
}

/** Соседняя локация с наименьшим `danger` (tie — меньший id); undefined если соседей нет. */
function safestNeighbor(loc: LocationId): LocationId | undefined {
  let best: LocationId | undefined;
  let bestDanger = Infinity;
  // neighbors отсортированы по возрастанию ⇒ строгое `<` даёт tie-break по min id.
  for (const nb of neighbors(loc)) {
    const d = getLocation(nb).danger;
    if (d < bestDanger) {
      bestDanger = d;
      best = nb;
    }
  }
  return best;
}

/**
 * Ищет ЖИВОГО человека-угрозу среди контактов животного (D-029: валидируем
 * existsEntity — контакт мог держать eid только что погибшей сущности ≤1 тик).
 * Возвращает `spottedEvent` первого такого человека (contacts сорт. по target ⇒
 * детерминированно min-target), чтобы бегство сослалось на породивший
 * `perception/spotted` (D-030). Нет живого человека → `-1` (сентинел «не бежать»);
 * человек есть, но `spottedEvent === 0` (нет id) → `0` (бежать, но causedBy = null).
 * EventId всегда >= 0, поэтому `-1` однозначно отличает «человека нет».
 */
function humanThreatSpottedEvent(world: SystemCtx['world'], eid: EntityId): number {
  const contacts = world.resources.get<readonly Contact[]>(CONTACTS_KEY, eid);
  if (contacts === undefined) return -1;
  for (const c of contacts) {
    // Существование обязательно проверить ДО адресации, иначе сошлёмся на покойника.
    if (!existsEntity(world.ecs, c.target)) continue;
    if (hasComponent(world.ecs, Human, c.target)) return c.spottedEvent;
  }
  return -1;
}

/**
 * «Departure» стоящего животного в соседний шаг `step`: ставит транзит и публикует
 * `move/departed` с переданной причиной `causedBy`, штампуя его id в
 * `Position.moveCause` (доживёт до прибытия, где Movement 1.4 возьмёт его в
 * `move/arrived.causedBy`, D-030). Декремент/прибытие — ветка «в пути» Movement.
 * `causedBy`: для БЕГСТВА — id `perception/spotted` человека-угрозы (из
 * `Contact.spottedEvent`, ретрофит 1.10a); для стадности — `null` (экологический
 * драйв корень цепочки, закон №2).
 */
function departTo(
  bus: EventBus,
  eid: EntityId,
  from: LocationId,
  step: LocationId,
  causedBy: EventId | null,
): void {
  const eta = Math.max(MIN_TRAVEL_TICKS, MAP_GRAPH.weight(from, step));
  POS.dest[eid] = step;
  POS.etaTicks[eid] = eta;
  const id = bus.publish({
    type: 'move/departed',
    causedBy,
    payload: { eid, from, to: step },
  });
  stampCause(Position, 'moveCause', eid, id);
}

/** Перепись стад/видов текущего тика (из ЖИВЫХ животных, resume-стабильна). */
interface Census {
  /** herd → (loc → число особей стада в этой локации). */
  readonly herdLoc: Map<number, Map<number, number>>;
  /** herd → код вида (все особи стада — один вид). */
  readonly herdSpecies: Map<number, number>;
  /** `${species}#${loc}` → число особей ВИДА в локации (для порога reproCap). */
  readonly speciesLoc: Map<string, number>;
}

/** Строит перепись, обходя `animals` (уже отсортированы по eid, закон №8). */
function buildCensus(animals: readonly EntityId[]): Census {
  const herdLoc = new Map<number, Map<number, number>>();
  const herdSpecies = new Map<number, number>();
  const speciesLoc = new Map<string, number>();
  for (const eid of animals) {
    const herd = ANIM.herd[eid] as number;
    const species = ANIM.species[eid] as number;
    const loc = POS.loc[eid] as number;

    let locs = herdLoc.get(herd);
    if (locs === undefined) {
      locs = new Map<number, number>();
      herdLoc.set(herd, locs);
    }
    locs.set(loc, (locs.get(loc) ?? 0) + 1);

    herdSpecies.set(herd, species);

    const key = `${species}#${loc}`;
    speciesLoc.set(key, (speciesLoc.get(key) ?? 0) + 1);
  }
  return { herdLoc, herdSpecies, speciesLoc };
}

/**
 * Мажоритарная локация стада: где сейчас БОЛЬШИНСТВО особей (tie — меньший id
 * локации). Обход ключей-локаций по возрастанию ⇒ строгое `>` даёт tie-break по
 * min id (закон №8).
 */
function herdMajorityLoc(locCounts: Map<number, number>): LocationId {
  const locs = Array.from(locCounts.keys()).sort((a, b) => a - b);
  let bestLoc = locs[0] as number;
  let bestCount = -1;
  for (const loc of locs) {
    const c = locCounts.get(loc) as number;
    if (c > bestCount) {
      bestCount = c;
      bestLoc = loc;
    }
  }
  return bestLoc as LocationId;
}

/**
 * Система Animals (`every:30`). Пасёт/поит стоящих, гонит пугливых от людей, стягивает
 * отставших к стаду и на племенных тиках даёт причинный приплод. Порядок фаз:
 * перепись → пастьба+движение (по eid) → размножение (по herd) — все детерминированы.
 */
export const Animals: System = {
  name: 'Animals',
  schedule: { every: ANIMALS_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;
    const ecs = world.ecs;
    const animals = queryEntities(ecs, [Animal, Alive]);
    if (animals.length === 0) return;

    // Перепись — из loc ДО движения этого тика; новорождённые добавятся ПОСЛЕ.
    const census = buildCensus(animals);

    // ── ПАСТЬБА/ПИТЬЁ + ДВИЖЕНИЕ (обход по eid, закон №8) ──────────────────────
    for (const eid of animals) {
      const loc = POS.loc[eid] as number;
      // В пути (dest !== loc) — животным занимается Movement (1.4); не пасём/не решаем.
      if ((POS.dest[eid] as number) !== loc) continue;

      const species = getSpecies(ANIM.species[eid] as number);

      // БЕГСТВО приоритетнее: пугливый + живой человек в contacts → уходим в
      // безопаснейшего соседа. Departure заканчивает обработку этого животного.
      if (species.flees) {
        const spottedEvent = humanThreatSpottedEvent(world, eid);
        if (spottedEvent >= 0) {
          const safe = safestNeighbor(loc as LocationId);
          if (safe !== undefined) {
            // Причинность замкнута (D-030): departure бегства ссылается на
            // perception/spotted человека-угрозы (из Contact.spottedEvent). 0 = нет
            // id ⇒ null (корень). Цепочка: человек двинулся → spotted → олень бежит.
            const causedBy = spottedEvent > 0 ? (spottedEvent as EventId) : null;
            departTo(bus, eid, loc as LocationId, safe, causedBy);
            continue;
          }
          // Соседей нет (изолятов на карте нет) — падаем в пастьбу как обычно.
        }
      }

      // ПАСТЬБА (стоит, не бежит): корм из среды локации, вода если есть.
      const locData = getLocation(loc as LocationId);
      NEED.hunger[eid] = clamp(
        (NEED.hunger[eid] as number) - ANIMAL_GRAZE_HUNGER_PER_TICK * locData.forage * ANIMALS_CADENCE,
        0,
        NEED_MAX,
      );
      if (locData.water) {
        NEED.thirst[eid] = clamp(
          (NEED.thirst[eid] as number) - ANIMAL_DRINK_THIRST_PER_TICK * ANIMALS_CADENCE,
          0,
          NEED_MAX,
        );
      }

      // СТАДНОСТЬ: отставший тянется к мажоритарной локации стада (первый шаг).
      const herd = ANIM.herd[eid] as number;
      const locCounts = census.herdLoc.get(herd) as Map<number, number>;
      const majLoc = herdMajorityLoc(locCounts);
      if (majLoc !== loc) {
        const step = firstStep(MAP_GRAPH, loc, majLoc);
        // Стадность — корень цепочки (эндогенный экологический драйв, закон №2).
        if (step !== undefined) departTo(bus, eid, loc as LocationId, step as LocationId, null);
      }
    }

    // ── РАЗМНОЖЕНИЕ (обход стад по возрастанию herd, закон №8) ─────────────────
    const herds = Array.from(census.herdSpecies.keys()).sort((a, b) => a - b);
    for (const herd of herds) {
      const speciesCode = census.herdSpecies.get(herd) as number;
      const species = getSpecies(speciesCode);

      // Племенной тик? (детерминированная периодичность, без хранимого таймера).
      if (!isBreedingTick(tick, herd, species.gestationTicks)) continue;

      // Локация рождения = где большинство стада сейчас.
      const locCounts = census.herdLoc.get(herd) as Map<number, number>;
      const loc = herdMajorityLoc(locCounts);

      // ПОРОГИ СОСТОЯНИЯ (причинность, НЕ «X% приплод»):
      const speciesKey = `${speciesCode}#${loc}`;
      const speciesHere = census.speciesLoc.get(speciesKey) ?? 0;
      const herdHere = locCounts.get(loc) ?? 0;
      const forageHere = getLocation(loc).forage;
      if (speciesHere >= species.reproCap) continue; // локальный потолок вида
      if (forageHere <= REPRO_FORAGE_MIN) continue; // голодная земля не плодит
      if (herdHere < REPRO_MIN_HERD_IN_LOC) continue; // нет пары родителей (закон №3)

      // РОЖДЕНИЕ: физически создаём новорождённого (закон №3 — рождён стадом).
      const born = spawnEntity(ecs);
      addComponent(ecs, Animal, born); // зануляет поля (D-024)
      ANIM.species[born] = speciesCode;
      ANIM.herd[born] = herd;

      addComponent(ecs, Position, born); // зануляет loc/dest/eta/moveCause (D-024)
      POS.loc[born] = loc;
      POS.dest[born] = loc; // dest === loc ⇒ стоит на месте (D-019)

      addComponent(ecs, Needs, born); // ниже критич. (D-027): стартовые малые значения
      NEED.hunger[born] = ANIMAL_NEWBORN_NEED;
      NEED.thirst[born] = ANIMAL_NEWBORN_NEED;
      NEED.fatigue[born] = ANIMAL_NEWBORN_NEED;
      NEED.fear[born] = 0;

      addComponent(ecs, Health, born);
      HP.hp[born] = HEALTH_MAX;

      addComponent(ecs, Alive, born);

      bus.publish({
        type: 'animal/born',
        causedBy: null, // экологический порог — корень причинной цепочки (закон №2)
        payload: { eid: born, herd, loc },
      });

      // ПЕРЕПИСЬ ОБНОВЛЯЕТСЯ В ЦИКЛЕ (фикс перескока reproCap при синхронных
      // co-located стадах): `phase(herd)` НЕ инъективна (хеш-коллизии фаз возможны),
      // поэтому два стада ОДНОГО вида в ОДНОЙ локации могут делить племенной тик.
      // Инкремент speciesLoc/herdLoc после рождения гарантирует, что следующее (по
      // отсортированному herd) такое стадо увидит обновлённый счёт и не родит сверх
      // reproCap (детерминированно: какое стадо родит при коллизии фаз — стабильно,
      // обход herds сортирован). Новорождённый физически вступил в стадо в этой
      // локации — перепись обязана это отразить.
      census.speciesLoc.set(speciesKey, speciesHere + 1);
      locCounts.set(loc, herdHere + 1);
    }
  },
};
