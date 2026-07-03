/**
 * @module @zona/sim/systems/needs.test
 *
 * Гейт системы Needs (задача 1.5, B.1). Покрывает:
 *  - накопление: за N тиков hunger/thirst/fatigue растут ровно на N ставок f32;
 *  - кламп нужд на потолке шкалы (NEED_MAX);
 *  - пороги: `needs/threshold` РОВНО один раз на пересечение вверх, без дублей,
 *    новое пересечение после падения ниже; causedBy=null;
 *  - урон истощения: голод/жажда >= критического → hp убывает на balance-ставку;
 *    Needs не удаляет сущность и не публикует entity/died;
 *  - затухание страха к 0, без ухода ниже 0;
 *  - детерминизм двух прогонов; порядок обхода = сортировка eid;
 *  - изоляция: сущность без Needs не затрагивается; носители независимы;
 *  - round-trip save/load в середине прогона — resume продолжает тождественно.
 *
 * Needs rng не использует ⇒ детерминизм структурный (арифметика f32 + порядок
 * eid). Компоненты — модульные singleton'ы (общие колонки по eid): миры в тестах
 * идут ПОСЛЕДОВАТЕЛЬНО, и там, где два мира делят eid, значения одного
 * захватываются в локальные переменные ДО прогона второго (как в movement.test).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, existsEntity, queryEntities } from '../core/ecs';
import { Needs as NeedsComponent, Health } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import {
  HUNGER_PER_TICK,
  THIRST_PER_TICK,
  FATIGUE_PER_TICK,
  FEAR_DECAY_PER_TICK,
  HUNGER_CRITICAL,
  THIRST_CRITICAL,
  FATIGUE_CRITICAL,
  STARVATION_DAMAGE_PER_TICK,
  DEHYDRATION_DAMAGE_PER_TICK,
  NEED_MAX,
} from '../balance/needs';
import { Needs } from './needs';

// Типизированные SoA-колонки для установки/чтения состояния в тестах.
const NEED = NeedsComponent as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HP = Health as unknown as { hp: Float32Array };

/** Начальное физиологическое состояние носителя (все поля опциональны, дефолт 0). */
interface Vitals {
  hunger?: number;
  thirst?: number;
  fatigue?: number;
  fear?: number;
  hp?: number;
}

/** Селит носителя Needs (+Health, если задан hp) с явными стартовыми значениями. */
function placeNeeder(world: SimWorld, v: Vitals = {}): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, NeedsComponent, eid); // зануляет поля (D-024)
  NEED.hunger[eid] = v.hunger ?? 0;
  NEED.thirst[eid] = v.thirst ?? 0;
  NEED.fatigue[eid] = v.fatigue ?? 0;
  NEED.fear[eid] = v.fear ?? 0;
  if (v.hp !== undefined) {
    addComponent(world.ecs, Health, eid);
    HP.hp[eid] = v.hp;
  }
  return eid;
}

/** Планировщик с единственной системой Needs. */
function needsScheduler() {
  const s = createScheduler();
  s.register(Needs);
  return s;
}

/**
 * Ожидаемое значение после N шагов `v = fround(v ± rate)` — воспроизводит
 * пошаговое f32-округление системы (сумма N ставок в f32 != N×ставка в double).
 * `sign` = +1 рост, -1 затухание. Без клампа (тесты держатся вдали от границ).
 */
function accum(start: number, rate: number, n: number, sign: 1 | -1 = 1): number {
  let v = Math.fround(start);
  for (let i = 0; i < n; i++) v = Math.fround(v + sign * rate);
  return v;
}

/** События needs/threshold указанного eid из лога, в порядке публикации. */
function thresholdEvents(world: SimWorld, eid: EntityId): readonly SimEvent[] {
  return world.bus.log.filter(
    (e) => e.type === 'needs/threshold' && (e.payload as { eid: number }).eid === eid,
  );
}

