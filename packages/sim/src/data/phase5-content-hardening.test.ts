/**
 * @module @zona/sim/data/phase5-content-hardening.test
 *
 * УСИЛЕНИЕ гейтов контента Фазы 5 (задача 5.1, законы №3/№8/№10). Читается как
 * сценарии мира, а не проверки полей: «учёный подсовывает в бестиарий химеру,
 * которая ест сама себя»; «завхоз выписывает лапу псевдособаки, но забывает
 * указать сколько лап с туши». Дополняет phase5-content-validation.test (уже
 * закрытые кейсы НЕ дублируем) злыми/граничными входами, о которых спрашивает
 * ревью 5.1, и ПИНит fail-fast неоднозначных случаев (каннибал-prey, всеядность),
 * отвергаемых валидатором с 5.1 (находка D-1).
 *
 * Приватные валидаторы недоступны напрямую — как и в соседнем файле, подсовываем
 * БИТЫЙ JSON через vi.doMock и заново импортируем ./index: загрузка модуля обязана
 * упасть ДО старта симуляции (fail-fast, закон №10), иначе мир молча испорчен.
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

/** Индексы в species.json: псевдособака (первый хищник с prey+partItem), олень. */
const PSEUDODOG = 2;
const DEER = 0;

async function expectLoadRejects(re: RegExp): Promise<void> {
  await expect(import('./index')).rejects.toThrow(re);
}
async function expectLoadResolves(): Promise<void> {
  await expect(import('./index')).resolves.toBeDefined();
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

// ── Виды: рассинхрон части туши и битые флаги ────────────────────────────────

describe('species.json — рассинхрон partItem/partYield (закон №3, обе стороны)', () => {
  it('partYield ЕСТЬ, а partItem вырезан → DataError (зеркальный рассинхрон)', async () => {
    // Соседний файл ловит «partItem без partYield»; здесь обратное направление —
    // выход добычи объявлен, а самой части нет. Оба конца обязаны падать.
    const bad = cloneSpecies();
    delete (bad.species[PSEUDODOG] as { partItem?: string }).partItem;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partItem и partYield должны быть заданы ОБА или НИ ОДНОГО/);
  });

  it('partYield дробный (1.5) → DataError (часть туши штучна, не пол-лапы)', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { partYield: number }).partYield = 1.5;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partYield должен быть целым >0/);
  });

  it('partYield отрицательный (-2) → DataError (нельзя «изъять» части в минус)', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { partYield: number }).partYield = -2;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partYield должен быть целым >0/);
  });

  it('partYield = NaN → DataError (не число из воздуха)', async () => {
    // NaN не переживает JSON.stringify, поэтому подменяем на объекте-моке напрямую.
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { partYield: number }).partYield = NaN;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/partYield должен быть целым >0/);
  });
});

describe('species.json — битые флаги/драйверы экосистемы (fail-fast)', () => {
  it('grazes не boolean (строка) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[DEER] as { grazes: unknown }).grazes = 'yes';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/флаг grazes должен быть boolean/);
  });

  it('reanimated не boolean (число) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[5] as { reanimated: unknown }).reanimated = 1; // zombie
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/флаг reanimated должен быть boolean/);
  });

  it('nocturnal не boolean (объект) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[3] as { nocturnal: unknown }).nocturnal = {}; // bloodsucker
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/флаг nocturnal должен быть boolean/);
  });

  it('moveDriver не из enum (число вместо строки) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { moveDriver: unknown }).moveDriver = 7;
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный moveDriver/);
  });

  it('moveDriver = пустая строка → DataError (не молчаливый фолбэк на herd)', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { moveDriver: string }).moveDriver = '';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/неизвестный moveDriver/);
  });
});

describe('species.json — битый список жертв prey', () => {
  it('prey не массив (строка "deer") → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { prey: unknown }).prey = 'deer';
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/prey должен быть массивом/);
  });

  it('prey содержит пустой ключ [""] → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { prey: string[] }).prey = ['deer', ''];
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/пустой ключ/);
  });
});

