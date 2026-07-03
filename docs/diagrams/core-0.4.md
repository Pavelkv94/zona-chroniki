# Ядро 0.4 — шина событий: граф зависимостей

Модули задачи 0.4 (контракт `SimEvent` в `@zona/shared`, `EventBus` в
`@zona/sim/core/events`, интеграция в `SimWorld`). Стрелка A → B означает
«A импортирует B».

```mermaid
graph TD
  subgraph shared["@zona/shared (чистые типы, без bitecs — закон №5)"]
    ids["ids.ts<br/>EventId (branded), Tick"]
    events["events.ts<br/>SimEventBase, SimEvent (union)"]
    sindex["index.ts"]
    ids --> events
    events --> sindex
    ids --> sindex
  end

  subgraph sim["@zona/sim/core"]
    busmod["events.ts<br/>EventBus, createEventBus<br/>(лог + буфер + eventSeq)"]
    world["world.ts<br/>SimWorld { …, bus }<br/>createSimWorld"]
    index["index.ts (публичный API)<br/>createEventBus, тип EventBus"]

    busmod --> events
    world --> busmod
    busmod --> index
  end

  scheduler["scheduler.ts (0.2, будущее)<br/>вызывает bus.endTick(tick)"]
  systems["системы (0.2+)<br/>publish / at(tick-1)"]

  scheduler -.->|endTick| busmod
  systems -.->|publish / at| busmod
```

## Модель двух фаз (D-005)

```mermaid
sequenceDiagram
  participant Sys as Система
  participant Bus as EventBus
  participant Sch as Планировщик (0.2)
  Note over Bus: буфер тика t (пусто)
  Sys->>Bus: publish(e)  →  id = ++eventSeq, tick = world.tick
  Note over Bus: событие в буфере, ещё НЕ в log/at
  Sch->>Bus: endTick(t)
  Note over Bus: буфер → append-only log, буфер очищен
  Sys->>Bus: at(t-1)  (чтение зафиксированного прошлого тика)
```

Инварианты: id монотонны и не сбрасываются на `endTick` (C-4, `eventSeq`
сериализуется в 0.5); порядок лога = порядок `publish` (закон №8, массивы без
Map-итерации). Append-only защищён на трёх уровнях: (1) событие заморожено
целиком — шапка И `payload` (deep freeze, глубина 1); (2) геттер `log` отдаёт
копию (`slice`); (3) `at`/`drainSince` возвращают новые массивы (`filter`).
`endTick(tick)` сверяет, что все события буфера имеют этот `tick` (иначе бросок —
ловит рассинхрон планировщика). Восстановление 0.5: `createEventBus(getTick,
{ eventSeq, log })` продолжает последовательность id без коллизий (C-4).
