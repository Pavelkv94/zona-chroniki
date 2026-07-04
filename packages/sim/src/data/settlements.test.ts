/**
 * @module @zona/sim/data/settlements.test
 *
 * Юниты контента Фазы 2 (задача 2.2): поселения (settlements.json) и матрица
 * отношений фракций (factions.json). Покрывает DoD:
 *  - settlements.json/factions.json ВАЛИДИРУЮТСЯ загрузчиком (fail-fast) и заморожены;
 *  - getSettlement(loc)/getSettlements()/getFaction(id)/getRelation(a,b) резолвятся;
 *  - СВЯЗНОСТЬ с картой: каждая settlement-локация реально `type === 'settlement'`
 *    в map.json (закон №10 — контент согласован между файлами);
 *  - relations: id уникальны, симметричны (rel(a,b)===rel(b,a)), в диапазоне
 *    [−100,100], без дублей неупорядоченной пары; фракция с собой = максимум;
 *  - закон №3: каждый itemId склада/рецепта существует в items.json.
 *
 * Всё детерминировано (закон №8): списки — из замороженных данных, без rng.
 */

import { describe, it, expect } from 'vitest';
import {
  MAP,
  ITEMS,
  FACTIONS,
  RELATIONS,
  SETTLEMENTS,
  getItem,
  getFaction,
  getRelation,
  getSettlement,
  getSettlements,
} from './index';

const ITEM_IDS = new Set(ITEMS.map((i) => i.id));
const FACTION_IDS = new Set(FACTIONS.map((f) => f.id));

// ── Фракции и матрица отношений (закон №10) ──────────────────────────────────

describe('factions.json — 4 фракции с уникальными id (задача 2.2)', () => {
  it('содержит loners/military/duty/bandits, id уникальны и непусты', () => {
    const ids = FACTIONS.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['loners', 'military', 'duty', 'bandits']));
    expect(new Set(ids).size).toBe(ids.length); // уникальны
    for (const f of FACTIONS) {
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.name.length).toBeGreaterThan(0);
    }
  });

  it('getFaction резолвит все 4 id и бросает на неизвестном (закон №10)', () => {
    for (const id of ['loners', 'military', 'duty', 'bandits']) {
      expect(getFaction(id).id).toBe(id);
    }
    expect(() => getFaction('__нет__')).toThrow();
  });
});

