/**
 * @module @zona/sim/narrative/significance
 *
 * ФУНДАМЕНТ нарративного хребта Фазы 3 (задача 3.1, D-067): оценка ЗНАЧИМОСТИ события
 * `significance(ev, world)` [0..1] + хранимый аккумулятор ИЗВЕСТНОСТИ `fame` (helpers
 * `getFame`/`incFame`). Это НЕ система (в конвейер не входит, событий не публикует, мир не
 * мутирует, worldgen её не зовёт): чистые нарративные функции живут в новой папке
 * `narrative/` (аналог `systems/`, но без побочных эффектов). Их позовут КАУЗАЛЬНЫМ шагом
 * Chronicle 3.2 (порог значимости → запись «День N: …») и Radio 3.5 (окраска эфира), и они
 * же поднимут `fame` упомянутым сущностям. В самой 3.1 `fame` нигде НЕ инкрементится ⇒ на
 * текущем прогоне значимость работает на БАЗОВЫХ весах (голдены Фазы 3 не двигаются).
 *
 * ══ ЗНАЧИМОСТЬ — ЧИСТАЯ DERIVED ФУНКЦИЯ (закон №2/№8) ═════════════════════════════
 * `significance(ev, world)` детерминирована, БЕЗ rng, НЕ мутирует, НЕ сканирует лог (перф):
 * читает ТОЛЬКО `ev` + состояние мира (`fame` участников из ResourceStore, тип носителя
 * цели). Формула:
 *
 *     raw   = base(ev)  +  bonus(ev)                       // тип события + tier/потери
 *     fameN = maxFame(участники ev) / FAME_CAP  ∈ [0..1]   // самый известный участник
 *     sig   = clamp01( raw + (1 − raw) · fameN · FAME_INFLUENCE )
 *
 * `base(ev)` — таблица весов по ТИПУ из `balance/narrative` (закон №7). Лифт
 * `raw + (1−raw)·…` монотонно тянет значимость к 1.0, НИКОГДА её не превышая (при raw=1,
 * напр. `settlement/abandoned`, значение остаётся 1.0) — кламп страхует от переполнения
 * `bonus`. Так «известнее участник → значимее» (GDD §10.2) выходит непрерывно.
 *
 * ── ТАБЛИЦА ВЕСОВ (обоснование — в balance/narrative.ts) ──────────────────────
 *   settlement/abandoned  1.00  ← ЯКОРЬ-МАКСИМУМ (GDD §10.2)
 *   settlement/built      0.55
 *   entity/died (NPC)     0.48  ← ЯКОРЬ-СМЕРТЬ, + лифт по fame жертвы
 *   encounter/resolved    0.42  (+0.06 за каждого выбывшего)
 *   encounter/started     0.30
 *   artifact/spawned      0.30  (+0.08 за tier)  ← ЯКОРЬ-СРЕДНЕ
 *   loot/transferred      0.28
 *   artifact/collected    0.28
 *   population/arrived    0.22
 *   item/exported         0.12
 *   weather/changed       0.10
 *   entity/died (зверь)   0.10
 *   trade/executed        0.06  ← DoD: смерть > рутинного trade
 *   needs/threshold       0.06
 *   corpse/created        0.06
 *   animal/born / harvested / broughtIn  0.05
 *   item/produced         0.03
 *   perception/spotted / item/consumed   0.02
 *   move/* · task/selected · sim/*        0.00 (шум)
 *   НЕИЗВЕСТНЫЙ ТИП        UNKNOWN_WEIGHT (0.00) — без throw
 *
 * ══ fame — ХРАНИМЫЙ аккумулятор (ResourceStore ключ 'fame', D-050/D-007) ═══════════
 * Число на eid, автосериализуется как money/memory. `getFame`(нет записи)=0. `incFame` —
 * МОНОТОННЫЙ (никогда не убывает в 3.1; decay отложен в 3b) инкремент с CAP, пишет НОВЫМ
 * значением через `resources.set` (D-035). Скан лога для fame ОТКЛОНЁН (O(лог)/оценку =
 * квадрат за прогон, D-006). `fame` РЕПУТАЦИОННО — это не предмет и не деньги: ключ `'fame'`
 * ДИЗЪЮНКТЕН `'money'`/`'inventory'`, EconomyInvariant (D-045) его не видит и не затронут.
 *
 * Пример:
 * ```ts
 * const sig = significance(deathEvent, world);   // 0.48 у анонима, ~0.90 у легенды
 * incFame(world.resources, victimEid, 5);        // позовёт Chronicle/Radio при упоминании
 * ```
 */