describe('накопление: рост нужд на N ставок за N тиков (f32-детерминированно)', () => {
  it('hunger/thirst/fatigue выросли ровно на N×ставку', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeNeeder(w);
    const n = 100;
    needsScheduler().run(w, n);

    expect(NEED.hunger[eid]).toBe(accum(0, HUNGER_PER_TICK, n));
    expect(NEED.thirst[eid]).toBe(accum(0, THIRST_PER_TICK, n));
    expect(NEED.fatigue[eid]).toBe(accum(0, FATIGUE_PER_TICK, n));
  });

  it('нужды клампятся на потолке шкалы (NEED_MAX), не превышают его', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX - 0.01, thirst: NEED_MAX - 0.01 });
    needsScheduler().run(w, 50); // заведомо перебьёт потолок
    expect(NEED.hunger[eid]).toBe(NEED_MAX);
    expect(NEED.thirst[eid]).toBe(NEED_MAX);
  });
});

describe('затухание страха к 0', () => {
  it('fear убывает на ставку затухания и не уходит ниже 0', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeNeeder(w, { fear: 10 });
    const n = 5;
    needsScheduler().run(w, n);
    expect(NEED.fear[eid]).toBe(accum(10, FEAR_DECAY_PER_TICK, n, -1));
  });

  it('страх зажат снизу на 0 (не отрицательный) при долгом затухании', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeNeeder(w, { fear: 3 });
    needsScheduler().run(w, 100); // 3 / 0.5 = 6 тиков до нуля, дальше держит 0
    expect(NEED.fear[eid]).toBe(0);
  });
});

describe('пороги: needs/threshold ровно один раз на пересечение вверх', () => {
  it('одно событие при пересечении голодом критического порога; causedBy=null', () => {
    const w = createSimWorld(3 as Seed);
    // Старт чуть ниже порога ⇒ пересечение на первом же тике.
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 });
    needsScheduler().run(w, 50);

    const evs = thresholdEvents(w, eid);
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.type).toBe('needs/threshold');
    expect(ev.payload).toEqual({ eid, need: 'hunger', level: 'critical' });
    expect(ev.causedBy).toBeNull();
    expect(ev.tick).toBe(0); // пересёк на первом тике
  });

  it('НЕ дублируется, пока нужда держится выше порога', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 });
    needsScheduler().run(w, 500);
    expect(thresholdEvents(w, eid)).toHaveLength(1);
  });

  it('падение ниже порога и повторный рост → НОВОЕ событие', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 });
    const sched = needsScheduler();

    sched.run(w, 1); // пересёк вверх → 1 событие
    expect(thresholdEvents(w, eid)).toHaveLength(1);

    // Нужду закрыли (напр. поел — это делает 1.8): опускаем ниже порога.
    NEED.hunger[eid] = HUNGER_CRITICAL - 0.01;
    sched.run(w, 1); // снова пересёк вверх → 2-е событие
    expect(thresholdEvents(w, eid)).toHaveLength(2);
  });

  it('усталость даёт порог, но урона hp не наносит', () => {
    const w = createSimWorld(3 as Seed);
    // Усталость у критического, голод/жажда — нет; hp есть.
    const eid = placeNeeder(w, { fatigue: 89.99, hp: 100 });
    needsScheduler().run(w, 5);
    const fatEvs = thresholdEvents(w, eid).filter(
      (e) => (e.payload as { need: string }).need === 'fatigue',
    );
    expect(fatEvs).toHaveLength(1);
    expect(HP.hp[eid]).toBe(100); // усталость не ранит
  });
});

describe('урон истощения (голод/жажда)', () => {
  it('голод >= критического: hp убывает на ставку голодания за тик', () => {
    const w = createSimWorld(4 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL, hp: 100 });
    const n = 10;
    needsScheduler().run(w, n);
    // Каждый тик hunger >= порога ⇒ урон STARVATION применяется все n тиков.
    expect(HP.hp[eid]).toBe(accum(100, STARVATION_DAMAGE_PER_TICK, n, -1));
  });

  it('голод И жажда за порогом: складываются оба урона за тик', () => {
    const w = createSimWorld(4 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL, thirst: THIRST_CRITICAL, hp: 100 });
    needsScheduler().run(w, 1);
    const expected = Math.fround(100 - STARVATION_DAMAGE_PER_TICK - DEHYDRATION_DAMAGE_PER_TICK);
    expect(HP.hp[eid]).toBe(expected);
  });

  it('Needs не удаляет сущность и не публикует entity/died при hp<=0', () => {
    const w = createSimWorld(4 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX, hp: 0.05 });
    needsScheduler().run(w, 20); // hp уходит в отрицательное
    expect(HP.hp[eid]).toBeLessThan(0); // Needs не клампует hp снизу
    expect(existsEntity(w.ecs, eid)).toBe(true); // жива для Death (1.11)
    // Needs НЕ владеет смертью: единственный публикуемый ею тип — needs/threshold
    // (никаких entity/died и т.п. — их добавит Death 1.11).
    expect(w.bus.log.every((e) => e.type === 'needs/threshold')).toBe(true);
  });

  it('носитель Needs без Health не падает при истощении (урон некому писать)', () => {
    const w = createSimWorld(4 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX }); // без hp ⇒ без Health
    expect(() => needsScheduler().run(w, 10)).not.toThrow();
    expect(NEED.hunger[eid]).toBe(NEED_MAX);
  });
});

