/**
 * @module @zona/sim/systems/death
 *
 * Система Death (задача 1.11, B.1) — превращает добитую сущность в ТРУП. Это
 * ПОСЛЕДНЯЯ система тика (после Needs/Encounters/Animals): к её запуску весь урон
 * этого тика уже применён в `Health.hp`, поэтому детекция «умер» видит финальное hp.
 *
 * Главный тест закона №1: смерть работает без игрока — сталкер сам оголодал
 * (Needs 1.5) или проиграл бой (Encounters 1.10b), его `Health.hp` ушёл <= 0, и
 * Death сам снимает его с «живых» и оставляет труп с лутом. Ни спавна, ни скрипта.
 *
 * ── ДЕТЕКЦИЯ (resume-safe, БЕЗ рантайм-флага; закон №8, P0) ───────────────────
 * «Умер» = сущность несёт тег `Alive` И `Health.hp <= 0`. Обход `queryEntities([Alive])`
 * (сорт. по eid) ∩ (hp <= 0). Death СНИМАЕТ `Alive` при обработке, поэтому на
 * следующем тике/после load покойник УЖЕ не в запросе — повторного `entity/died`
 * нет. Флаг «уже умер» — это САМО ОТСУТСТВИЕ тега `Alive` (сериализуется задачей 1.0
 * → resume-safe), а не in-memory Set (тот не пережил бы snapshot и дал бы дубль).
 * Прямой аналог prev-детекции порога в Needs (1.5): состояние, а не рантайм-память.
 *
 * ── ПРЕОБРАЗОВАНИЕ В ТРУП ────────────────────────────────────────────────────
 * СНИМАЕМ: `Alive`, а также `Needs`/`Task`/`Animal` (если есть) — мёртвому не нужны
 * физиология, задача и видо-поведение. ВЕШАЕМ `Corpse`. ОСТАВЛЯЕМ: `Position` (труп
 * где-то лежит), `Health` (hp<=0 — маркер трупа), «холодные» ресурсы `name`+`inventory`
 * (личность и ЛУТ покойника). Труп НЕ удаляется (`destroyEntity`) — он ПЕРСИСТИТ,
 * чтобы лут физически существовал (закон №3) и летопись ссылалась на него. Тег
 * `Human` НЕ снимаем: он говорит, что труп был человеком (для будущей разделки/лута).
 * Распад и лутание трупов — БУДУЩАЯ фаза (см. хвост DECISIONS 1.11).
 *
 * ── ПРИЧИННОСТЬ (закон №6, D-030): смерть НЕ создаёт причину, а НАСЛЕДУЕТ ───────
 * `entity/died.causedBy` = `Health.lethalCause` (0 → null): id `encounter/resolved`
 * (бой, штамп Encounters) или `needs/threshold` (голод/жажда, штамп Needs-ретрофита
 * 1.11). Так обе смерти ОБЪЯСНИМЫ до корня: `encounter/started → resolved → died`
 * и `needs/threshold → died`. `corpse/created.causedBy` = id `entity/died` (труп есть
 * следствие смерти).
 *
 * Метка `cause` (`'combat'`/`'starvation'`/`'thirst'`/`'unknown'`) ВТОРИЧНА (главное —
 * `causedBy`). Выводим её РАЗОВО из типа события-причины, читая committed-лог по id
 * (смерть редка — не hot-path; НЕ сканируем лог каждый тик для каждого живого):
 *  • найдено `encounter/resolved` → 'combat'; `needs/threshold` → 'thirst'/'starvation';
 *  • lethalCause == 0 → 'unknown' (причина не проштампована, напр. «рождён критическим»);
 *  • lethalCause != 0, но события НЕТ в committed-логе ⇒ оно опубликовано В ЭТОМ ЖЕ
 *    тике (Death последняя, буфер ещё не зафиксирован endTick, D-005). В Фазе 1
 *    ЕДИНСТВЕННЫЙ внутритиковый штамповщик lethalCause — Encounters (бой), т.к.
 *    Needs штампует порог за МНОГО тиков до того, как hp дотает до <=0 (тот id давно
 *    в логе). Поэтому «не в логе» ⇒ 'combat'. Связь `causedBy` при этом всё равно
 *    точна: оба события окажутся в логе после endTick этого тика.
 *
 * ── ДЕТЕРМИНИЗМ (закон №8) ────────────────────────────────────────────────────
 * rng не используется. Обход покойников — по возрастанию eid; события каждого
 * покойника (`entity/died` затем `corpse/created`) — в фикс. порядке. items трупа
 * сортируются по itemId. Два прогона на одном seed → идентичный лог смертей.
 */

import type { EntityId, EventId, ItemId, LocationId, SimEvent } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, removeComponent, addComponent } from '../core/ecs';
import { Position, Health, Needs, Task, Animal, Alive, Corpse } from '../core/components';

/** Ключи ResourceStore (форма — как пишет worldgen 1.3 / Encounters 1.10b). */
const NAME_KEY = 'name';
const INVENTORY_KEY = 'inventory';

/** Метка вида причины смерти для `entity/died.payload.cause`. */
type DeathCause = 'combat' | 'starvation' | 'thirst' | 'unknown';

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array };
const HP = Health as unknown as { readonly hp: Float32Array; readonly lethalCause: Uint32Array };

