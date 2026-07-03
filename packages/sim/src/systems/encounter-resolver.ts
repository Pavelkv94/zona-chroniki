/**
 * @module @zona/sim/systems/encounter-resolver
 *
 * ЕДИНЫЙ резолвер столкновений (задача 1.10b, D-022) — ЧИСТАЯ функция над
 * `Combatant[][]` (>= 2 стороны), БЕЗ доступа к ECS/шине/данным/глобальному
 * состоянию. Один и тот же код разрешает ЛЮБОЕ столкновение: охоту человек-vs-
 * животное (Фаза 1) и человек-vs-человек (Фаза 2) — вид/тип НЕ хардкодится
 * (D-022). Отличие сторон — только в числах комбатанта: зверь несёт `ammo=0,
 * melee>0, power` из species.json; стрелок — `ammo>0, power` из навыка×оружия.
 *
 * ── Закон №2 (РАЗБРОС, а не «X% шанс убить») ─────────────────────────────────
 * Единственный источник случайности — ФИЗИЧЕСКИЙ РАЗБРОС выстрела/удара
 * (`rng.next()` — нормированное отклонение ствола/руки этого выстрела: физиология,
 * прямо разрешённая законом №2). Попадание — ДЕТЕРМИНИРОВАННОЕ геометрическое
 * следствие: «конверт точности» стрелка (из `power`/навыка и констант balance)
 * определяет, попал ли РАЗБРОСанный выстрел в цель (`spread < acc`). Это НЕ бросок
 * «шанс события» над самим фактом убийства, а разброс попадания над физическим
 * актом (так же трактует balance/combat.ts). Урон, выбывание, слом морали,
 * победа — всё выведено из СОСТОЯНИЯ боя (health/потери/пороги), без «X% исхода».
 *
 * ── Модель раунда (СИНХРОННО, без первохода) ─────────────────────────────────
 * Раунды 1..maxRounds крутятся ВНУТРИ функции (не по тикам — резолв целиком в
 * одном вызове, поэтому Encounters resume-safe). В каждом раунде:
 *  1. Снимок ЖИВЫХ бойцов (health>0) на начало раунда.
 *  2. Каждый живой боец (обход сорт. по (side, eid)) выбирает цель — ЖИВОГО врага
 *     из другой стороны с МИН eid (детерминизм) и атакует ПО СНИМКУ начала раунда:
 *       • есть патроны (ammo>0) → выстрел: тратит `AMMO_PER_ROUND` (копится в
 *         ammoSpent), урон `RANGED_HIT_DAMAGE` при попадании;
 *       • патронов нет, есть melee>0 → удар в упор: урон = свой `melee`.
 *     Попадание = `rng.next() < acc(power, вид_атаки)`; урон копится ЦЕЛИ.
 *  3. Урон применяется ПОСЛЕ обхода (синхронно): `health -= накопленный урон`;
 *     кто ушёл в `health<=0` — новые casualties. Синхронность убирает
 *     преимущество меньшего side (иначе side0 «стрелял бы первым»).
 *  4. Оценка исхода: сторон с живыми <= 1 → победа/взаимное уничтожение (стоп);
 *     иначе слом морали (`casualties/initial >= MORALE_BREAK_FRACTION`): сломанные
 *     стороны бегут (их живые — survivors). Все живые стороны сломались → взаимный
 *     слом; часть → победа несломанных; никто → следующий раунд. maxRounds без
 *     развязки → пат.
 *
 * ── Канал ЗДОРОВЬЯ (in/out через Combatant.health) ───────────────────────────
 * У `EncounterOutcome` НЕТ карты hp по eid (контракт фиксирован), поэтому итоговое
 * здоровье бойцов резолвер ПИШЕТ ОБРАТНО в изменяемое поле `Combatant.health`
 * переданных объектов — это ЕДИНСТВЕННЫЙ побочный эффект (никаких ECS/шины/данных).
 * Вызывающая система (Encounters) держит те же объекты по eid и читает `health`
 * после резолва (survivors → в Health.hp, casualties → hp<=0 + lethalCause).
 * Функция остаётся детерминированной: `(вход, rng) → (тот же outcome, те же
 * мутации health)`.
 *
 * ── Детерминизм (закон №8) ────────────────────────────────────────────────────
 * Обход сторон/бойцов — по (side, eid) через заранее отсортированные копии; выбор
 * цели — мин eid живого врага; rng продвигается в фиксированном порядке атак.
 * Никаких Map/Set-итераций без сортировки. Одинаковый вход + один и тот же rng →
 * идентичный outcome и идентичные мутации health.
 */