describe('детерминизм и порядок обработки (закон №8)', () => {
  function scenario(seed: number): { hunger: number; fear: number; log: readonly SimEvent[] } {
    const w = createSimWorld(seed as Seed);
    placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01, fear: 20 }); // eid 1
    placeNeeder(w, { thirst: THIRST_CRITICAL - 0.01, hp: 100 }); // eid 2
    placeNeeder(w, { fatigue: 50 }); // eid 3
    needsScheduler().run(w, 30);
    const e1 = 1 as EntityId;
    return {
      hunger: NEED.hunger[e1] as number,
      fear: NEED.fear[e1] as number,
      // нормализуем в сравнимую форму (значения — примитивы, безопасно)
      log: w.bus.log.map((e) => ({ ...e, payload: { ...e.payload } })) as SimEvent[],
    };
  }

  it('два прогона одного сценария → идентичные значения и лог', () => {
    const a = scenario(7);
    const b = scenario(7);
    expect(b.hunger).toBe(a.hunger);
    expect(b.fear).toBe(a.fear);
    expect(b.log).toEqual(a.log);
  });

  it('порог-события на тике 0 идут в порядке возрастания eid', () => {
    const w = createSimWorld(7 as Seed);
    placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 }); // eid 1 — порог hunger@0
    placeNeeder(w, { thirst: THIRST_CRITICAL - 0.01 }); // eid 2 — порог thirst@0
    needsScheduler().run(w, 1);
    const tick0 = w.bus.log.filter((e) => e.tick === 0 && e.type === 'needs/threshold');
    const eids = tick0.map((e) => (e.payload as { eid: number }).eid);
    expect(eids).toEqual([...eids].sort((x, y) => x - y));
    expect(eids).toEqual([1, 2]);
  });
});

describe('изоляция сущностей', () => {
  it('сущность без Needs не затрагивается (не в запросе)', () => {
    const w = createSimWorld(5 as Seed);
    const other = spawnEntity(w.ecs);
    addComponent(w.ecs, Health, other);
    HP.hp[other] = 100;
    // носителей Needs нет вовсе
    expect(queryEntities(w.ecs, [NeedsComponent])).toHaveLength(0);
    needsScheduler().run(w, 50);
    expect(HP.hp[other]).toBe(100); // здоровье нетронуто
  });

  it('несколько носителей независимы: разные стартовые состояния эволюционируют раздельно', () => {
    const w = createSimWorld(5 as Seed);
    const a = placeNeeder(w, { hunger: 10 });
    const b = placeNeeder(w, { hunger: 40 });
    needsScheduler().run(w, 20);
    expect(NEED.hunger[a]).toBe(accum(10, HUNGER_PER_TICK, 20));
    expect(NEED.hunger[b]).toBe(accum(40, HUNGER_PER_TICK, 20));
  });
});

