/**
 * @module @zona/sim/systems/memory-decay
 *
 * Система MemoryDecay (задача 2.15, D-050/D-058) — ЗАТУХАНИЕ памяти/отношений и чистка
 * истёкшего обхода. NPC не помнит вечно: событие уходит в прошлое (нет подкрепления),
 * salience памяти убывает, вражда остывает к нейтралу, а обход маршрута снимается по
 * сроку. Общение — только через «холодный» ResourceStore (закон №6): система ничего не
 * зовёт и (осознанно) НЕ публикует событий (см. «Тихое забвение» ниже).
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Забвение идёт БЕЗ игрока: salience/отношения затухают по СОСТОЯНИЮ записей (их
 * salience/tick), даже если в мире нет ни одного живого наблюдателя. Память — свойство
 * NPC, а не интерфейс игрока.
 *
 * ── ПРИЧИННОСТЬ ЗАТУХАНИЯ (закон №2, НЕ «X% забыть») ──────────────────────────
 * Убыль — ДЕТЕРМИНИРОВАННАЯ функция (tick, salience): за один вызов salience памяти
 * уменьшается на `MEMORY_SALIENCE_DECAY_PER_TICK × cadence`, модуль отношения — к 0 на
 * `RELATION_DECAY_PER_TICK × cadence` (компенсация редкого шага, как заряд ArtifactSpawn
 * «×every»). rng НЕ используется вовсе. Это «среда сознания» (как рост нужд Needs), а не
 * бросок кости над фактом забывания.
 *
 * ── PRUNE (закон №8, стабильный) ──────────────────────────────────────────────
 *  - memory: запись выбрасывается, если `salience < MEMORY_FORGET_THRESHOLD` ИЛИ старше
 *    `MEMORY_MAX_AGE_TICKS` (~60 дней — страховка от «вечной» памяти при разовом сильном
 *    подкреплении). Массив пересобирается сорт.; пустой → ключ удаляется целиком.
 *  - relations: значение подтягивается к 0; при `|value| <= RELATION_NEUTRAL_EPSILON`
 *    отношение считается нейтральным и запись выбрасывается (нейтрал не хранится, D-050).
 *  - avoidLoc: запись с `untilTick <= tick` истекла и удаляется.
 * Обход eid — `resources.entries(key)` (сорт. по eid, закон №8); массивы сорт.; всё —
 * чистая арифметика ⇒ prune воспроизводим.
 *
 * ── ТИХОЕ ЗАБВЕНИЕ (обоснование: событий НЕ публикуем) ───────────────────────
 * Затухание — ОТСУТСТВИЕ подкрепления, а не происшествие в мире: у него нет причины-
 * события (корень был бы `null`, как у эндогенного роста), а «забыл» — не факт летописи.
 * Публиковать `memory/forgotten` на каждую истёршуюся запись значило бы засорять
 * append-only лог тысячами не-нарративных событий и менять хэш каждого прогона на ровном
 * месте. Поэтому prune ТИХИЙ (как затухание страха в Needs, которое тоже не эвентит).
 * SEAM Фазы 3: если летописи понадобится «NPC забыл обиду», narrative выведет это из
 * истории salience, а не из per-tick события отсюда.
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (закон №8, P0) ───────────────────────────────────────
 * Затухание зависит ТОЛЬКО от salience/value/tick записи (не от рантайм-таймера) ⇒
 * непрерывный прогон ≡ split save/load. Запись — НОВЫМ массивом (не in-place, D-035).
 * rng не используется.
 *
 * ── НЕ В КОНВЕЙЕРЕ (голдены Фазы 1) ───────────────────────────────────────────
 * MemoryDecay НЕ регистрируется в registerPhase1Systems и не создаётся worldgen'ом
 * (текущий worldgen не пишет memory/relations/avoidLoc — до 2.16). На текущем мире система
 * — no-op (нет записей ⇒ `entries` пусты ⇒ ни записи, ни события), поэтому голдены пустого
 * мира (481914ae) и sim:100days (37a19d72) НЕ сдвигаются. Подключение — задача 2.16.
 */

import type { EntityId, MemoryRecord, RelationEntry, AvoidEntry } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { ResourceStore } from '../core/world';
import { MEMORY_KEY, RELATIONS_KEY, AVOID_KEY } from './memory';
import {
  MEMORY_SALIENCE_DECAY_PER_TICK,
  MEMORY_FORGET_THRESHOLD,
  MEMORY_MAX_AGE_TICKS,
  RELATION_DECAY_PER_TICK,
  RELATION_NEUTRAL_EPSILON,
} from '../balance/social';

/**
 * Шаг планировщика MemoryDecay. `60` (час игрового времени): затухание не требует
 * по-тиковой реакции (горизонт памяти — недели), редкий шаг дешевле (как
 * ArtifactSpawn/Animals). Ставки затухания домножаются на этот шаг (компенсация
 * накопления за `cadence` тиков). Структурная величина (не баланс/не контент).
 */