describe('species.json — целостность каталога видов', () => {
  it('дублирующийся key (два вида "pseudodog") → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[3] as { key: string }).key = 'pseudodog'; // индекс 3 сохраняет id=3
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/дублирующийся key "pseudodog"/);
  });

  it('дублирующийся id (id вне плотного индекса) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[3] as { id: number }).id = PSEUDODOG; // id=2 на позиции 3
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/плотный индекс/);
  });
});

// ── Неоднозначные диеты: fail-fast (guard введён в 5.1 по находке D-1) ─────────
//
// Эти кейсы QA 5.1 пометил как «валиден ли?». Интегратор решил: диета
// ВЗАИМОИСКЛЮЧАЮЩА (всеядность не моделируется) и каннибал-prey запрещён —
// оба противоречат причинно-диетной модели пищевой пирамиды Фазы 5 и не
// используются контентом. Валидатор теперь БРОСАЕТ; тесты это пинят.

describe('species.json — ДИЕТА: взаимоисключающие конфигурации ловятся fail-fast', () => {
  it('predator+grazes одновременно (всеядность) → DataError', async () => {
    const bad = cloneSpecies();
    const s = bad.species[PSEUDODOG] as { predator: boolean; grazes: boolean };
    s.predator = true;
    s.grazes = true; // хищник И травоядное сразу — валидатор обязан отвергнуть
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/predator и grazes взаимоисключающи/);
  });

  it('prey на самого себя (каннибализм) → DataError', async () => {
    const bad = cloneSpecies();
    (bad.species[PSEUDODOG] as { prey: string[] }).prey = ['pseudodog'];
    vi.doMock('./species.json', () => ({ default: bad }));
    await expectLoadRejects(/не может быть жертвой самому себе/);
  });
});

// ── Болезни: расширенные граничные входы ─────────────────────────────────────

describe('diseases.json — граничные значения полей (обе границы диапазонов)', () => {
  it('transmissibility отрицательная (-0.1) → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { transmissibility: number }).transmissibility = -0.1;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/transmissibility .* вне \[0,1\]/);
  });

  it('lethality > 1 (1.5) → DataError (никакая болезнь не «убивает на 150%»)', async () => {
    const bad = cloneDiseases();
    (bad.diseases[1] as { lethality: number }).lethality = 1.5;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/lethality .* вне \[0,1\]/);
  });

  it('lethality отрицательная (-0.2) → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { lethality: number }).lethality = -0.2;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/lethality .* вне \[0,1\]/);
  });

  it('recoveryTicks = 0 → DataError (мгновенное выздоровление — не срок)', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { recoveryTicks: number }).recoveryTicks = 0;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/recoveryTicks должен быть целым >0/);
  });

  it('recoveryTicks дробный (100.5) → DataError (тики целочисленны)', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { recoveryTicks: number }).recoveryTicks = 100.5;
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/recoveryTicks должен быть целым >0/);
  });

  it('transmissibility на самой границе (1.0) — ДОПУСТИМА (граница включена)', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { transmissibility: number }).transmissibility = 1.0;
    (bad.diseases[0] as { lethality: number }).lethality = 0.0; // 0 — тоже валидная граница
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadResolves();
  });

  it('пустой key при валидном id → DataError', async () => {
    const bad = cloneDiseases();
    (bad.diseases[0] as { key: string }).key = '';
    vi.doMock('./diseases.json', () => ({ default: bad }));
    await expectLoadRejects(/пустой key/);
  });
});

// ── Фракции: битая диспозиция stance (не-строка) ─────────────────────────────

describe('factions.json — stance злые типы', () => {
  it('stance число (5) вместо строки → DataError', async () => {
    const bad = cloneFactions();
    (bad.factions[2] as { stance: unknown }).stance = 5;
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/stance .* не из \{defensive,aggressive,crusader\}/);
  });

  it('stance пустая строка → DataError', async () => {
    const bad = cloneFactions();
    (bad.factions[1] as { stance: string }).stance = '';
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadRejects(/stance .* не из/);
  });

  it('stance опущен у loners — ДОПУСТИМО (диспозиция необязательна)', async () => {
    const bad = cloneFactions();
    delete (bad.factions[0] as { stance?: string }).stance;
    vi.doMock('./factions.json', () => ({ default: bad }));
    await expectLoadResolves();
  });
});
