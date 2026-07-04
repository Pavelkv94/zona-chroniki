/**
 * @module @zona/sim/systems/encounters
 *
 * Система Encounters (задачи 1.10b + 2.11, B.1) — ЗАВЯЗКА и РАЗРЕШЕНИЕ столкновений
 * из СОСТОЯНИЯ мира. Один и тот же код разрешает ЛЮБОЕ столкновение через единый
 * резолвер (`encounter-resolver`, D-022): охоту человек-vs-животное (Фаза 1) и
 * грабёж человек-vs-человек (Фаза 2, задача 2.11, D-049/D-060). Система только
 * ДЕТЕКТИРУЕТ бой (кто с кем), собирает `Combatant`-стороны, зовёт резолвер и
 * ПРИМЕНЯЕТ исход к миру. Вся боевая арифметика/rng — в резолвере; здесь — только
 * ECS/шина/инвентарь (закон №6).
 *
 * Главный тест закона №1: работает без игрока — сталкер сам выбрал HUNT/ROB
 * (TaskSelection), сам дошёл (Movement) и здесь сам стреляет; мясо/лут появляются у
 * победителя из ТУШИ/ПРОИГРАВШЕГО (закон №3), патроны ФИЗИЧЕСКИ уходят из инвентаря.
 *
 * ── ДЕТЕКЦИЯ ОХОТЫ (человек-vs-животное, детерминированно, сорт.) ─────────────
 * Кандидат-охотник: человек (Human, Alive) с `Task.kind===HUNT`, СТОЯЩИЙ
 * (`Position.dest===loc`), в локации которого есть ЖИВОЕ животное. Цель = его
 * `Task.targetEid`, если это живое Animal в ЕГО локации (existsEntity+Alive+Animal+
 * co-located, D-029); иначе (targetEid устарел) — любое живое Animal в его локации
 * с МИН eid. Охотники группируются по (loc, цель): несколько охотников на ОДНУ дичь
 * → одна сторона side0; сторона side1 — сама дичь.
 *
 * ── ДЕТЕКЦИЯ ГРАБЕЖА (человек-vs-человек, задача 2.11, D-060) ─────────────────
 * Кандидат-грабитель: человек (Human, Alive) с `Task.kind===ROB`, СТОЯЩИЙ
 * (`Position.dest===loc`), чья цель `Task.targetEid` — СУЩЕСТВУЮЩИЙ живой Human в
 * ЕГО локации (existsEntity+Alive+Human+co-located, тот же гейт цели, что у HUNT;
 * БЕЗ fallback — нет валидной цели ⇒ грабежа нет). Грабители группируются по (loc,
 * цель): side0 — грабители, side1 — САМА ЦЕЛЬ (ЗАЩИЩАЕТСЯ как полноценный Combatant,
 * не пассивная жертва — стреляет своим оружием/патронами). ВНИМАНИЕ (изоляция):
 * решение ВЫБРАТЬ ROB — задача 2.12; пока НИКТО в живом мире не выбирает ROB, эта
 * ветка ДРЕМЛЕТ ⇒ голдены Фазы 1 не сдвигаются (тот же паттерн, что ArtifactSearch/
 * Trade без своих полей). Blanket-агрессии по фракционной вражде здесь НЕТ — грабёж
 * driven ТОЛЬКО задачей ROB (утилити-грабёж одиночек/обход групп — эмерджентно 2.12).
 *
 * ── СБОРКА Combatant (D-022) ─────────────────────────────────────────────────
 *  • человек (охотник/грабитель/защищающаяся цель): power = `shooting ×
 *    HUMAN_WEAPON_POWER` при наличии совместимого оружия+патронов (иначе 0 —
 *    безоружный); ammo = кол-во патронов калибра оружия; melee = `HUMAN_UNARMED_MELEE`;
 *    health = `Health.hp`. ЕДИНАЯ сборка `humanCombatant` для ЛЮБОЙ стороны-человека.
 *  • животное: power/melee из species.json, ammo=0, health = `Health.hp`.
 * Вид/тип НЕ хардкодится в резолвере — числа комбатанта абстрактны (D-022).
 *
 * ── ПРИЧИННОСТЬ (закон №6, D-030) ────────────────────────────────────────────
 * `encounter/started.causedBy` = `spottedEvent` цели из `contacts` атакующего
 * (мин-eid атакующего; id того `perception/spotted`, что свёл их) → иначе
 * `Task.causeEvent` (штамп `task/selected`) → иначе null.
 * `encounter/resolved.causedBy` = id `encounter/started`.
 * `loot/transferred.causedBy` = id `encounter/resolved` (перевод лута — следствие исхода).
 * Убитым штампуется `Health.lethalCause = id encounter/resolved` (D-030): смерть
 * снимет Death (1.11), взяв причину из этого поля. Encounters сам НЕ удаляет и НЕ
 * помечает Corpse — только `hp<=0` + `lethalCause`.
 *
 * ── ПРИМЕНЕНИЕ ИСХОДА (закон №3) + ЛЕДЖЕР МАССЫ (D-045) ───────────────────────
 *  • Патроны: у каждого стрелка (ЛЮБОЙ стороны) инвентарь уменьшается на
 *    `ammoSpent` — НОВЫЙ массив через `resources.set` (не in-place), списываются
 *    патроны совместимого калибра. Каждый ФАКТИЧЕСКИ израсходованный ammo-предмет
 *    публикует `item/consumed` (reason:'combat', `causedBy`=id `encounter/resolved`)
 *    — уничтожение массы видимо EconomyInvariant.
 *  • Здоровье: выжившим пишем `Health.hp` из итогового `Combatant.health`.
 *  • Убитые: `hp<=0` + `stampCause(lethalCause)`; НЕ удаляем (Death 1.11).
 *  • Мясо (только ОХОТА): за каждое убитое ЖИВОТНОЕ из `loot` победитель-охотник
 *    (side победы, мин eid) получает `meatYield` мяса (источник — ТУША, закон №3) и
 *    публикует `item/harvested` (source:'carcass', `causedBy`=id `encounter/resolved`)
 *    — создание массы видимо EconomyInvariant.
 *
 * ── ПЕРЕВОД ЛУТА (только ГРАБЁЖ, закон №3, D-049 «лут — перевод конс.») ────────
 * ПОЛИТИКА: победитель забирает ВЕСЬ инвентарь И ВСЕ деньги ПРОИГРАВШЕГО (не «часть/
 * ценное»). Обоснование: (1) простота и полнота — не нужна произвольная классификация
 * «ценного»; (2) БИТ-В-БИТ сохранение массы — Σ денег и Σ каждого предмета мира НЕ
 * меняются (лут физически переехал, ничего не создано/уничтожено), поэтому это
 * ПЕРЕВОД, а НЕ леджер (EconomyInvariant дельта 0, как торговля D-047); (3) НЕТ
 * ДВОЙНОГО УЧЁТА с трупом (D-041): Encounters ИДЁТ ДО Death в тике, поэтому лут
 * снимается с проигравшего РАНЬШЕ, чем Death делает труп — труп несёт УЖЕ пустой
 * инвентарь (лут на победителе; масса не задвоилась и не исчезла). Условие перевода:
 * `disposition==='sideWon'` и есть живой победитель-человек; проигравшая сторона —
 * ВСЕ её бойцы (мёртвые И сбежавшие), получатель — МИН-eid ЖИВОЙ человек победившей
 * стороны. Симметрично: если ЦЕЛЬ защитилась и победила — грабит уже она напавших
 * (проигравший→победитель, без спец-случая инициатора). В 1v1 проигравший всегда
 * ГИБНЕТ (сторона из 1 бойца не «ломается живой»: порог морали требует потери =
 * смерти) ⇒ типичный грабёж = труп обчищен. Перевод — НОВЫМИ массивами через
 * `resources.set` (D-035); `loot/transferred` эмитится лишь когда что-то реально
 * перешло. Никакого леджера `item/*` — переводы массу СОХРАНЯЮТ (D-045).
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (законы №8, P0) ──────────────────────────────────────
 * Локации/животные/атакующие обходятся по возрастанию (сорт. ключи); бои сорт. по
 * (loc, target). rng — ТОЛЬКО `ctx.rng.fork(`encounter@${tick}#${loc}#${target}`)`
 * на разброс попадания: метка УНИКАЛЬНА на (tick, loc, target) — цели охоты
 * (животные) и грабежа (люди) имеют непересекающиеся eid ⇒ метки не коллидируют,
 * два одновременных боя получают НЕЗАВИСИМЫЕ потоки. Поток stateless (выводится из
 * label, D-004). Бой резолвится ЦЕЛИКОМ в одном тике ⇒ нет боевого состояния между
 * тиками ⇒ непрерывный прогон ≡ split save/load (P0). Порядок в тике (B.1): после
 * Movement/TaskEffects, ДО Animals/Death.
 */

