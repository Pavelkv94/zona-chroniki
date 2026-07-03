# Weather + день/ночь (1.6) — зависимости и поток

Система Weather меняет погоду СРЕДЫ на singleton-носителе `WorldClock` (марковский
процесс с длительностью). День/ночь — ЧИСТАЯ производная от `tick` (не хранится).

## Граф зависимостей

```mermaid
graph TD
  Weather["systems/weather.ts<br/>Weather (every:10)"]
  DayNight["systems/daynight.ts<br/>isNight / timeOfDay (чистые)"]
  CLOCK["core/components.ts<br/>WorldClock (weather, weatherSince)"]
  ECS["core/ecs.ts<br/>queryEntities"]
  RNG["core/rng.ts (world.rng)<br/>fork('weather-duration@since')<br/>fork('weather-type@tick')"]
  BUS["core/events.ts (world.bus)<br/>publish / log"]
  BALW["balance/weather.ts<br/>WEATHER_TYPES · MIN/MAX · DAWN/DUSK"]
  BALT["balance/time.ts<br/>TICKS_PER_DAY"]
  EV["@zona/shared/events.ts<br/>weather/changed {from,to}"]

  Weather --> CLOCK
  Weather --> ECS
  Weather --> RNG
  Weather --> BUS
  Weather --> BALW
  Weather --> EV
  BUS -. causedBy: предыдущий weather/changed .-> Weather
  DayNight --> BALW
  DayNight --> BALT
  WG["worldgen 1.3<br/>создаёт singleton WorldClock"] -. владеет носителем .-> CLOCK
  TS18["TaskSelection 1.8"] -. импортирует isNight .-> DayNight
```

## Ключевые инварианты

- **rng под закон №2 (D-019):** погода — генерация СРЕДЫ, детерминированная от
  seed, а не «X% исхода у сущности». Идёт даже без единого NPC (закон №1). Поэтому
  seeded PRNG ядра здесь легален (категория «генерация мира»).
- **Resume-безопасность (P0, закон №8):** ничего не хранится в рантайме. Длительность
  текущей погоды = `world.rng.fork('weather-duration@' + weatherSince).int(MIN,MAX)` —
  зависит ТОЛЬКО от сериализуемого `weatherSince` + `seed`, поэтому восстанавливается
  тождественно на любом тике после load. Длительность НЕ зависит от типа (иначе для
  пересчёта пришлось бы знать предыдущий тип, который не хранится). Тип новой погоды
  хранится в `WorldClock.weather`, пересчитывать его после load не нужно.
- **Причинность (закон №6):** `weather/changed.causedBy` → id предыдущего
  `weather/changed` в логе (лог сериализуется ⇒ цепочка переживает save/load), либо
  `null` для первой смены.
- **Singleton:** 0 носителей → no-op; ровно 1 → работа; >1 → throw (баг worldgen).
- **День/ночь не хранится (D-019):** `isNight(tick)` = `tick mod TICKS_PER_DAY`
  относительно `[DAWN_TICK, DUSK_TICK)`. Чистая функция → тривиальный resume.

## Пример

```ts
import { Weather } from '@zona/sim/systems/weather';
import { isNight } from '@zona/sim/systems/daynight';

sched.register(Weather);          // среда меняет погоду от seed
if (isNight(ctx.tick)) { /* ночная логика TaskSelection 1.8 */ }
```
