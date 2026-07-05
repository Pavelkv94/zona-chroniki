/**
 * @module @zona/headless/view-4.1.test
 *
 * View-контракт Sim→UI (задача 4.1, D-076) как СЦЕНАРИИ ЗОНЫ, а не проверки полей.
 * Наблюдатель Фазы 4 смотрит на живущий без него мир через `exportWorldView` (лёгкий
 * снимок каждый тик) и `exportEntityDetail` (тяжёлое досье по клику). Под прицелом:
 *  - ДЕТЕРМИНИЗМ (закон №8): один seed → две НЕЗАВИСИМЫЕ истории → снимок бит-в-бит
 *    один и тот же; другой seed → другой снимок; сущности строго по eid.
 *  - ЧИСТОЕ ЧТЕНИЕ (D-006/D-080): смотреть — не значит трогать. hashSnapshot до==после;
 *    экспорт КАЖДЫЙ тик даёт тот же финал, что и без него; голдены 481914ae/429867e2 целы.
 *  - ЗАКОН №5 (граница ECS↔UI): наружу текут ТОЛЬКО plain-формы — JSON их сериализует
 *    без потерь; view.ts не тянет bitecs; @zona/sim не реэкспортирует обёртки движка.
 *  - КОРРЕКТНОСТЬ на ЖИВОМ worldgen-мире: сталкеры/животные/поселения/трупы различимы,
 *    погибший сталкер стал трупом (Corpse ПЕРВЫМ), несущий артефакт помечен carrying.
 *
 * ── ВАЖНО ПРО ГЛОБАЛЬНОЕ СОСТОЯНИЕ bitecs ─────────────────────────────────────
 * SoA-колонки компонентов (Position/Health/Needs/Task/…) — ГЛОБАЛЬНЫ на процесс: сборка
 * ВТОРОГО мира (`worldgen`) перезаписывает их, а `serialize`/`exportWorldView` читают
 * ТЕКУЩИЕ глобальные колонки. Поэтому КАЖДЫЙ тест строит свой мир и снимает с него ВСЁ
 * нужное (view/detail/hash) ВНУТРИ одного `it`, до постройки следующего мира. Захваченный
 * `exportWorldView` — уже plain-объект чисел, он переживает постройку соседнего мира.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createSimWorld,
  createScheduler,
  registerPhase3Systems,
  worldgen,
  serialize,
  hashSnapshot,
  TICKS_PER_DAY,
  exportWorldView,
  exportEntityDetail,
  type SimWorld,
} from '@zona/sim';
import type { EntityId, WorldView, EntityDetail, SnapshotJSON } from '@zona/shared';

const DAY = TICKS_PER_DAY;

/** Единица инвентаря в ResourceStore (форма, читаемая экспортёром carrying). */
interface InvEntry {
  readonly item: string;
  readonly qty: number;
}

/**
 * Собирает ЖИВОЙ мир полным конвейером Фазы 4-наблюдения = Фаза 3 (D-076: экспортёры
 * читают тот же мир, что гоняет CLI). `run(ticks)` крутит планировщик. Каждый вызов
 * `build` перезаписывает глобальные SoA-колонки — снимай данные до следующего build.
 */
function build(seed: number): { world: SimWorld; run: (ticks: number) => void } {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase3Systems(scheduler);
  return { world, run: (ticks) => scheduler.run(world, ticks) };
}

/** Живой сталкер с наименьшим eid в снимке (детерминированный «кликабельный» герой). */
function firstLiveHuman(view: WorldView): EntityId {
  const h = view.entities.find((e) => e.kind === 'human' && e.alive);
  if (h === undefined) throw new Error('в снимке нет живого сталкера — worldgen сломан');
  return h.eid;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) ДЕТЕРМИНИЗМ (ЗАКОН №8): одинаковый seed → одинаковая история → одинаковый снимок.