/** Имя покойника в ResourceStore (D-007). Совпадает с записью worldgen 1.3. */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/** Единица инвентаря в ResourceStore (ссылка на предмет + количество, закон №3). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** ui32-поле причины (0 = «нет причины», D-031) → `EventId | null`. */
function causeOrNull(id: number): EventId | null {
  return id === 0 ? null : (id as EventId);
}

/**
 * Находит событие с заданным `id` в committed-логе БИНАРНЫМ поиском (лог сорт. по
 * id по возрастанию; id монотонны, но с возможными пропусками от discardTick, C-4).
 * Возвращает событие или `undefined`, если оно не зафиксировано (пропуск/буфер).
 */
function findEventById(log: readonly SimEvent[], id: number): SimEvent | undefined {
  let lo = 0;
  let hi = log.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ev = log[mid] as SimEvent;
    if (ev.id === id) return ev;
    if (ev.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * Выводит метку `cause` из `lethalCause` (id причины). Читает committed-лог по id
 * (см. docblock): найденный тип → метка; не найдено при ненулевом id ⇒ причина
 * опубликована в этом тике (Фаза 1: только Encounters) ⇒ 'combat'; 0 → 'unknown'.
 */
function deriveCause(log: readonly SimEvent[], lethalCause: number): DeathCause {
  if (lethalCause === 0) return 'unknown';
  const ev = findEventById(log, lethalCause);
  if (ev === undefined) return 'combat'; // внутритиковый штамп → бой (Фаза 1)
  if (ev.type === 'encounter/resolved') return 'combat';
  if (ev.type === 'needs/threshold') {
    return ev.payload.need === 'thirst' ? 'thirst' : 'starvation';
  }
  return 'unknown';
}

/** Полное имя покойника «first last» для летописи (закон №4), либо undefined. */
function fullName(rec: NameRecord | undefined): string | undefined {
  if (rec === undefined) return undefined;
  return `${rec.first} ${rec.last}`;
}

/**
 * Инвентарь покойника парами `[itemId, qty]`, сорт. по itemId (детерминизм, №8);
 * пустой массив, если инвентаря нет. Труп физически несёт этот лут (закон №3).
 */
function corpseItems(inv: readonly InventoryEntry[] | undefined): ReadonlyArray<readonly [ItemId, number]> {
  if (inv === undefined || inv.length === 0) return [];
  return inv
    .map((e) => [e.item, e.qty] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Система Death (`every: 1`, ПОСЛЕДНЯЯ в тике). Превращает каждого носителя `Alive`
 * с `Health.hp <= 0` в персистентный труп: снимает Alive/Needs/Task/Animal, вешает
 * Corpse, публикует `entity/died` (причина = lethalCause) и `corpse/created` (лут).
 */
export const Death: System = {
  name: 'Death',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;

    // Детекция: носители Alive с hp<=0. Нужен Health, чтобы читать hp (иначе — не наш
    // случай смерти по здоровью). queryEntities отдаёт по возрастанию eid (закон №8).
    const dying: EntityId[] = [];
    for (const eid of queryEntities(ecs, [Alive])) {
      if (!hasComponent(ecs, Health, eid)) continue;
      if ((HP.hp[eid] as number) <= 0) dying.push(eid);
    }
    if (dying.length === 0) return;

    // committed-лог для вывода метки cause (снимаем КОПИЮ раз на тик — смерть редка,
    // но несколько одновременных смертей не должны копировать лог на каждую).
    const log = bus.log;

    for (const eid of dying) {
      // ПРИЧИНА: наследуем из lethalCause (0 → null). Метку выводим из типа события.
      const lethalCause = HP.lethalCause[eid] as number;
      const causedBy = causeOrNull(lethalCause);
      const cause = deriveCause(log, lethalCause);

      // ИМЯ (закон №4): у человека — есть; у животного записи 'name' нет → опустим.
      const name = fullName(world.resources.get<NameRecord>(NAME_KEY, eid));

      // ЛУТ: инвентарь трупа [itemId,qty]. Остаётся на трупе (закон №3, не переносим).
      const items = corpseItems(world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid));
      const loc = POS.loc[eid] as LocationId;

      // ПРЕОБРАЗОВАНИЕ: снять Alive + физиологию/задачу/видо-поведение, повесить Corpse.
      // Position/Health/ResourceStore(name+inventory) ОСТАЮТСЯ — труп несёт лут и лежит.
      removeComponent(ecs, Alive, eid);
      if (hasComponent(ecs, Needs, eid)) removeComponent(ecs, Needs, eid);
      if (hasComponent(ecs, Task, eid)) removeComponent(ecs, Task, eid);
      if (hasComponent(ecs, Animal, eid)) removeComponent(ecs, Animal, eid);
      addComponent(ecs, Corpse, eid);

      // entity/died (причина наследована), затем corpse/created (следствие смерти).
      const diedId = bus.publish({
        type: 'entity/died',
        causedBy,
        payload: name === undefined ? { eid, cause } : { eid, name, cause },
      });
      bus.publish({
        type: 'corpse/created',
        causedBy: diedId,
        payload: { eid, loc, items },
      });
    }
  },
};
