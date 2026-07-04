/**
 * @module @zona/sim/systems/robbery-memory
 *
 * Система RobberyMemory (задача 2.13, D-063) — ФОРМИРОВАНИЕ памяти об ограблении.
 * Замыкает социальную петлю бандитизма: жертва, ПЕРЕЖИВШАЯ грабёж, ЗАПОМИНАЕТ, кто её
 * ограбил, портит к нему отношение и начинает ИЗБЕГАТЬ опасного места. Обход маршрута
 * (часть B, task-selection.ts) уводит её мимо этой локации, память об обидчике питает
 * ROB-relationPenalty (2.12) и будущую месть/страх (Фаза 3). Всё — из СОСТОЯНИЯ (закон
 * №2), реактивно на событие, без игрока (закон №1) и без прямого вызова Encounters
 * (закон №6 — реакция ТОЛЬКО через шину).
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Память складывается без игрока: система читает уже ЗАФИКСИРОВАННЫЕ `loot/transferred`
 * прошлого тика и пишет «холодные» ключи памяти/отношений/обхода жертвы. Ни спавна, ни
 * скрипта — только реакция на факт мира.
 *
 * ── ЧТО ЧИТАЕТ (закон №6 — только шина) ──────────────────────────────────────
 * `loot/transferred {from,to,items,money,loc}` (Encounters 2.11/D-060): `from` —
 * ограбленный, `to` — грабитель, `loc` — где случилось. Система НЕ знает боевой
 * арифметики и не зовёт Encounters — читает лишь ФАКТ перевода лута через `bus.at(tick−1)`
 * (события уже закоммичены endTick, видны одинаково всем — модель двух фаз D-005).
 * `every: 1` ⇒ каждый закоммиченный тик читается РОВНО раз (тик T — на тике T+1), пропусков
 * нет.
 *
 * ── ЖИВАЯ ЖЕРТВА («мёртвые не помнят», порядок тика) ──────────────────────────
 * Память формируется, ТОЛЬКО если `from` — существующий носитель `Alive` (пережил
 * грабёж). Encounters идёт ДО Death в тике: убитой жертве Death (1.11) уже снял `Alive`
 * в ТОМ ЖЕ тике T, поэтому на тике T+1 проверка `Alive` корректно отсеивает погибших
 * (в 1v1 проигравший гибнет ⇒ типичный грабёж памяти НЕ формирует; помнит СБЕЖАВШИЙ
 * живым из сломленной группы или обчищенный победивший защитник — редкий survivor).
 * `to` (грабитель) как СУБЪЕКТ памяти НЕ обязан быть жив: жертва помнит и мёртвого
 * обидчика (запись — про прошлое).
 *
 * ── ТРИ ЭФФЕКТА (через ЧИСТЫЕ хелперы memory.ts 2.15 — НЕ дублируем логику) ────
 *  1. addMemory(from, {kind:'robbed', subject=entitySubject(to), salience=
 *     ROBBERY_MEMORY_SALIENCE, tick=ev.tick, causeEvent=ev.id, isFirsthand=true}) —
 *     помнит грабителя; `causeEvent` линкует запись на `loot/transferred` (D-038, id в
 *     поле записи, без скана лога). isFirsthand=true — жертва пережила лично (не слух).
 *  2. adjustRelation(from → entitySubject(to), −ROBBERY_RELATION_DELTA) — отношение к
 *     обидчику падает (кламп [−1..1]); + adjustRelation(from → factionSubject(фракция
 *     грабителя), −ROBBERY_FACTION_RELATION_DELTA), ЕСЛИ фракция грабителя наблюдаема
 *     (ResourceStore 'faction' — репутация «бандитов» у жертвы просаживается, DERIVED
 *     factionReputation 2.15 это учтёт).
 *  3. addAvoid(from, ev.loc, ev.tick + ROBBERY_AVOID_DURATION_TICKS) — метит место
 *     грабежа избегаемым на ~неделю (D-050); TaskSelection не поведёт туда маршрут.
 *     MemoryDecay (every:60) сам снимет запись по сроку — RobberyMemory за истечением не
 *     следит.
 *
 * ── ТИХО (событий НЕ публикуем, обоснование как MemoryDecay D-058) ────────────
 * Формирование памяти — ВНУТРЕННЕЕ изменение состояния сознания жертвы (как рост нужд
 * Needs или сдвиг отношения), а НЕ новое происшествие в мире: само происшествие
 * (`loot/transferred`) уже в логе, а его id хранится в `MemoryRecord.causeEvent`, поэтому
 * летопись (Фаза 3) проследит «жертва запомнила грабёж» память→causeEvent→loot/transferred
 * БЕЗ отдельного per-robbery события. Публиковать `memory/formed` значило бы задваивать
 * каждый грабёж в append-only логе и менять хэш на ровном месте. Prune MemoryDecay так же
 * тих (D-058).
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (законы №8, P0) ──────────────────────────────────────
 * Обход событий — в порядке лога (сорт. по id, D-005); эффекты каждого события — в
 * фиксированном порядке (память → отношения → обход); хелперы пишут НОВЫМИ
 * отсортированными массивами (D-035). rng НЕ используется (закон №2 — здесь нет
 * физиологии). Всё зависит только от закоммиченного лога прошлого тика ⇒ непрерывный
 * прогон ≡ split save/load.
 *
 * ── ПОДКЛЮЧЕНИЕ (2.16a конвейер, 2.16b носители) ─────────────────────────────
 * RobberyMemory в registerPhase2Systems (D-064). До 2.16b бандитов не было ⇒ ROB
 * дремал (0 `loot/transferred` ⇒ no-op). С 2.16b worldgen селит бандитов (фракция
 * bandits predatory, D-062/D-065) ⇒ ROB эмитит `loot/transferred` ⇒ система реально
 * пишет память/портит отношения/метит место грабежа. На ПУСТОМ мире (без сущностей)
 * по-прежнему no-op (голден 481914ae цел).
 */

