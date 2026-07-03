/**
 * @module @zona/sim/systems/weather.test
 *
 * Гейт системы Weather (задача 1.6, B.1). Покрывает:
 *  - детерминизм: два прогона одного seed → идентичная история weather/changed
 *    (типы from/to и тики смен);
 *  - длительность каждой (закрытой) погоды ∈ [MIN, MAX] balance, кратна шагу (10);
 *  - причинная цепочка: каждая смена ссылается на предыдущую, первая — null;
 *  - смена ВИДИМА (from != to);
 *  - нет смены на тике 0 и пока не отжита длительность;
 *  - RESUME (P0): непрерывный прогон ≡ split save/load на середине — тождественны
 *    и WorldClock, и лог weather/changed (доказано хэшем снапшота);
 *  - singleton: 0 носителей → no-op; >1 → throw;
 *  - isNight/timeOfDay: границы DAWN/DUSK, разные сутки, чистота функции.
 *
 * WorldClock — модульный singleton-компонент (общие колонки по eid): миры в тестах
 * идут ПОСЛЕДОВАТЕЛЬНО; там, где два мира делят eid, финал одного захватывается в
 * примитивы/строку-хэш ДО прогона второго (как в needs.test/movement.test).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent } from '../core/ecs';
import { WorldClock } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { TICKS_PER_DAY } from '../balance/time';
import {
  WEATHER_TYPES,
  WEATHER_MIN_DURATION,
  WEATHER_MAX_DURATION,
  DAWN_TICK,
  DUSK_TICK,
} from '../balance/weather';
import { Weather, weatherDuration, nextWeatherCode } from './weather';
import { isNight, timeOfDay, minuteOfDay } from './daynight';

/** Типизированные SoA-колонки WorldClock для установки/чтения в тестах. */
const CLOCK = WorldClock as unknown as {
  weather: Uint8Array;
  weatherSince: Uint32Array;
};

/** Селит singleton-носителя WorldClock (weather/weatherSince, дефолт 0). */
function placeClock(world: SimWorld, weather = 0, since = 0): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, WorldClock, eid); // зануляет поля (D-024)
  CLOCK.weather[eid] = weather;
  CLOCK.weatherSince[eid] = since;
  return eid;
}

/** Планировщик с единственной системой Weather (every:10). */
function weatherScheduler() {
  const s = createScheduler();
  s.register(Weather);
  return s;
}

/** Плоский снимок событий weather/changed (безопасно переносить между мирами). */
interface ChangeRow {
  id: EventId;
  tick: number;
  from: number;
  to: number;
  causedBy: EventId | null;
}
function changeRows(world: SimWorld): ChangeRow[] {
  return world.bus.log
    .filter((e): e is Extract<SimEvent, { type: 'weather/changed' }> => e.type === 'weather/changed')
    .map((e) => ({ id: e.id, tick: e.tick, from: e.payload.from, to: e.payload.to, causedBy: e.causedBy }));
}

describe('детерминизм: одинаковый seed → идентичная история погоды (закон №8)', () => {
  function history(seed: number): ReadonlyArray<{ tick: number; from: number; to: number }> {
    const w = createSimWorld(seed as Seed);
    placeClock(w);
    weatherScheduler().run(w, 5000);
    return changeRows(w).map((r) => ({ tick: r.tick, from: r.from, to: r.to }));
  }

  it('два прогона одного seed совпадают по типам и тикам смен', () => {
    const a = history(101);
    const b = history(101);
    expect(a.length).toBeGreaterThan(3); // за 5000 тиков сменилась не раз
    expect(b).toEqual(a);
  });

  it('другой seed даёт другую историю (rng реально влияет)', () => {
    const a = history(101);
    const b = history(202);
    expect(b).not.toEqual(a);
  });
});