import type { Contact, EntityId, EventId, ItemId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, existsEntity, stampCause } from '../core/ecs';
import { Position, Task, Skills, Health, Animal, Human, Alive, TaskKind } from '../core/components';
import { getSpecies, getItem } from '../data/index';
import { MAX_ROUNDS, HUMAN_WEAPON_POWER, HUMAN_UNARMED_MELEE } from '../balance/combat';
import { resolveEncounter, type Combatant } from './encounter-resolver';

/** Ключи ResourceStore (форма — как пишет worldgen 1.3 / Perception 1.7 / Trade 2.5). */
const INVENTORY_KEY = 'inventory';
const MONEY_KEY = 'money';
const CONTACTS_KEY = 'contacts';

/** itemId мяса (источник — туша убитого животного, закон №3; есть в items.json). */
const MEAT_ITEM = 'meat';

/** Единица инвентаря (та же форма, что пишет worldgen 1.3, сорт. по item). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

/** Вид боя: охота человек-vs-животное или грабёж человек-vs-человек (2.11). */
type BattleKind = 'hunt' | 'rob';

/** Свёрнутый бой: сторона-атакующие (side0) против одной цели (side1). */
interface Battle {
  readonly loc: number;
  readonly target: EntityId;
  readonly attackers: EntityId[]; // side0, сорт. по eid (queryEntities)
  readonly kind: BattleKind;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array; readonly dest: Uint32Array };
