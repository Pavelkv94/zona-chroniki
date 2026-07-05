/**
 * @module @zona/sim/systems/hunt-memory
 *
 * ЛИЧНАЯ ОХОТНИЧЬЯ ПАМЯТЬ охотника (задача P-5/Б, D-087) — СЕРИАЛИЗУЕМЫЙ субстрат, из
 * которого TaskSelection (1.8) выводит ЭКОНОМИЧЕСКУЮ недоохоту и набор угодий «куда
 * идти». Это чистые хелперы над «холодным» ключом ResourceStore на носителе-охотнике —
 * ни системы не зовут, ни событий не публикуют (закон №6): память меняет СОСТОЯНИЕ, а
 * решение и его причины держит TaskSelection.
 *
 * ── ЗАЧЕМ ОТДЕЛЬНАЯ СТРУКТУРА (а не расширять Memory/MemoryRecord) ─────────────
 * Социальная память (memory.ts, `MemoryRecord`) адресует ФАКТ о СУБЪЕКТЕ (сущность/
 * фракция) с `salience`/`isFirsthand`/консолидацией и ЗАТУХАЕТ монотонно к забвению
 * (MemoryDecay). Охотничья память — иная семантика: числовая «ожидаемая добыча»
 * (`expectation` 0..1) по ЛОКАЦИИ-угодью, которая растёт от наблюдения дичи И падает
 * от пустых выходов (двусторонняя, не только затухание), адресована loc (не subject) и
 * НЕ участвует ни в слухах, ни в репутации. Смешивать её с социальной памятью значило бы
 * ломать инварианты консолидации/затухания обеих. Поэтому — свой ключ `'huntMemory'`,
 * по форме близкий к `avoidLoc` (разрежённый сорт. массив кортежей на eid охотника):
 * `[loc, expectation, tick]`, отсортирован по loc (детерминизм, закон №8), сериализуем
 * (числа) ⇒ переживает snapshot тождественно (resume-safe, закон №8). Нейтрала-по-
 * умолчанию нет: отсутствие записи о loc = «не знаю про это угодье».
 *
 * ── АНТИ-ЧИТ (главный фильтр Б) ───────────────────────────────────────────────
 * Каждая запись рождается и обновляется ТОЛЬКО из ЛИЧНО ВОСПРИНЯТОГО ЭТИМ охотником:
 *  • ПОДКРЕПЛЕНИЕ (`reinforce`): он ВИДИТ живую дичь в locации (через свои `contacts`,
 *    Perception 1.7) ⇒ expectation этого loc = 1 (полная уверенность «тут есть дичь»),
 *    tick = сейчас. Никакого мирового счётчика вида / скана всех животных / чужих целей.
 *  • ПУСТОЙ ВЫХОД (`decay`): он СТОИТ у угодья из своей памяти, но НЕ воспринимает там
 *    живой дичи ⇒ expectation −= EMPTY_PENALTY; ниже HUNT_GROUND_MIN_EXPECTATION угодье
 *    ЗАБЫВАЕТСЯ (запись снята) ⇒ выпадает из кандидатов охоты. Так перевыбитое угодье,
 *    куда он раз за разом приходит впустую, уходит из ЕГО карты → дичь там плодится без
 *    охотников → ЭМЕРДЖЕНТНАЯ саморегуляция БЕЗ глобального знания.
 *  • СТАРЕНИЕ: запись без подкрепления дольше HUNT_GROUND_MAX_AGE_TICKS забывается
 *    (страховка от «вечной» веры в давно не посещённое угодье).
 * «Успешный убой» дичи здесь НЕ отдельный сигнал: чтобы убить, охотник ОБЯЗАН быть
 * co-located с живой дичью, т.е. в тот же тик он её ВОСПРИНЯЛ ⇒ `reinforce` уже сработал
 * (убой строго сильнее и уже покрыт наблюдением). Это держит все обновления в ОДНОМ
 * восприятийном источнике, без прямого вызова из боевой системы (закон №6).
 *
 * ── ЕДИНОЕ ОБНОВЛЕНИЕ ЗА ТИК (детерминизм/дешевизна) ──────────────────────────
 * `updateHuntMemory` читает грунты один раз, применяет старение → подкрепление →
 * пустой выход и пишет РОВНО ОДИН новый сорт. массив, только если он ОТЛИЧАЕТСЯ от
 * прежнего (иначе store не трогаем — стабильность снапшота, дешевизна). Пустой набор ⇒
 * ключ снимается (нет «вечного» пустого массива). Порядок применения фиксирован и
 * непересекающийся (loc-множества подкрепления и пустого выхода не пересекаются:
 * пустой выход возможен лишь когда co-located дичи НЕТ ⇒ standLoc ∉ perceived) ⇒ итог
 * порядко-независим (закон №8). rng не участвует (закон №2).
 */

import type { EntityId } from '@zona/shared';
import type { ResourceStore } from '../core/world';
import {
  HUNT_GROUND_EMPTY_PENALTY,
  HUNT_GROUND_MIN_EXPECTATION,
  HUNT_GROUND_MAX_AGE_TICKS,
} from '../balance/ecology';

/** Ключ «холодного» ResourceStore охотничьей памяти (на eid охотника, D-087). */
export const HUNT_MEMORY_KEY = 'huntMemory';

/**
 * Одна запись охотничьей памяти: угодье `loc`, ЛИЧНАЯ «ожидаемая добыча» `expectation`
 * (0..1) и `tick` последнего подкрепления (для старения). Плоский числовой кортеж —
 * сериализуемость (D-013) + сортируемость по loc (закон №8).
 */