describe('длительность каждой погоды ∈ [MIN, MAX] balance, кратна шагу планировщика', () => {
  it('интервалы между сменами лежат в диапазоне и кратны 10', () => {
    const w = createSimWorld(303 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 6000);

    // Границы сегментов: старт (weatherSince=0) + тик каждой смены.
    const rows = changeRows(w);
    expect(rows.length).toBeGreaterThan(3);
    const boundaries = [0, ...rows.map((r) => r.tick)];

    for (let i = 1; i < boundaries.length; i++) {
      const since = boundaries[i - 1]!;
      const interval = boundaries[i]! - since;
      // Диапазон balance (MIN/MAX кратны 10, поэтому интервал точно в [MIN,MAX]).
      expect(interval).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
      expect(interval).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
      expect(interval % 10).toBe(0);
      // Интервал = вытянутая длительность, округлённая вверх до шага проверки (10).
      const drawn = weatherDuration(w.rng, since);
      expect(drawn).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
      expect(drawn).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
      expect(interval).toBe(Math.ceil(drawn / 10) * 10);
    }
  });

  it('weatherDuration возвращает целое в [MIN,MAX] для разных since (детерминизм от seed)', () => {
    const w = createSimWorld(404 as Seed);
    for (const since of [0, 120, 500, 1440, 9990]) {
      const d1 = weatherDuration(w.rng, since);
      const d2 = weatherDuration(w.rng, since);
      expect(d2).toBe(d1); // форк детерминирован → повторный вызов тот же
      expect(Number.isInteger(d1)).toBe(true);
      expect(d1).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
      expect(d1).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
    }
  });
});

describe('причинная цепочка weather/changed (закон №6)', () => {
  it('первая смена — causedBy null, каждая следующая ссылается на предыдущую', () => {
    const w = createSimWorld(505 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 5000);

    const rows = changeRows(w);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]!.causedBy).toBeNull(); // корень цепочки погоды
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.causedBy).toBe(rows[i - 1]!.id);
    }
  });

  it('каждая смена ВИДИМА: from != to', () => {
    const w = createSimWorld(606 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 5000);
    for (const r of changeRows(w)) {
      expect(r.from).not.toBe(r.to);
      expect(r.to).toBeGreaterThanOrEqual(0);
      expect(r.to).toBeLessThan(WEATHER_TYPES.length);
    }
  });

  it('nextWeatherCode никогда не возвращает исходный код, покрывает все альтернативы', () => {
    const w = createSimWorld(707 as Seed);
    for (let from = 0; from < WEATHER_TYPES.length; from++) {
      const seen = new Set<number>();
      for (let t = 0; t < 2000; t += 10) {
        const to = nextWeatherCode(w.rng, t, from);
        expect(to).not.toBe(from);
        expect(to).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThan(WEATHER_TYPES.length);
        seen.add(to);
      }
      // За 200 тиков-меток вытянуты все n-1 альтернатив (равновероятный выбор).
      expect(seen.size).toBe(WEATHER_TYPES.length - 1);
    }
  });
});

describe('нет преждевременной смены', () => {
  it('на тике 0 и до истечения длительности погода не меняется', () => {
    const w = createSimWorld(808 as Seed);
    const eid = placeClock(w, 2 /* fog */, 0);
    const dur = weatherDuration(w.rng, 0);
    // Прогон строго меньше длительности (кратно 10, чтобы попасть на due-тики).
    const before = Math.floor((dur - 1) / 10) * 10;
    weatherScheduler().run(w, before + 1); // ещё не достигли порога смены
    expect(changeRows(w)).toHaveLength(0);
    expect(CLOCK.weather[eid]).toBe(2);
    expect(CLOCK.weatherSince[eid]).toBe(0);
  });
});