import type { EntityId, EventId, LocationId } from '@zona/shared';
import type { Rng } from '../core/rng';
import {
  BASE_ACCURACY,
  MELEE_BASE_ACCURACY,
  SKILL_ACCURACY_MULT,
  POWER_ACCURACY_REF,
  AMMO_PER_ROUND,
  RANGED_HIT_DAMAGE,
  MORALE_BREAK_FRACTION,
  MIN_ACCURACY,
  MAX_ACCURACY,
} from '../balance/combat';

/**
 * Боец в столкновении. Числа абстрактны (D-022): резолвер не знает «человек это
 * или зверь». `health` — ИЗМЕНЯЕМОЕ поле: резолвер пишет в него итоговое здоровье
 * (см. docblock, канал out). Остальные поля резолвер только читает.
 */
export interface Combatant {
  /** eid бойца (тождество для casualties/survivors/ammoSpent). */
  readonly eid: EntityId;
  /** Индекс стороны (0-based). Бойцы одной стороны не бьют друг друга. */
  readonly side: number;
  /** Боевая сила → «конверт точности» (человек: навык×оружие; зверь: species.power). */
  readonly power: number;
  /** Патроны, доступные бойцу (стрелок: >0; зверь: 0). Тратятся в бою. */
  readonly ammo: number;
  /** Урон удара в упор (зверь: species.melee; безоружный человек: balance). */
  readonly melee: number;
  /** Текущее здоровье; резолвер УМЕНЬШАЕТ его уроном и ПИШЕТ итог сюда (in/out). */
  health: number;
}

/** Вход резолвера: локация (для летописи), стороны, причина, rng, лимит раундов. */
export interface EncounterInput {
  /** Локация столкновения (пробрасывается в событие; на логику не влияет). */
  readonly loc: LocationId;
  /** Стороны боя (>= 2), каждая — массив бойцов. */
  readonly sides: readonly (readonly Combatant[])[];
  /** Причина завязки (id события) или null — для летописи вызывающего. */
  readonly cause: EventId | null;
  /** Seeded PRNG — ТОЛЬКО разброс попадания (закон №2). */
  readonly rng: Rng;
  /** Максимум раундов обмена (обычно `MAX_ROUNDS` из balance). */
  readonly maxRounds: number;
}

/** Исход боя (форма фиксирована контрактом 1.10b). */
export interface EncounterOutcome {
  /** Сколько раундов реально прошло (1..maxRounds). */
  readonly rounds: number;
  /** eid выбывших (health<=0), сорт. по eid. */
  readonly casualties: readonly EntityId[];
  /** eid уцелевших (health>0, включая сломавшихся/сбежавших), сорт. по eid. */
  readonly survivors: readonly EntityId[];
  /** Израсходованные патроны `[eid, кол-во]` (только >0), сорт. по eid. */
  readonly ammoSpent: ReadonlyArray<readonly [EntityId, number]>;
  /** Кого лутать — выбывшие бойцы (труп/добыча); вид определяет вызывающий. */
  readonly loot: ReadonlyArray<{ readonly from: EntityId }>;
  /** Тип развязки. */
  readonly disposition: 'sideWon' | 'mutualBreak' | 'stalemate';
  /** Индекс победившей стороны или null (взаимный слом/пат). */
  readonly winnerSide: number | null;
}