import type { EntityId, SimEvent } from '@zona/shared';
import type { ResourceStore } from '../core/world';
import type { SimWorld } from '../core/world';
import {
  FAME_CAP,
  FAME_INFLUENCE,
  UNKNOWN_WEIGHT,
  SETTLEMENT_ABANDONED_WEIGHT,
  SETTLEMENT_BUILT_WEIGHT,
  DEATH_NPC_WEIGHT,
  DEATH_ANIMAL_WEIGHT,
  CORPSE_CREATED_WEIGHT,
  ENCOUNTER_STARTED_WEIGHT,
  ENCOUNTER_RESOLVED_WEIGHT,
  CASUALTY_BONUS,
  LOOT_TRANSFERRED_WEIGHT,
  ARTIFACT_SPAWNED_WEIGHT,
  ARTIFACT_COLLECTED_WEIGHT,
  ARTIFACT_TIER_BONUS,
  POPULATION_ARRIVED_WEIGHT,
  ITEM_EXPORTED_WEIGHT,
  TRADE_EXECUTED_WEIGHT,
  WEATHER_CHANGED_WEIGHT,
  NEEDS_THRESHOLD_WEIGHT,
  ANIMAL_BORN_WEIGHT,
  PERCEPTION_SPOTTED_WEIGHT,
  ITEM_HARVESTED_WEIGHT,
  ITEM_BROUGHT_IN_WEIGHT,
  ITEM_PRODUCED_WEIGHT,
  ITEM_CONSUMED_WEIGHT,
} from '../balance/narrative';

// ══ fame — хранимый аккумулятор известности ═══════════════════════════════════

/** Ключ ResourceStore известности (D-050/D-007: число на eid, автосериализуется). */
export const FAME_KEY = 'fame';

/** Кламп в [0..1] (шкала значимости). */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Известность сущности `eid`; `0`, если записи нет (нет упоминаний в летописи/эфире). */
export function getFame(resources: ResourceStore, eid: EntityId): number {
  return resources.get<number>(FAME_KEY, eid) ?? 0;
}

/**
 * МОНОТОННО поднимает известность `eid` на `delta`, НОВЫМ значением через `resources.set`
 * (D-035). Инвариант 3.1: fame НИКОГДА не убывает (decay отложен в 3b) и не превышает
 * `FAME_CAP` — итог зажат в `[current, FAME_CAP]`, поэтому даже отрицательный/чрезмерный
 * `delta` монотонности не ломает (уходит в no-op / упор в CAP). Значимость на текущем
 * прогоне НЕ зовёт `incFame` (его позовут Chronicle 3.2 / Radio 3.5) ⇒ fame везде 0.
 */
export function incFame(resources: ResourceStore, eid: EntityId, delta: number): void {
  const current = getFame(resources, eid);
  const raised = current + delta;
  // Монотонность + CAP: не ниже текущего, не выше потолка.
  const next = raised < current ? current : raised > FAME_CAP ? FAME_CAP : raised;
  if (next !== current) resources.set<number>(FAME_KEY, eid, next);
}

// ══ Значимость — чистая DERIVED функция ═══════════════════════════════════════

/**
 * Носитель цели ИМЕНОВАН (человек с именем-фамилией, закон №4)? Труп сохраняет 'name' в
 * ResourceStore (Death не удаляет ресурсы), поэтому проверка работает и для покойника;
 * у животного/мутанта имени нет. Для `entity/died` payload сам несёт `name` при наличии —
 * учитываем оба источника, читая «тип носителя цели» из состояния мира (контракт D-067).
 */
function isNamedCarrier(world: SimWorld, eid: EntityId): boolean {
  return world.resources.has('name', eid);
}

/** Максимальная известность среди участников события (0, если участников/записей нет). */
function maxParticipantFame(world: SimWorld, participants: readonly EntityId[]): number {
  let max = 0;
  for (const eid of participants) {
    const f = getFame(world.resources, eid);
    if (f > max) max = f;
  }
  return max;
}

/**
 * Участники события (чьё `fame` масштабирует значимость) — извлекаются из payload по типу.
 * Служебные/шумовые типы участников не имеют ⇒ пустой список (значимость = базовый вес). Это
 * же множество Chronicle (3.2/D-068) берёт СУБЪЕКТАМИ летописной записи и на каждого поднимает
 * `fame` — единый источник истины «кто участвует в событии» (без дублирования switch'а).
 */
