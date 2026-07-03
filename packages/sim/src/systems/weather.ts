/**
 * @module @zona/sim/systems/weather
 *
 * Система Weather (задача 1.6, B.1) — процедурная смена погоды СРЕДЫ на singleton-
 * носителе `WorldClock`. Погода — марковский процесс с длительностью: текущий тип
 * держится случайную (но детерминированную от seed) длительность, затем среда
 * переключается на другой тип. Общение — только через компонент `WorldClock` и
 * шину событий с `causedBy` (закон №6): напрямую другие системы не вызываются.
 *
 * ── Почему здесь ДОПУСТИМ rng (закон №2, обоснование D-019) ───────────────────
 * Закон №2 запрещает «X% шанс ИСХОДА У СУЩНОСТИ» (событие должно вытекать из
 * состояния мира, а не из монетки на действие NPC). Погода — это НЕ исход у
 * сущности: это ПРОЦЕДУРНАЯ ГЕНЕРАЦИЯ СРЕДЫ, такая же категория, как генерация
 * карты/мира. Она детерминирована от `seed` (одинаковый seed → одинаковая история
 * погоды), не зависит от того, есть ли в мире хоть один NPC (главный тест закона №1:
 * погода идёт, даже если игрок/все NPC исчезли — носитель WorldClock существует сам
 * по себе), и её rng — тот же seeded PRNG ядра (закон №2 разрешает его для «генерации
 * мира»). Поэтому `ctx.world.rng` для выбора типа и длительности погоды — легальная
 * категория «генерация среды», а не запрещённый «шанс события у сущности». Это ЯВНО
 * зафиксировано в D-019 («погода использует rng»).
 *
 * ── Singleton WorldClock ─────────────────────────────────────────────────────
 * `queryEntities([WorldClock])` ОБЯЗАН вернуть ровно одного носителя (его создаёт
 * worldgen 1.3; в юнит-тестах — вручную). Поведение системы:
 *  • 0 носителей → NO-OP (мир ещё не сгенерирован — не падаем, ничего не делаем);
 *  • ровно 1 → работаем с ним;
 *  • >1 → THROW. Это нарушение инварианта мира (WorldClock документирован как
 *    SINGLETON, D-019): «обработать первого» замаскировало бы баг worldgen и
 *    привязало бы погоду к порядку eid. Падаем ГРОМКО и детерминированно —
 *    консистентно с fail-fast ядра (дубль имени системы, ссылка на мёртвый eid:
 *    D-024/D-016). Тик атомарен (scheduler откатит буфер), состояние не портится.
 *
 * ── Смена погоды и её ДЛИТЕЛЬНОСТЬ (resume-безопасность, P0 закон №8) ─────────
 * КЛЮЧЕВОЕ решение: система НЕ хранит «длительность» и «когда следующая смена» в
 * НЕсериализуемом рантайм-состоянии (это была бы мина, как несохранённый флаг в
 * 1.5). Всё выводится ТОЛЬКО из сериализуемого `WorldClock.weatherSince` + `seed`:
 *
 *  • Длительность ТЕКУЩЕЙ погоды = `weatherDuration(world.rng, weatherSince)` —
 *    форк `world.rng.fork('weather-duration@'+weatherSince)`, целое из
 *    [MIN, MAX] (balance/weather). Зависит ТОЛЬКО от (seed, weatherSince), оба
 *    из снапшота ⇒ на ЛЮБОМ тике (в т.ч. сразу после load) длительность
 *    восстанавливается тождественно. Никакого хранения в компоненте не нужно.
 *    Важно: длительность НАМЕРЕННО НЕ зависит от типа погоды — иначе для её
 *    пересчёта после load пришлось бы знать ПРЕДЫДУЩИЙ тип (его мы не храним).
 *
 *  • Смена происходит на ближайшем due-тике Weather, где
 *    `tick - weatherSince >= weatherDuration(...)`. Поскольку система идёт с шагом
 *    `every:10`, а `weatherSince` всегда кратен 10 (стартовый 0 + смены только на
 *    due-тиках) и MIN/MAX кратны 10 (balance), фактический интервал между сменами
 *    ∈ [MIN, MAX] и кратен 10 — детерминированно.
 *
 *  • Новый тип = `nextWeatherCode(world.rng, tick, fromCode)` — форк
 *    `world.rng.fork('weather-type@'+tick)`, РАВНОВЕРОЯТНО среди WEATHER_TYPES,
 *    ИСКЛЮЧАЯ текущий (from != to), чтобы смена всегда была видимой (осознанный
 *    выбор: «погода сменилась» = реальный переход). Тип зависит от (seed, tick,
 *    fromCode); его пересчитывать после load НЕ нужно (он хранится в
 *    `WorldClock.weather`), поэтому зависимость от fromCode безопасна.
 *
 *  • Запись: `WorldClock.weather = to`, `WorldClock.weatherSince = tick`. Публикуем
 *    `weather/changed {from, to}` с `causedBy` = id ПРЕДЫДУЩЕГО `weather/changed` в
 *    логе (цепочка смен, закон №6) или `null` для самой первой смены. Лог
 *    сериализуется ⇒ после load цепочка причинности продолжается без разрыва.
 *
 * ПОЧЕМУ `world.rng`, а не `ctx.rng`: `ctx.rng = world.rng.fork('Weather@'+tick)`
 * (D-009) зависит от ТЕКУЩЕГО тика; для пересчёта длительности прошлой погоды нужен
 * форк по МЕТКЕ прошлого `weatherSince`. Поэтому форкаем `world.rng` напрямую своими
 * метками, привязанными к сериализованным значениям — это и даёт resume-безопасность.
 * (Форк детерминирован от (label, rootSeed), D-004: повторный форк той же метки даёт
 * тот же поток, поэтому пересчёт на любом тике идентичен.)
 *
 * ── Детерминизм итерации (закон №8) ──────────────────────────────────────────
 * `queryEntities` сортирует по eid; носитель один, порядок тривиален. Никаких
 * Map/Set-итераций, Date.now, Math.random.
 */