const MEMORYDECAY_CADENCE = 60;

// ── Канарейка перебаланса: за один шаг нельзя стереть больше всей шкалы ─────────
//
// Убыль за вызов (`ставка × cadence`) должна быть строго меньше полной шкалы (1.0),
// иначе один шаг обнулял бы любую свежую память/вражду (мгновенная амнезия — молчаливый
// баг баланса). Проверяем при загрузке модуля и падаем ГРОМКО (как guard ArtifactSpawn).
if (
  MEMORY_SALIENCE_DECAY_PER_TICK * MEMORYDECAY_CADENCE >= 1 ||
  RELATION_DECAY_PER_TICK * MEMORYDECAY_CADENCE >= 1
) {
  throw new Error(
    `MemoryDecay: убыль за шаг (ставка × ${MEMORYDECAY_CADENCE}) должна быть строго меньше ` +
      `полной шкалы (1.0), иначе один шаг стирает любую свежую память/отношение. ` +
      `Правьте balance/social.ts или MEMORYDECAY_CADENCE.`,
  );
}

/** Затухание памяти одного NPC: убыль salience + prune слабых/старых. */
function decayMemory(resources: ResourceStore, eid: EntityId, tick: number, step: number): void {
  const records = resources.get<readonly MemoryRecord[]>(MEMORY_KEY, eid);
  if (records === undefined || records.length === 0) return;
  const drop = MEMORY_SALIENCE_DECAY_PER_TICK * step;
  const next: MemoryRecord[] = [];
  for (const r of records) {
    const salience = r.salience - drop;
    if (salience < MEMORY_FORGET_THRESHOLD) continue; // истёрлась — забыта
    if (tick - r.tick > MEMORY_MAX_AGE_TICKS) continue; // старше горизонта — забыта
    next.push({ ...r, salience });
  }
  if (next.length === 0) resources.delete(MEMORY_KEY, eid); // пустой ключ не серилизуем
  else resources.set<readonly MemoryRecord[]>(MEMORY_KEY, eid, next);
}

/** Затухание отношений одного NPC: подтяжка к нейтралу + prune почти-нейтральных. */
function decayRelations(resources: ResourceStore, eid: EntityId, step: number): void {
  const rels = resources.get<readonly RelationEntry[]>(RELATIONS_KEY, eid);
  if (rels === undefined || rels.length === 0) return;
  const pull = RELATION_DECAY_PER_TICK * step;
  const next: RelationEntry[] = [];
  for (const [subject, value] of rels) {
    // Движение к 0 на `pull`, без перелёта через нейтрал.
    const mag = Math.abs(value) - pull;
    if (mag <= RELATION_NEUTRAL_EPSILON) continue; // остыло до нейтрала — запись уходит
    next.push([subject, value < 0 ? -mag : mag]);
  }
  if (next.length === 0) resources.delete(RELATIONS_KEY, eid);
  else resources.set<readonly RelationEntry[]>(RELATIONS_KEY, eid, next);
}

/** Чистка обхода одного NPC: удалить истёкшие записи (`untilTick <= tick`). */
function pruneAvoids(resources: ResourceStore, eid: EntityId, tick: number): void {
  const avoids = resources.get<readonly AvoidEntry[]>(AVOID_KEY, eid);
  if (avoids === undefined || avoids.length === 0) return;
  const next: AvoidEntry[] = [];
  for (const [loc, until] of avoids) {
    if (until > tick) next.push([loc, until]); // ещё действует
  }
  if (next.length === 0) resources.delete(AVOID_KEY, eid);
  else resources.set<readonly AvoidEntry[]>(AVOID_KEY, eid, next);
}

/**
 * Система MemoryDecay (`every: MEMORYDECAY_CADENCE`). Затухает память/отношения и чистит
 * истёкший обход у каждого NPC-носителя соответствующего ключа. No-op, если записей нет.
 */
export const MemoryDecay: System = {
  name: 'MemoryDecay',
  schedule: { every: MEMORYDECAY_CADENCE },
  update(ctx: SystemCtx): void {
    const { world } = ctx;
    const { resources } = world;
    const tick = world.tick;
    const step = MEMORYDECAY_CADENCE;

    // entries(key) — сорт. по eid (закон №8). Снимаем список eid ДО мутаций, чтобы не
    // зависеть от порядка/переаллокации бакета во время записи.
    for (const [eid] of resources.entries<readonly MemoryRecord[]>(MEMORY_KEY)) {
      decayMemory(resources, eid, tick, step);
    }
    for (const [eid] of resources.entries<readonly RelationEntry[]>(RELATIONS_KEY)) {
      decayRelations(resources, eid, step);
    }
    for (const [eid] of resources.entries<readonly AvoidEntry[]>(AVOID_KEY)) {
      pruneAvoids(resources, eid, tick);
    }
  },
};
