# Ядро 0.1 — каркас: граф зависимостей

Модули задачи 0.1 (типы `@zona/shared`, `SimWorld`, `ResourceStore`, обёртка bitecs).
Стрелка A → B означает «A импортирует B».

```mermaid
graph TD
  subgraph shared["@zona/shared (чистые типы, без bitecs — закон №5)"]
    ids["ids.ts<br/>EntityId, EventId, LocationId (branded);<br/>Tick, Seed (не branded), FactionId, ItemId"]
    schedule["schedule.ts<br/>SystemSchedule, SystemName"]
    sindex["index.ts"]
    ids --> sindex
    schedule --> sindex
  end

  subgraph sim["@zona/sim/core"]
    ecs["ecs.ts (внутренний)<br/>обёртка bitecs 0.4:<br/>create/spawn/destroyEcs/exists/allEntities"]
    world["world.ts<br/>SimWorld, ResourceStore (has/purgeEntity),<br/>createSimWorld, destroyEntity"]
    system["system.ts<br/>контракты System, SystemCtx<br/>(заглушки, реализация 0.2/0.3/0.4)"]
    index["index.ts (публичный API)<br/>createSimWorld, destroyEntity, типы"]

    world --> ecs
    system --> world
    world --> index
    system --> index
  end

  bitecs["bitecs 0.4<br/>(единственная точка импорта — ecs.ts)"]

  ecs --> bitecs
  ecs -.->|type EntityId| sindex
  world -.->|type EntityId, Seed, Tick| sindex
  system -.->|type SystemName, SystemSchedule, Tick| sindex
```

## Инварианты
- Закон №5: `bitecs` импортируется только в `ecs.ts`; `@zona/shared` не тянет движок.
  Тип `EcsWorld` и низкоуровневый `ecs.ts` НЕ реэкспортируются из публичного index.
- Закон №8: `ResourceStore.entries`/`allEntities` сортируют по возрастанию eid;
  `purgeEntity` обходит ключи отсортированно (детерминизм итерации).
- Закон №3 (риск C-6): bitecs 0.4 переиспользует eid → удаление сущности идёт ТОЛЬКО
  через `destroyEntity(world, eid)`, который делает ecs-destroy + `purgeEntity` (иначе
  новая сущность унаследует данные покойника). Версионирование bitecs на 0.1 не включаем.
- Поля `bus`/`rng` в `SimWorld`/`SystemCtx` появятся в задачах 0.4/0.3 — здесь их нет.