describe('round-trip save/load в середине прогона (resume тождественен)', () => {
  it('deserialize в середине → накопление продолжается идентично непрерывному', () => {
    // Непрерывный прогон 20 тиков — захватываем финал в примитивы ДО split
    // (компоненты — общий singleton по eid, split переиспользует тот же eid).
    const cont = createSimWorld(8 as Seed);
    placeNeeder(cont, { hunger: HUNGER_CRITICAL - 0.05, thirst: 30, fatigue: 12, fear: 4, hp: 100 });
    needsScheduler().run(cont, 20);
    const contEid = 1 as EntityId;
    const expected = {
      hunger: NEED.hunger[contEid] as number,
      thirst: NEED.thirst[contEid] as number,
      fatigue: NEED.fatigue[contEid] as number,
      fear: NEED.fear[contEid] as number,
      hp: HP.hp[contEid] as number,
      thresholds: thresholdEvents(cont, contEid).length,
    };

    // Split: 10 тиков → snapshot → deserialize → ещё 10 тиков.
    const split = createSimWorld(8 as Seed);
    const eid = placeNeeder(split, { hunger: HUNGER_CRITICAL - 0.05, thirst: 30, fatigue: 12, fear: 4, hp: 100 });
    needsScheduler().run(split, 10);
    const snap = serialize(split);
    const resumed = deserialize(snap);

    expect(resumed.tick).toBe(10);
    // Тот же eid жив после восстановления; продолжаем накопление.
    needsScheduler().run(resumed, 10);

    expect(NEED.hunger[eid]).toBe(expected.hunger);
    expect(NEED.thirst[eid]).toBe(expected.thirst);
    expect(NEED.fatigue[eid]).toBe(expected.fatigue);
    expect(NEED.fear[eid]).toBe(expected.fear);
    expect(HP.hp[eid]).toBe(expected.hp);
    // Порог голода пересечён ровно один раз суммарно по обеим половинам.
    expect(thresholdEvents(resumed, eid).length).toBe(expected.thresholds);
  });
});

// ── Ниже — усиление гейта QA (задача 1.5): граничные случаи порога, «рождённый
// критическим», порядок нескольких пересечений, точная арифметика урона, глубоко
// отрицательный hp, стабильность урона на потолке, детерминизм страха, носитель
// без Health, и — ПРИЦЕЛЬНО — resume-безопасность детекции порога (нет скрытого
// рантайм-флага «уже сообщено»: пересечение вычисляется из prev-значения поля,
// а поле переживает save/load). Все сценарии детерминированы (rng не участвует).

/** Виды нужд в порядке публикации порогов для сущности `eid`. */
function thresholdNeeds(world: SimWorld, eid: EntityId): readonly string[] {
  return thresholdEvents(world, eid).map((e) => (e.payload as { need: string }).need);
}

describe('граница порога: crossing строгий (prev < crit), уровень — нестрогий (>= crit)', () => {
  it('значение РОВНО на пороге со старта → НЕ пересечение (prev == crit), события нет', () => {
    const w = createSimWorld(31 as Seed);
    // hunger стартует ТОЧНО на пороге (80 представимо в f32 точно).
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL, hp: 100 });
    needsScheduler().run(w, 1);
    // prev(=crit) НЕ < crit ⇒ пересечения нет ⇒ ни одного needs/threshold…
    expect(thresholdNeeds(w, eid).filter((n) => n === 'hunger')).toHaveLength(0);
    // …НО урон истощения использует >= crit ⇒ hp всё равно убыл на ставку.
    // ФИКСАЦИЯ off-by-one: значение, «лежащее» ровно на пороге, считается
    // критическим для УРОНА, но не порождает СОБЫТИЯ (нет момента пересечения).
    expect(HP.hp[eid]).toBe(Math.fround(100 - STARVATION_DAMAGE_PER_TICK));
  });

  it('пересечение снизу срабатывает ровно раз и ПЕРЕЛЕТАЕТ порог (шаг > f32-гранулярности у 80)', () => {
    const w = createSimWorld(31 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 });
    needsScheduler().run(w, 1);
    expect(thresholdNeeds(w, eid).filter((n) => n === 'hunger')).toHaveLength(1);
    // Накопление шагом 0.035 всегда ПЕРЕПРЫГИВАЕТ 80 (гранулярность f32 у 80 ~7.6e-6),
    // поэтому «приземление ровно на порог» через рост невозможно — >= и > здесь
    // неотличимы при накоплении; различие проявляется лишь при значении, ВЫСТАВЛЕННОМ
    // ровно на порог (см. тест выше). Документируем: next строго больше порога.
    expect(NEED.hunger[eid] as number).toBeGreaterThan(HUNGER_CRITICAL);
  });
});

