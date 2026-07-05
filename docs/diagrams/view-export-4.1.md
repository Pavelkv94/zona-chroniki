# View-контракт Sim→UI + экспортёры (задача 4.1, D-076)

ФУНДАМЕНТ Фазы 4 (интерфейс наблюдателя). Read-only срез приватного ECS+ResourceStore
в plain-формы `@zona/shared` для Worker-моста и панелей UI. НЕ система, в конвейер тика
НЕ входит (D-080), голдены не двигает; чистое чтение (D-006); ни один bitecs-тип наружу
не течёт (закон №5 / D-011).

## Граница пакетов и поток данных

```mermaid
flowchart LR
  subgraph sim["@zona/sim (headless, приватный ECS)"]
    ECS["bitecs SoA-компоненты\nPosition/Health/Task/Needs/\nAnimal/WorldClock + теги\nHuman/Corpse/Alive/Settlement"]
    RES["ResourceStore\nname/faction/inventory/money/\nmemory/relations/fame"]
    BUS["EventBus.log\n(append-only)"]
    DATA["data\ngetSpecies/getItem\n(закон №10)"]
    ECSW["core/ecs ОБЁРТКИ\nqueryEntities/hasComponent/\nexistsEntity (ВНУТРЕННИЕ, D-011)"]
    EXP["view/export.ts\nexportWorldView\nexportEntityDetail\n(read-only, D-006)"]
    ECS --> ECSW
    ECSW --> EXP
    ECS -.SoA-колонки.-> EXP
    RES --> EXP
    BUS --> EXP
    DATA --> EXP
  end

  subgraph shared["@zona/shared (plain, без bitecs — закон №5)"]
    VIEW["view.ts\nWorldView / EntityView\nEntityDetail / EntityKind"]
  end

  subgraph ui["Фаза 4: наблюдатель (D-080)"]
    BRIDGE["Worker-мост"]
    PANELS["карта · список · инспектор"]
  end

  EXP ==>|"plain-формы\n(НЕ ECS-типы)"| VIEW
  VIEW --> BRIDGE --> PANELS

  ECSW -. "НЕ реэкспортируются\nиз @zona/sim (D-011)" .-x ui
```

## Классификация kind (порядок проверки тегов)

`Corpse` проверяется ПЕРВЫМ: мёртвый человек несёт И `Human`, И `Corpse` (Death снимает
`Alive`, вешает `Corpse`, но `Human`-тег остаётся) ⇒ он `'corpse'`, а не `'human'`.

```mermaid
flowchart TD
  A[eid] --> C{Corpse?}
  C -- да --> CO["'corpse'"]
  C -- нет --> H{Human?}
  H -- да --> HU["'human'"]
  H -- нет --> AN{Animal?}
  AN -- да --> ANI["'animal'"]
  AN -- нет --> S{Settlement?}
  S -- да --> SE["'settlement'"]
  S -- нет --> N["null\n(часы мира / аномальное поле:\nне видима на карте,\nexportEntityDetail ⇒ null)"]
```

## Два уровня детализации

```mermaid
flowchart LR
  subgraph light["ЛЁГКИЙ (каждый тик)"]
    WV["WorldView\nday · tick · weather ·\nentities[] (сорт eid) · population"]
    EV["EntityView\neid·kind·faction·loc·dest·eta·\nhpFrac·task·inCombat·carrying·alive"]
    WV --> EV
  end
  subgraph heavy["ТЯЖЁЛЫЙ (по клику)"]
    ED["EntityDetail\nname?·needs·hp·task?·species?·\ninventory(сорт)·money·memory·\nrelations·fame·recentEvents"]
  end
```

## Решения полей

- **inCombat** — всегда `false` в 4.1: бой длится РОВНО один тик (`encounter/started`+
  `resolved` в одном тике), персистентного состояния «в бою» на сущности нет. Скан
  `bus.at(tick)` дорог (O(лог) на каждый per-tick экспорт) и неоднозначен (буфер тика ещё
  не закоммичен). TODO Фазы 4: «недавно в бою» из закоммиченного окна encounter-событий.
- **carrying** — есть ли в инвентаре предмет kind `'artifact'` (`getItem`, закон №10).
- **recentEvents** — `participantsOf(ev)` (канон нарратива, D-067) ∪ прямые актёры
  распорядка (`task/selected`/`move/*`); последние 50 (презентационное окно, не balance).
- **hpFrac** = `hp / HEALTH_MAX` клампится [0..1]; без Health (поселение) — `1`.
- **faction** — из ResourceStore `'faction'`; у животных/трупов/поселений записи нет ⇒ `null`.

## Инварианты

- **Закон №5**: `view.ts` зависит только от plain shared-модулей (`./ids`, `./memory`);
  ECS-обёртки читаются внутри `export.ts`, но НЕ реэкспортируются из `@zona/sim` (D-011).
- **D-006**: `hashSnapshot` до == после экспорта (мир не мутирован).
- **D-080 / голдены**: экспортёры не в конвейере/worldgen ⇒ `sim:100days 0f1ef408`,
  пустой мир `481914ae`, day1 seed42 `429867e2` — не сдвинуты.
- **Детерминизм (закон №8)**: обходы сорт. по eid/itemId; два экспорта одного мира deep-equal.
