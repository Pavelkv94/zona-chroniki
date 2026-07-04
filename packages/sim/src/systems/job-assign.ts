/**
 * @module @zona/sim/systems/job-assign
 *
 * Хелпер НАЙМА (задача 2.4, D-046/D-052/D-053(4)) — детерминированное назначение
 * компонента `Job` резидентам поселений с «оседлой» профессией. Это НЕ система (в
 * конвейер не встаёт): чистая функция над миром, которую вызовет стратегический
 * FactionAI/интеграция Фазы 2 (задача 2.16). До тех пор носителей Job в живом прогоне
 * НЕТ — WORK-ветка TaskSelection (2.4) не исполняется, Economy (2.3) видит 0 труда,
 * а голдены Фазы 1 (пустого мира / sim:100days) НЕ сдвигаются (см. закон №8, D-053).
 *
 * Главный тест закона №1: наём выводится из СОСТОЯНИЯ мира (кто где живёт + профессия
 * из data), а не из команды игрока — assignJobs работает headless без игрока.
 *
 * ── КРИТЕРИЙ НАЙМА (закон №2 — из состояния, не «X% шанс») ─────────────────────
 * Живой Human трудоустраивается на поселение, если ВСЁ выполнено:
 *   1) есть Home и `Home.loc` == локация поселения (сущность-носитель Settlement на
 *      той же loc) — резидент;
 *   2) его профессия (cold 'profession' в ResourceStore) имеет НЕПУСТОЙ `workTasks`
 *      (professions.json) — «оседлая» профессия (санитар/технарь/торговец), у которой
 *      есть рабочее место в поселении. Полевые профессии (сталкер/охотник/барахольщик,
 *      `workTasks: []`) рабочего места НЕ имеют ⇒ Job не получают, их распорядок дня
 *      рождается из нужд (FORAGE/HUNT/рейд, D-020) — это и есть эмерджентное
 *      разделение труда, а не механический «каждый второй» (обоснование выбора
 *      критерия: он причинно связан с фикцией — на смену ходит тот, у кого есть смена).
 *
 * ── D-053(4): employer/workplace ВЫСТАВЛЯЮТСЯ СРАЗУ после addComponent ─────────
 * `addComponent(Job)` зануляет поля (D-024) ⇒ до явной записи `employer==0`, что
 * Economy/census прочитали бы как «работает на eid 0» (ложная приписка). Поэтому
 * СРАЗУ после add выставляем `workplace = loc поселения` и `employer = eid поселения`
 * — до того как Job станет виден любому читателю.
 *
 * ── ИДЕМПОТЕНТНОСТЬ и ДЕТЕРМИНИЗМ (закон №8) ──────────────────────────────────
 * Уже трудоустроенный (носитель Job) ПРОПУСКАЕТСЯ — повторный вызов не плодит/не
 * перетасовывает наём (стабилен). Обход людей и поселений — `queryEntities` (сорт. по
 * eid), карта loc→поселение строится детерминированно ⇒ два прогона одного seed дают
 * тождественные назначения. rng НЕ используется (наём — не физиология и не генмир).
 * Событий/предметов/денег НЕ создаётся (закон №3): Job — компонент-состояние, не
 * предмет; масса экономики не двигается (EconomyInvariant не затронут).
 */

import type { EntityId } from '@zona/shared';
import type { SimWorld } from '../core/world';
import { queryEntities, hasComponent, addComponent } from '../core/ecs';
import { Settlement, Position, Home, Job, Human, Alive } from '../core/components';
import { getProfession } from '../data/index';

/** Cold-ключ профессии NPC (строковый id, форма worldgen). */
const PROFESSION_KEY = 'profession';

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array };
const HOME = Home as unknown as { readonly loc: Uint32Array };
const JOB = Job as unknown as { workplace: Uint32Array; employer: Uint32Array };

/**
 * Назначает `Job` резидентам поселений с «оседлой» профессией (см. модульный
 * docblock). Детерминированно (обход по eid), идемпотентно (уже трудоустроенные
 * пропускаются). ОБЯЗАТЕЛЬНО ставит `employer`/`workplace` сразу после
 * `addComponent(Job)` (D-053(4)) — до первого чтения Economy/census. Не публикует
 * событий и не двигает массу (закон №3). Экспортируется для FactionAI/2.16.
 */
export function assignJobs(world: SimWorld): void {
  const ecs = world.ecs;

  // Карта loc поселения → eid поселения (обход Settlement по eid, детерминизм).
  // loc поселения уникален (валидатор settlements.json) ⇒ коллизий нет.
  const settlementByLoc = new Map<number, EntityId>();
  for (const s of queryEntities(ecs, [Settlement])) {
    settlementByLoc.set(POS.loc[s] as number, s);
  }
  if (settlementByLoc.size === 0) return;

  for (const h of queryEntities(ecs, [Human, Alive])) {
    // Идемпотентность: уже трудоустроен — не переназначаем (стабильно при повторе).
    if (hasComponent(ecs, Job, h)) continue;
    // Резидент поселения: есть Home и его loc — локация поселения.
    if (!hasComponent(ecs, Home, h)) continue;
    const homeLoc = HOME.loc[h] as number;
    const settlementEid = settlementByLoc.get(homeLoc);
    if (settlementEid === undefined) continue;
    // Оседлая профессия: непустой workTasks (professions.json, закон №10).
    const professionId = world.resources.get<string>(PROFESSION_KEY, h);
    if (professionId === undefined) continue;
    if (getProfession(professionId).workTasks.length === 0) continue;

    // D-053(4): выставить employer/workplace СРАЗУ после add (иначе employer=0).
    addComponent(ecs, Job, h); // зануляет поля (D-024)
    JOB.workplace[h] = homeLoc; // loc рабочего места = loc поселения
    JOB.employer[h] = settlementEid; // eid работодателя (НЕ дефолтный 0)
  }
}