describe('НАХОДКА-класс: «рождённый критическим» молчит (нет пересечения), но получает урон', () => {
  it('старт ВЫШЕ порога ⇒ ни одного needs/threshold за всю жизнь, хотя hp тает', () => {
    const w = createSimWorld(32 as Seed);
    // Worldgen (1.3) МОГ БЫ создать голодного ветерана (hunger=85 > crit=80).
    const eid = placeNeeder(w, { hunger: 85, hp: 100 });
    needsScheduler().run(w, 200);

    // prev на тике 0 уже >= crit ⇒ пересечения вверх НИКОГДА не будет (нужда лишь
    // растёт) ⇒ НОЛЬ событий needs/threshold. Это осознанно фиксируем как контракт:
    // система Needs объявляет только МОМЕНТ пересечения, а не факт «выше порога».
    expect(thresholdEvents(w, eid)).toHaveLength(0);
    // При этом урон истощения идёт с тика 0 (>= crit), NPC гарантированно тает…
    expect(HP.hp[eid] as number).toBeLessThan(100);
    // …и в итоге умрёт (это доведёт Death 1.11) БЕЗ события-причины «стал критически
    // голоден» — разрыв причинной цепочки летописи (закон №6) для такой смерти.
    // РИСК для worldgen (1.3): либо гарантировать старт нужд НИЖЕ критических, либо
    // порождать начальный threshold для родившихся критическими.
    expect(existsEntity(w.ecs, eid)).toBe(true);
  });

  it('такой NPC ОБЪЯВИТ порог, только если нужду опустят ниже и она снова пересечёт', () => {
    const w = createSimWorld(32 as Seed);
    const eid = placeNeeder(w, { hunger: 85 });
    const sched = needsScheduler();
    sched.run(w, 1);
    expect(thresholdEvents(w, eid)).toHaveLength(0); // молчал, будучи выше
    // «Поел» (это работа 1.8) — упал ниже порога:
    NEED.hunger[eid] = HUNGER_CRITICAL - 1;
    sched.run(w, 1); // всё ещё ниже — молчит
    expect(thresholdEvents(w, eid)).toHaveLength(0);
    NEED.hunger[eid] = HUNGER_CRITICAL - 0.01;
    sched.run(w, 1); // теперь ПЕРЕСЁК вверх → первое за жизнь событие
    expect(thresholdEvents(w, eid)).toHaveLength(1);
  });
});

describe('несколько порогов на одном тике: порядок детерминирован', () => {
  it('одна сущность пересекает hunger+thirst+fatigue разом → события в фикс. порядке нужд', () => {
    const w = createSimWorld(33 as Seed);
    const eid = placeNeeder(w, {
      hunger: HUNGER_CRITICAL - 0.01,
      thirst: THIRST_CRITICAL - 0.01,
      fatigue: FATIGUE_CRITICAL - 0.01,
    });
    needsScheduler().run(w, 1);
    // Порядок задаёт СИСТЕМА (hunger, thirst, fatigue), а не значения/eid.
    expect(thresholdNeeds(w, eid)).toEqual(['hunger', 'thirst', 'fatigue']);
  });

  it('две сущности разом пересекают hunger+thirst → внешний порядок по eid, внутренний по нужде', () => {
    const w = createSimWorld(33 as Seed);
    const e1 = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01, thirst: THIRST_CRITICAL - 0.01 });
    const e2 = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01, thirst: THIRST_CRITICAL - 0.01 });
    needsScheduler().run(w, 1);
    const seq = w.bus.log
      .filter((e) => e.type === 'needs/threshold')
      .map((e) => {
        const p = e.payload as { eid: number; need: string };
        return `${p.eid}:${p.need}`;
      });
    // Обход сущностей по возрастанию eid (внешний цикл), внутри — порядок нужд.
    expect(seq).toEqual([`${e1}:hunger`, `${e1}:thirst`, `${e2}:hunger`, `${e2}:thirst`]);
  });
});

