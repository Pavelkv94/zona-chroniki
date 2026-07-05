/**
 * @module @zona/sim/data/phase5-content-validation.test
 *
 * НЕГАТИВНЫЕ гейты загрузчика контента Фазы 5 (задача 5.1, закон №10 fail-fast, ревью
 * 5.0 note #1): доказывают, что `validateSpecies` (новые флаги) и `validateDiseases`
 * РЕАЛЬНО БРОСАЮТ `DataError` на битом контенте, а не «проходят по недосмотру».
 * Валидаторы приватные — подсовываем БИТЫЙ JSON через `vi.doMock` и заново импортируем
 * `./index`: загрузка модуля обязана упасть ДО старта симуляции (несуществующий prey/
 * partItem, partItem без partYield, плохой moveDriver, кривая болезнь не должны молча
 * портить мир). Каждый кейс изолирован `vi.resetModules()` (закон №8).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realSpecies from './species.json';
import realDiseases from './diseases.json';
import realFactions from './factions.json';

type SpeciesJson = typeof realSpecies;
type DiseasesJson = typeof realDiseases;
type FactionsJson = typeof realFactions;

function cloneSpecies(): SpeciesJson {
  return JSON.parse(JSON.stringify(realSpecies)) as SpeciesJson;
}
function cloneDiseases(): DiseasesJson {
  return JSON.parse(JSON.stringify(realDiseases)) as DiseasesJson;
}
function cloneFactions(): FactionsJson {
  return JSON.parse(JSON.stringify(realFactions)) as FactionsJson;
}

/** Индекс псевдособаки (первый хищник с prey/partItem) в species.json. */
const PSEUDODOG = 2;

async function expectLoadRejects(re: RegExp): Promise<void> {
  await expect(import('./index')).rejects.toThrow(re);
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('./species.json');
  vi.doUnmock('./diseases.json');
  vi.doUnmock('./factions.json');
  vi.resetModules();
});

describe('species.json — fail-fast на битых флагах экосистемы (закон №3/№10)', () => {
  it('prey ссылается на несуществующий вид → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { prey: string[] }).prey = ['deer', '__нетвида__'];
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестная жертва "__нетвида__"/);
  });

  it('prey="human" (резервный токен) — ДОПУСТИМ (не падает по этой причине)', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { prey: string[] }).prey = ['human'];
    vi.doMock('./species.json', () => ({ default: bad }));
    // Контент валиден — загрузка проходит (human — легальная жертва-человек).
    await expect(import('./index')).resolves.toBeDefined();
  });

  it('partItem без partYield → DataError (согласованность)', async () => {
    const bad = cloneSpecies();
    delete (bad.species[PSEUDODOG] as { partYield?: number }).partYield;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partItem и partYield должны быть заданы ОБА или НИ ОДНОГО/);
  });

  it('partItem ссылается на несуществующий предмет → DataError (закон №3)', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { partItem: string }).partItem = '__нетпредмета__';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partItem "__нетпредмета__" не существует/);
  });

  it('неизвестный moveDriver → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { moveDriver: string }).moveDriver = 'teleport';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный moveDriver "teleport"/);
  });

  it('нечисловой флаг predator → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { predator: unknown }).predator = 'yes';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/флаг predator должен быть boolean/);
  });

  it('нецелый partYield → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { partYield: number }).partYield = 0;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partYield должен быть целым >0/);
  });
});

describe('diseases.json — fail-fast на битой болезни (закон №10)', () => {
  it('transmissibility вне [0,1] → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { transmissibility: number }).transmissibility = 2.5;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/transmissibility 2\.5 вне \[0,1\]/);
  });

  it('нулевой severityRate → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { severityRate: number }).severityRate = 0;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/severityRate должен быть >0/);
  });

  it('recoveryTicks нецелый/<=0 → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { recoveryTicks: number }).recoveryTicks = -1;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/recoveryTicks должен быть целым >0/);
  });

  it('дубль id болезни → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[1] as { id: string }).id = bad.diseases[0]!.id;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/дублирующийся id/);
  });

  it('coldBorne не boolean → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { coldBorne: unknown }).coldBorne = 1;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/coldBorne не boolean/);
  });
});

describe('factions.json — fail-fast на битой диспозиции stance (закон №10)', () => {
  it('неизвестный stance → DataError', async () => {
    const bad = cloneFactions();
    (bad.factions[2] as { stance: string }).stance = 'pacifist';
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/stance "pacifist" не из \{defensive,aggressive,crusader\}/);
  });
});