/** Значение, зажатое в [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * «Конверт точности» атаки: база (стрелковая/ближняя) + бонус нормированной силы,
 * зажатый в [MIN, MAX] (промах и попадание возможны ВСЕГДА). Это НЕ вероятность
 * события — это доля-порог, в которую должен попасть РАЗБРОС выстрела (rng), чтобы
 * атака состоялась (закон №2). `power` нормируется общим референсом → человек и
 * зверь без хардкода вида (D-022).
 */
function accuracy(power: number, melee: boolean): number {
  const base = melee ? MELEE_BASE_ACCURACY : BASE_ACCURACY;
  const powerNorm = clamp(power / POWER_ACCURACY_REF, 0, 1);
  return clamp(base + powerNorm * SKILL_ACCURACY_MULT, MIN_ACCURACY, MAX_ACCURACY);
}

/** Внутреннее рабочее состояние бойца (копия входа + счётчики боя). */
interface Fighter {
  readonly ref: Combatant; // исходный объект — сюда пишется итоговый health (out-канал)
  readonly eid: EntityId;
  readonly side: number;
  readonly power: number;
  ammo: number; // остаток патронов (уменьшается по мере стрельбы)
  readonly melee: number;
  health: number; // рабочее здоровье в бою
  ammoSpent: number; // сколько патронов потрачено (для outcome)
  broke: boolean; // сторона сломалась → боец сбежал (перестаёт участвовать)
}

/**
 * Разрешает столкновение ЦЕЛИКОМ (все раунды внутри), детерминированно от
 * `(input, input.rng)`. Пишет итоговое здоровье обратно в `Combatant.health`
 * переданных бойцов (out-канал, см. docblock). Никаких обращений к ECS/шине.
 */