describe('урон истощения: точная арифметика и стабильность', () => {
  it('голод И жажда за порогом много тиков: hp = f32 от суммы обеих ставок за тик', () => {
    const w = createSimWorld(34 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX, thirst: NEED_MAX, hp: 100 });
    const n = 250;
    needsScheduler().run(w, n);
    // Система пишет hp ОДИН раз за тик: fround(hpPrev - STARVATION - DEHYDRATION)
    // (обе разности в double, единственное f32-округление — при записи в колонку).
    let hp = Math.fround(100);
    for (let i = 0; i < n; i++) {
      hp = Math.fround(hp - STARVATION_DAMAGE_PER_TICK - DEHYDRATION_DAMAGE_PER_TICK);
    }
    expect(HP.hp[eid]).toBe(hp);
  });

  it('урон стабилен НА ПОТОЛКЕ шкалы: hunger заклампан на NEED_MAX, ставка урона не меняется', () => {
    const w = createSimWorld(34 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX, hp: 100 });
    const n = 40;
    needsScheduler().run(w, n);
    expect(NEED.hunger[eid]).toBe(NEED_MAX); // держит потолок…
    // …и урон голодания каждый тик ровно STARVATION (одна нужда за порогом).
    expect(HP.hp[eid]).toBe(accum(100, STARVATION_DAMAGE_PER_TICK, n, -1));
    // Родился на потолке (> crit) ⇒ порог не публикуется (нет пересечения).
    expect(thresholdEvents(w, eid)).toHaveLength(0);
  });

  it('hp уходит ГЛУБОКО в минус: Needs не клампует снизу и не паникует', () => {
    const w = createSimWorld(34 as Seed);
    const eid = placeNeeder(w, { hunger: NEED_MAX, thirst: NEED_MAX, hp: 1 });
    const n = 100;
    expect(() => needsScheduler().run(w, n)).not.toThrow();
    let hp = Math.fround(1);
    for (let i = 0; i < n; i++) {
      hp = Math.fround(hp - STARVATION_DAMAGE_PER_TICK - DEHYDRATION_DAMAGE_PER_TICK);
    }
    expect(HP.hp[eid]).toBe(hp);
    expect(HP.hp[eid] as number).toBeLessThan(0); // Death (1.11) прочитает уход <=0
    expect(existsEntity(w.ecs, eid)).toBe(true); // Needs не снимает сущность
    expect(w.bus.log.every((e) => e.type === 'needs/threshold')).toBe(true); // не сама смерть
  });
});

describe('носитель Needs без Health: истощение без адресата урона', () => {
  it('накопление и порог идут, но урон писать некуда — не бросает', () => {
    const w = createSimWorld(35 as Seed);
    // Без hp ⇒ без компонента Health; голод стартует под порогом → пересечёт.
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01 });
    expect(() => needsScheduler().run(w, 300)).not.toThrow();
    // Порог ПУБЛИКУЕТСЯ независимо от наличия Health (событие — про нужду, не про hp).
    expect(thresholdEvents(w, eid)).toHaveLength(1);
    // Нужда продолжила расти как обычно (за порогом, без «урона в никуда»).
    expect(NEED.hunger[eid] as number).toBeGreaterThan(HUNGER_CRITICAL);
    expect(NEED.hunger[eid]).toBe(accum(HUNGER_CRITICAL - 0.01, HUNGER_PER_TICK, 300));
  });
});

describe('затухание страха: детерминированный путь к 0 и удержание нуля', () => {
  it('fear=100 гаснет ровно за 200 тиков (100/0.5), дальше держит 0 без осцилляции', () => {
    const w = createSimWorld(36 as Seed);
    const eid = placeNeeder(w, { fear: 100 });
    const sched = needsScheduler();
    sched.run(w, 199);
    expect(NEED.fear[eid]).toBe(0.5); // за тик до нуля
    sched.run(w, 1); // тик 200
    expect(NEED.fear[eid]).toBe(0); // ровно ноль
    sched.run(w, 300); // ещё 300 тиков — clamp(0-0.5,0) = 0, не отрицателен и не скачет
    expect(NEED.fear[eid]).toBe(0);
  });

  it('система Needs НИКОГДА не публикует порог страха (это забота Perception 1.7)', () => {
    const w = createSimWorld(36 as Seed);
    const eid = placeNeeder(w, { fear: 100 });
    needsScheduler().run(w, 250);
    expect(thresholdNeeds(w, eid).filter((n) => n === 'fear')).toHaveLength(0);
  });
});

