# Ядро Фазы 0 — обзорный граф модулей и инварианты (гейт 0.7)

Обзор ВСЕЙ Фазы 0: как собраны кирпичи задач 0.1–0.6 и какие инварианты
закрывает интеграционный гейт детерминизма 0.7. Стрелка `A → B` означает
«A импортирует/зависит от B». Пунктир — контролируемое касание чужого слоя.

Диаграммы по отдельным задачам: `core-0.1.md`, `core-0.2.md`, `core-0.4.md`,
`core-0.5a.md`. Здесь — крупный план целиком.

## Граф модулей ядра

```mermaid
graph TD
  subgraph shared["@zona/shared — чистые типы (без bitecs/DOM/Node, закон №5)"]
    ids["ids.ts<br/>EntityId, EventId, Tick, Seed"]
    sched["schedule.ts<br/>SystemSchedule, SystemName"]
    ev["events.ts<br/>SimEvent, SimEventBase (causedBy)"]
    snapT["snapshot.ts<br/>JsonValue, SnapshotJSON"]
    ids --> ev
    ids --> snapT
    ev --> snapT
  end

  subgraph sim["@zona/sim/core — headless-ядро"]
    ecs["ecs.ts<br/>обёртка bitecs 0.4<br/>spawn/allEntities/exportEntityIndex"]
    world["world.ts<br/>SimWorld, ResourceStore<br/>createSimWorld / destroyEntity"]
    rng["rng.ts<br/>mulberry32 + fork(label)<br/>createRng / restoreRng"]
    events["events.ts<br/>EventBus append-only<br/>publish / endTick / discardTick"]
    system["system.ts<br/>System, SystemCtx"]
    sched2["scheduler.ts<br/>createScheduler<br/>tickOnce / run (атомарный тик)"]
    snap["snapshot.ts<br/>canonicalize / hashSnapshot<br/>serialize / deserialize"]
    simIndex["index.ts — публичный API @zona/sim"]
    balance["balance/time.ts<br/>TICKS_PER_DAY (закон №7)"]

    world --> ecs
    world --> rng
    world --> events
    system --> world
    system --> events
    system --> rng
    sched2 --> system
    sched2 --> world
    snap --> ecs
    snap --> world
    snap --> rng
    snap --> events
    world --> ids
    events --> ev
    sched2 --> sched
    snap --> snapT

    world --> simIndex
    rng --> simIndex
    events --> simIndex
    sched2 --> simIndex
    system --> simIndex
    snap --> simIndex
    balance --> simIndex
  end

  subgraph headless["@zona/headless — CLI (единственный слой с временем/Node)"]
    cli["cli.ts<br/>parseArgs / runHeadless / main<br/>performance.now — ТОЛЬКО здесь (D-006)"]
  end

  simIndex --> cli
  ecs -.->|"$internal (слой D-008)"| bitecs["bitecs 0.4"]

  subgraph gate07["Гейт 0.7 — интеграционные проверки (тесты, продакшн не меняют)"]
    detTest["determinism.test.ts<br/>4 фейк-системы → 2×1000 тиков"]
    smokeTest["headless/smoke.test.ts<br/>runHeadless ×2 → один хэш"]
  end
  simIndex --> detTest
  cli --> smokeTest
```

## Поток одного тика (что доказывает детерминизм)

```mermaid
sequenceDiagram
  participant Run as scheduler.run
  participant Sys as due-системы (порядок регистрации)
  participant Rng as world.rng.fork(name@tick)
  participant Bus as EventBus (буфер тика)
  Run->>Sys: для каждой due-системы собрать ctx
  Sys->>Rng: ctx.rng = fork(`${name}@${tick}`) (D-009)
  Sys->>Bus: publish(event, causedBy) → в буфер
  Note over Run,Bus: любой throw → discardTick + rethrow<br/>(тик атомарен, следа нет)
  Run->>Bus: endTick(tick) — буфер → append-only лог
  Run->>Run: world.tick = tick + 1
```

## Ключевые инварианты Фазы 0 (что закрывает гейт 0.7)

| Инвариант | Где живёт | Решение | Как проверяет гейт 0.7 |
|-----------|-----------|---------|------------------------|
| **Детерминизм по seed**: один seed → одна история (лог + хэш) | `rng.ts`, `scheduler.ts` | D-004, D-009, закон №8 | ТЕСТ A: seed=42 дважды → идентичный `bus.log` и `hashSnapshot` |
| **Чувствительность к seed**: rng не декоративен | `rng.ts` | D-004, закон №2 | ТЕСТ B: seed=43 ≠ seed=42 по логу и хэшу |
| **Атомарный тик** (всё-или-ничего) | `scheduler.ts`, `events.ts` | D-005 | косвенно: без исключений лог непрерывен, id монотонны (ТЕСТ A) |
| **Append-only лог + монотонный EventId** | `events.ts` | D-005, C-4 | ТЕСТ A: `id` строго возрастает в порядке публикаций |
| **Полная причинная цепочка** (`causedBy`) | `events.ts` | закон №6 | ТЕСТ A: каждая `causedBy` → существующее раннее событие; обрыв только в `null`; без циклов; есть цепочки глубины ≥ 2 |
| **Ничего из воздуха**: только живые eid; reuse без «призраков» | `world.ts`, `snapshot.ts` | D-007, D-008 | ТЕСТ A: рождения+смерти реальны, `maxId < всего рождённых` (freelist reuse) |
| **Resume-детерминизм**: save/load не сдвигает историю | `snapshot.ts`, `ecs.ts` | D-011, D-014, D-016 | ТЕСТ C: 1000 непрерывно === 500 + serialize/deserialize + 500 |
| **Порядок исполнения = порядок регистрации** (единственный tie-break) | `scheduler.ts` | D-006, закон №8 | ТЕСТ D: независимые системы коммутируют; делящие шину — стабильно нет |
| **Замер времени только в headless** | `headless/cli.ts` | D-006 | `ms` не входит в хэш (cli.test.ts); ядро времени не знает |
| **Константы — из /balance** | `balance/time.ts` | закон №7 | CLI переводит `--days` через `TICKS_PER_DAY`, не через «1440» |

## Как гейт остаётся «не холостым»

CLI Фазы 0 гоняет ПУСТЫЕ тики (реальных систем ещё нет) — на нём детерминизм
доказывался бы на пустом логе. Поэтому гейт 0.7 подсовывает планировщику 4
фейк-системы (`census` every 5, `birth` every 3, `mutation` every 2/phase 1,
`death` every 7/phase 2), которые реально рождают/хоронят сущностей, пишут
ресурсы и строят причинные цепочки. Тест ЯВНО утверждает, что лог не пуст и что
freelist eid задействован — иначе «зелёный» гейт был бы фикцией.
