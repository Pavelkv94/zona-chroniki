/**
 * @module @zona/sim/data/settlements-validation.test
 *
 * НЕГАТИВНЫЕ гейты загрузчика контента Фазы 2 (задача 2.2, закон №10 fail-fast):
 * доказывают, что `validateSettlements`/`validateFactionRelations` РЕАЛЬНО БРОСАЮТ
 * `DataError` на битом контенте — а не «проходят по недосмотру». Валидаторы —
 * приватные (не экспортируются), поэтому подсовываем БИТЫЙ JSON через `vi.doMock`
 * и заново импортируем `./index`: загрузка модуля обязана упасть до старта симуляции
 * (опечатка-нуль/чужой itemId/несимметричное отношение не должны молча портить мир).
 *
 * Карта/предметы/фракции-СПИСОК остаются РЕАЛЬНЫМИ (мокаем только проверяемый файл),
 * чтобы падал ровно тот валидатор, который тестируем. Каждый кейс изолирован
 * `vi.resetModules()` — глобального состояния между кейсами нет (закон №8).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realSettlements from './settlements.json';
import realFactions from './factions.json';

type SettlementsJson = typeof realSettlements;
type FactionsJson = typeof realFactions;

/** Глубокая копия реального контента — мутируем её, не трогая исходный JSON. */
function cloneSettlements(): SettlementsJson {
  return JSON.parse(JSON.stringify(realSettlements)) as SettlementsJson;
}
function cloneFactions(): FactionsJson {
  return JSON.parse(JSON.stringify(realFactions)) as FactionsJson;
}

/** Импортирует './index' СВЕЖИМ (после doMock) и ждёт падения валидатора. */
async function expectLoadRejects(re: RegExp): Promise<void> {
  await expect(import('./index')).rejects.toThrow(re);
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('./settlements.json');
  vi.doUnmock('./factions.json');
  vi.resetModules();
});

describe('settlements.json — fail-fast на битом складе/локации/фракции (закон №3/№10)', () => {
  it('поселение на НЕ-settlement локации (loc=2, Агропром/wild) → DataError', async () => {
    const bad = cloneSettlements();
    bad.settlements[0]!.loc = 2; // wild-локация, а не поселение
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/не type 'settlement'/);
  });

  it('itemId склада вне items.json → DataError (закон №3: предмета не существует)', async () => {
    const bad = cloneSettlements();
    (bad.settlements[0]!.startingWarehouse[0] as { item: string }).item = 'gold_bar__нет';
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный предмет "gold_bar__нет"/);
  });

  it('дубль предмета на складе → DataError', async () => {
    const bad = cloneSettlements();
    const wh = bad.settlements[0]!.startingWarehouse;
    (wh[1] as { item: string }).item = (wh[0] as { item: string }).item; // две записи одного item
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/дубль предмета/);
  });

  it('нецелое/нулевое qty склада → DataError', async () => {
    const bad = cloneSettlements();
    (bad.settlements[0]!.startingWarehouse[0] as { qty: number }).qty = 0;
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/qty должен быть целым >0/);
  });

  it('неизвестная фракция поселения → DataError (закон №10)', async () => {
    const bad = cloneSettlements();
    (bad.settlements[0]! as { faction: string }).faction = '__нетфракции__';
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестная фракция "__нетфракции__"/);
  });

  it('отрицательная касса (startingTreasury<0) → DataError', async () => {
    const bad = cloneSettlements();
    (bad.settlements[0]! as { startingTreasury: number }).startingTreasury = -1;
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/startingTreasury должен быть >=0/);
  });

  it('дубль loc (два поселения на одной локации) → DataError', async () => {
    const bad = cloneSettlements();
    bad.settlements[1]!.loc = bad.settlements[0]!.loc; // обе на одной локации
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/дубль loc=/);
  });

  it('рецепт с несуществующим out → DataError (закон №3)', async () => {
    const bad = cloneSettlements();
    (bad.settlements[0]!.recipes[0] as { out: string }).out = '__нетпредмета__';
    vi.doMock('./settlements.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный out "__нетпредмета__"/);
  });
});

describe('factions.json — fail-fast на битой матрице отношений (закон №10)', () => {
  it('отношение вне диапазона [−100,100] → DataError', async () => {
    const bad = cloneFactions();
    (bad.relations[0] as { value: number }).value = 250;
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/value 250 вне \[-100,100\]/);
  });

  it('ДУБЛЬ неупорядоченной пары (асимметрия/двойная запись) → DataError', async () => {
    const bad = cloneFactions();
    const first = bad.relations[0]!;
    // Добавляем ОБРАТНОЕ ребро той же пары — отношение симметрично, дубль запрещён.
    bad.relations.push({ a: first.b, b: first.a, value: 5 });
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/дубль пары/);
  });

  it('отношение фракции с самой собой (a===b) → DataError', async () => {
    const bad = cloneFactions();
    (bad.relations[0] as { b: string }).b = bad.relations[0]!.a;
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/с собой не хранится/);
  });

  it('ссылка на несуществующую фракцию в relations → DataError', async () => {
    const bad = cloneFactions();
    (bad.relations[0] as { b: string }).b = '__нетфракции__';
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестная фракция b="__нетфракции__"/);
  });
});