export function resolveEncounter(input: EncounterInput): EncounterOutcome {
  const { sides, rng, maxRounds } = input;

  // ── Плоский список бойцов, ОТСОРТИРОВАННЫЙ по (side, eid) — детерминизм (№8) ──
  const fighters: Fighter[] = [];
  for (let s = 0; s < sides.length; s++) {
    for (const c of sides[s]!) {
      fighters.push({
        ref: c,
        eid: c.eid,
        side: c.side,
        power: c.power,
        ammo: c.ammo,
        melee: c.melee,
        health: c.health,
        ammoSpent: 0,
        broke: false,
      });
    }
  }
  fighters.sort((a, b) => (a.side - b.side) || (a.eid - b.eid));

  // Начальный размер каждой стороны (для порога морали). Индекс = side.
  const initialCount = new Map<number, number>();
  for (const f of fighters) initialCount.set(f.side, (initialCount.get(f.side) ?? 0) + 1);

  /** Живой боец = health>0 И не сбежавший (сломанная сторона вышла из боя). */
  const isActive = (f: Fighter): boolean => f.health > 0 && !f.broke;

  let rounds = 0;
  let disposition: EncounterOutcome['disposition'] = 'stalemate';
  let winnerSide: number | null = null;

  for (let r = 0; r < maxRounds; r++) {
    // Активные стороны на начало раунда; < 2 → бой уже нечем вести.
    const activeSidesStart = new Set<number>();
    for (const f of fighters) if (isActive(f)) activeSidesStart.add(f.side);
    if (activeSidesStart.size < 2) break;

    rounds++;

    // Снимок живых на начало раунда — цели выбираются по нему (синхронность).
    const roundLiving = fighters.filter(isActive);
    // Накопленный урон по цели (eid) за этот раунд; применяется в конце.
    const damage = new Map<EntityId, number>();

    for (const attacker of roundLiving) {
      // Цель — живой (по снимку начала раунда) враг из ДРУГОЙ стороны с мин eid.
      // roundLiving уже сорт. по (side, eid), поэтому первый чужой = мин eid.
      let target: Fighter | undefined;
      for (const cand of roundLiving) {
        if (cand.side === attacker.side) continue;
        if (cand.health <= 0) continue; // умер по снимку — не цель (сорт. по eid ⇒ мин)
        target = cand;
        break;
      }
      if (target === undefined) continue; // врагов не осталось

      // Выбор оружия: патроны есть → выстрел; иначе удар в упор (melee>0).
      const shooting = attacker.ammo >= AMMO_PER_ROUND;
      if (!shooting && attacker.melee <= 0) continue; // безоружный и без патронов — пас

      // РАЗБРОС выстрела/удара (физиология, закон №2) → попадание = spread < acc.
      const spread = rng.next();
      const acc = accuracy(attacker.power, !shooting);
      if (shooting) {
        attacker.ammo -= AMMO_PER_ROUND;
        attacker.ammoSpent += AMMO_PER_ROUND;
        if (spread < acc) damage.set(target.eid, (damage.get(target.eid) ?? 0) + RANGED_HIT_DAMAGE);
      } else {
        if (spread < acc) damage.set(target.eid, (damage.get(target.eid) ?? 0) + attacker.melee);
      }
    }

    // Применяем накопленный урон синхронно (обход сорт. — детерминизм не важен для
    // суммы, но фиксируем порядок как инвариант ядра).
    for (const f of fighters) {
      const dmg = damage.get(f.eid);
      if (dmg !== undefined && f.health > 0) f.health -= dmg;
    }

    // ── Оценка исхода ──────────────────────────────────────────────────────────
    const livingSides = new Set<number>();
    for (const f of fighters) if (isActive(f)) livingSides.add(f.side);

    if (livingSides.size === 1) {
      winnerSide = livingSides.values().next().value as number;
      disposition = 'sideWon';
      break;
    }
    if (livingSides.size === 0) {
      winnerSide = null;
      disposition = 'mutualBreak'; // взаимное уничтожение в одном раунде
      break;
    }

    // Слом морали: сторона с долей потерь >= порога ломается (её живые бегут).
    // Обход сторон по возрастанию — детерминированно (закон №8).
    const brokenThisRound: number[] = [];
    for (const side of Array.from(livingSides).sort((a, b) => a - b)) {
      const init = initialCount.get(side) ?? 0;
      if (init === 0) continue;
      let living = 0;
      for (const f of fighters) if (f.side === side && isActive(f)) living++;
      const lost = init - living;
      if (lost / init >= MORALE_BREAK_FRACTION) brokenThisRound.push(side);
    }

    if (brokenThisRound.length > 0) {
      const brokenSet = new Set(brokenThisRound);
      for (const f of fighters) if (brokenSet.has(f.side)) f.broke = true;

      // Кто остался НЕ сломанным среди живых сторон?
      const remaining = Array.from(livingSides).filter((s) => !brokenSet.has(s));
      if (remaining.length === 0) {
        winnerSide = null;
        disposition = 'mutualBreak';
      } else if (remaining.length === 1) {
        winnerSide = remaining[0] as number;
        disposition = 'sideWon';
      } else {
        // >1 несломанная сторона (Фаза 2, >2 сторон) — бой не развязан этим сломом.
        // Продолжать с оставшимися нельзя корректно одной меткой; фиксируем пат.
        winnerSide = null;
        disposition = 'stalemate';
      }
      break;
    }
    // Никто не сломался и >=2 стороны живы → следующий раунд (или пат по лимиту).
  }

  // ── Сборка outcome + запись итогового health обратно в Combatant (out-канал) ──
  const casualties: EntityId[] = [];
  const survivors: EntityId[] = [];
  const ammoSpent: Array<readonly [EntityId, number]> = [];
  const loot: Array<{ readonly from: EntityId }> = [];

  for (const f of fighters) {
    f.ref.health = f.health; // ПИШЕМ итог в переданный объект (Encounters прочтёт)
    if (f.health <= 0) {
      casualties.push(f.eid);
      loot.push({ from: f.eid });
    } else {
      survivors.push(f.eid);
    }
    if (f.ammoSpent > 0) ammoSpent.push([f.eid, f.ammoSpent] as const);
  }

  casualties.sort((a, b) => a - b);
  survivors.sort((a, b) => a - b);
  ammoSpent.sort((a, b) => a[0] - b[0]);
  loot.sort((a, b) => a.from - b.from);

  return { rounds, casualties, survivors, ammoSpent, loot, disposition, winnerSide };
}