import type { EntityId, EventId, Tick } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { queryEntities } from '../core/ecs';
import { WorldClock } from '../core/components';
import { WEATHER_TYPES, WEATHER_MIN_DURATION, WEATHER_MAX_DURATION } from '../balance/weather';

/** Тип события смены погоды (уже в union `SimEvent`) — метка поиска в логе. */
const WEATHER_CHANGED_TYPE = 'weather/changed';

/**
 * Шаг планировщика Weather. Инвариант [MIN,MAX]-длительности держится ТОЛЬКО пока
 * MIN/MAX кратны этому шагу: смена ловится на ближайшем due-тике (округление ВВЕРХ),
 * поэтому при MAX не кратном шагу фактический интервал мог бы превысить MAX. Guard
 * ниже ловит рассинхрон при перебалансе (balance-analyst) ДО молчаливого нарушения.
 */
const WEATHER_CADENCE = 10;
if (
  WEATHER_MAX_DURATION % WEATHER_CADENCE !== 0 ||
  WEATHER_MIN_DURATION % WEATHER_CADENCE !== 0
) {
  throw new Error(
    `Weather: WEATHER_MIN/MAX_DURATION должны быть кратны шагу планировщика ` +
      `${WEATHER_CADENCE} (иначе фактический интервал смены вылезет за [MIN,MAX]). ` +
      `MIN=${WEATHER_MIN_DURATION}, MAX=${WEATHER_MAX_DURATION}.`,
  );
}

/** Типизированные SoA-колонки `WorldClock` (weather — ui8, weatherSince — ui32). */
const CLOCK = WorldClock as unknown as {
  readonly weather: Uint8Array;
  readonly weatherSince: Uint32Array;
};