// ═════════════════════════════════════════════════════════════════════════════
describe('Две одинаковые Зоны видны наблюдателю бит-в-бит одинаково (закон №8)', () => {
  it('seed 42, два НЕЗАВИСИМЫХ прогона по 2 дня → exportWorldView DEEP-EQUAL (не только счётчик)', () => {
    // Снимок первой Зоны захватываем как plain-объект ДО постройки второй (иначе вторая
    // worldgen перезапишет глобальные SoA-колонки, из которых читает exportWorldView).
    const a = build(42);
    a.run(2 * DAY);
    const viewA = exportWorldView(a.world);

    const b = build(42);
    b.run(2 * DAY);
    const viewB = exportWorldView(b.world);

    // Глубокое сравнение ВСЕГО снимка: часы, погода, каждая сущность и все её поля,
    // сводка населения. Совпадение счётчиков — слабо; здесь совпадает КАЖДЫЙ eid и флаг.
    expect(viewB).toEqual(viewA);
    expect(viewA.entities.length).toBeGreaterThan(0); // тест не холостой
  });

  it('detail того же сталкера в двух прогонах одного seed — DEEP-EQUAL (досье воспроизводимо)', () => {
    const a = build(7);
    a.run(2 * DAY);
    const eidA = firstLiveHuman(exportWorldView(a.world));
    const detailA = exportEntityDetail(a.world, eidA);

    const b = build(7);
    b.run(2 * DAY);
    const eidB = firstLiveHuman(exportWorldView(b.world));
    const detailB = exportEntityDetail(b.world, eidB);

    expect(eidB).toBe(eidA); // тот же сталкер вышел героем — история воспроизвелась
    expect(detailB).toEqual(detailA);
  });

  it('ДРУГОЙ seed → ДРУГАЯ Зона: снимок отличается (не константа)', () => {
    const a = build(42);
    a.run(2 * DAY);
    const viewA = exportWorldView(a.world);

    const c = build(7);
    c.run(2 * DAY);
    const viewC = exportWorldView(c.world);

    expect(viewC).not.toEqual(viewA);
  });

  it('exportWorldView одного мира дважды подряд — DEEP-EQUAL (снимок не зависит от вызова)', () => {
    const a = build(42);
    a.run(DAY);
    expect(exportWorldView(a.world)).toEqual(exportWorldView(a.world));
  });

  it('entities строго возрастают по eid (стабильный порядок карты/списка, закон №8)', () => {
    const a = build(7);
    a.run(DAY);
    const eids = exportWorldView(a.world).entities.map((e) => e.eid as number);
    const sorted = [...eids].sort((x, y) => x - y);
    expect(eids).toEqual(sorted);
    // строго возрастают — ни одного дубля eid в снимке (человек+труп не задваивается).
    expect(new Set(eids).size).toBe(eids.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) ЧИСТОЕ ЧТЕНИЕ (D-006/D-080): смотреть на мир — не трогать мир. Ни один экспорт
//    не двигает snapshot-хэш; голдены (пустой мир 481914ae, day1 seed42 429867e2) целы.
// ═════════════════════════════════════════════════════════════════════════════
describe('Наблюдатель не участник: экспорт ничего в мире не меняет (D-006/D-080)', () => {
  it('hashSnapshot ДО == ПОСЛЕ exportWorldView И exportEntityDetail (весь снимок + все досье)', () => {
    const a = build(42);
    a.run(DAY);
    const before = hashSnapshot(serialize(a.world));

    const view = exportWorldView(a.world);
    for (const e of view.entities) exportEntityDetail(a.world, e.eid); // досье КАЖДОЙ сущности
    exportEntityDetail(a.world, 999999 as EntityId); // и по несуществующему — тоже чтение
    exportWorldView(a.world);

    expect(hashSnapshot(serialize(a.world)), 'экспортёры обязаны быть чистым чтением').toBe(before);
  });

  it('ГОЛДЕН day1 seed42 = 6d4317ab НЕ сдвигается массовым экспортом (экспорт вне конвейера)', () => {
    const a = build(42);
    a.run(DAY);
    // Тот же путь и горизонт, что закрепляет day1-голден cli.test — досье привязано к реальному хэшу.
    expect(hashSnapshot(serialize(a.world))).toBe('6d4317ab');
    const view = exportWorldView(a.world);
    for (const e of view.entities) exportEntityDetail(a.world, e.eid);
    expect(hashSnapshot(serialize(a.world)), 'экспорт не осквернил голден-мир').toBe('6d4317ab');
  });

  it('экспорт КАЖДЫЙ тик 2 дня даёт ТОТ ЖЕ финальный хэш, что прогон без экспорта', () => {
    // Мир с экспортом на каждом тике — снимаем финальный хэш ДО постройки контрольного мира.
    const p1 = build(999);
    for (let t = 0; t < 2 * DAY; t++) {
      p1.run(1);
      const v = exportWorldView(p1.world);
      if (v.entities.length > 0) exportEntityDetail(p1.world, v.entities[0]!.eid);
    }
    const hashWithExport = hashSnapshot(serialize(p1.world));

    // Контрольный мир того же seed — БЕЗ единого экспорта.
    const p2 = build(999);
    p2.run(2 * DAY);
    const hashPlain = hashSnapshot(serialize(p2.world));

    expect(hashWithExport, 'per-tick экспорт изменил траекторию мира').toBe(hashPlain);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) ЗАКОН №5: наружу — только plain. JSON сериализует снимок без потерь (нет циклов/
//    функций/bitecs-объектов); view.ts не тянет движок; обёртки ecs не реэкспортированы.
// ═════════════════════════════════════════════════════════════════════════════
describe('Граница ECS↔UI: формы plain, движок не течёт наружу (закон №5/D-011)', () => {
  it('JSON.stringify(WorldView) и (EntityDetail) НЕ бросают и переживают round-trip (plain)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const detail = exportEntityDetail(a.world, firstLiveHuman(view));

    // Не бросает (нет циклов) и round-trip тождественен (нет функций/BigInt/undefined-дыр,
    // нет bitecs-объектов, которые JSON схлопнул бы в {} — тогда parse≠оригинал).
    const viewRT = JSON.parse(JSON.stringify(view)) as WorldView;
    const detailRT = JSON.parse(JSON.stringify(detail)) as EntityDetail;
    expect(viewRT).toEqual(view);
    expect(detailRT).toEqual(detail);
  });

  it('shared/src/view.ts импортирует ТОЛЬКО plain-модули shared (нет bitecs/core/ecs)', () => {
    const viewPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../shared/src/view.ts');
    const src = readFileSync(viewPath, 'utf8');
    const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(['./ids', './memory']).toContain(spec);
    expect(/from\s+['"]bitecs['"]/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*core\/ecs['"]/.test(src)).toBe(false);
  });

  it('@zona/sim отдаёт экспортёры, но НЕ обёртки движка (queryEntities/hasComponent/existsEntity undefined)', async () => {
    const sim = (await import('@zona/sim')) as Record<string, unknown>;
    expect(typeof sim.exportWorldView).toBe('function');
    expect(typeof sim.exportEntityDetail).toBe('function');
    expect(sim.queryEntities).toBeUndefined();
    expect(sim.hasComponent).toBeUndefined();
    expect(sim.existsEntity).toBeUndefined();
    expect(sim.addComponent).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) КОРРЕКТНОСТЬ СНИМКА на живом worldgen-мире: кто есть кто на карте.
// ═════════════════════════════════════════════════════════════════════════════
describe('Кто населяет Зону: снимок различает сталкеров, животных, поселения, трупы (D-076)', () => {
  it('число entities = люди+животные+трупы+поселения; население согласовано с видами', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);

    const by = { human: 0, animal: 0, corpse: 0, settlement: 0 };
    for (const e of view.entities) by[e.kind]++;
    expect(by.human + by.animal + by.corpse + by.settlement).toBe(view.entities.length);
    // население WorldView считает погибшего человека трупом, а не человеком.
    expect(view.population.humans).toBe(by.human);
    expect(view.population.animals).toBe(by.animal);
    expect(view.population.corpses).toBe(by.corpse);
    // Мир реально населён всеми тремя оседлыми родами.
    expect(by.human).toBeGreaterThan(0);
    expect(by.settlement).toBeGreaterThan(0);
  });

  it('сталкер: kind=human, фракция задана, alive; животное: kind=animal, фракция null', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);

    const human = view.entities.find((e) => e.kind === 'human' && e.alive)!;
    expect(human.faction).not.toBeNull(); // loners/поселение/бандиты — у человека всегда фракция
    expect(human.hpFrac).toBeGreaterThanOrEqual(0);
    expect(human.hpFrac).toBeLessThanOrEqual(1);
    expect(human.inCombat).toBe(false); // 4.1: бой длится 1 тик, персистентного состояния нет

    const animals = view.entities.filter((e) => e.kind === 'animal');
    expect(animals.length).toBeGreaterThan(0);
    for (const an of animals) {
      expect(an.faction).toBeNull(); // у зверя записи фракции нет
      expect(an.alive).toBe(true); // живой зверь несёт Alive
    }
  });

  it('поселение: kind=settlement, не Alive, hpFrac=1 (не повреждаемо — нет Health)', () => {
    const a = build(42);
    a.run(DAY);
    for (const s of exportWorldView(a.world).entities.filter((e) => e.kind === 'settlement')) {
      expect(s.alive).toBe(false);
      expect(s.hpFrac).toBe(1);
    }
  });

  it('hpFrac любой сущности ∈ [0..1]; стоит (dest=null ⇒ eta=0) либо идёт (dest ≠ loc)', () => {
    const a = build(42);
    a.run(DAY);
    for (const e of exportWorldView(a.world).entities) {
      expect(e.hpFrac).toBeGreaterThanOrEqual(0);
      expect(e.hpFrac).toBeLessThanOrEqual(1);
      if (e.dest === null) expect(e.etaTicks).toBe(0);
      else expect(e.dest).not.toBe(e.loc);
    }
  });

  it('часы мира: day = floor(tick/TICKS_PER_DAY), tick совпадает, weather — валидный код', () => {
    const a = build(42);
    a.run(DAY + 5); // зашли на второй день
    const view = exportWorldView(a.world);
    expect(view.tick).toBe(a.world.tick);
    expect(view.day).toBe(Math.floor(a.world.tick / TICKS_PER_DAY));
    expect(view.day).toBe(1);
    expect(Number.isInteger(view.weather)).toBe(true);
    expect(view.weather).toBeGreaterThanOrEqual(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) СЦЕНАРИЙ: сталкер погиб — наблюдатель видит труп, а не живого (Corpse ПЕРВЫМ).
// ═════════════════════════════════════════════════════════════════════════════
describe('Погибший сталкер становится трупом в глазах наблюдателя (порядок Corpse→Human)', () => {
  it('труп с СОХРАНЁННЫМ именем классифицируется как corpse, не human, и не в счёте людей', () => {
    // 5.2/D-085: форедж снял голодные смерти дня-1 — трупы со дня 3. Горизонт 2 дня.
    // Труп сталкера несёт И Human, И Corpse; classifyKind проверяет Corpse ПЕРВЫМ ⇒ 'corpse'.
    // Что он был человеком — доказывает СОХРАНЁННОЕ имя (у звериного трупа имени нет).
    const a = build(42);
    a.run(3 * DAY);
    const view = exportWorldView(a.world);
    const corpses = view.entities.filter((e) => e.kind === 'corpse');
    expect(corpses.length).toBeGreaterThan(0); // ко дню 3 кто-то погиб

    // Ищем труп ЧЕЛОВЕКА (у него осталось имя) — снимаем досье внутри этого же it.
    let humanCorpse: { eid: EntityId; detail: EntityDetail } | null = null;
    for (const c of corpses) {
      const d = exportEntityDetail(a.world, c.eid)!;
      if (d.name !== undefined) {
        humanCorpse = { eid: c.eid, detail: d };
        break;
      }
    }
    expect(humanCorpse, 'ко дню 3 ожидается хотя бы один труп бывшего сталкера').not.toBeNull();

    const cv = view.entities.find((e) => e.eid === humanCorpse!.eid)!;
    expect(cv.kind).toBe('corpse'); // НЕ 'human', хотя Human-тег на нём остался
    expect(cv.alive).toBe(false);
    expect(cv.hpFrac).toBe(0); // hp ≤ 0 ⇒ клампится в 0
    // Досье трупа: имя сохранено, здоровья нет (≤0), вида нет (Animal тут ни при чём).
    expect(humanCorpse!.detail.kind).toBe('corpse');
    expect(humanCorpse!.detail.hp).toBeLessThanOrEqual(0);
    expect(humanCorpse!.detail.species).toBeUndefined();
    // Он посчитан трупом, а не человеком.
    expect(view.population.corpses).toBeGreaterThan(0);
    expect(view.entities.filter((e) => e.eid === cv.eid && e.kind === 'human')).toHaveLength(0);
  });

  it('досье трупа несёт его смерть в recentEvents (участие в собственном entity/died)', () => {
    // recentEvents — окно ПОСЛЕДНИХ RECENT_EVENTS_LIMIT (50) событий сущности. Труп несёт тег
    // Human ⇒ ещё долго «замечается» проходящими (perception/spotted target=труп), и за сутки
    // после гибели эти наблюдения вытесняют смерть из 50-окна. Интент теста — что смерть
    // ВСПЛЫВАЕТ в досье покойника — проверяем В МОМЕНТ гибели: гоняем по тику, ловим ПЕРВУЮ
    // entity/died (Death — конец конвейера, id смерти > наблюдений того тика) и сразу снимаем
    // досье. 5.2/D-085: первые смерти со дня 3 — цикл добегает до них.
    const a = build(42);
    let seen = 0;
    let victim: EntityId | null = null;
    let deathId = -1;
    for (let t = 0; t < 5 * DAY && victim === null; t++) {
      a.run(1);
      const log = a.world.bus.log;
      for (let i = seen; i < log.length; i++) {
        if (log[i]!.type === 'entity/died') {
          victim = (log[i]!.payload as { eid: EntityId }).eid;
          deathId = log[i]!.id as unknown as number;
          break;
        }
      }
      seen = log.length;
    }
    expect(victim, 'за 5 дней обязан случиться хотя бы один entity/died').not.toBeNull();
    const detail = exportEntityDetail(a.world, victim!)!;
    expect(
      detail.recentEvents.includes(deathId as unknown as (typeof detail.recentEvents)[number]),
      `смерть ${deathId} сталкера ${victim} обязана быть в его недавних событиях в момент гибели`,
    ).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6) СЦЕНАРИЙ: сталкер поднял артефакт — снимок помечает его carrying.
// ═════════════════════════════════════════════════════════════════════════════
describe('Ноша ценного видна на карте: артефакт в рюкзаке → carrying (закон №3)', () => {
  it('до артефакта carrying=false; кладём артефакт в инвентарь → carrying=true', () => {
    const a = build(42);
    a.run(DAY);
    const eid = firstLiveHuman(exportWorldView(a.world));

    // Стартовый сталкер артефакт не несёт.
    const before = exportWorldView(a.world).entities.find((e) => e.eid === eid)!;
    expect(before.carrying).toBe(false);

    // Кладём РЕАЛЬНЫЙ артефакт (items.json, kind 'artifact') к тому, что уже есть в рюкзаке —
    // источник вне закона №3 нас тут не волнует, проверяем ЧТЕНИЕ флага экспортёром.
    const inv = (a.world.resources.get<readonly InvEntry[]>('inventory', eid) ?? []) as readonly InvEntry[];
    a.world.resources.set('inventory', eid, [...inv, { item: 'artifact_medusa', qty: 1 }]);

    const after = exportWorldView(a.world).entities.find((e) => e.eid === eid)!;
    expect(after.carrying).toBe(true);
    // Артефакт виден и в тяжёлом досье (инвентарь сорт. по itemId).
    const detail = exportEntityDetail(a.world, eid)!;
    expect(detail.inventory.map((p) => p[0])).toContain('artifact_medusa');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7) ТЯЖЁЛОЕ ДОСЬЕ (EntityDetail): полнота живого NPC, null-случаи, дефолты «голой» сущности.
// ═════════════════════════════════════════════════════════════════════════════
describe('Досье по клику: полное состояние сталкера и корректные null/дефолты (D-076)', () => {
  it('живой сталкер: имя-фамилия, нужды [0..100], инвентарь(сорт), деньги/слава, память/отношения, recentEvents', () => {
    const a = build(42);
    a.run(DAY);
    const detail = exportEntityDetail(a.world, firstLiveHuman(exportWorldView(a.world)))!;
    expect(detail).not.toBeNull();
    expect(detail.kind).toBe('human');
    expect(detail.faction).not.toBeNull();

    // Имя-фамилия обязательны (закон №4: NPC без имени-фамилии запрещён).
    expect(detail.name).toBeDefined();
    expect(detail.name!.first.length).toBeGreaterThan(0);
    expect(detail.name!.last.length).toBeGreaterThan(0);

    for (const [need, v] of Object.entries(detail.needs)) {
      expect(Number.isFinite(v), `нужда ${need} — число`).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(detail.hp).toBeGreaterThan(0); // живой

    const items = detail.inventory.map((p) => p[0]);
    expect(items).toEqual([...items].sort()); // сорт по itemId (закон №8)
    expect(detail.inventory.length).toBeGreaterThan(0); // стартовый набор (D-021)
    for (const [, qty] of detail.inventory) expect(qty).toBeGreaterThan(0);

    expect(typeof detail.money).toBe('number');
    expect(typeof detail.fame).toBe('number');
    expect(Array.isArray(detail.memory)).toBe(true);
    expect(Array.isArray(detail.relations)).toBe(true);
    // За день у активного сталкера накопились события распорядка (task/move) — досье не пустое.
    expect(detail.recentEvents.length).toBeGreaterThan(0);
  });

  it('recentEvents сталкера действительно ПРО НЕГО: каждое id есть в логе и упоминает eid', () => {
    const a = build(42);
    a.run(DAY);
    const eid = firstLiveHuman(exportWorldView(a.world));
    const detail = exportEntityDetail(a.world, eid)!;

    const byId = new Map<number, (typeof a.world.bus.log)[number]>();
    for (const ev of a.world.bus.log) byId.set(ev.id as number, ev);

    expect(detail.recentEvents.length).toBeGreaterThan(0);
    for (const id of detail.recentEvents) {
      const ev = byId.get(id as number);
      expect(ev, `событие ${id} из recentEvents обязано быть в логе`).toBeDefined();
    }
    // id упорядочены по возрастанию (хронология, закон №8) и уникальны.
    const nums = detail.recentEvents.map((x) => x as number);
    expect(nums).toEqual([...nums].sort((x, y) => x - y));
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('живое животное: species (ключ вида) задан, имени и фракции нет', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const animal = view.entities.find((e) => e.kind === 'animal');
    if (animal === undefined) return; // стадо могло быть выбито — тогда пропускаем
    const d = exportEntityDetail(a.world, animal.eid)!;
    expect(d.kind).toBe('animal');
    expect(typeof d.species).toBe('string');
    expect(d.species!.length).toBeGreaterThan(0);
    expect(d.name).toBeUndefined();
    expect(d.faction).toBeNull();
  });

  it('несуществующий eid ⇒ null (кликнули пустоту)', () => {
    const a = build(42);
    a.run(DAY);
    expect(exportEntityDetail(a.world, 999999 as EntityId)).toBeNull();
  });

  it('СУЩЕСТВУЮЩАЯ, но НЕ-видимая сущность (часы мира/аномальное поле) ⇒ null (её нельзя кликнуть)', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const visible = new Set(view.entities.map((e) => e.eid as number));

    // Все живые eid берём из снапшота (публичный API), исключаем видимые на карте —
    // остаются часы мира и аномальные поля: существуют, но detail для них null.
    const snap = serialize(a.world) as unknown as SnapshotJSON;
    const nonVisible = (snap.entities as readonly EntityId[]).filter((e) => !visible.has(e as number));
    expect(nonVisible.length, 'worldgen обязан создать часы мира и поля вне карты').toBeGreaterThan(0);
    for (const eid of nonVisible) {
      expect(
        exportEntityDetail(a.world, eid),
        `не-видимая сущность ${eid} не «кликается» — detail должен быть null`,
      ).toBeNull();
    }
  });

  it('«голая» сущность-поселение (нет name/memory/Needs/Health) ⇒ дефолты без исключений', () => {
    const a = build(42);
    a.run(DAY);
    const view = exportWorldView(a.world);
    const settlement = view.entities.find((e) => e.kind === 'settlement')!;

    // Досье поселения не бросает и заполняет отсутствующие части дефолтами.
    const d = exportEntityDetail(a.world, settlement.eid)!;
    expect(d).not.toBeNull();
    expect(d.kind).toBe('settlement');
    expect(d.name).toBeUndefined(); // у поселения нет записи 'name'
    expect(d.species).toBeUndefined();
    expect(d.task).toBeUndefined();
    expect(d.needs).toEqual({ hunger: 0, thirst: 0, fatigue: 0, fear: 0 }); // нет Needs ⇒ нули
    expect(d.hp).toBe(0); // нет Health
    expect(d.memory).toEqual([]); // нет записи 'memory'
    expect(d.relations).toEqual([]);
    // Склад/касса поселения — реальны (ResourceStore inventory/money).
    expect(typeof d.money).toBe('number');
    expect(Array.isArray(d.inventory)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8) ГРАНИЧНЫЙ МИР: пустая Зона. Экспорт не рождает сущностей и не двигает голден.
// ═════════════════════════════════════════════════════════════════════════════
describe('Пустая Зона: снимок пуст, голден 481914ae цел даже под экспортом (закон №3)', () => {
  it('пустой мир (seed 0, без worldgen) = голден 481914ae; exportWorldView его не оживляет', () => {
    const empty = createSimWorld(0);
    // Голден-якорь пустого мира (закреплён core/snapshot.test.ts и по всей Фазе 1-3).
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');

    const view = exportWorldView(empty);
    expect(view.entities).toEqual([]);
    expect(view.population).toEqual({ humans: 0, animals: 0, corpses: 0 });
    expect(view.day).toBe(0);
    expect(view.tick).toBe(0);
    expect(view.weather).toBe(0); // нет носителя WorldClock ⇒ 0 (стартовое 'clear')

    // Досье по любому eid в пустоте — null; сам мир после экспорта всё ещё 481914ae.
    expect(exportEntityDetail(empty, 1 as EntityId)).toBeNull();
    expect(hashSnapshot(serialize(empty)), 'экспорт оживил пустой мир').toBe('481914ae');
  });
});