import type { EntityId, EventId, FactionId, Tick } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { existsEntity, hasComponent } from '../core/ecs';
import { Alive } from '../core/components';
import { addMemory, adjustRelation, addAvoid, entitySubject, factionSubject } from './memory';
import {
  ROBBERY_MEMORY_SALIENCE,
  ROBBERY_RELATION_DELTA,
  ROBBERY_FACTION_RELATION_DELTA,
  ROBBERY_AVOID_DURATION_TICKS,
} from '../balance/social';

/** Ключ ResourceStore с наблюдаемой фракцией NPC (D-007; совпадает с worldgen/TaskSelection). */
const FACTION_KEY = 'faction';

/** Абстрактный id вида памяти об ограблении (закон №10 — код оперирует id, D-058). */
const ROBBED_KIND = 'robbed';

/**
 * Система RobberyMemory (`every: 1`). Реагирует на закоммиченные `loot/transferred`
 * прошлого тика: каждой ЖИВОЙ жертве записывает память о грабителе, портит к нему (и его
 * фракции) отношение и метит место грабежа избегаемым. No-op, если таких событий нет.
 */
export const RobberyMemory: System = {
  name: 'RobberyMemory',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    // Читаем ТОЛЬКО закоммиченный прошлый тик (модель двух фаз D-005): на тике 0 пусто.
    if (tick <= 0) return;
    const events = bus.at((tick - 1) as Tick); // сорт. по id (детерминизм, закон №8)

    for (const ev of events) {
      if (ev.type !== 'loot/transferred') continue;
      const victim = ev.payload.from as EntityId;
      const robber = ev.payload.to as EntityId;

      // «Мёртвые не помнят»: жертва должна ПЕРЕЖИТЬ грабёж (носит Alive). Death (1.11)
      // снял Alive у погибшей в том же тике грабежа ⇒ здесь она уже отсеяна.
      if (!existsEntity(ecs, victim) || !hasComponent(ecs, Alive, victim)) continue;

      const robberSubject = entitySubject(robber);

      // 1. Память о грабителе (causeEvent = id loot/transferred, D-038).
      addMemory(resources, victim, {
        kind: ROBBED_KIND,
        subject: robberSubject,
        salience: ROBBERY_MEMORY_SALIENCE,
        tick: ev.tick,
        causeEvent: ev.id as EventId,
        isFirsthand: true,
      });

      // 2. Отношение к грабителю падает; к его фракции — если она наблюдаема.
      adjustRelation(resources, victim, robberSubject, -ROBBERY_RELATION_DELTA);
      const robberFaction = resources.get<FactionId>(FACTION_KEY, robber);
      if (robberFaction !== undefined) {
        adjustRelation(resources, victim, factionSubject(robberFaction), -ROBBERY_FACTION_RELATION_DELTA);
      }

      // 3. Обход места грабежа до ev.tick + срок (MemoryDecay снимет по истечении).
      addAvoid(resources, victim, ev.payload.loc as number, (ev.tick as number) + ROBBERY_AVOID_DURATION_TICKS);
    }
  },
};
