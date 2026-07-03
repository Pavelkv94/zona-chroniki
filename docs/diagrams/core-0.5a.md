# Ядро 0.5a — сериализация (write-path): граф зависимостей

Модули задачи 0.5a: контракт `SnapshotJSON`/`JsonValue` в `@zona/shared`,
`exportEntityIndex` в `@zona/sim/core/ecs` (внутренний, D-011), а также
`canonicalize`/`hashSnapshot`/`serialize` в `@zona/sim/core/snapshot`.
Стрелка A → B означает «A импортирует B». Обратная сторона (`deserialize`,
`createEcsWorldFromIndex`) — задача 0.5b (D-015).

```mermaid
graph TD
  subgraph shared["@zona/shared (чистые типы, без bitecs — закон №5)"]
    ids["ids.ts<br/>EntityId, Seed, Tick"]
    events["events.ts<br/>SimEvent"]
    snapT["snapshot.ts<br/>JsonValue, SnapshotJSON<br/>(форма ЗАМОРОЖЕНА в 0.5a)"]
    sindex["index.ts"]
    ids --> snapT
    events --> snapT
    snapT --> sindex
  end

  subgraph sim["@zona/sim/core"]
    ecs["ecs.ts<br/>exportEntityIndex (внутр., D-011)<br/>единственная точка bitecs $internal"]
    world["world.ts<br/>ResourceStore.keys() (аддитивно)<br/>SimWorld"]
    snap["snapshot.ts<br/>canonicalize / hashSnapshot / serialize"]
    index["index.ts (публичный API)<br/>serialize, hashSnapshot, canonicalize<br/>+ типы SnapshotJSON/JsonValue"]

    snap --> ecs
    snap --> world
    snap --> snapT
    ecs --> snapT
    snap --> index
  end

  bitecs["bitecs 0.4<br/>$internal.entityIndex"]
  ecs -.->|"$internal (D-008 слой)"| bitecs
```

## Что и как сериализуется

```mermaid
graph LR
  W["SimWorld"] --> S["serialize()"]
  S --> V["version:1, seed, tick"]
  S --> R["rngState = world.rng.state (корневой, D-014)"]
  S --> E["eventSeq, eventLog (bus, C-4)"]
  S --> EI["ecsIndex = exportEntityIndex()<br/>(freelist, авторитет по живым eid)"]
  S --> EN["entities = allEntities()<br/>(живые, сорт. — производное, закон №3)"]
  S --> RES["resources: только живые eid,<br/>ключи+eid сорт., значения канонизуемы (D-013)"]
  S --> C["components = {} (Фаза 0)"]
```

## Инварианты (законы №8/№3, D-011/D-012/D-013/D-014)

- **Канонизатор (D-012/D-013).** Ключи объектов сортируются по возрастанию
  (UTF-16); массивы сохраняют порядок; числа — `Number.toString`,
  `NaN/±Infinity` → throw; строки — через `JSON.stringify`; `null` допустим.
  `undefined`/функция/символ/`bigint`/`Map`/`Set`/экземпляр класса/дыра массива →
  throw с указанием пути (`ctx` содержит ключ ресурса и eid). НЕ `JSON.stringify`,
  у которого порядок ключей = insertion order → нестабильный хэш (риск C-3).
- **hashSnapshot.** FNV-1a **32-бит** по кодовым единицам (UTF-16) каноничной
  строки; результат — 8 hex-символов. Инвариантен к порядку вставки ключей.
- **exportEntityIndex (D-011).** Клонирует реальную структуру `EntityIndex`
  bitecs 0.4: `aliveCount`, `dense` (все выданные eid длиной `maxId`: префикс
  `aliveCount` — живые, хвост — freelist), `sparse` (eid → индекс в `dense`),
  `maxId`, `versioning=false` (D-008), `versionBits`/`entityMask`/`versionShift`/
  `versionMask`. Разреженный `sparse` (дыра на индексе 0 — id 0 зарезервирован)
  нормализуется в ПЛОТНЫЙ массив: дыры → `0` (безопасно: id 0 никогда не жив,
  `dense[sparse[0]] !== 0`). Результат детерминирован и полностью JSON-safe.
- **Закон №3.** В снапшот попадают ТОЛЬКО живые eid: `entities` из
  `allEntities`, ресурсы фильтруются по множеству живых eid (защита сверх
  инварианта purge, D-008).
- **Закон №5.** `@zona/shared` не знает формы `ecsIndex` (для него `JsonValue`);
  bitecs `$internal` касается только `ecs.ts`.
```