const TSK = Task as unknown as {
  readonly kind: Uint8Array;
  readonly targetEid: Uint32Array;
  readonly causeEvent: Uint32Array;
};
const SKILL = Skills as unknown as { readonly shooting: Float32Array };
const HP = Health as unknown as { hp: Float32Array };
const ANIM = Animal as unknown as { readonly species: Uint8Array };

/** ui32-поле причины (0 = «нет причины», D-031) → `EventId | null`. */
function causeOrNull(id: number): EventId | null {
  return id === 0 ? null : (id as EventId);
}

/**
 * Стрелковый профиль человека из инвентаря: находит ПЕРВОЕ оружие (сорт. по item)
 * и суммирует патроны СОВПАДАЮЩЕГО калибра. Без оружия — ammo=0/hasWeapon=false
 * (безоружный опирается на melee). Детерминизм: inv отсортирован по item (worldgen).
 */
function shooterProfile(inv: readonly InventoryEntry[] | undefined): {
  ammo: number;
  hasWeapon: boolean;
} {
  if (inv === undefined) return { ammo: 0, hasWeapon: false };
  let caliber: string | undefined;
  for (const e of inv) {
    if (e.qty <= 0) continue;
    const item = getItem(e.item);
    if (item.kind === 'weapon' && item.caliber !== undefined) {
      caliber = item.caliber;
      break; // первое оружие по отсортированному инвентарю
    }
  }
  if (caliber === undefined) return { ammo: 0, hasWeapon: false };
  let ammo = 0;
  for (const e of inv) {
    if (e.qty <= 0) continue;
    const item = getItem(e.item);
    if (item.kind === 'ammo' && item.caliber === caliber) ammo += e.qty;
  }
  return { ammo, hasWeapon: true };
}

/**
 * Собирает `Combatant` человека `eid` на стороне `side` из инвентаря/навыка/hp —
 * ЕДИНАЯ сборка для ЛЮБОЙ стороны-человека (охотник, грабитель, защищающаяся цель):
 * power = shooting×оружие (0 без оружия), ammo/melee/health (D-022). Кладёт инвентарь
 * человека в `humanInv` (по нему потом списываются патроны). Идентична прежней
 * инлайн-сборке охотника ⇒ путь HUNT байт-в-байт неизменен.
 */
function humanCombatant(
  ctx: SystemCtx,
  eid: EntityId,
  side: number,
  humanInv: Map<EntityId, readonly InventoryEntry[]>,
): Combatant {
  const ecs = ctx.world.ecs;
  const inv = ctx.world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid);
  if (inv !== undefined) humanInv.set(eid, inv);
  const prof = shooterProfile(inv);
  const shooting = hasComponent(ecs, Skills, eid) ? (SKILL.shooting[eid] as number) : 0;
  const power = prof.hasWeapon ? shooting * HUMAN_WEAPON_POWER : 0;
  return {
    eid,
    side,
    power,
    ammo: prof.hasWeapon ? prof.ammo : 0,
    melee: HUMAN_UNARMED_MELEE,
    health: HP.hp[eid] as number,
  };
}

