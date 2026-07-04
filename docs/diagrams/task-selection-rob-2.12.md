# TaskSelection — выбор ROB (задача 2.12, D-049/D-062)

Как утилити-AI `systems/task-selection.ts` детерминированно ВЫБИРАЕТ грабёж (ROB).
Исполнение боя/лута — Encounters (2.11, D-060). Выбор дремлет, пока в мире нет
акторов хищной фракции (worldgen спавнит 'loners') ⇒ голдены Фазы 1 стабильны.

## Поток решения ROB для одного NPC

```mermaid
flowchart TD
  START([живой Human, тик]) --> FAC{"faction NPC —<br/>predatory? (factions.json,<br/>isPredatoryFaction, закон №10)"}
  FAC -- нет --> ROBINF["sRob = −∞<br/>(ROB вне argmax)"]
  FAC -- да --> CONTACTS["читаем contacts NPC<br/>(Perception, закон №1 —<br/>только воспринятое)"]
  CONTACTS --> LOOP{"для каждого видимого target:<br/>co-located + СТОИТ +<br/>живой Human + НЕ хищник?"}
  LOOP -- нет --> SKIP[пропустить кандидата]
  LOOP -- да --> SCORE["sRob(target) =<br/>W.robGain·lootProxy<br/>− W.robRisk·targetStrength<br/>− W.robRel·relationPenalty"]
  SCORE --> BEST["argmax по target<br/>(строгое >, tie→меньший eid)"]
  SKIP --> BEST
  BEST --> HAST{"нашлась жертва?"}
  HAST -- нет --> ROBINF
  HAST -- да --> ROBSET["sRob = score,<br/>robTarget = жертва"]
  ROBINF --> ARGMAX
  ROBSET --> ARGMAX["argmax по ВСЕМ задачам<br/>(SLEEP..ROB=9..SEARCH=10, D-020)"]
  ARGMAX --> WON{"ROB победил?"}
  WON -- да --> WRITE["Task.kind=ROB,<br/>targetEid=жертва, targetLoc=loc;<br/>publish task/selected;<br/>stampCause (D-030)"]
  WON -- нет --> OTHER[другая задача]
  WRITE --> ENC["Encounters 2.11:<br/>стоящий бандит + стоящая<br/>co-located жертва → бой → лут"]
```

## Составляющие sRob (наблюдаемые, анти-чит D-049)

```mermaid
flowchart LR
  subgraph lootProxy["lootProxy — по РОЛИ, БЕЗ инвентаря жертвы"]
    LB["ROB_LOOT_BASE"] --> LSUM(("+"))
    LM["+ROB_LOOT_MERCHANT_BONUS<br/>если профессия торговая<br/>(workTasks ∋ 'trade')"] --> LSUM
  end
  subgraph strength["targetStrength — наблюдаемая сила"]
    SW["shooting·ROB_STRENGTH_WEAPON<br/>(видимое оружие)"] --> SSUM(("+"))
    SH["(hp/HEALTH_MAX)·ROB_STRENGTH_HP"] --> SSUM
    SA["allies·ROB_STRENGTH_ALLY<br/>(со-локейт одно-фракционники<br/>→ группа сильна → sRob↓)"] --> SSUM
  end
  subgraph rel["relationPenalty — субстрат 2.15"]
    RP["max(getRelation(бандит→цель),<br/>factionReputation(цель.faction))"]
  end
  LSUM -->|·W.robGain| SROB(("sRob"))
  SSUM -->|−·W.robRisk| SROB
  RP -->|−·W.robRel| SROB
```

## Инварианты

- Закон №10: хищность — поле `predatory` в factions.json, НЕ хардкод id в коде.
- Закон №1: жертва — из `contacts` (воспринятое), не из глобального состояния мира.
- Анти-чит (D-049): `lootProxyOf` не читает 'inventory' жертвы — оценка по роли; силу
  считает по ВИДИМОМУ оружию/hp/союзникам, не по ценности кармана.
- Эмерджентность: «грабёж одиночек / обход групп» — из `allies·ROB_STRENGTH_ALLY`, без
  спец-кода.
- Закон №8: обходы сортированы (contacts по target, roster по eid), tie→меньший eid;
  rng не участвует.
- Согласование с Encounters 2.11 (D-060): гейт жертвы (co-located + стоит + живой Human
  не-хищник) тождествен условию, при котором encounters.ts завяжет бой.
```
