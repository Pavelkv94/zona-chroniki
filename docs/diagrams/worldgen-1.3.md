# Worldgen 1.3 — стартовая генерация мира

Задача 1.3: `worldgen(world: SimWorld): void` — вызывается ОДИН раз при сборке
мира (CLI 1.12) до первого тика. Заселяет пустой `SimWorld` детерминированно от
seed (`rng.fork('worldgen')`, D-021). Источник стартового инвентаря — «внесено
из-за Периметра» (D-021, закон №3).

## Зависимости модуля

```mermaid
graph TD
  WG["worldgen.ts (1.3)"]

  WG -->|spawnEntity / addComponent| ECS["core/ecs"]
  WG -->|SoA-компоненты| COMP["core/components<br/>Position/Needs/Health/Skills/Home/Animal/WorldClock<br/>+ теги Human/Alive + WEATHER_CODE"]
  WG -->|холодные данные D-007| RES["world.resources<br/>name / faction / profession / money / inventory"]
  WG -->|rng.fork('worldgen') D-004| RNG["world.rng"]
  WG -->|MAP / NAMES / getSpecies| DATA["data/index<br/>(факции/профессии — контент, закон №10)"]
  WG -->|HEALTH_MAX| BN["balance/needs"]
  WG -->|числа расстановки| BW["balance/worldgen<br/>STALKER_COUNT / STARTING_* / STARTING_HERDS<br/>HERD_MIN_GAME / SKILL_* / ANIMAL_*"]

  WG -. экспорт .-> IDX["@zona/sim index (для CLI 1.12)"]
```

## Рефактор 2.14a (D-059): извлечён `spawnStalker`

Рождение ОДНОГО человека вынесено в переиспользуемую
`spawnStalker(world, rng, cfg): EntityId`. worldgen зовёт её в цикле на когорту
(20) и на каждого торговца; PopulationInflux (2.14/D-051, приток) позже — на
новоприбывших. Поведение worldgen НЕ изменилось (голдены Фазы 1 бит-в-бит:
порядок и число rng-вызовов сохранены — `нужды×3 → навыки×3 → имя → [профессия]`).

```mermaid
graph TD
  WGS["spawnStalkers (когорта 20)"] -->|cfg: loc/home=Кордон, faction=loners,<br/>profession=pick(пул), inventory=фабрика| SS["spawnStalker(world,rng,cfg): eid"]
  WGT["spawnTrader (при поселении)"] -->|cfg: loc/home=s.loc, faction=s.faction,<br/>profession=fixed('trader')| SS
  INFLUX["PopulationInflux 2.14 (D-051)<br/>economy-engineer"] -. вызовет .->|cfg: loc/home=ENTRY_LOCATION,<br/>eid → леджер item/broughtIn| SS
  SS --> NPC["Position(стоит)+Needs(<крит)+Health(100)<br/>+Skills+Home+Human+Alive<br/>+имя/фракция/профессия/деньги/инвентарь<br/>(Task НЕ ставится, D-020)"]
```

SEAM для 2.14: `cfg.loc` (точка входа), `cfg.inventory` (фабрика свежей копии, без
aliasing — закон №3), возвращаемый `eid` (по нему 2.14 заледжерит `item/broughtIn`
— источник инвентаря; сам леджер в функции НЕ реализован, граница зон D-052).
Профессия — дискриминированный союз `{kind:'pick',from}` / `{kind:'fixed',id}`:
`pick` тратит ровно один `rng.pick` (как когорта), `fixed` — ноль (как торговец),
чем и держится бит-в-бит совпадение потоков.

## Что создаётся

```mermaid
graph LR
  WG["worldgen"] --> CLK["1x WorldClock<br/>weather=clear(0), weatherSince=0<br/>SINGLETON (D-019/D-028)"]
  WG --> ST["20x Сталкер (Кордон, loc 0)<br/>Position(стоит) + Needs(<крит, D-027)<br/>+ Health(100) + Skills(разброс)<br/>+ Home(0) + Human + Alive<br/>+ имя/фракция/профессия/деньги/инвентарь<br/>(Task НЕ ставится — назначит 1.8, D-020)"]
  WG --> HR["Стада (wild/ruins, game>0.3, не Саркофаг)<br/>deer 4 стада / boar 3 стада<br/>особь: Position + Needs + Health + Animal + Alive<br/>herd — уникальный № (D-025)"]
```

## Инварианты (гейт worldgen.test.ts)

- Детерминизм: `worldgen(seed)` дважды → идентичный хэш снапшота (закон №8).
- Сталкер: loc=Кордон; Needs строго < HUNGER/THIRST/FATIGUE_CRITICAL (D-027);
  Health>0; имя с непустыми first И last (закон №4); непустой инвентарь с
  валидными itemId (закон №3); money>=0.
- Ровно 1 WorldClock; никто не в Саркофаге (loc 9); сталкеры в Кордоне.
- Стада: в wild/ruins с game>HERD_MIN_GAME; валидный species+herd; размер стада
  ∈ [herdMin,herdMax]; один вид на стадо.
- RESUME: worldgen → serialize → deserialize → идентичный хэш.
- Число сущностей < WORLD_CAPACITY (для seed=42: 54 = 1 мир + 20 + 33 животных).