/**
 * Списывает `spent` патронов совместимого с оружием калибра из инвентаря стрелка —
 * НОВЫЙ массив (не in-place, закон №3: сумма патронов уменьшается ровно на spent).
 * Списывает с ammo-записей того же калибра, что и первое оружие, по порядку;
 * опустевшие записи выпадают (сортировка по item сохраняется). Возвращает пары
 * `[itemId, кол-во]` ФАКТИЧЕСКИ списанных патронов (сорт. по порядку инвентаря =
 * по item) — вызывающий публикует по ним леджер `item/consumed` (D-045). Пустой
 * массив — если списывать нечего (spent<=0 или нет патронов калибра).
 */
function spendAmmo(
  resources: SystemCtx['world']['resources'],
  eid: EntityId,
  inv: readonly InventoryEntry[],
  spent: number,
): ReadonlyArray<readonly [string, number]> {
  // Калибр оружия (как в shooterProfile).
  let caliber: string | undefined;
  for (const e of inv) {
    if (e.qty <= 0) continue;
    const item = getItem(e.item);
    if (item.kind === 'weapon' && item.caliber !== undefined) {
      caliber = item.caliber;
      break;
    }
  }
  let remaining = spent;
  const next: InventoryEntry[] = [];
  const consumed: Array<readonly [string, number]> = [];
  for (const e of inv) {
    const item = getItem(e.item);
    if (remaining > 0 && item.kind === 'ammo' && item.caliber === caliber && e.qty > 0) {
      const take = Math.min(remaining, e.qty);
      remaining -= take;
      consumed.push([e.item, take]);
      const left = e.qty - take;
      if (left > 0) next.push({ item: e.item, qty: left });
      // left===0 ⇒ запись выпадает (патроны исчерпаны).
    } else {
      next.push(e);
    }
  }
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, next);
  return consumed;
}

/**
 * Добавляет `qty` мяса в инвентарь победителя — НОВЫЙ массив (не in-place), мержит
 * с существующей записью 'meat' и сохраняет сортировку по item (источник — туша,
 * закон №3). Если инвентаря нет — создаёт со стеком мяса.
 */
function addMeat(
  resources: SystemCtx['world']['resources'],
  eid: EntityId,
  qty: number,
): void {
  const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
  const next: InventoryEntry[] = [];
  let merged = false;
  for (const e of inv) {
    if (e.item === MEAT_ITEM) {
      next.push({ item: MEAT_ITEM, qty: e.qty + qty });
      merged = true;
    } else {
      next.push(e);
    }
  }
  if (!merged) next.push({ item: MEAT_ITEM, qty });
  // Сортировка по item (детерминизм и совместимость с потребителями, закон №8).
  next.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, next);
}

/**
 * ПЕРЕВОД лута проигравшего `from` победителю `to` (грабёж 2.11, D-049/D-060): ВЕСЬ
 * инвентарь И ВСЕ деньги `from` переезжают к `to` — НОВЫМИ массивами (D-035),
 * `from` обнуляется (труп/беглец пуст). СОХРАНЕНИЕ МАССЫ бит-в-бит: Σ мира не
 * меняется (перевод, НЕ леджер — EconomyInvariant дельта 0). Публикует
 * `loot/transferred` (`causedBy`=id `encounter/resolved`) ТОЛЬКО если реально что-то
 * перешло. Порядок: труп ещё не создан (Encounters до Death) ⇒ нет двойного учёта.
 */