describe('RESUME (P0): непрерывный прогон ≡ split save/load (закон №8)', () => {
  it('WorldClock и лог weather/changed тождественны после load на середине', () => {
    const N = 4000;
    const MID = 1500;

    // Непрерывный эталон — захватываем в примитивы/строку ДО split (общий eid).
    const cont = createSimWorld(909 as Seed);
    placeClock(cont);
    weatherScheduler().run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contChanges = changeRows(cont);
    expect(contChanges.length).toBeGreaterThan(2); // смены реально были

    // Split: MID тиков → snapshot → deserialize → остаток.
    const split = createSimWorld(909 as Seed);
    placeClock(split);
    weatherScheduler().run(split, MID);
    const resumed = deserialize(serialize(split));
    expect(resumed.tick).toBe(MID);
    weatherScheduler().run(resumed, N - MID);

    // Байтовое совпадение состояния (WorldClock + лог + eventSeq) — доказательство.
    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    // И явно: история смен идентична (нет дубля/пропуска смены на границе load).
    expect(changeRows(resumed)).toEqual(contChanges);
  });

  it('split РОВНО на тике смены (граница) не даёт дубля и не теряет смену', () => {
    // Находим тик первой смены и режем сплит ровно на нём.
    const probe = createSimWorld(1010 as Seed);
    placeClock(probe);
    weatherScheduler().run(probe, 4000);
    const probeChanges = changeRows(probe);
    const firstChangeTick = probeChanges[0]!.tick;
    const probeHash = hashSnapshot(serialize(probe));

    const split = createSimWorld(1010 as Seed);
    placeClock(split);
    weatherScheduler().run(split, firstChangeTick); // сплит РОВНО на тике смены
    const resumed = deserialize(serialize(split));
    weatherScheduler().run(resumed, 4000 - firstChangeTick);

    expect(hashSnapshot(serialize(resumed))).toBe(probeHash);
    expect(changeRows(resumed)).toEqual(probeChanges);
  });
});

describe('singleton WorldClock', () => {
  it('0 носителей → no-op: без событий и без throw', () => {
    const w = createSimWorld(1111 as Seed);
    // Никакого WorldClock не создаём.
    expect(() => weatherScheduler().run(w, 3000)).not.toThrow();
    expect(changeRows(w)).toHaveLength(0);
  });

  it('>1 носитель → throw (нарушение инварианта singleton, D-019)', () => {
    const w = createSimWorld(1212 as Seed);
    placeClock(w); // носитель 1
    placeClock(w); // носитель 2 — нарушение
    // Weather due на тике 0 (every:10) → бросает; scheduler пробрасывает.
    expect(() => weatherScheduler().run(w, 1)).toThrow(/singleton/);
  });
});