/**
 * Длительность (в тиках) погоды, начавшейся на тике `since`. Форк по метке,
 * привязанной ТОЛЬКО к `since` (сериализованному), делает значение полностью
 * восстановимым из снапшота (P0 resume, закон №8) и НЕ зависящим от типа погоды.
 * Целое из [WEATHER_MIN_DURATION, WEATHER_MAX_DURATION] (balance, закон №7).
 * Экспортируется, чтобы тесты проверяли контракт длительности без дублирования
 * формулы форка.
 */
export function weatherDuration(worldRng: Rng, since: Tick): number {
  // int(min, max+1) ⇒ включительно [MIN, MAX]. Верхняя граница balance инклюзивна.
  return worldRng.fork(`weather-duration@${since}`).int(WEATHER_MIN_DURATION, WEATHER_MAX_DURATION + 1);
}

/**
 * Код новой погоды при смене на тике `changeTick`, РАВНОВЕРОЯТНО среди
 * WEATHER_TYPES, но ИСКЛЮЧАЯ текущий `fromCode` (гарантирует from != to — смена
 * видима). Реализация без аллокаций: тянем индекс из [0, n-1) и «перешагиваем»
 * позицию исключённого типа. Форк по метке (seed, changeTick) → детерминизм.
 * Экспортируется для тестов (проверка «to != from» и детерминизма выбора).
 */
export function nextWeatherCode(worldRng: Rng, changeTick: Tick, fromCode: number): number {
  const n = WEATHER_TYPES.length;
  // Тянем среди (n-1) кандидатов, затем сдвигаем, чтобы пропустить fromCode.
  let k = worldRng.fork(`weather-type@${changeTick}`).int(0, n - 1);
  if (k >= fromCode) k += 1;
  return k;
}

/**
 * id самого свежего `weather/changed` в логе (причина следующей смены, закон №6),
 * либо `null`, если смен ещё не было (первая смена — корень цепочки погоды).
 * Скан с конца → первое совпадение = максимальный id. Лог сериализуется ⇒
 * цепочка переживает save/load без разрыва.
 */
function lastWeatherChange(bus: EventBus): EventId | null {
  const log = bus.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i];
    if (ev === undefined) continue;
    if (ev.type === WEATHER_CHANGED_TYPE) return ev.id;
  }
  return null;
}

/**
 * Система Weather (`every:10`). Находит singleton WorldClock и, если текущая
 * погода «отжила» свою детерминированную длительность, переключает её на другой
 * тип, обновляя `weather`/`weatherSince` и публикуя `weather/changed`.
 */
export const Weather: System = {
  name: 'Weather',
  schedule: { every: WEATHER_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;
    const carriers = queryEntities(world.ecs, [WorldClock]);

    if (carriers.length === 0) return; // мир ещё не сгенерирован — no-op
    if (carriers.length > 1) {
      // Инвариант singleton нарушен (баг worldgen): падаем громко и
      // детерминированно, а не маскируем выбором «первого» (см. docblock).
      throw new Error(
        `Weather: WorldClock — singleton, но найдено ${carriers.length} носителей ` +
          `(${carriers.join(', ')}). Это баг генерации мира (D-019).`,
      );
    }

    const eid = carriers[0] as EntityId;
    const since = CLOCK.weatherSince[eid] as number;
    const duration = weatherDuration(world.rng, since as Tick);

    // Ещё не отжила длительность — держим текущую погоду.
    if (tick - since < duration) return;

    const from = CLOCK.weather[eid] as number;
    const to = nextWeatherCode(world.rng, tick as Tick, from);

    CLOCK.weather[eid] = to;
    CLOCK.weatherSince[eid] = tick;

    bus.publish({
      type: 'weather/changed',
      causedBy: lastWeatherChange(bus),
      payload: { from, to },
    });
  },
};
