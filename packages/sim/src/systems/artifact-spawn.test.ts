/**
 * @module @zona/sim/systems/artifact-spawn.test
 *
 * Гейт системы ArtifactSpawn (задача 2.9, D-054). Покрывает:
 *  - РОСТ ЗАРЯДА ПРИЧИННЫЙ: charge растёт на ARTIFACT_CHARGE_PER_TICK*cadence за вызов,
 *    детерминированно (без rng, независимо от seed);
 *  - НЕТ РОЖДЕНИЯ НИЖЕ ПОРОГА: пока charge < порога — только копится, ни артефакта,
 *    ни события;
 *  - ПОРОГ → РОВНО ОДИН артефакт за вызов, заряд списывается на порог (остаток
 *    переносится); артефакт физически лежит в наземном луте поля ('inventory'), qty 1;
 *  - TIER → ТИП АРТЕФАКТА детерминирован (data-driven, getArtifactForTier), клампинг
 *    сверх контента;
 *  - ЛЕДЖЕР: на каждую единицу — item/harvested(who=field, source='anomaly', qty=1),
 *    causedBy=artifact/spawned; artifact/spawned.causedBy=null (корень);
 *  - EconomyInvariant (D-045): Σ артефактов в inventory полей == Σ item/harvested.qty
 *    (масса растёт ровно на дельту леджера) — формула D-045, суженная на этот мир;
 *  - RESUME (P0, закон №8): непрерывный ≡ split save/load по хэшу И логу artifact/spawned
 *    (charge — аккумулятор-состояние, без таймера);
 *  - NO-OP на мире без полей (голдены Фазы 1 не двигаются);
 *  - ГЛАВНЫЙ ТЕСТ (закон №1): рождение идёт БЕЗ единого человека в мире.
 *
 * Компоненты — модульные singleton'ы (общие колонки по eid): миры идут ПОСЛЕДОВАТЕЛЬНО;
 * где миры делят eid, финал захватывается в примитивы/хэш ДО прогона следующего.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, ItemId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, queryEntities } from '../core/ecs';
import { AnomalyField, Position, Human } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { getArtifactForTier } from '../data/index';
import { ARTIFACT_CHARGE_PER_TICK, ARTIFACT_SPAWN_THRESHOLD } from '../balance/ecology';
import { ArtifactSpawn } from './artifact-spawn';

/** Шаг планировщика (истина — сама система, не литерал). */
const CADENCE = ArtifactSpawn.schedule.every;
/** Прирост заряда за один вызов системы. */
const GROWTH = ARTIFACT_CHARGE_PER_TICK * CADENCE;

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const FIELD = AnomalyField as unknown as { charge: Float32Array; tier: Uint8Array };
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Селит аномальное поле (AnomalyField + Position) с заданными charge/tier/loc. */
function placeField(world: SimWorld, charge: number, tier: number, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, AnomalyField, eid);
  FIELD.charge[eid] = charge;
  FIELD.tier[eid] = tier;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // «стоит» (D-019) — поле неподвижно
  return eid;
}

/** Планировщик из указанных систем (порядок регистрации = порядок исполнения). */
function scheduler(...systems: Parameters<ReturnType<typeof createScheduler>['register']>[0][]) {
  const s = createScheduler();
  for (const sys of systems) s.register(sys);
  return s;
}

/** Наземный лут поля (inventory) или []. */
function fieldInv(world: SimWorld, eid: EntityId): readonly InventoryEntry[] {
  return world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
}

