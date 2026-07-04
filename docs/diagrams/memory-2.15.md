# Память / отношения / обход + MemoryDecay (2.15, D-050/D-058)

Субстрат «мозга» NPC для цепочки бандитов (2.11 encounters людей → 2.12 ROB-решение →
2.13 память ограбления + обход маршрута). Три «холодных» ключа ResourceStore на eid NPC
(plain JSON, сорт. массивы, D-007/D-013/D-046, **НЕ** SoA — как inventory/money):

- **`'memory'`** → `MemoryRecord[]` — что NPC помнит; каждая запись несёт `causeEvent`
  (EventId события-причины, D-038) и `salience` (сила, затухает), `isFirsthand` (личное
  восприятие vs слух).
- **`'relations'`** → `RelationEntry[]` = `[subject, value]` сорт. по subject; value∈[−1..1].
- **`'avoidLoc'`** → `AvoidEntry[]` = `[loc, untilTick]` сорт. по loc.

Субъект памяти/отношения — единый **строковый** ключ `Subject` (закон №8): сущность
`"e:<eid>"`, фракция `"f:<factionId>"` (однородная сортировка, как inventory по item).

Два артефакта задачи:

- **MemoryDecay** (`systems/memory-decay.ts`, `every:60`, изолированная) — ДЕТЕРМИНИРОВАННОЕ
  затухание salience / остывание отношений к нейтралу / чистка истёкшего обхода. rng НЕ
  используется (закон №2). Тихая (событий не публикует). No-op на живом мире (worldgen не
  пишет эти ключи до 2.16) ⇒ голдены Фазы 1 целы.
- **Хелпер-API** (`systems/memory.ts`, чистые функции) — addMemory/getRelation/adjustRelation/
  addAvoid/isAvoided + DERIVED factionReputation. Субстрат для 2.12/2.13/TaskSelection; сам
  ROB-выбор здесь НЕ реализован.

## Граф зависимостей

```mermaid
graph TD
  SHARED["@zona/shared/memory.ts<br/>Subject · MemoryRecord · RelationEntry · AvoidEntry"]
  HELP["systems/memory.ts (хелперы)<br/>addMemory · getRelation · adjustRelation<br/>addAvoid · isAvoided · factionReputation<br/>entitySubject/factionSubject/parseSubject"]
  DECAY["systems/memory-decay.ts<br/>MemoryDecay (every:60)"]
  BAL["balance/social.ts (закон №7)<br/>MEMORY_MAX_AGE · *_DECAY_PER_TICK<br/>FORGET_THRESHOLD · RELATION_NEUTRAL_EPSILON"]
  RS["core/world.ts (ResourceStore)<br/>'memory' · 'relations' · 'avoidLoc' · 'faction'<br/>на eid NPC (D-046)"]
  SNAP["core/snapshot.ts<br/>serialize/deserialize (все ключи авто)"]

  FUT12["2.12 ROB-выбор (TaskSelection)<br/>читает getRelation/factionReputation"]
  FUT13["2.13 память ограбления<br/>addMemory + addAvoid → обход"]
  FUTTS["TaskSelection обход маршрута<br/>читает isAvoided(eid,loc,tick)"]

  HELP --> SHARED
  HELP --> BAL
  HELP -->|"пишет/читает НОВЫМИ<br/>массивами (D-035)"| RS

  DECAY --> SHARED
  DECAY --> BAL
  DECAY -->|"затухание+prune,<br/>НОВЫЕ массивы (D-035)"| RS

  RS --> SNAP

  FUT12 -. использует .-> HELP
  FUT13 -. использует .-> HELP
  FUTTS -. использует .-> HELP

  classDef future fill:#eee,stroke:#999,stroke-dasharray:4 3,color:#555;
  class FUT12,FUT13,FUTTS future;
```

## Затухание — детерминированная функция времени (закон №2, БЕЗ rng)

```mermaid
flowchart TD
  START["MemoryDecay.update (tick T, step=cadence 60)"]
  START --> M{"для каждого eid<br/>с 'memory' (сорт. по eid)"}
  M -->|"salience −= DECAY×step"| MC{"salience &lt; FORGET_THRESHOLD<br/>ИЛИ age &gt; MAX_AGE_TICKS?"}
  MC -->|да| MDROP["запись выброшена<br/>(пустой ключ удалён)"]
  MC -->|нет| MKEEP["запись сохранена (новый массив)"]

  START --> R{"для каждого eid<br/>с 'relations'"}
  R -->|"|value| −= DECAY×step<br/>(без перелёта через 0)"| RC{"|value| &lt;= NEUTRAL_EPSILON?"}
  RC -->|да| RDROP["отношение → нейтрал,<br/>запись выброшена"]
  RC -->|нет| RKEEP["отношение сохранено (знак цел)"]

  START --> A{"для каждого eid<br/>с 'avoidLoc'"}
  A --> AC{"untilTick &lt;= T?"}
  AC -->|да| ADROP["обход истёк — удалён"]
  AC -->|нет| AKEEP["обход действует"]
```

## Главный тест (закон №1) и resume

- **Без игрока**: затухание зависит только от `salience`/`value`/`tick` записей — идёт,
  даже если в мире нет ни одного живого наблюдателя.
- **Resume ≡ continuous** (закон №8): ключи `'memory'`/`'relations'`/`'avoidLoc'` — обычные
  ResourceStore-записи, `serialize`/`deserialize` пишут их автоматически (`resources.keys()`
  перечисляет все непустые ключи); затухание не зависит от рантайм-таймера ⇒ split
  save/load даёт тот же хэш, что непрерывный прогон (доказано тестом).
- **Голдены Фазы 1 целы**: MemoryDecay вне pipeline, worldgen не создаёт этих записей ⇒
  no-op ⇒ `sim:100days` 37a19d72 и пустой мир 481914ae неизменны.