function transferLoot(
  resources: SystemCtx['world']['resources'],
  bus: SystemCtx['bus'],
  from: EntityId,
  to: EntityId,
  loc: number,
  cause: EventId | null,
): void {
  const fromInv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, from) ?? [];
  const fromMoney = resources.get<number>(MONEY_KEY, from) ?? 0;

  // Что реально перейдёт (qty>0), сорт. по item — для события и слияния.
  const moved = fromInv
    .filter((e) => e.qty > 0)
    .map((e) => [e.item as ItemId, e.qty] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  if (fromMoney <= 0 && moved.length === 0) return; // проигравший гол — ничего не перешло

  // Слияние инвентаря from В инвентарь to (сумма qty по item, сорт. по item).
  const toInv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, to) ?? [];
  const merged = new Map<string, number>();
  for (const e of toInv) merged.set(e.item, (merged.get(e.item) ?? 0) + e.qty);
  for (const e of fromInv) if (e.qty > 0) merged.set(e.item, (merged.get(e.item) ?? 0) + e.qty);
  const nextTo: InventoryEntry[] = [];
  for (const item of Array.from(merged.keys()).sort()) {
    const qty = merged.get(item) as number;
    if (qty > 0) nextTo.push({ item, qty });
  }
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, to, nextTo);
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, from, []); // проигравший обчищен

  // Деньги: from → to (обнуляем from только если было что переводить).
  if (fromMoney > 0) {
    const toMoney = resources.get<number>(MONEY_KEY, to) ?? 0;
    resources.set<number>(MONEY_KEY, to, toMoney + fromMoney);
    resources.set<number>(MONEY_KEY, from, 0);
  }

  bus.publish({
    type: 'loot/transferred',
    causedBy: cause,
    payload: { from, to, items: moved, money: fromMoney, loc: loc as LocationId },
  });
}

/** spottedEvent цели `target` из contacts наблюдателя `eid` (>0) или -1, если нет. */
function spottedEventFor(
  resources: SystemCtx['world']['resources'],
  eid: EntityId,
  target: EntityId,
): number {
  const contacts = resources.get<readonly Contact[]>(CONTACTS_KEY, eid);
  if (contacts === undefined) return -1;
  for (const c of contacts) {
    if (c.target === target) return c.spottedEvent;
  }
  return -1;
}

/**
 * Система Encounters (`every: 1`). Детектит бои охотник-vs-дичь (HUNT) и грабёж
 * человек-vs-человек (ROB) по состоянию, резолвит их единым резолвером и применяет
 * исход (патроны/hp/lethalCause/мясо/перевод лута).
 */
