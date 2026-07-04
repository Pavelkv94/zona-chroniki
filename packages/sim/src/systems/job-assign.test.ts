/**
 * @module @zona/sim/systems/job-assign.test
 *
 * Гейт хелпера НАЙМА assignJobs (задача 2.4, D-046/D-053(4)). Доказывает:
 *  - назначает Job резиденту (Home.loc==loc поселения) с ОСЕДЛОЙ профессией
 *    (непустой workTasks); полевой профессии (workTasks:[]) — НЕ назначает;
 *  - не-резиденту (Home на не-поселении) и без Home — НЕ назначает;
 *  - D-053(4): employer == eid поселения (НЕ дефолтный 0), workplace == loc поселения;
 *  - детерминизм: два прогона одного seed → идентичный набор назначений;
 *  - идемпотентность: повторный вызов не плодит/не меняет наём;
 *  - масса не двигается (Job — не предмет): 'money'/'inventory' резидента не тронуты.
 *
 * assignJobs — НЕ система, гоняется прямым вызовом (в конвейер не входит, D-052).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, assignJobs, type SimWorld } from '../index';
import { spawnEntity, addComponent, removeComponent, hasComponent, queryEntities } from '../core/ecs';
import { Settlement, Position, Home, Job, Human, Alive } from '../core/components';
import { getSettlements } from '../data/index';

const SETTLE = Settlement as unknown as { morale: Float32Array; security: Float32Array };
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const JOB = Job as unknown as { workplace: Uint32Array; employer: Uint32Array };

/** Поселение на реальной loc-поселении (из settlements.json). */
function spawnSettlement(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Settlement, eid);
  SETTLE.morale[eid] = 0.7;
  SETTLE.security[eid] = 0.6;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  return eid;
}

interface PersonOpts {
  readonly home?: number;
  readonly profession?: string;
}

/** Живой Human с Home и cold-профессией (если заданы). */
function spawnPerson(world: SimWorld, o: PersonOpts): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  if (o.home !== undefined) {
    addComponent(world.ecs, Home, eid);
    HOME.loc[eid] = o.home;
  }
  if (o.profession !== undefined) {
    world.resources.set<string>('profession', eid, o.profession);
  }
  return eid;
}

/** loc двух контентных поселений (Кордон=0, Бар=5). */
const SETTLEMENT_LOCS = getSettlements().map((s) => s.loc);
const KORDON = 0;
const BAR = 5;
/** Не-поселение (wild), для проверки «резидент вне поселения». */
const WILD = 3;

// ═══════════════════════════════════════════════════════════════════════════
// КРИТЕРИЙ НАЙМА
// ═══════════════════════════════════════════════════════════════════════════