describe('isNight/timeOfDay: чистая функция суточного цикла (D-019)', () => {
  it('границы DAWN/DUSK: день = [DAWN, DUSK), ночь — дополнение', () => {
    expect(isNight(0)).toBe(true); // полночь — ночь
    expect(isNight(DAWN_TICK - 1)).toBe(true); // за минуту до рассвета
    expect(isNight(DAWN_TICK)).toBe(false); // рассвет — уже день
    expect(isNight(DUSK_TICK - 1)).toBe(false); // за минуту до заката — день
    expect(isNight(DUSK_TICK)).toBe(true); // закат — уже ночь
    expect(isNight(TICKS_PER_DAY - 1)).toBe(true); // конец суток — ночь
  });

  it('корректен на разных сутках (периодичность TICKS_PER_DAY)', () => {
    for (const day of [0, 1, 5, 42]) {
      const base = day * TICKS_PER_DAY;
      expect(isNight(base + 0)).toBe(true); // полночь дня day
      expect(isNight(base + DAWN_TICK)).toBe(false); // рассвет дня day
      expect(isNight(base + 720)).toBe(false); // полдень дня day
      expect(isNight(base + DUSK_TICK)).toBe(true); // закат дня day
    }
  });

  it('чистая функция: повторный вызов на том же тике — тот же результат', () => {
    for (const t of [0, 359, 360, 719, 1259, 1260, 1439, 1440, 5000]) {
      expect(isNight(t)).toBe(isNight(t));
    }
  });

  it('minuteOfDay нормализует и отрицательные тики в [0, TICKS_PER_DAY)', () => {
    expect(minuteOfDay(0)).toBe(0);
    expect(minuteOfDay(TICKS_PER_DAY)).toBe(0);
    expect(minuteOfDay(TICKS_PER_DAY + 360)).toBe(360);
    expect(minuteOfDay(-1)).toBe(TICKS_PER_DAY - 1);
    expect(isNight(-1)).toBe(true); // -1 → минута 1439 → ночь
  });

  it('timeOfDay согласован с isNight и возвращает минуту суток и фазу', () => {
    expect(timeOfDay(720)).toEqual({ minuteOfDay: 720, phase: 'day', isNight: false });
    expect(timeOfDay(0)).toEqual({ minuteOfDay: 0, phase: 'night', isNight: true });
    expect(timeOfDay(DUSK_TICK)).toEqual({ minuteOfDay: DUSK_TICK, phase: 'night', isNight: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ ГЕЙТА 1.6 (QA): границы, длинные серии, resume-батарея, инварианты.
// Тесты читаются как сценарии мира. Ожидания выводятся из ЭКСПОРТИРУЕМЫХ функций
// контракта (weatherDuration/nextWeatherCode) и balance, а не хардкодятся, чтобы
// оставаться верными при перебалансе. Шаг планировщика берём из самой системы
// (Weather.schedule.every), а не литералом — тест ловит рассинхрон шага и balance.
// ─────────────────────────────────────────────────────────────────────────────

/** Шаг планировщика Weather (источник истины — сама система, не литерал 10). */
const STEP = Weather.schedule.every;

describe('баланс-канарейка: [MIN,MAX] держится ТОЛЬКО пока MAX кратен шагу планировщика', () => {
  // Фактический интервал между сменами = ceil(drawn/STEP)*STEP (смена ловится на
  // ближайшем due-тике). Округление ВВЕРХ ⇒ интервал >= drawn >= MIN всегда. Но
  // верхняя граница держится лишь если MAX кратен STEP: иначе drawn==MAX
  // округлилось бы до MAX+…, ВЫЙДЯ ЗА MAX. Это «тихая» связка balance↔schedule:
  // канарейка обязана покраснеть на перебалансе ДО того, как инвариант интервала
  // сломается молча в проде.
  it('WEATHER_MIN_DURATION и WEATHER_MAX_DURATION кратны Weather.schedule.every', () => {
    expect(STEP).toBeGreaterThan(0);
    expect(WEATHER_MIN_DURATION % STEP).toBe(0);
    expect(WEATHER_MAX_DURATION % STEP).toBe(0);
    expect(WEATHER_MIN_DURATION).toBeGreaterThan(0);
    expect(WEATHER_MIN_DURATION).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
  });

  it('на верхней границе (drawn==MAX) округление до шага НЕ выносит интервал за MAX', () => {
    // Property-проверка чистого контракта длительности + модели округления: гоним
    // сотни тысяч меток since, ДОСТИГАЕМ обеих границ drawn (MIN и MAX) и проверяем,
    // что округлённый вверх интервал остаётся в [MIN, MAX]. Именно этот сценарий
    // (drawn ровно MAX) сломался бы, будь MAX не кратен шагу.
    const w = createSimWorld(9999 as Seed);
    let sawMax = false;
    let sawMin = false;
    for (let since = 0; since <= 300000; since += STEP) {
      const drawn = weatherDuration(w.rng, since);
      const interval = Math.ceil(drawn / STEP) * STEP;
      expect(interval).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
      expect(interval).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
      if (drawn === WEATHER_MAX_DURATION) sawMax = true;
      if (drawn === WEATHER_MIN_DURATION) sawMin = true;
    }
    expect(sawMax).toBe(true); // верхняя граница реально встречается — и не превышена
    expect(sawMin).toBe(true); // нижняя тоже — округление её не занизило
  });
});

describe('длинная серия смен: КАЖДЫЙ интервал в [MIN,MAX] и weatherSince строго растёт', () => {
  it('на десятках смен подряд ни один сегмент не выходит из диапазона и кратен шагу', () => {
    // ~60 суток мира — достаточно для многих десятков смен; проверяем ВСЮ серию,
    // а не одну смену: инвариант длительности должен держаться неограниченно.
    const w = createSimWorld(2323 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 60 * TICKS_PER_DAY);

    const rows = changeRows(w);
    expect(rows.length).toBeGreaterThan(30); // серия действительно длинная
    const boundaries = [0, ...rows.map((r) => r.tick)];
    for (let i = 1; i < boundaries.length; i++) {
      const interval = boundaries[i]! - boundaries[i - 1]!;
      expect(interval).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
      expect(interval).toBeLessThanOrEqual(WEATHER_MAX_DURATION);
      expect(interval % STEP).toBe(0);
    }
  });

  it('weatherSince (тики смен) строго возрастает — метки fork(weather-duration@since) не коллидируют', () => {
    // Каждая смена пишет weatherSince=tick, а следующая наступит минимум через MIN
    // тиков ⇒ since СТРОГО растёт, значит метка `weather-duration@${since}` уникальна
    // для каждого сегмента и потоки rng сегментов не пересекаются. Проверяем монотонность.
    const w = createSimWorld(1313 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 30000);
    const ticks = changeRows(w).map((r) => r.tick);
    expect(ticks.length).toBeGreaterThan(5);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!); // строго растёт
      expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThanOrEqual(WEATHER_MIN_DURATION);
    }
  });
});

describe('первая смена от старта (weatherSince=0)', () => {
  it('происходит на ceil(weatherDuration@0 / STEP)*STEP, тип = nextWeatherCode(...,0), причина null', () => {
    const seed = 1414;
    // Ожидание выводим из контракта на НЕЗАВИСИМОМ мире того же seed.
    const probe = createSimWorld(seed as Seed);
    const dur0 = weatherDuration(probe.rng, 0);
    const expectedTick = Math.ceil(dur0 / STEP) * STEP;
    const expectedTo = nextWeatherCode(probe.rng, expectedTick, 0 /* стартовый clear=0 */);

    const w = createSimWorld(seed as Seed);
    placeClock(w, 0, 0);
    weatherScheduler().run(w, expectedTick + 1);

    const rows = changeRows(w);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.tick).toBe(expectedTick);
    expect(rows[0]!.from).toBe(0);
    expect(rows[0]!.to).toBe(expectedTo);
    expect(rows[0]!.causedBy).toBeNull(); // корень цепочки погоды
  });

  it('за один тик ДО ожидаемой первой смены — смены ещё нет', () => {
    const seed = 1414;
    const probe = createSimWorld(seed as Seed);
    const expectedTick = Math.ceil(weatherDuration(probe.rng, 0) / STEP) * STEP;

    const w = createSimWorld(seed as Seed);
    placeClock(w, 0, 0);
    weatherScheduler().run(w, expectedTick); // прогон ДО тика смены (не включая его)
    expect(changeRows(w)).toHaveLength(0);
  });
});

describe('видимость и покрытие типов на длинном прогоне', () => {
  it('за длинный прогон наступает КАЖДЫЙ тип погоды хотя бы раз, и всегда from != to', () => {
    const w = createSimWorld(1515 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 200000); // сотни смен
    const rows = changeRows(w);
    expect(rows.length).toBeGreaterThan(100);

    const seenTo = new Set<number>();
    for (const r of rows) {
      expect(r.from).not.toBe(r.to); // смена ВСЕГДА видима
      expect(r.to).toBeGreaterThanOrEqual(0);
      expect(r.to).toBeLessThan(WEATHER_TYPES.length);
      seenTo.add(r.to);
    }
    // При достаточном прогоне равновероятный выбор покрывает ВСЕ типы.
    expect(seenTo.size).toBe(WEATHER_TYPES.length);
  });
});

describe('isNight/timeOfDay: исчерпывающие границы суток (D-019)', () => {
  it('для КАЖДОЙ минуты суток isNight совпадает с определением дня [DAWN, DUSK) и с timeOfDay', () => {
    for (let m = 0; m < TICKS_PER_DAY; m++) {
      const expectedNight = m < DAWN_TICK || m >= DUSK_TICK;
      expect(isNight(m)).toBe(expectedNight);
      const tod = timeOfDay(m);
      expect(tod.isNight).toBe(expectedNight);
      expect(tod.phase).toBe(expectedNight ? 'night' : 'day');
      expect(tod.minuteOfDay).toBe(m);
      expect(minuteOfDay(m)).toBe(m);
    }
  });

  it('за сутки РОВНО два перехода фазы — день начинается на DAWN, ночь на DUSK (несколько суток)', () => {
    for (const day of [0, 1, 7, 100]) {
      const base = day * TICKS_PER_DAY;
      const flips: Array<{ atMinute: number; to: 'day' | 'night' }> = [];
      // Идём по всем тикам суток, сравнивая с ПРЕДЫДУЩИМ тиком (в т.ч. переход
      // через полночь base-1 → base): переход фиксируем, когда isNight меняется.
      for (let m = 0; m < TICKS_PER_DAY; m++) {
        const t = base + m;
        if (isNight(t) !== isNight(t - 1)) {
          flips.push({ atMinute: m, to: isNight(t) ? 'night' : 'day' });
        }
      }
      expect(flips).toEqual([
        { atMinute: DAWN_TICK, to: 'day' }, // рассвет: ночь → день РОВНО на DAWN
        { atMinute: DUSK_TICK, to: 'night' }, // закат: день → ночь РОВНО на DUSK
      ]);
      // Полночь НЕ является переходом (ночь по обе стороны) — косвенно доказано
      // тем, что переходов ровно два и оба не на minute 0.
    }
  });

  it('обёртка через полночь: последний тик суток и первый тик следующих — оба ночь', () => {
    for (const day of [0, 3, 50]) {
      const base = day * TICKS_PER_DAY;
      expect(isNight(base + TICKS_PER_DAY - 1)).toBe(true); // 23:59 — ночь
      expect(isNight(base + TICKS_PER_DAY)).toBe(true); // 00:00 следующих суток — ночь
    }
  });

  it('чистота: isNight и timeOfDay зависят ТОЛЬКО от tick (одинаковый tick → одинаковый ответ)', () => {
    for (const t of [0, DAWN_TICK, DUSK_TICK, 1439, 1440, 100000, -1, -1441]) {
      expect(isNight(t)).toBe(isNight(t));
      expect(timeOfDay(t)).toEqual(timeOfDay(t));
      // согласованность агрегата с базовой функцией на любом тике
      expect(timeOfDay(t).isNight).toBe(isNight(t));
      expect(timeOfDay(t).minuteOfDay).toBe(minuteOfDay(t));
    }
  });
});

describe('singleton WorldClock: 0 / 1 / >1', () => {
  it('ровно 1 носитель → система работает (смены происходят)', () => {
    const w = createSimWorld(4242 as Seed);
    placeClock(w);
    weatherScheduler().run(w, 3000);
    expect(changeRows(w).length).toBeGreaterThan(0);
  });

  it('>1 носитель → throw с ДЕТЕРМИНИРОВАННЫМ сообщением (одинаковым между прогонами)', () => {
    function messageOf(seed: number): string {
      const w = createSimWorld(seed as Seed);
      placeClock(w);
      placeClock(w);
      try {
        weatherScheduler().run(w, 1);
        return '<no throw>';
      } catch (e) {
        return (e as Error).message;
      }
    }
    const m1 = messageOf(3131);
    const m2 = messageOf(3131);
    expect(m1).toBe(m2); // сообщение стабильно (queryEntities сортирует eid)
    expect(m1).toMatch(/singleton/);
    expect(m1).toMatch(/найдено 2 носител/);
  });
});

describe('RESUME-батарея (P0, закон №8): save/load в РАЗНЫЕ моменты цикла ≡ непрерывный', () => {
  const SEED = 1616;
  const N = 8000;

  /** Непрерывный эталон: hash снапшота (строка) + история смен (plain-объекты). */
  function continuous(): { hash: string; rows: ChangeRow[] } {
    const w = createSimWorld(SEED as Seed);
    placeClock(w);
    weatherScheduler().run(w, N);
    return { hash: hashSnapshot(serialize(w)), rows: changeRows(w) };
  }

  /** Один split на тике `mid`: прогон→snapshot→load→остаток; hash+rows после load. */
  function splitAt(mid: number): { hash: string; rows: ChangeRow[] } {
    const w = createSimWorld(SEED as Seed);
    placeClock(w);
    weatherScheduler().run(w, mid);
    const resumed = deserialize(serialize(w));
    expect(resumed.tick).toBe(mid);
    weatherScheduler().run(resumed, N - mid);
    return { hash: hashSnapshot(serialize(resumed)), rows: changeRows(resumed) };
  }

  it('split на тике смены, за 1 тик до/после неё, вне due-тиков — все дают ту же историю', () => {
    // Эталон захватываем В ПРИМИТИВЫ/PLAIN до прогона split-миров (общий eid у
    // модульного WorldClock — как в шапке файла).
    const ref = continuous();
    expect(ref.rows.length).toBeGreaterThan(3);

    const c0 = ref.rows[0]!.tick; // тик первой смены
    const c1 = ref.rows[1]!.tick; // тик второй смены
    // Наборы точек разреза вокруг смен и в «случайных» местах цикла, включая
    // НЕ кратные шагу (проверяют, что load на не-due тике не сдвигает погоду).
    const mids = [
      c0 - STEP, // за один Weather-тик до смены
      c0 - 1, // за 1 тик до смены (не due)
      c0, // РОВНО на тике смены (смена произойдёт сразу ПОСЛЕ load)
      c0 + 1, // через 1 тик после смены (не due)
      c0 + STEP, // через один Weather-тик после смены
      Math.floor((c0 + c1) / 2), // середина второго сегмента
      1237, // произвольный не кратный шагу тик
      5555, // ещё один, ближе к концу
    ].filter((m) => m > 0 && m < N);

    for (const mid of mids) {
      const got = splitAt(mid);
      expect(got.hash, `hash mismatch at mid=${mid}`).toBe(ref.hash);
      expect(got.rows, `history mismatch at mid=${mid}`).toEqual(ref.rows);
    }
  });

  it('ДВОЙНОЙ save/load (две точки разреза) ≡ непрерывный — нет дрейфа при повторной регидратации', () => {
    const ref = continuous();
    const mid1 = ref.rows[0]!.tick; // ровно на первой смене
    const mid2 = ref.rows[2]!.tick + 1; // после третьей смены, вне due

    const w = createSimWorld(SEED as Seed);
    placeClock(w);
    weatherScheduler().run(w, mid1);
    const r1 = deserialize(serialize(w)); // 1-й load ровно на смене
    weatherScheduler().run(r1, mid2 - mid1);
    const r2 = deserialize(serialize(r1)); // 2-й load в другой момент цикла
    weatherScheduler().run(r2, N - mid2);

    expect(hashSnapshot(serialize(r2))).toBe(ref.hash);
    expect(changeRows(r2)).toEqual(ref.rows);
  });
});