describe('factions.json — матрица отношений (симметрия/диапазон/резолв)', () => {
  it('каждое ребро: валидные id, a!==b, value ∈ [−100,100]', () => {
    for (const r of RELATIONS) {
      expect(FACTION_IDS.has(r.a)).toBe(true);
      expect(FACTION_IDS.has(r.b)).toBe(true);
      expect(r.a).not.toBe(r.b);
      expect(r.value).toBeGreaterThanOrEqual(-100);
      expect(r.value).toBeLessThanOrEqual(100);
    }
  });

  it('нет дублей по неупорядоченной паре (симметрия хранится один раз)', () => {
    const seen = new Set<string>();
    for (const r of RELATIONS) {
      const key = r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('getRelation симметричен: rel(a,b) === rel(b,a)', () => {
    for (const r of RELATIONS) {
      expect(getRelation(r.a, r.b)).toBe(r.value);
      expect(getRelation(r.b, r.a)).toBe(r.value); // обратный порядок — то же
    }
  });

  it('фракция с собой = максимум (+100); неописанная пара = нейтралитет (0)', () => {
    for (const id of FACTION_IDS) expect(getRelation(id, id)).toBe(100);
    // Пары без явной записи в матрице → 0. (Если пара описана — этот тест её пропустит.)
    const described = new Set(
      RELATIONS.map((r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`)),
    );
    const ids = [...FACTION_IDS];
    for (const a of ids)
      for (const b of ids) {
        if (a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!described.has(key)) expect(getRelation(a, b)).toBe(0);
      }
  });

  it('дизайн-контракт: Долг↔Бандиты враждебны (<0), Одиночки↔Долг не враждебны (>=0)', () => {
    expect(getRelation('duty', 'bandits')).toBeLessThan(0);
    expect(getRelation('loners', 'duty')).toBeGreaterThanOrEqual(0);
  });

  it('getRelation бросает на неизвестной фракции (закон №10)', () => {
    expect(() => getRelation('loners', '__нет__')).toThrow();
    expect(() => getRelation('__нет__', 'duty')).toThrow();
  });

  it('RELATIONS заморожен (иммутабельность контента)', () => {
    expect(Object.isFrozen(RELATIONS)).toBe(true);
  });
});

// ── Поселения (закон №10) ────────────────────────────────────────────────────

describe('settlements.json — 2 поселения (Кордон/Росток) со складом и кассой', () => {
  it('ровно 2 поселения на локациях 0 (Кордон) и 5 (Росток)', () => {
    expect(SETTLEMENTS.length).toBe(2);
    const locs = SETTLEMENTS.map((s) => s.loc).sort((a, b) => a - b);
    expect(locs).toEqual([0, 5]);
  });

  it('getSettlements()/getSettlement(loc) резолвятся; не-поселение → undefined', () => {
    expect(getSettlements().length).toBe(2);
    expect(getSettlement(0)?.faction).toBe('loners');
    expect(getSettlement(5)?.faction).toBe('duty');
    expect(getSettlement(9)).toBeUndefined(); // Саркофаг — не поселение
    expect(getSettlement(2)).toBeUndefined(); // Агропром (wild)
  });

  it('СВЯЗНОСТЬ с map: каждая settlement-локация реально type "settlement" (D-025)', () => {
    for (const s of SETTLEMENTS) {
      expect(MAP.locations[s.loc]!.type).toBe('settlement');
    }
    // И обратно: все settlement-локации карты покрыты поселением (нет «пустых» баз).
    const covered = new Set(SETTLEMENTS.map((s) => s.loc));
    for (const loc of MAP.locations) {
      if (loc.type === 'settlement') expect(covered.has(loc.id)).toBe(true);
    }
  });

  it('каждое поселение: faction резолвится, shelterBase ∈ [0,10], treasury >= 0', () => {
    for (const s of SETTLEMENTS) {
      expect(() => getFaction(s.faction)).not.toThrow();
      expect(FACTION_IDS.has(s.faction)).toBe(true);
      expect(s.shelterBase).toBeGreaterThanOrEqual(0);
      expect(s.shelterBase).toBeLessThanOrEqual(10);
      expect(s.startingTreasury).toBeGreaterThanOrEqual(0);
    }
  });

  it('склад (закон №3): каждый itemId существует в items.json, qty>0 целые, без дублей', () => {
    for (const s of SETTLEMENTS) {
      expect(s.startingWarehouse.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const w of s.startingWarehouse) {
        expect(ITEM_IDS.has(w.item)).toBe(true);
        expect(() => getItem(w.item)).not.toThrow();
        expect(Number.isInteger(w.qty)).toBe(true);
        expect(w.qty).toBeGreaterThan(0);
        expect(seen.has(w.item)).toBe(false);
        seen.add(w.item);
      }
    }
  });

  it('рецепты (закон №3): out и все in.item существуют в items.json; qty>0; labor>0', () => {
    for (const s of SETTLEMENTS) {
      for (const r of s.recipes) {
        expect(ITEM_IDS.has(r.out)).toBe(true);
        expect(r.labor).toBeGreaterThan(0);
        expect(r.in.length).toBeGreaterThan(0);
        for (const ing of r.in) {
          expect(ITEM_IDS.has(ing.item)).toBe(true);
          expect(ing.qty).toBeGreaterThan(0);
        }
      }
    }
  });

  it('потребление неотрицательно; buildQueue — непустые projectId', () => {
    for (const s of SETTLEMENTS) {
      expect(s.consumption.perCapita.food).toBeGreaterThanOrEqual(0);
      expect(s.consumption.perCapita.water).toBeGreaterThanOrEqual(0);
      for (const p of s.buildQueue) expect(p.length).toBeGreaterThan(0);
    }
  });

  it('склад НЕ содержит meat (инвариант Ф1: meat=0 на старте, мясо только из туш 1.10b)', () => {
    // Мясо в мире обязано физически возникать из туш (item/harvested), а не лежать на
    // складе базлайном — иначе стартовая масса мяса ≠ 0 и «meat=0 на t0» ломается.
    for (const s of SETTLEMENTS) {
      for (const w of s.startingWarehouse) expect(w.item).not.toBe('meat');
    }
  });

  it('SETTLEMENTS заморожен (иммутабельность контента)', () => {
    expect(Object.isFrozen(SETTLEMENTS)).toBe(true);
    expect(Object.isFrozen(SETTLEMENTS[0]!.startingWarehouse)).toBe(true);
  });
});