export type HuntGroundEntry = readonly [loc: number, expectation: number, tick: number];

/**
 * Порог тик-давности, реже которого НЕ переписываем запись при повторном подкреплении
 * УЖЕ насыщенного (expectation===1) угодья: освежаем `tick` не чаще раза в час игрового
 * времени. Структурная величина (троттлинг записи, не баланс/не контент): точность
 * старения (горизонт ~10 дней) от часового округления не страдает, а churn снапшота
 * ограничен. Не влияет на семантику — только на частоту перезаписи неизменного факта.
 */
const HUNT_GROUND_REFRESH_TICKS = 60;

/** Общий неизменяемый пустой массив (перф: без per-call аллокации `[]` в горячем цикле). */
const EMPTY_GROUNDS: readonly HuntGroundEntry[] = Object.freeze([]);

/** Все угодья охотничьей памяти NPC (сорт. по loc); пустой массив, если памяти нет. */
export function getHuntGrounds(resources: ResourceStore, eid: EntityId): readonly HuntGroundEntry[] {
  return resources.get<readonly HuntGroundEntry[]>(HUNT_MEMORY_KEY, eid) ?? EMPTY_GROUNDS;
}

/**
 * ЛИЧНАЯ «ожидаемая добыча» угодья `loc` в памяти охотника `eid` (0..1); `0`, если он
 * про это угодье НЕ помнит. Читает TaskSelection для дисконта sHunt (перевыбитое угодье
 * с низким expectation даёт слабый вклад охоты ⇒ проигрывает собирательству).
 */
export function getGroundExpectation(resources: ResourceStore, eid: EntityId, loc: number): number {
  for (const [l, exp] of getHuntGrounds(resources, eid)) if (l === loc) return exp;
  return 0;
}

/** true, если новый набор угодий БАЙТ-в-байт (по значениям) совпадает с прежним. */
function sameGrounds(a: readonly HuntGroundEntry[], b: readonly HuntGroundEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as HuntGroundEntry;
    const y = b[i] as HuntGroundEntry;
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
  }
  return true;
}

/**
 * ЕДИНОЕ детерминированное обновление охотничьей памяти `eid` на тике `tick` из ЛИЧНО
 * ВОСПРИНЯТОГО (закон №1/№2, анти-чит):
 *  • `perceivedGameLocs` — локации, где охотник СЕЙЧАС видит живую дичь (из его contacts):
 *    каждая ПОДКРЕПЛЯЕТСЯ (expectation=1, tick=now);
 *  • `emptyStandLoc` — угодье, у которого он СТОИТ, но живой дичи НЕ воспринимает
 *    (пустой выход), либо `undefined`: если это угодье в памяти — expectation −=
 *    EMPTY_PENALTY, ниже порога забывается. Передаётся ТОЛЬКО когда loc уже был грунтом
 *    и не входит в `perceivedGameLocs` (см. вызов в TaskSelection).
 * Старение: записи старше HUNT_GROUND_MAX_AGE_TICKS без подкрепления снимаются. Пишет
 * ОДИН сорт. массив лишь при изменении (иначе store не трогает); пустой ⇒ ключ снят.
 */
export function updateHuntMemory(
  resources: ResourceStore,
  eid: EntityId,
  tick: number,
  perceivedGameLocs: ReadonlySet<number>,
  emptyStandLoc: number | undefined,
): void {
  const cur = getHuntGrounds(resources, eid);
  // Карта loc → [expectation, lastTick]; начинаем с текущего, отсеивая устаревшее.
  const m = new Map<number, readonly [number, number]>();
  for (const [loc, exp, t] of cur) {
    if (tick - t > HUNT_GROUND_MAX_AGE_TICKS) continue; // забыто по возрасту
    m.set(loc, [exp, t]);
  }

  // ПОДКРЕПЛЕНИЕ: воспринятые угодья — полная уверенность, освежаем tick (троттлинг).
  for (const loc of perceivedGameLocs) {
    const prev = m.get(loc);
    if (prev !== undefined && prev[0] === 1 && tick - prev[1] < HUNT_GROUND_REFRESH_TICKS) continue;
    m.set(loc, [1, tick]);
  }

  // ПУСТОЙ ВЫХОД: угодье из памяти, у которого стоим без дичи — вера падает/забывается.
  if (emptyStandLoc !== undefined) {
    const prev = m.get(emptyStandLoc);
    if (prev !== undefined) {
      const nextExp = prev[0] - HUNT_GROUND_EMPTY_PENALTY;
      if (nextExp < HUNT_GROUND_MIN_EXPECTATION) m.delete(emptyStandLoc);
      else m.set(emptyStandLoc, [nextExp, prev[1]]); // tick не освежаем (это не подкрепление)
    }
  }

  // Сборка отсортированного по loc массива (закон №8) + запись при изменении.
  const next: HuntGroundEntry[] = [];
  for (const loc of Array.from(m.keys()).sort((a, b) => a - b)) {
    const v = m.get(loc) as readonly [number, number];
    next.push([loc, v[0], v[1]]);
  }
  if (sameGrounds(cur, next)) return; // ничего не изменилось — store не трогаем
  if (next.length === 0) resources.delete(HUNT_MEMORY_KEY, eid);
  else resources.set<readonly HuntGroundEntry[]>(HUNT_MEMORY_KEY, eid, next);
}
