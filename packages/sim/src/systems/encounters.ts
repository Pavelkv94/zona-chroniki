/**
 * @module @zona/sim/systems/encounters
 *
 * Система Encounters (задача 1.10b, B.1) — ЗАВЯЗКА и РАЗРЕШЕНИЕ столкновений из
 * СОСТОЯНИЯ мира. Фаза 1: охота человек-vs-животное. Система только ДЕТЕКТИРУЕТ бой
 * (кто с кем), собирает `Combatant`-стороны и зовёт ЕДИНЫЙ чистый резолвер
 * (`encounter-resolver`, D-022), затем ПРИМЕНЯЕТ исход к миру. Вся боевая
 * арифметика/rng — в резолвере; здесь — только ECS/шина/инвентарь (закон №6).
 *
 * Главный тест закона №1: работает без игрока — сталкер сам выбрал HUNT
 * (TaskSelection 1.8) по голоду и обстановке, сам дошёл (Movement 1.4) и здесь сам
 * стреляет по дичи; мясо появляется у победителя из ТУШИ (закон №3), патроны
 * ФИЗИЧЕСКИ уходят из инвентаря (закон №3).
 *
 * ── ДЕТЕКЦИЯ (детерминированно, сорт.) ───────────────────────────────────────
 * Кандидат-охотник: человек (Human, Alive) с `Task.kind===HUNT`, СТОЯЩИЙ
 * (`Position.dest===loc`), в локации которого есть ЖИВОЕ животное. Цель = его
 * `Task.targetEid`, если это живое Animal в ЕГО локации (existsEntity+Alive+Animal+
 * co-located, D-029); иначе (targetEid устарел) — любое живое Animal в его локации
 * с МИН eid. Охотники группируются по (loc, цель): несколько охотников на ОДНУ дичь
 * → одна сторона side0; сторона side1 — сама дичь. ОДИН бой на (loc, цель) за тик.
 *
 * ── СБОРКА Combatant (D-022) ─────────────────────────────────────────────────
 *  • человек: power = `shooting × HUMAN_WEAPON_POWER` при наличии совместимого
 *    оружия+патронов (иначе 0 — безоружный); ammo = кол-во патронов калибра оружия
 *    в инвентаре; melee = `HUMAN_UNARMED_MELEE`; health = `Health.hp`.
 *  • животное: power/melee из species.json, ammo=0, health = `Health.hp`.
 * Вид НЕ хардкодится в резолвере — обе стороны через один цикл (тест-заглушка
 * человек-vs-человек пойдёт той же сигнатурой).
 *
 * ── ПРИЧИННОСТЬ (закон №6, D-030) ────────────────────────────────────────────
 * `encounter/started.causedBy` = `spottedEvent` цели из `contacts` охотника
 * (мин-eid охотника; id того `perception/spotted`, что свёл их) → иначе
 * `Task.causeEvent` (штамп `task/selected`) → иначе null.
 * `encounter/resolved.causedBy` = id `encounter/started`.
 * Убитым штампуется `Health.lethalCause = id encounter/resolved` (D-030): смерть
 * снимет Death (1.11), взяв причину из этого поля. Encounters сам НЕ удаляет и НЕ
 * помечает Corpse — только `hp<=0` + `lethalCause`.
 *
 * ── ПРИМЕНЕНИЕ ИСХОДА (закон №3) + ЛЕДЖЕР МАССЫ (D-045) ───────────────────────
 *  • Патроны: у каждого стрелка инвентарь уменьшается на `ammoSpent` — НОВЫЙ массив
 *    через `resources.set` (не in-place), списываются патроны совместимого калибра.
 *    Каждый ФАКТИЧЕСКИ израсходованный ammo-предмет публикует `item/consumed`
 *    (reason:'combat', `causedBy`=id `encounter/resolved`) — уничтожение массы
 *    видимо EconomyInvariant.
 *  • Здоровье: выжившим пишем `Health.hp` из итогового `Combatant.health`.
 *  • Убитые: `hp<=0` + `stampCause(lethalCause)`; НЕ удаляем (Death 1.11).
 *  • Мясо: за каждое убитое ЖИВОТНОЕ из `loot` победитель-охотник (side победы,
 *    мин eid) получает `meatYield` мяса в инвентарь (источник — ТУША, закон №3) и
 *    публикует `item/harvested` (source:'carcass', `causedBy`=id `encounter/resolved`)
 *    — создание массы видимо EconomyInvariant. Только при `disposition==='sideWon'`
 *    с живым человеком-победителем; без победы мяса нет (труп останется Death 1.11).
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (законы №8, P0) ──────────────────────────────────────
 * Локации/животные/охотники обходятся по возрастанию (сорт. ключи). rng — ТОЛЬКО
 * `ctx.rng.fork(`encounter@${tick}#${loc}#${target}`)` на разброс попадания: метка
 * УНИКАЛЬНА на (tick, loc, target) — два одновременных боя в одной локации (разная
 * дичь) получают НЕЗАВИСИМЫЕ потоки разброса (без target делили бы один label ⇒
 * ложная корреляция исходов). Поток stateless (выводится из label, D-004) — не
 * хранит межтикового состояния. Бой резолвится ЦЕЛИКОМ в одном тике ⇒ нет боевого состояния между
 * тиками ⇒ непрерывный прогон ≡ split save/load (P0). Порядок в тике (B.1): после
 * Movement/TaskEffects, ДО Animals/Death.
 */

