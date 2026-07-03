# Movement (1.4) — зависимости и поток

Система Movement перемещает носителей `Position` по графу локаций к
`Task.targetLoc` кратчайшим путём. Читает `Task` (ставит TaskSelection 1.8),
пишет `Position`, публикует `move/departed`/`move/arrived` в шину.

## Граф зависимостей

```mermaid
graph TD
  Movement["systems/movement.ts<br/>Movement (every:1)"]
  PF["systems/pathfinding.ts<br/>Dijkstra + MAP_GRAPH"]
  DATA["data/index.ts<br/>MAP / neighbors / edgeLen"]
  BAL["balance/movement.ts<br/>MIN_TRAVEL_TICKS"]
  POS["core/components.ts<br/>Position (loc,dest,etaTicks)"]
  TASK["core/components.ts<br/>Task (targetLoc) — только чтение"]
  ECS["core/ecs.ts<br/>queryEntities / hasComponent"]
  BUS["core/events.ts (world.bus)<br/>publish / at / log"]
  EV["@zona/shared/events.ts<br/>move/departed · move/arrived"]

  Movement --> PF
  Movement --> POS
  Movement -. читает .-> TASK
  Movement --> ECS
  Movement --> BUS
  Movement --> BAL
  Movement --> EV
  PF --> DATA
  TS18["TaskSelection 1.8<br/>(ставит Task, шлёт task/selected)"] -. пишет Task/шину .-> TASK
  BUS -. causedBy .-> Movement
```

## Модель транзита (одна ветка на тик)

```mermaid
flowchart TD
  start{"dest === loc ?"}
  start -- "да (стоит)" --> hasTask{"есть Task и<br/>targetLoc ≠ loc ?"}
  hasTask -- нет --> idle["стоит: событий нет"]
  hasTask -- да --> depart["dest = firstStep(loc→target)<br/>etaTicks = max(MIN_TRAVEL_TICKS, edgeLen)<br/>publish move/departed<br/>causedBy: первый хоп → task/selected(eid,targetLoc) | null;<br/>промежуточный хоп → последний move/arrived этого eid"]
  start -- "нет (в пути)" --> dec["etaTicks -= 1"]
  dec --> chk{"etaTicks ≤ 0 ?"}
  chk -- нет --> transit["продолжает путь"]
  chk -- да --> arrive["loc = dest (прибыл)<br/>publish move/arrived<br/>causedBy = последний move/departed этого eid"]
  arrive --> multihop["loc = dest ⇒ снова «стоит»;<br/>следующий тик — departure к след. шагу"]
```

Одиночный переход занимает ровно `edgeLen` тиков (departure@T → arrival@T+edgeLen).
Мультихоп: между хопами один тик-передышка на промежуточном узле (по контракту
B.1 «на следующем тике departs дальше»). Кратчайший путь по `edgeLen` сам не
заходит в тупик Саркофаг (loc 9, degree=1), поэтому спец-обработки danger в
Movement нет — это забота TaskSelection (D-025).