/** Плоские строки artifact/spawned (безопасно переносить между мирами). */
interface SpawnRow {
  field: EntityId;
  item: string;
  tier: number;
  loc: number;
  tick: number;
  causedBy: number | null;
}
function spawnRows(world: SimWorld): SpawnRow[] {
  return world.bus.log
    .filter((e): e is Extract<SimEvent, { type: 'artifact/spawned' }> => e.type === 'artifact/spawned')
    .map((e) => ({
      field: e.payload.field,
      item: e.payload.item,
      tier: e.payload.tier,
      loc: e.payload.loc,
      tick: e.tick,
      causedBy: e.causedBy,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// РОСТ ЗАРЯДА — ПРИЧИННЫЙ (закон №2), БЕЗ RNG
// ─────────────────────────────────────────────────────────────────────────────
describe('рост заряда — детерминированная физика поля (закон №2, без rng)', () => {
  it('за один вызов charge растёт РОВНО на ARTIFACT_CHARGE_PER_TICK*cadence', () => {
    const w = createSimWorld(1 as Seed);
    const f = placeField(w, 0, 0, 4);
    scheduler(ArtifactSpawn).run(w, 1); // тик 0 — система due
    expect(FIELD.charge[f]).toBeCloseTo(GROWTH, 6);
  });

  it('рост НЕ зависит от seed (нет rng — «генерация среды», не «X% шанс»)', () => {
    const a = createSimWorld(1 as Seed);
    const fa = placeField(a, 0.1, 1, 4);
    scheduler(ArtifactSpawn).run(a, CADENCE * 3);
    const chargeA = FIELD.charge[fa]!;

    const b = createSimWorld(999 as Seed);
    const fb = placeField(b, 0.1, 1, 4);
    scheduler(ArtifactSpawn).run(b, CADENCE * 3);
    expect(FIELD.charge[fb]).toBeCloseTo(chargeA, 6);
  });

  it('канарейка перебаланса: прирост за шаг строго меньше порога (не более 1 артефакта/вызов)', () => {
    expect(GROWTH).toBeLessThan(ARTIFACT_SPAWN_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НЕТ РОЖДЕНИЯ НИЖЕ ПОРОГА
// ─────────────────────────────────────────────────────────────────────────────
describe('ниже порога — только накопление, без рождения (закон №2)', () => {
  it('charge=0 после вызова < порога → нет artifact/spawned, лут поля пуст', () => {
    const w = createSimWorld(2 as Seed);
    const f = placeField(w, 0, 0, 4);
    scheduler(ArtifactSpawn).run(w, 1);
    expect(spawnRows(w).length).toBe(0);
    expect(fieldInv(w, f).length).toBe(0);
    expect(FIELD.charge[f]!).toBeLessThan(ARTIFACT_SPAWN_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОРОГ → РОВНО ОДИН АРТЕФАКТ; ЗАРЯД СПИСЫВАЕТСЯ
// ─────────────────────────────────────────────────────────────────────────────
describe('порог → рождение артефакта, списание заряда (закон №3)', () => {
  it('charge на пороге → РОВНО один артефакт в луте поля (qty 1), заряд -= порог', () => {
    const w = createSimWorld(3 as Seed);
    const f = placeField(w, ARTIFACT_SPAWN_THRESHOLD, 0, 4); // ровно на пороге
    scheduler(ArtifactSpawn).run(w, 1);

    const spawns = spawnRows(w);
    expect(spawns.length).toBe(1); // РОВНО один за вызов
    const inv = fieldInv(w, f);
    expect(inv.length).toBe(1);
    expect(inv[0]!.qty).toBe(1);
    expect(inv[0]!.item).toBe(getArtifactForTier(0).id);
    // charge: (порог + growth) − порог = growth (остаток перенесён, не потерян).
    expect(FIELD.charge[f]).toBeCloseTo(GROWTH, 6);
  });

  it('РОВНО один артефакт за вызов даже при огромном заряде (остаток переносится)', () => {
    const w = createSimWorld(4 as Seed);
    const f = placeField(w, ARTIFACT_SPAWN_THRESHOLD * 3, 0, 4);
    scheduler(ArtifactSpawn).run(w, 1);
    expect(spawnRows(w).length).toBe(1); // не 3 — не более одного за вызов
    expect(fieldInv(w, f)[0]!.qty).toBe(1);
    // Остаток ~ 2*порог + growth (последующие вызовы дренируют его).
    expect(FIELD.charge[f]!).toBeCloseTo(ARTIFACT_SPAWN_THRESHOLD * 2 + GROWTH, 5);
  });

  it('ГЛАВНЫЙ ТЕСТ (закон №1): артефакт рождается БЕЗ единого человека в мире', () => {
    const w = createSimWorld(5 as Seed);
    placeField(w, ARTIFACT_SPAWN_THRESHOLD, 0, 4);
    expect(queryEntities(w.ecs, [Human]).length).toBe(0); // людей нет вовсе
    scheduler(ArtifactSpawn).run(w, 1);
    expect(spawnRows(w).length).toBe(1); // мир живёт без игрока
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER → ТИП АРТЕФАКТА (data-driven, детерминирован)
// ─────────────────────────────────────────────────────────────────────────────
describe('tier поля → тип артефакта детерминирован (data-driven, закон №10)', () => {
  it('каждый tier даёт артефакт getArtifactForTier(tier); клампинг сверх контента', () => {
    for (const tier of [0, 1, 2, 5]) {
      const w = createSimWorld((10 + tier) as Seed);
      const f = placeField(w, ARTIFACT_SPAWN_THRESHOLD, tier, 4);
      scheduler(ArtifactSpawn).run(w, 1);
      const inv = fieldInv(w, f);
      expect(inv.length).toBe(1);
      expect(inv[0]!.item).toBe(getArtifactForTier(tier).id);
      expect(spawnRows(w)[0]!.tier).toBe(tier);
    }
  });

  it('разные ступени дают РАЗНЫЕ артефакты (tier 0 ≠ tier 2)', () => {
    expect(getArtifactForTier(0).id).not.toBe(getArtifactForTier(2).id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ЛЕДЖЕР + EconomyInvariant (D-045)
// ─────────────────────────────────────────────────────────────────────────────
describe('леджер item/harvested корректен; масса растёт ровно на дельту леджера (D-045)', () => {
  it('на рождение — один item/harvested(who=field, source=anomaly, qty1), causedBy=spawned; spawned.causedBy=null', () => {
    const w = createSimWorld(6 as Seed);
    const f = placeField(w, ARTIFACT_SPAWN_THRESHOLD, 1, 4);
    scheduler(ArtifactSpawn).run(w, 1);

    const spawned = w.bus.log.find((e) => e.type === 'artifact/spawned')!;
    const harvested = w.bus.log.filter((e) => e.type === 'item/harvested');
    expect(harvested.length).toBe(1);
    const h = harvested[0] as Extract<SimEvent, { type: 'item/harvested' }>;
    expect(h.payload.who).toBe(f);
    expect(h.payload.source).toBe('anomaly');
    expect(h.payload.qty).toBe(1);
    expect(h.payload.item).toBe(getArtifactForTier(1).id);
    expect(h.causedBy).toBe(spawned.id); // добыча — следствие рождения
    expect(spawned.causedBy).toBe(null); // накопление заряда — корень цепочки
  });

  it('EconomyInvariant (D-045): Σ артефактов в луте полей == Σ item/harvested.qty', () => {
    // Несколько полей, много вызовов → несколько рождений. Формула D-045 (baseline 0):
    // прирост массы мира (артефакты в inventory) должен ровно равняться дельте леджера.
    const w = createSimWorld(7 as Seed);
    const fields = [
      placeField(w, ARTIFACT_SPAWN_THRESHOLD, 0, 4),
      placeField(w, ARTIFACT_SPAWN_THRESHOLD * 2, 1, 5),
      placeField(w, 0, 2, 4),
    ];
    scheduler(ArtifactSpawn).run(w, CADENCE * 40); // достаточно для нескольких разрядов

    // Σ массы мира по артефактам (worldTotals-аналог, только артефакты).
    let massArtifacts = 0;
    for (const f of fields) for (const e of fieldInv(w, f)) massArtifacts += e.qty;

    // Σ леджера (ledgerDelta-аналог: только harvested — единственный источник тут).
    let ledgerArtifacts = 0;
    for (const e of w.bus.log) {
      if (e.type === 'item/harvested') ledgerArtifacts += e.payload.qty;
    }

    expect(massArtifacts).toBeGreaterThan(0); // рождения реально были
    expect(massArtifacts).toBe(ledgerArtifacts); // масса == леджер (D-045 держится)
    // Каждое рождение = ровно одно spawned + одно harvested (парность).
    expect(spawnRows(w).length).toBe(ledgerArtifacts);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUME (P0, закон №8)
// ─────────────────────────────────────────────────────────────────────────────
describe('resume: непрерывный ≡ split save/load (P0, закон №8)', () => {
  it('хэш и лог artifact/spawned совпадают у непрерывного и split-прогонов', () => {
    const N = CADENCE * 30;
    const MID = CADENCE * 11;

    const build = (): SimWorld => {
      const w = createSimWorld(42 as Seed);
      placeField(w, ARTIFACT_SPAWN_THRESHOLD, 0, 4);
      placeField(w, ARTIFACT_SPAWN_THRESHOLD * 0.5, 2, 5);
      return w;
    };

    const cont = build();
    scheduler(ArtifactSpawn).run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contSpawns = spawnRows(cont);

    const split = build();
    scheduler(ArtifactSpawn).run(split, MID);
    const resumed = deserialize(serialize(split));
    scheduler(ArtifactSpawn).run(resumed, N - MID);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(spawnRows(resumed)).toEqual(contSpawns);
    expect(contSpawns.length).toBeGreaterThan(0); // прогон реально рождал артефакты
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NO-OP на мире без полей (голдены Фазы 1)
// ─────────────────────────────────────────────────────────────────────────────
describe('мир без аномальных полей: система — no-op (голдены Фазы 1 стабильны)', () => {
  it('пустой мир: ArtifactSpawn ничего не публикует и не создаёт носителей', () => {
    const w = createSimWorld(1 as Seed);
    scheduler(ArtifactSpawn).run(w, CADENCE * 5);
    // Ни одного события (ранний выход при пустом наборе полей) — система инертна на
    // текущем worldgen (носителей AnomalyField нет до 2.16) ⇒ голдены Фазы 1 целы.
    expect(w.bus.log.length).toBe(0);
    expect(queryEntities(w.ecs, [AnomalyField]).length).toBe(0);
  });
});