import type { Contact, EntityId, EventId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent, existsEntity, stampCause } from '../core/ecs';
import { Position, Task, Skills, Health, Animal, Human, Alive, TaskKind } from '../core/components';
import { getSpecies, getItem } from '../data/index';
import { MAX_ROUNDS, HUMAN_WEAPON_POWER, HUMAN_UNARMED_MELEE } from '../balance/combat';
import { resolveEncounter, type Combatant } from './encounter-resolver';

/** Ключи ResourceStore (форма — как пишет worldgen 1.3 / Perception 1.7). */
const INVENTORY_KEY = 'inventory';
const CONTACTS_KEY = 'contacts';

/** itemId мяса (источник — туша убитого животного, закон №3; есть в items.json). */
const MEAT_ITEM = 'meat';

/** Единица инвентаря (та же форма, что пишет worldgen 1.3, сорт. по item). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
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
 * Система Encounters (`every: 1`). Детектит бои охотник-vs-дичь по состоянию,
 * резолвит их единым резолвером и применяет исход (патроны/hp/lethalCause/мясо).
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
    if (animalsByLoc.size === 0) return; // без дичи охотиться не с кем

    // ── Охотники → цель. Группируем по (loc, targetAnimal). ────────────────────
    // Ключ бакета: `${loc}#${targetEid}`; значение — сорт. по eid охотники.
    interface Battle {
      readonly loc: number;
      readonly target: EntityId;
      readonly hunters: EntityId[];
    }
    const battles = new Map<string, Battle>();

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
        battle = { loc, target, hunters: [] };
        battles.set(key, battle);
      }
      battle.hunters.push(h); // queryEntities сорт. ⇒ hunters по возрастанию eid
    }
    if (battles.size === 0) return;

    // ── Резолвим бои в ДЕТЕРМИНИРОВАННОМ порядке (сорт. по loc, затем target) ───
    const ordered = Array.from(battles.values()).sort(
      (a, b) => (a.loc - b.loc) || (a.target - b.target),
    );

    for (const battle of ordered) {
      const { loc, target, hunters } = battle;

      // Стороны: side0 — охотники; side1 — дичь. Combatant с числами (D-022).
      const eidToCombatant = new Map<EntityId, Combatant>();
      const humanInv = new Map<EntityId, readonly InventoryEntry[]>();

      const side0: Combatant[] = [];
      for (const h of hunters) {
        const inv = world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, h);
        if (inv !== undefined) humanInv.set(h, inv);
        const prof = shooterProfile(inv);
        const shooting = hasComponent(ecs, Skills, h) ? (SKILL.shooting[h] as number) : 0;
        const power = prof.hasWeapon ? shooting * HUMAN_WEAPON_POWER : 0;
        const c: Combatant = {
          eid: h,
          side: 0,
          power,
          ammo: prof.hasWeapon ? prof.ammo : 0,
          melee: HUMAN_UNARMED_MELEE,
          health: HP.hp[h] as number,
        };
        side0.push(c);
        eidToCombatant.set(h, c);
      }

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
      const side1: Combatant[] = [animalCombatant];

      // Причина: spottedEvent цели из contacts мин-eid охотника → Task.causeEvent → null.
      const leadHunter = hunters[0] as EntityId;
      let cause: EventId | null = null;
      const spotted = spottedEventFor(world.resources, leadHunter, target);
      if (spotted > 0) {
        cause = spotted as EventId;
      } else {
        cause = causeOrNull(TSK.causeEvent[leadHunter] as number);
      }

      // encounter/started.
      const startedId = bus.publish({
        type: 'encounter/started',
        causedBy: cause,
        payload: {
          sides: [hunters.slice(), [target]],
          loc: loc as LocationId,
        },
      });

      // Резолвер: rng ТОЛЬКО на разброс. Метка УНИКАЛЬНА на (tick, loc, target) —
      // включает eid цели, иначе два одновременных боя в ОДНОЙ локации (разная
      // дичь) форкнули бы одинаковый label ⇒ идентичный stateless-поток разброса
      // ⇒ ложно-скоррелированные исходы. С target потоки независимы, оставаясь
      // stateless/resume-safe (выводятся из label, D-004).
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
      // Патроны: физически списываем у стрелков (закон №3). ЛЕДЖЕР (D-045):
      // каждый ФАКТИЧЕСКИ израсходованный ammo-предмет — item/consumed(reason:
      // 'combat'), причина = id encounter/resolved (расход есть следствие боя).
      // Обход outcome.ammoSpent — по возрастанию eid (резолвер сортирует).
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

      // Здоровье: всем бойцам пишем итог из резолвера (survivors — живые hp;
      // casualties — hp<=0). Убитым штампуем lethalCause = id resolved (D-030).
      // Обход по ОТСОРТИРОВАННЫМ eid (закон №8: без итерации Map без сортировки —
      // операции по eid независимы, но фиксируем порядок как инвариант ядра).
      const casualtySet = new Set(outcome.casualties);
      for (const eid of [...eidToCombatant.keys()].sort((a, b) => a - b)) {
        const c = eidToCombatant.get(eid) as Combatant;
        HP.hp[eid] = c.health;
        if (casualtySet.has(eid)) {
          stampCause(Health, 'lethalCause', eid, resolvedId);
        }
      }

      // Мясо: победитель-охотник (мин eid живого человека победившей стороны)
      // получает мясо за КАЖДОЕ убитое животное из loot (источник — туша, закон №3).
      if (outcome.disposition === 'sideWon' && outcome.winnerSide === 0) {
        // Мин-eid уцелевший охотник (hunters сорт., survivors — health>0).
        let winner: EntityId | undefined;
        for (const h of hunters) {
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
              // ЛЕДЖЕР (D-045, закон №3): мясо ФИЗИЧЕСКИ возникло из туши — новая
              // масса в мире, видимая EconomyInvariant. item/harvested(source:
              // 'carcass'), причина = id encounter/resolved (добыча = следствие боя).
              bus.publish({
                type: 'item/harvested',
                causedBy: resolvedId,
                payload: { who: winner, item: MEAT_ITEM, qty: sp.meatYield, source: 'carcass' },
              });
            }
          }
        }
      }
    }
  },
};
