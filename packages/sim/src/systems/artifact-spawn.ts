/**
 * @module @zona/sim/systems/artifact-spawn
 *
 * Система ArtifactSpawn (задача 2.9, D-054) — ПРИЧИННОЕ рождение артефактов в
 * аномальных полях. Аномальное поле (носитель data-компонента `AnomalyField`,
 * D-046) накапливает заряд и, достигнув порога, «разряжается» в физический предмет-
 * артефакт, лежащий на земле поля. Это легитимный ИСТОЧНИК массы (закон №3): предмет
 * не из воздуха — он рождён полем; появление леджерится `item/harvested`, поэтому
 * EconomyInvariant (D-045) держится. Общение — только через ECS-компоненты,
 * «холодный» ResourceStore и шину с `causedBy` (закон №6): система никого не зовёт.
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Всё здесь работает БЕЗ игрока: заряд полей растёт и артефакты рождаются по
 * СОСТОЯНИЮ поля, даже если в мире нет ни одного человека. Артефакт — эмерджентный
 * продукт аномальной физики, а не выдача игроку.
 *
 * ── ПРИЧИННОСТЬ РОСТА ЗАРЯДА (закон №2, НЕ «X% выпадения») ─────────────────────
 * `AnomalyField.charge` растёт ДЕТЕРМИНИРОВАННО каждый тик на `ARTIFACT_CHARGE_PER_TICK`
 * (balance/ecology, закон №7); система идёт с шагом `every: ARTIFACTSPAWN_CADENCE`,
 * поэтому за один вызов добавляет `ARTIFACT_CHARGE_PER_TICK * cadence` (компенсация
 * редкого шага, как ставки пастьбы Animals «×every»). Это интринсик-физика аномалии —
 * категория «генерация среды» (как накопление длительности погоды D-028 или рост
 * нужд Needs), а НЕ бросок кости над фактом выпадения: rng НЕ используется вовсе.
 * Резерв на Фазу 3 (seam): выброс (emission) сможет ДОБАВЛЯТЬ заряд событием (тогда
 * `artifact/spawned.causedBy` = id выброса); сейчас рост чисто интринсик, corner-cause
 * = null.
 *
 * ── ПОРОГ И РАЗРЯД ────────────────────────────────────────────────────────────
 * При `charge >= ARTIFACT_SPAWN_THRESHOLD` поле рождает РОВНО ОДИН артефакт за вызов
 * (как одно рождение на стадо у Animals — ограничивает всплеск): `charge -= порог`
 * (списание на стоимость, остаток переносится). Тип артефакта — из `AnomalyField.tier`
 * через данные (`getArtifactForTier`, items.json, закон №10 — код оперирует id);
 * `tier` детерминированно (без rng) отображается в артефакт. Ниже порога — только
 * рост заряда, НИКАКОГО рождения (закон №2: причина — состояние заряда).
 *
 * ── «АРТЕФАКТ НА ЗЕМЛЕ» = наземный лут поля (D-046, БЕЗ нового механизма) ──────
 * Родившийся артефакт кладётся в cold `'inventory'` НА eid ПОЛЯ — тот же ключ и та
 * же форма `{item, qty}` (сорт. по item), под которыми лежат склад поселения, лут
 * трупа и инвентарь NPC (D-046/D-007). Отдельного «наземного хранилища» не вводим:
 * инвентарь на не-NPC сущности УЖЕ есть механизм лута мира (труп D-041, склад 2.2),
 * и он уже учитывается EconomyInvariant (worldTotals суммирует 'inventory' по ВСЕМ
 * eid). SEAM ДЛЯ СБОРА (задача 2.10, SEARCH): NPC заберёт артефакт, ПЕРЕМЕСТИВ запись
 * из inventory поля в свой inventory — это ПЕРЕВОД (масса сохраняется, леджер не
 * нужен, как торговля D-047), а НЕ повторный `item/harvested`. Поле остаётся носителем
 * AnomalyField и продолжает заряжаться (может накопить несколько артефактов до сбора —
 * qty растёт/несколько записей; форма инвентаря это поддерживает).
 *
 * ── ЛЕДЖЕР МАССЫ (закон №3, D-045) ────────────────────────────────────────────
 * Рождение УВЕЛИЧИВАЕТ массу мира (артефакт появился в inventory поля), поэтому на
 * КАЖДУЮ единицу эмитится `item/harvested{who: field, item, qty:1, source:'anomaly'}`
 * (`causedBy` = id `artifact/spawned`). Дельта леджера равна росту тоталов ⇒
 * EconomyInvariant держится (проверено тестом mass==ledger).
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (закон №8, P0) ───────────────────────────────────────
 * Обход полей — `queryEntities([AnomalyField])` (сорт. по eid). `charge` —
 * сериализуемое SoA-поле (D-046/1.0): аккумулятор сам себе «часы», хранимого таймера
 * нет ⇒ непрерывный прогон ≡ split save/load (рост зависит только от charge, не от
 * тика). rng НЕ используется (рост/порог/выбор артефакта — арифметика). Инвентарь
 * поля пишется НОВЫМ массивом (не мутация in-place, изоляция ссылок, закон №3).
 *
 * ── ПОДКЛЮЧЕНИЕ (2.16a конвейер, 2.16b носители) ─────────────────────────────
 * ArtifactSpawn в registerPhase2Systems (D-064). С 2.16b worldgen материализует
 * носители AnomalyField из anomaly_fields.json (charge=0, лут пуст; D-065), поэтому
 * система реально копит заряд и рождает артефакты в наземный лут поля (item/harvested).
 * На ПУСТОМ мире (без полей) — ранний выход/no-op (голден 481914ae цел).
 */