export const Encounters: System = {
  name: 'Encounters',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;
    const ecs = world.ecs;

    // ── Живые животные по локациям (сорт. по eid внутри бакета) ────────────────
    const animalsByLoc = new Map<number, EntityId[]>();
    for (const a of queryEntities(ecs, [Animal, Alive, Position, Health])) {
      if ((HP.hp[a] as number) <= 0) continue; // убит, но ещё не снят Death (1.11) — не цель
      const l = POS.loc[a] as number;
      if ((POS.dest[a] as number) !== l) continue; // в пути — не участвует
      let bucket = animalsByLoc.get(l);
      if (bucket === undefined) {
        bucket = [];
        animalsByLoc.set(l, bucket);
      }
      bucket.push(a); // queryEntities отдаёт по возрастанию eid ⇒ бакет сорт.
    }

    // ── Бои по ключу `${loc}#${target}` (охота И грабёж; цели-животные и цели-люди
    // имеют непересекающиеся eid ⇒ ключи не коллидируют). ───────────────────────
    const battles = new Map<string, Battle>();

    // ОХОТА: человек с HUNT, стоящий, в локации с живой дичью → бой с животным-целью.
    if (animalsByLoc.size > 0) {
      for (const h of queryEntities(ecs, [Human, Alive, Task, Position, Health])) {
        if ((TSK.kind[h] as number) !== TaskKind.HUNT) continue;
        if ((HP.hp[h] as number) <= 0) continue; // убит, но ещё не снят Death — не охотится
        const loc = POS.loc[h] as number;
        if ((POS.dest[h] as number) !== loc) continue; // не стоит — ещё в пути к дичи
        const localAnimals = animalsByLoc.get(loc);
        if (localAnimals === undefined || localAnimals.length === 0) continue;

        // Цель: Task.targetEid, если это живое co-located Animal; иначе мин-eid дичь тут.
        let target = TSK.targetEid[h] as EntityId;
        const validTarget =
          target !== 0 &&
          existsEntity(ecs, target) &&
          hasComponent(ecs, Animal, target) &&
          hasComponent(ecs, Alive, target) &&
          hasComponent(ecs, Health, target) &&
          (HP.hp[target] as number) > 0 &&
          (POS.loc[target] as number) === loc;
        if (!validTarget) target = localAnimals[0] as EntityId; // мин-eid дичь в локации

        const key = `${loc}#${target}`;
        let battle = battles.get(key);
        if (battle === undefined) {
          battle = { loc, target, attackers: [], kind: 'hunt' };
          battles.set(key, battle);
        }
        battle.attackers.push(h); // queryEntities сорт. ⇒ attackers по возрастанию eid
      }
    }

    // ГРАБЁЖ (2.11): человек с ROB, стоящий, чья цель — живой co-located Human → бой.
    // БЕЗ fallback: невалидная цель ⇒ грабежа нет (в живом мире ROB пока никто не
    // выбирает ⇒ ветка дремлет, голдены Фазы 1 стабильны). Цель ЗАЩИЩАЕТСЯ (side1).
    for (const r of queryEntities(ecs, [Human, Alive, Task, Position, Health])) {
      if ((TSK.kind[r] as number) !== TaskKind.ROB) continue;
      if ((HP.hp[r] as number) <= 0) continue; // убит, но ещё не снят Death — не грабит
      const loc = POS.loc[r] as number;
      if ((POS.dest[r] as number) !== loc) continue; // ещё в пути к цели — не стоит

      const target = TSK.targetEid[r] as EntityId;
      const validTarget =
        target !== 0 &&
        existsEntity(ecs, target) &&
        hasComponent(ecs, Human, target) &&
        hasComponent(ecs, Alive, target) &&
        hasComponent(ecs, Health, target) &&
        (HP.hp[target] as number) > 0 &&
        (POS.loc[target] as number) === loc &&
        (POS.dest[target] as number) === loc; // цель тоже СТОИТ здесь (co-located, не в пути)
      if (!validTarget) continue;
      if (target === r) continue; // не грабит сам себя (страховка)

      const key = `${loc}#${target}`;
      let battle = battles.get(key);
      if (battle === undefined) {
        battle = { loc, target, attackers: [], kind: 'rob' };
        battles.set(key, battle);
      }
      battle.attackers.push(r); // сорт. по eid
    }

    if (battles.size === 0) return;

    // ── Резолвим бои в ДЕТЕРМИНИРОВАННОМ порядке (сорт. по loc, затем target) ───
    const ordered = Array.from(battles.values()).sort(
      (a, b) => (a.loc - b.loc) || (a.target - b.target),
    );

    for (const battle of ordered) {
      const { loc, target, attackers, kind } = battle;

      // Стороны: side0 — атакующие (люди); side1 — цель (животное или защищающийся
      // человек). Combatant с числами (D-022).
      const eidToCombatant = new Map<EntityId, Combatant>();
      const humanInv = new Map<EntityId, readonly InventoryEntry[]>();

      const side0: Combatant[] = [];
      for (const h of attackers) {
        const c = humanCombatant(ctx, h, 0, humanInv);
        side0.push(c);
        eidToCombatant.set(h, c);
      }

      let side1: Combatant[];
      if (kind === 'hunt') {
        const species = getSpecies(ANIM.species[target] as number);
        const animalCombatant: Combatant = {
          eid: target,
          side: 1,
          power: species.power,
          ammo: 0,
          melee: species.melee,
          health: HP.hp[target] as number,
        };
        eidToCombatant.set(target, animalCombatant);
        side1 = [animalCombatant];
      } else {
        // Грабёж: цель — ЗАЩИЩАЮЩИЙСЯ человек (полноценный Combatant, стреляет в ответ).
        const defender = humanCombatant(ctx, target, 1, humanInv);
        eidToCombatant.set(target, defender);
        side1 = [defender];
      }

      // Причина: spottedEvent цели из contacts мин-eid атакующего → Task.causeEvent → null.
      const leadAttacker = attackers[0] as EntityId;
      let cause: EventId | null = null;
      const spotted = spottedEventFor(world.resources, leadAttacker, target);
      if (spotted > 0) {
        cause = spotted as EventId;
      } else {
        cause = causeOrNull(TSK.causeEvent[leadAttacker] as number);
      }

      // encounter/started.
      const startedId = bus.publish({
        type: 'encounter/started',
        causedBy: cause,
        payload: {
          sides: [attackers.slice(), [target]],
          loc: loc as LocationId,
        },
      });

      // Резолвер: rng ТОЛЬКО на разброс. Метка УНИКАЛЬНА на (tick, loc, target).
      const outcome = resolveEncounter({
        loc: loc as LocationId,
        sides: [side0, side1],
        cause,
        rng: ctx.rng.fork(`encounter@${tick}#${loc}#${target}`),
        maxRounds: MAX_ROUNDS,
      });

      // encounter/resolved (причина — started).
      const resolvedId = bus.publish({
        type: 'encounter/resolved',
        causedBy: startedId,
        payload: {
          winnerSide: outcome.winnerSide,
          casualties: outcome.casualties.slice(),
          ammoSpent: outcome.ammoSpent.map((p) => [p[0], p[1]] as const),
        },
      });

      // ── ПРИМЕНЕНИЕ ИСХОДА ──────────────────────────────────────────────────
      // Патроны: физически списываем у стрелков ЛЮБОЙ стороны (закон №3). ЛЕДЖЕР
      // (D-045): каждый ФАКТИЧЕСКИ израсходованный ammo-предмет — item/consumed
      // (reason:'combat'), причина = id encounter/resolved. Обход outcome.ammoSpent
      // — по возрастанию eid (резолвер сортирует).
      for (const [eid, spent] of outcome.ammoSpent) {
        const inv = humanInv.get(eid);
        if (inv !== undefined && spent > 0) {
          const consumed = spendAmmo(world.resources, eid, inv, spent);
          for (const [item, qty] of consumed) {
            bus.publish({
              type: 'item/consumed',
              causedBy: resolvedId,
              payload: { who: eid, item, qty, reason: 'combat' },
            });
          }
        }
      }

      // Здоровье: всем бойцам пишем итог из резолвера; убитым — lethalCause = resolved.
      const casualtySet = new Set(outcome.casualties);
      for (const eid of [...eidToCombatant.keys()].sort((a, b) => a - b)) {
        const c = eidToCombatant.get(eid) as Combatant;
        HP.hp[eid] = c.health;
        if (casualtySet.has(eid)) {
          stampCause(Health, 'lethalCause', eid, resolvedId);
        }
      }

      // Мясо (ТОЛЬКО ОХОТА): победитель-охотник (мин eid живого человека победившей
      // стороны) получает мясо за КАЖДОЕ убитое животное из loot (туша, закон №3).
      if (kind === 'hunt' && outcome.disposition === 'sideWon' && outcome.winnerSide === 0) {
        let winner: EntityId | undefined;
        for (const h of attackers) {
          if (!casualtySet.has(h)) {
            winner = h;
            break;
          }
        }
        if (winner !== undefined) {
          for (const l of outcome.loot) {
            if (hasComponent(ecs, Animal, l.from)) {
              const sp = getSpecies(ANIM.species[l.from] as number);
              addMeat(world.resources, winner, sp.meatYield);
              bus.publish({
                type: 'item/harvested',
                causedBy: resolvedId,
                payload: { who: winner, item: MEAT_ITEM, qty: sp.meatYield, source: 'carcass' },
              });
            }
          }
        }
      }

      // Перевод лута (ТОЛЬКО ГРАБЁЖ, D-049/D-060): лут ВСЕЙ проигравшей стороны →
      // мин-eid живому человеку победившей. Симметрично (проигравший→победитель).
      // Перевод, НЕ леджер: масса мира сохранена бит-в-бит (EconomyInvariant дельта 0).
      if (kind === 'rob' && outcome.disposition === 'sideWon' && outcome.winnerSide !== null) {
        const winnerSide = outcome.winnerSide;
        // Получатель: мин-eid ЖИВОЙ (не casualty) человек победившей стороны.
        let recipient: EntityId | undefined;
        for (const eid of [...eidToCombatant.keys()].sort((a, b) => a - b)) {
          const c = eidToCombatant.get(eid) as Combatant;
          if (c.side === winnerSide && !casualtySet.has(eid)) {
            recipient = eid;
            break;
          }
        }
        if (recipient !== undefined) {
          // Проигравшие: ВСЕ бойцы НЕ победившей стороны (мёртвые И сбежавшие), сорт. по eid.
          const losers: EntityId[] = [];
          for (const eid of [...eidToCombatant.keys()].sort((a, b) => a - b)) {
            const c = eidToCombatant.get(eid) as Combatant;
            if (c.side !== winnerSide) losers.push(eid);
          }
          for (const loser of losers) {
            transferLoot(world.resources, bus, loser, recipient, loc, resolvedId);
          }
        }
      }
    }
  },
};