describe('assignJobs: наём резидентов с оседлой профессией', () => {
  it('резидент поселения с оседлой профессией (medic) → получает Job', () => {
    const w = createSimWorld(1 as Seed);
    const settle = spawnSettlement(w, KORDON);
    const medic = spawnPerson(w, { home: KORDON, profession: 'medic' });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, medic)).toBe(true);
    // D-053(4): employer/workplace выставлены реальными, НЕ дефолтный 0.
    expect(JOB.employer[medic]).toBe(settle);
    expect(JOB.workplace[medic]).toBe(KORDON);
  });

  it('резидент с ПОЛЕВОЙ профессией (stalker, workTasks:[]) → Job НЕ получает', () => {
    const w = createSimWorld(2 as Seed);
    spawnSettlement(w, KORDON);
    const stalker = spawnPerson(w, { home: KORDON, profession: 'stalker' });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, stalker)).toBe(false);
  });

  it('все оседлые (medic/mechanic/trader) наняты, все полевые (stalker/hunter/scavenger) — нет', () => {
    const w = createSimWorld(3 as Seed);
    spawnSettlement(w, KORDON);
    const sedentary = ['medic', 'mechanic', 'trader'].map((p) => spawnPerson(w, { home: KORDON, profession: p }));
    const field = ['stalker', 'hunter', 'scavenger'].map((p) => spawnPerson(w, { home: KORDON, profession: p }));
    assignJobs(w);
    for (const e of sedentary) expect(hasComponent(w.ecs, Job, e)).toBe(true);
    for (const e of field) expect(hasComponent(w.ecs, Job, e)).toBe(false);
  });

  it('резидент НЕ поселения (Home на wild) с оседлой профессией → Job НЕ получает', () => {
    const w = createSimWorld(4 as Seed);
    spawnSettlement(w, KORDON);
    const medicInWild = spawnPerson(w, { home: WILD, profession: 'medic' });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, medicInWild)).toBe(false);
  });

  it('без Home (бездомный) → Job НЕ получает даже с оседлой профессией', () => {
    const w = createSimWorld(5 as Seed);
    spawnSettlement(w, KORDON);
    const homeless = spawnPerson(w, { profession: 'medic' });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, homeless)).toBe(false);
  });

  it('без профессии → Job НЕ получает (нельзя резолвить workTasks)', () => {
    const w = createSimWorld(6 as Seed);
    spawnSettlement(w, KORDON);
    const nameless = spawnPerson(w, { home: KORDON });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, nameless)).toBe(false);
  });

  it('нет поселений вовсе → никто не нанят (assignJobs — no-op)', () => {
    const w = createSimWorld(7 as Seed);
    const medic = spawnPerson(w, { home: KORDON, profession: 'medic' });
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, medic)).toBe(false);
  });

  it('несколько поселений: каждый нанят на СВОЁ (employer = поселение своей loc)', () => {
    const w = createSimWorld(8 as Seed);
    const kordon = spawnSettlement(w, KORDON);
    const bar = spawnSettlement(w, BAR);
    const atKordon = spawnPerson(w, { home: KORDON, profession: 'mechanic' });
    const atBar = spawnPerson(w, { home: BAR, profession: 'trader' });
    assignJobs(w);
    expect(JOB.employer[atKordon]).toBe(kordon);
    expect(JOB.workplace[atKordon]).toBe(KORDON);
    expect(JOB.employer[atBar]).toBe(bar);
    expect(JOB.workplace[atBar]).toBe(BAR);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ДЕТЕРМИНИЗМ + ИДЕМПОТЕНТНОСТЬ
// ═══════════════════════════════════════════════════════════════════════════

describe('assignJobs: детерминизм и идемпотентность', () => {
  /** Строит смешанный мир и возвращает набор {eid, employer, workplace} нанятых. */
  function runOnce(seed: number): Array<{ eid: number; employer: number; workplace: number }> {
    const w = createSimWorld(seed as Seed);
    spawnSettlement(w, KORDON);
    spawnSettlement(w, BAR);
    const profs = ['stalker', 'medic', 'hunter', 'mechanic', 'scavenger', 'trader'];
    profs.forEach((p, i) => spawnPerson(w, { home: i % 2 === 0 ? KORDON : BAR, profession: p }));
    assignJobs(w);
    const out: Array<{ eid: number; employer: number; workplace: number }> = [];
    for (const e of queryEntities(w.ecs, [Job])) {
      out.push({ eid: e as number, employer: JOB.employer[e] as number, workplace: JOB.workplace[e] as number });
    }
    return out;
  }

  it('два прогона одного seed → идентичный набор назначений', () => {
    expect(runOnce(42)).toEqual(runOnce(42));
  });

  it('повторный вызов идемпотентен: тот же набор, employer/workplace не меняются', () => {
    const w = createSimWorld(9 as Seed);
    const settle = spawnSettlement(w, KORDON);
    const medic = spawnPerson(w, { home: KORDON, profession: 'medic' });
    assignJobs(w);
    const empAfter1 = JOB.employer[medic];
    const wpAfter1 = JOB.workplace[medic];
    // Повторный вызов — ничего не должно измениться (носитель Job пропускается).
    assignJobs(w);
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, medic)).toBe(true);
    expect(JOB.employer[medic]).toBe(empAfter1);
    expect(JOB.employer[medic]).toBe(settle);
    expect(JOB.workplace[medic]).toBe(wpAfter1);
    // Ровно один носитель Job (не задублировался).
    expect(queryEntities(w.ecs, [Job]).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// МАССА НЕ ДВИГАЕТСЯ (закон №3): Job — не предмет
// ═══════════════════════════════════════════════════════════════════════════

describe('assignJobs: наём не создаёт/не двигает предметы и деньги (закон №3)', () => {
  it("'money'/'inventory' резидента не тронуты наймом", () => {
    const w = createSimWorld(10 as Seed);
    spawnSettlement(w, KORDON);
    const medic = spawnPerson(w, { home: KORDON, profession: 'medic' });
    w.resources.set<number>('money', medic, 123);
    w.resources.set('inventory', medic, [{ item: 'canned', qty: 2 }]);
    assignJobs(w);
    expect(w.resources.get<number>('money', medic)).toBe(123);
    expect(w.resources.get('inventory', medic)).toEqual([{ item: 'canned', qty: 2 }]);
    // Наём не публикует событий (Job — компонент-состояние, не леджер-предмет).
    expect(w.bus.log.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ QA (задача 2.4): дыры критерия найма + прицельный D-053(4).
// Сценарии читаются как истории поселения: «Кордон полон бродяг — некому встать
// за прилавок»; «санитар помер — его больше не ставят на смену».
// ═══════════════════════════════════════════════════════════════════════════

describe('assignJobs: вырожденные составы поселения (критерий найма из состояния)', () => {
  it('поселение из ОДНИХ полевиков (все workTasks:[]) → 0 носителей Job во всём мире', () => {
    const w = createSimWorld(40 as Seed);
    spawnSettlement(w, KORDON);
    // Кордон заселён только бродягами без рабочего места — за прилавок встать некому.
    for (const p of ['stalker', 'hunter', 'scavenger', 'stalker', 'hunter']) {
      spawnPerson(w, { home: KORDON, profession: p });
    }
    assignJobs(w);
    expect(queryEntities(w.ecs, [Job]).length).toBe(0); // ни одного трудоустройства
  });

  it('МЁРТВЫЙ Human (без Alive) с оседлой профессией → Job НЕ получает (наём только живых)', () => {
    const w = createSimWorld(41 as Seed);
    spawnSettlement(w, KORDON);
    const corpse = spawnPerson(w, { home: KORDON, profession: 'medic' });
    removeComponent(w.ecs, Alive, corpse); // санитар помер до раздачи смен
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, corpse)).toBe(false);
    expect(queryEntities(w.ecs, [Job]).length).toBe(0);
  });

  it('живой резидент нанят, мёртвый сосед той же профессии — нет (наём выбирает по Alive)', () => {
    const w = createSimWorld(42 as Seed);
    const settle = spawnSettlement(w, KORDON);
    const alive = spawnPerson(w, { home: KORDON, profession: 'medic' });
    const dead = spawnPerson(w, { home: KORDON, profession: 'medic' });
    removeComponent(w.ecs, Alive, dead);
    assignJobs(w);
    expect(hasComponent(w.ecs, Job, alive)).toBe(true);
    expect(JOB.employer[alive]).toBe(settle);
    expect(hasComponent(w.ecs, Job, dead)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-053(4) ПРИЦЕЛЬНО: employer НИКОГДА не 0 после найма (иначе census припишет к eid 0)
// ───────────────────────────────────────────────────────────────────────────
describe('assignJobs: D-053(4) — employer выставлен СРАЗУ, никогда не дефолтный 0', () => {
  it('в СМЕШАННОМ мире КАЖДЫЙ носитель Job имеет employer != 0 и == реальному Settlement', () => {
    const w = createSimWorld(43 as Seed);
    const kordon = spawnSettlement(w, KORDON);
    const bar = spawnSettlement(w, BAR);
    const validEmployers = new Set<number>([kordon as number, bar as number]);
    // Пёстрый состав обоих поселений: часть наймётся, часть — нет.
    const profs = ['medic', 'stalker', 'trader', 'hunter', 'mechanic', 'scavenger'];
    profs.forEach((p, i) => spawnPerson(w, { home: i % 2 === 0 ? KORDON : BAR, profession: p }));
    assignJobs(w);
    const jobs = queryEntities(w.ecs, [Job]);
    expect(jobs.length).toBeGreaterThan(0); // наём реально произошёл (не пустая проверка)
    for (const e of jobs) {
      // Корневой инвариант D-053(4): ноль здесь = «работает на eid 0» (ложная приписка
      // census/Economy) — категорически запрещён. addComponent зануляет, запись сразу.
      expect(JOB.employer[e]).not.toBe(0);
      expect(validEmployers.has(JOB.employer[e] as number)).toBe(true);
      // И workplace — реальная loc поселения работодателя (Position.loc этого eid).
      expect(JOB.workplace[e]).toBe(POS.loc[JOB.employer[e] as EntityId]);
    }
  });

  it('census-стиль: бакетизация работников по employer НЕ содержит ключа 0', () => {
    // Повторяем логику buildCensus (Economy): группировка живых Job-носителей по
    // employer. Ключ 0 = «приписан к eid 0» ⇒ дыра D-053(4). Его быть не должно.
    const w = createSimWorld(44 as Seed);
    spawnSettlement(w, KORDON);
    spawnSettlement(w, BAR);
    ['medic', 'mechanic', 'trader'].forEach((p) => spawnPerson(w, { home: KORDON, profession: p }));
    ['trader', 'medic'].forEach((p) => spawnPerson(w, { home: BAR, profession: p }));
    assignJobs(w);
    const byEmployer = new Map<number, number>();
    for (const e of queryEntities(w.ecs, [Job])) {
      const emp = JOB.employer[e] as number;
      byEmployer.set(emp, (byEmployer.get(emp) ?? 0) + 1);
    }
    expect(byEmployer.has(0)).toBe(false); // ни один работник не «висит» на eid 0
    expect(byEmployer.size).toBe(2); // ровно два работодателя (Кордон и Бар)
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ИДЕМПОТЕНТНОСТЬ ПРИЦЕЛЬНО: повторный вызов не двигает employer/workplace/состав
// ───────────────────────────────────────────────────────────────────────────
describe('assignJobs: повторный вызов стабилен (employer/workplace не «переезжают»)', () => {
  it('3× подряд в смешанном мире → неизменный набор {eid,employer,workplace}', () => {
    const w = createSimWorld(45 as Seed);
    spawnSettlement(w, KORDON);
    spawnSettlement(w, BAR);
    const profs = ['medic', 'stalker', 'mechanic', 'hunter', 'trader', 'scavenger'];
    profs.forEach((p, i) => spawnPerson(w, { home: i % 2 === 0 ? KORDON : BAR, profession: p }));
    const snapshot = (): string =>
      queryEntities(w.ecs, [Job])
        .map((e) => `${e}:${JOB.employer[e]}:${JOB.workplace[e]}`)
        .join('|');
    assignJobs(w);
    const after1 = snapshot();
    assignJobs(w);
    assignJobs(w);
    expect(snapshot()).toBe(after1); // ни одного смещения/дубля при повторе
  });
});

// Санити: контентные поселения реально стоят на используемых loc (0 и 5).
describe('санити: контентные loc поселений', () => {
  it('SETTLEMENT_LOCS содержит KORDON и BAR', () => {
    expect(SETTLEMENT_LOCS).toContain(KORDON);
    expect(SETTLEMENT_LOCS).toContain(BAR);
  });
});
