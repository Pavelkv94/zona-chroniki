# Задача 2.13 — Память об ограблении + обход маршрута (D-063)

Замыкает социальную петлю бандитизма: жертва, пережившая грабёж, ЗАПОМИНАЕТ обидчика,
портит к нему (и его фракции) отношение и начинает ИЗБЕГАТЬ места грабежа. Обход читает
TaskSelection и уводит маршрут мимо опасной локации.

## Часть A — формирование памяти (реакция на событие)

`RobberyMemory` (`systems/robbery-memory.ts`, `every: 1`) реактивно читает закоммиченные
`loot/transferred` прошлого тика (`bus.at(tick−1)`, модель двух фаз D-005) и через ЧИСТЫЕ
хелперы `memory.ts` (2.15/D-058) пишет «холодные» ключи жертвы. НЕ зовёт Encounters —
только шина (закон №6).

```mermaid
flowchart TD
  ENC["Encounters 2.11 (D-060)<br/>грабёж разрешён"] -->|emit| LT["loot/transferred<br/>{from=жертва, to=грабитель, loc}"]
  LT -->|endTick ⇒ лог| BUS[("EventBus<br/>append-only")]
  BUS -->|at(tick−1)| RM["RobberyMemory (2.13)"]

  RM -->|from жив? Alive| CHK{"existsEntity<br/>+ hasComponent Alive"}
  CHK -->|нет — «мёртвые не помнят»| SKIP["пропуск"]
  CHK -->|да — survivor| EFF

  subgraph EFF["3 эффекта через хелперы memory.ts (D-035, сорт., без rng)"]
    M["addMemory(from,{kind:'robbed',<br/>subject=e:грабитель, salience=1,<br/>tick=ev.tick, causeEvent=ev.id})"]
    R1["adjustRelation(from → e:грабитель, −ROBBERY_RELATION_DELTA)"]
    R2["adjustRelation(from → f:фракция, −FACTION_DELTA)<br/>(если фракция грабителя наблюдаема)"]
    A["addAvoid(from, ev.loc,<br/>ev.tick + AVOID_DURATION_TICKS)"]
  end

  EFF --> RES[("ResourceStore жертвы<br/>memory / relations / avoidLoc")]
  RES -->|salience↓ / relation→0 / avoid снят| MD["MemoryDecay 2.15 (every:60)<br/>затухание + чистка обхода"]
```

- ТИХО: RobberyMemory событий НЕ публикует (обоснование как MemoryDecay D-058) —
  формирование памяти есть внутреннее изменение состояния, а сам грабёж уже в логе;
  `MemoryRecord.causeEvent = id loot/transferred` (D-038) даёт летописную линковку без
  отдельного события.
- «Мёртвые не помнят»: Encounters идёт ДО Death в тике; убитой жертве Death снял `Alive`
  в том же тике грабежа ⇒ на `tick+1` проверка `Alive` её отсеивает. В 1v1 проигравший
  гибнет ⇒ память формирует лишь редкий survivor (сбежал живым из сломленной группы /
  обчищенный победивший защитник).

## Часть B — обход маршрута (TaskSelection читает avoidLoc)

```mermaid
flowchart LR
  AV[("avoidLoc жертвы<br/>[loc, untilTick]")] -->|getAvoids / isAvoided| TS["TaskSelection (2.13-обход)"]
  TS -->|notAvoided(list)| F1["дичь (animalLocs)"]
  TS -->|notAvoided| F2["вода (WATER_LOCS)"]
  TS -->|notAvoided| F3["поселения (settlementLocs)"]
  TS -->|notAvoided| F4["поля-артефакты (artifactFieldLocs)"]
  TS -->|avoid-предикат| F5["FLEE-сосед (safestNeighbor)"]
  F1 & F2 & F3 & F4 & F5 --> NL["nearestLoc / safestNeighbor<br/>по НЕизбегаемым кандидатам"]
  NL -->|единственный кандидат избегаем ⇒ null| INF["оценка = −∞ ⇒ иная задача"]
  NL -->|есть альтернатива| ALT["цель огибает опасное место"]
```

Механизм — ИСКЛЮЧЕНИЕ избегаемых loc из множеств КАНДИДАТОВ-ЦЕЛЕЙ перед поиском ближайшей
(тот же приём, что фильтр FLEE по safestNeighbor). НЕ фильтруются: текущая loc (задачи-
на-месте EAT/FORAGE/REST, питьё в воде под ногами) и дом (SLEEP). Тупик обхода (все
соседи/кандидаты избегаемы) деградирует к выбору без фильтра — выживание/движение важнее
обхода (закон №4, не idle).

## Изоляция (голдены Фазы 1)

- RobberyMemory НЕ в `registerPhase1Systems` и не создаётся worldgen (подключит 2.16). В
  живом мире бандитов нет, ROB дремлет (D-062) ⇒ `loot/transferred` не эмитится ⇒ 0
  записей ⇒ система дремлет.
- Часть B: у NPC без avoid-записей `getAvoids` пуст ⇒ `notAvoided` возвращает исходные
  списки (та же ссылка), FLEE-предикат не передаётся ⇒ выбор задач байт-в-байт прежний.
- Подтверждено: `sim:100days 37a19d72`, пустой мир `481914ae` — НЕ сдвинуты.