describe('resume-безопасность детекции порога (P0 детерминизма save/load)', () => {
  it('снапшот СРАЗУ ПОСЛЕ пересечения (нужда всё ещё выше) → после load НЕТ дубля порога', () => {
    // Прицельная проверка «скрытого рантайм-флага»: если бы детекция опиралась на
    // in-memory Set «уже сообщённых» eid, он не сериализуется, и первый тик после
    // load снова счёл бы нужду критической → дубль needs/threshold. Здесь детекция
    // сравнивает prev/next ПОЛЯ (переживает snapshot), поэтому дубля быть НЕ должно.
    const w = createSimWorld(37 as Seed);
    const eid = placeNeeder(w, { hunger: HUNGER_CRITICAL - 0.01, hp: 100 });
    const sched = needsScheduler();
    sched.run(w, 3); // тик 0 пересёк вверх → 1 событие; дальше hunger держится выше
    expect(thresholdEvents(w, eid)).toHaveLength(1);
    expect(NEED.hunger[eid] as number).toBeGreaterThan(HUNGER_CRITICAL);

    const resumed = deserialize(serialize(w));
    // Восстановленный лог уже содержит ровно то одно событие…
    expect(thresholdEvents(resumed, eid)).toHaveLength(1);
    needsScheduler().run(resumed, 100); // нужда выше порога всё время → пересечений нет
    // …и НИ ОДНОГО нового — рантайм-флага «сообщено» не существует, resume чист.
    expect(thresholdEvents(resumed, eid)).toHaveLength(1);
  });

  it('split save/load ДО пересечения ≡ непрерывный прогон (хэш мира и лог порогов идентичны)', () => {
    // Нужды стартуют НИЖЕ порогов, пересечения случаются ПОСЛЕ точки сплита —
    // проверяем, что само пересечение переживает resume побитово.
    const vitals = { hunger: 70, thirst: 60, fatigue: 40, fear: 100, hp: 100 };
    const cont = createSimWorld(38 as Seed);
    const cEid = placeNeeder(cont, vitals);
    needsScheduler().run(cont, 400);
    const contHash = hashSnapshot(serialize(cont)); // строка-примитив, безопасна к переносу
    const contThresh = thresholdEvents(cont, cEid).map((e) => ({
      tick: e.tick,
      need: (e.payload as { need: string }).need,
    }));
    // hunger (70→80 при 0.035/тик) пересекает ~тик 286; thirst (60→85 при 0.07) ~тик 357;
    // оба ПОСЛЕ сплита на 137 → тест реально проверяет crossing через resume.
    expect(contThresh.map((t) => t.need)).toEqual(['hunger', 'thirst']);

    const split = createSimWorld(38 as Seed);
    const sEid = placeNeeder(split, vitals);
    needsScheduler().run(split, 137);
    const resumed = deserialize(serialize(split));
    needsScheduler().run(resumed, 400 - 137);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    const splitThresh = thresholdEvents(resumed, sEid).map((e) => ({
      tick: e.tick,
      need: (e.payload as { need: string }).need,
    }));
    expect(splitThresh).toEqual(contThresh);
  });

  it('split save/load ПОСЛЕ пересечения ≡ непрерывный (уже сообщённый порог не дублируется)', () => {
    const vitals = { hunger: 70, thirst: 60, fatigue: 40, fear: 100, hp: 100 };
    const cont = createSimWorld(39 as Seed);
    const cEid = placeNeeder(cont, vitals);
    needsScheduler().run(cont, 400);
    const contHash = hashSnapshot(serialize(cont));
    const contThreshLen = thresholdEvents(cont, cEid).length;

    const split = createSimWorld(39 as Seed);
    const sEid = placeNeeder(split, vitals);
    needsScheduler().run(split, 320); // сплит ПОСЛЕ пересечения hunger (~286)
    const resumed = deserialize(serialize(split));
    needsScheduler().run(resumed, 400 - 320);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(thresholdEvents(resumed, sEid).length).toBe(contThreshLen); // без дублей на границе
  });
});