import type { EntityId, EventId, ItemId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities } from '../core/ecs';
import { AnomalyField, Position } from '../core/components';
import { getArtifactForTier } from '../data/index';
import { ARTIFACT_CHARGE_PER_TICK, ARTIFACT_SPAWN_THRESHOLD } from '../balance/ecology';

/** Ключ ResourceStore наземного лута поля (тот же, что склад/труп/инвентарь, D-046). */
const INVENTORY_KEY = 'inventory';

/**
 * Шаг планировщика ArtifactSpawn. `60` (час игрового времени): аномальная физика не
 * требует по-тиковой реакции, редкий шаг дешевле (бюджет 1.6 мс, D-006). Ставка
 * `ARTIFACT_CHARGE_PER_TICK` домножается на этот шаг (компенсация накопления за
 * `cadence` тиков — как «×every» у Animals). Структурная величина (не баланс/не
 * контент), поэтому живёт рядом с системой, как `ANIMALS_CADENCE`.
 */
const ARTIFACTSPAWN_CADENCE = 60;

// ── Инвариант «за один шаг не более одного артефакта» (канарейка перебаланса) ──
//
// Система рождает РОВНО ОДИН артефакт за вызов (остаток заряда переносится). Чтобы
// поле не копило заряд быстрее, чем разряжается (иначе очередь артефактов росла бы
// молча), прирост за шаг ОБЯЗАН быть строго меньше порога. Проверяем при загрузке
// модуля и падаем ГРОМКО при рассинхроне констант (как guard кратности у Animals).
if (ARTIFACT_CHARGE_PER_TICK * ARTIFACTSPAWN_CADENCE >= ARTIFACT_SPAWN_THRESHOLD) {
  throw new Error(
    `ArtifactSpawn: прирост заряда за шаг (${ARTIFACT_CHARGE_PER_TICK} * ${ARTIFACTSPAWN_CADENCE}) ` +
      `должен быть строго меньше порога рождения (${ARTIFACT_SPAWN_THRESHOLD}), иначе поле копит ` +
      `заряд быстрее, чем разряжается. Правьте balance/ecology.ts или ARTIFACTSPAWN_CADENCE.`,
  );
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const FIELD = AnomalyField as unknown as { charge: Float32Array; readonly tier: Uint8Array };
const POS = Position as unknown as { readonly loc: Uint32Array };

/** Единица инвентаря (та же форма, что пишет worldgen 1.3, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * Добавляет `qty` артефакта `item` в наземный лут поля `eid` — НОВЫЙ массив (не
 * in-place, закон №3/№8), мержит с существующей записью и сохраняет сортировку по
 * item. Если инвентаря ещё нет — создаёт с одной записью. Так поле может накопить
 * несколько артефактов до сбора (SEARCH 2.10), не теряя формы инвентаря.
 */
function addArtifact(
  resources: SystemCtx['world']['resources'],
  eid: EntityId,
  item: ItemId,
  qty: number,
): void {
  const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
  const next: InventoryEntry[] = [];
  let merged = false;
  for (const e of inv) {
    if (e.item === item) {
      next.push({ item, qty: e.qty + qty });
      merged = true;
    } else {
      next.push(e);
    }
  }
  if (!merged) next.push({ item, qty });
  next.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, next);
}

/**
 * Система ArtifactSpawn (`every: ARTIFACTSPAWN_CADENCE`). Копит заряд каждому
 * аномальному полю и на пороге рождает артефакт в наземный лут поля (+ леджер).
 */
export const ArtifactSpawn: System = {
  name: 'ArtifactSpawn',
  schedule: { every: ARTIFACTSPAWN_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const fields = queryEntities(world.ecs, [AnomalyField, Position]);
    if (fields.length === 0) return; // нет полей — no-op (текущий worldgen, голдены целы)

    for (const eid of fields) {
      // Рост заряда — детерминированная физика поля (закон №2), компенсация шага.
      const charge = (FIELD.charge[eid] as number) + ARTIFACT_CHARGE_PER_TICK * ARTIFACTSPAWN_CADENCE;

      if (charge < ARTIFACT_SPAWN_THRESHOLD) {
        FIELD.charge[eid] = charge; // ниже порога — только копим, рождения нет
        continue;
      }

      // РАЗРЯД: рождается РОВНО ОДИН артефакт, заряд списывается на стоимость (порог),
      // остаток переносится (не теряется).
      FIELD.charge[eid] = charge - ARTIFACT_SPAWN_THRESHOLD;

      const tier = FIELD.tier[eid] as number;
      const artifact = getArtifactForTier(tier); // data-driven, детерминирован по tier
      const item = artifact.id as ItemId;
      const loc = POS.loc[eid] as LocationId;

      // Артефакт физически появляется в наземном луте поля (закон №3: источник — поле).
      addArtifact(world.resources, eid, item, 1);

      // Причинность (закон №6, D-030/D-054): накопление заряда до порога — КОРЕНЬ
      // цепочки (null), как animal/born; выброс Фазы 3 встанет сюда позже (seam).
      const spawnedId: EventId = bus.publish({
        type: 'artifact/spawned',
        causedBy: null,
        payload: { field: eid, item, tier, loc },
      });

      // ЛЕДЖЕР (D-045, закон №3): новая масса в мире (артефакт в inventory поля) —
      // item/harvested(source:'anomaly'), причина = artifact/spawned. EconomyInvariant
      // увидит рост тоталов ровно на эту дельту.
      bus.publish({
        type: 'item/harvested',
        causedBy: spawnedId,
        payload: { who: eid, item, qty: 1, source: 'anomaly' },
      });
    }
  },
};