export function participantsOf(ev: SimEvent): readonly EntityId[] {
  switch (ev.type) {
    case 'entity/died':
      return ev.payload.killer !== undefined ? [ev.payload.eid, ev.payload.killer] : [ev.payload.eid];
    case 'corpse/created':
      return [ev.payload.eid];
    case 'encounter/started':
      return ev.payload.sides.flat();
    case 'encounter/resolved':
      return ev.payload.casualties;
    case 'loot/transferred':
      return [ev.payload.from, ev.payload.to];
    case 'artifact/collected':
      return [ev.payload.collector];
    case 'population/arrived':
      return [ev.payload.eid];
    case 'trade/executed':
      return [ev.payload.buyer, ev.payload.seller];
    case 'settlement/abandoned':
    case 'settlement/built':
      return [ev.payload.settlement];
    case 'perception/spotted':
      return [ev.payload.observer, ev.payload.target];
    case 'needs/threshold':
      return [ev.payload.eid];
    case 'animal/born':
      return [ev.payload.eid];
    // Служебные, шумовые и леджер-события: участник для масштаба не выделяется.
    default:
      return [];
  }
}

/**
 * БАЗОВЫЙ вес + фиксированные бонусы (tier артефакта, число потерь) события. Читает ТОЛЬКО
 * `ev` + «тип носителя цели» из мира (NPC vs зверь для `entity/died`). Неизвестный тип →
 * `UNKNOWN_WEIGHT` (без throw). Лифт по fame добавляет `significance` поверх этого.
 */
function baseWeight(ev: SimEvent, world: SimWorld): number {
  switch (ev.type) {
    case 'settlement/abandoned':
      return SETTLEMENT_ABANDONED_WEIGHT;
    case 'settlement/built':
      return SETTLEMENT_BUILT_WEIGHT;
    case 'entity/died': {
      const named = ev.payload.name !== undefined || isNamedCarrier(world, ev.payload.eid);
      return named ? DEATH_NPC_WEIGHT : DEATH_ANIMAL_WEIGHT;
    }
    case 'corpse/created':
      return CORPSE_CREATED_WEIGHT;
    case 'encounter/started':
      return ENCOUNTER_STARTED_WEIGHT;
    case 'encounter/resolved':
      return ENCOUNTER_RESOLVED_WEIGHT + ev.payload.casualties.length * CASUALTY_BONUS;
    case 'loot/transferred':
      return LOOT_TRANSFERRED_WEIGHT;
    case 'artifact/spawned':
      return ARTIFACT_SPAWNED_WEIGHT + ev.payload.tier * ARTIFACT_TIER_BONUS;
    case 'artifact/collected':
      return ARTIFACT_COLLECTED_WEIGHT;
    case 'population/arrived':
      return POPULATION_ARRIVED_WEIGHT;
    case 'item/exported':
      return ITEM_EXPORTED_WEIGHT;
    case 'trade/executed':
      return TRADE_EXECUTED_WEIGHT;
    case 'weather/changed':
      return WEATHER_CHANGED_WEIGHT;
    case 'needs/threshold':
      return NEEDS_THRESHOLD_WEIGHT;
    case 'animal/born':
      return ANIMAL_BORN_WEIGHT;
    case 'perception/spotted':
      return PERCEPTION_SPOTTED_WEIGHT;
    case 'item/harvested':
      return ITEM_HARVESTED_WEIGHT;
    case 'item/broughtIn':
      return ITEM_BROUGHT_IN_WEIGHT;
    case 'item/produced':
      return ITEM_PRODUCED_WEIGHT;
    case 'item/consumed':
      return ITEM_CONSUMED_WEIGHT;
    // move/departed, move/arrived, task/selected, sim/tickStarted, sim/snapshotTaken → шум.
    default:
      return UNKNOWN_WEIGHT;
  }
}

/**
 * ЗНАЧИМОСТЬ события `ev` ∈ [0..1] (задача 3.1, D-067). ЧИСТАЯ DERIVED функция: детерминирована,
 * БЕЗ rng (закон №2/№8), НЕ мутирует мир, НЕ сканирует лог. `raw` = базовый вес типа + бонусы
 * (tier/потери); затем масштаб по известности САМОГО ИЗВЕСТНОГО участника: `sig = raw +
 * (1−raw)·fameN·FAME_INFLUENCE`, клампится в [0..1]. Пока (3.1) fame везде 0 ⇒ значимость =
 * clamp01(raw), т.е. чистые базовые веса; Chronicle 3.2 / Radio 3.5 поднимут fame и «оживят» лифт.
 */
export function significance(ev: SimEvent, world: SimWorld): number {
  const raw = baseWeight(ev, world);
  const fameNorm = maxParticipantFame(world, participantsOf(ev)) / FAME_CAP;
  const lifted = raw + (1 - raw) * fameNorm * FAME_INFLUENCE;
  return clamp01(lifted);
}
