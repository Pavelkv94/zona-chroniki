# ArtifactSpawn (2.9, D-054) — рождение артефактов в аномальных полях

Система ArtifactSpawn копит заряд каждому аномальному полю (`AnomalyField.charge`
растёт ДЕТЕРМИНИРОВАННО каждый тик — физика аномалии, не «X% выпадения») и на пороге
«разряжает» поле в физический артефакт — наземный лут поля (`'inventory'` на eid
поля, D-046). Появление массы леджерится `item/harvested(source:'anomaly')`, поэтому
EconomyInvariant (D-045) держится. Тип артефакта — из `AnomalyField.tier` через данные.

## Граф зависимостей

```mermaid
graph TD
  AS["systems/artifact-spawn.ts<br/>ArtifactSpawn (every:60)"]
  COMP["core/components.ts<br/>AnomalyField(charge,tier) · Position"]
  ECS["core/ecs.ts<br/>queryEntities"]
  RES["core/world.ts (ResourceStore)<br/>get/set('inventory', fieldEid)"]
  BUS["core/events.ts (world.bus)<br/>publish / log"]
  DATA["data/index.ts<br/>getArtifactForTier (data-driven, закон №10)"]
  ITEMS["data/items.json<br/>kind:'artifact' + tier (medusa/stone_flower/moonlight)"]
  BALE["balance/ecology.ts<br/>ARTIFACT_CHARGE_PER_TICK · ARTIFACT_SPAWN_THRESHOLD"]
  EV["@zona/shared/events.ts<br/>artifact/spawned {field,item,tier,loc} · item/harvested(source:'anomaly')"]

  AS --> COMP
  AS --> ECS
  AS --> RES
  AS --> BUS
  AS --> DATA
  DATA --> ITEMS
  AS --> BALE
  AS --> EV

  ECON["EconomyInvariant 2.0 (headless)<br/>worldTotals == baseline + ledgerDelta"] -. учитывает inventory поля + item/harvested .-> RES
  SEARCH["SEARCH 2.10 (seam)"] -. заберёт лут поля ПЕРЕВОДОМ (масса конс., без леджера) .-> RES
  EMIT["Emission Фаза 3 (seam)"] -. добавит заряд событием → artifact/spawned.causedBy=выброс .-> COMP
```

## Ключевые инварианты

- **Закон №1 (живёт без игрока):** заряд копится и артефакты рождаются по состоянию
  поля, даже когда в мире НЕТ ни одного человека (доказано тестом). Артефакт —
  эмерджентный продукт аномальной физики, а не выдача игроку.
- **Закон №2 (причинность, НЕ «X% выпадения»):** `charge += ARTIFACT_CHARGE_PER_TICK *
  cadence` каждый вызов — детерминированная физика (категория «генерация среды», как
  накопление длительности погоды D-028 / рост нужд Needs). rng НЕ используется вовсе.
  Рождение — при `charge >= ARTIFACT_SPAWN_THRESHOLD`, из СОСТОЯНИЯ заряда.
- **Порог и разряд:** РОВНО ОДИН артефакт за вызов (как одно рождение/стадо у Animals),
  `charge -= порог` (списание на стоимость, остаток переносится). Guard-канарейка при
  загрузке модуля: `прирост_за_шаг < порог` (иначе поле копит быстрее, чем разряжается).
- **Закон №3 (ничего из воздуха):** артефакт физически появляется в наземном луте поля
  (`'inventory'` на eid поля — тот же механизм, что склад поселения / лут трупа, D-046),
  источник — само поле. Инвентарь пишется НОВЫМ массивом (не in-place).
- **Закон №10 (контент — данные):** `tier` → артефакт через `getArtifactForTier` (артефакт
  с наибольшим `tier <= запрошенного`, клампинг). Артефакты — items.json (`kind:'artifact'`,
  уникальный целый `tier`); код оперирует id.
- **Леджер (закон №3, D-045):** на КАЖДУЮ единицу — `item/harvested{who:field,qty:1,
  source:'anomaly'}` (`causedBy` = id `artifact/spawned`). Масса растёт ровно на дельту
  леджера ⇒ EconomyInvariant держится. Масса создаётся при РОЖДЕНИИ (не при сборе):
  worldTotals уже вырос, поэтому леджерит рождение (уточнение к D-048).
- **Причинность (закон №6, D-030):** `artifact/spawned.causedBy = null` — накопление
  заряда до порога есть КОРЕНЬ цепочки (как `animal/born`). SEAM Фазы 3: выброс встанет
  сюда id-причиной.
- **Закон №8 + RESUME (P0):** `charge` — сериализуемое SoA-поле, аккумулятор сам себе
  «часы», хранимого таймера НЕТ ⇒ непрерывный ≡ split save/load (доказано хэшем + логом
  `artifact/spawned`).
- **SEAM сбора (задача 2.10, SEARCH):** NPC заберёт артефакт ПЕРЕВОДОМ записи из inventory
  поля в свой inventory — масса сохраняется, леджер НЕ нужен (как торговля D-047), НЕ
  повторный `item/harvested`. Поле продолжает заряжаться (может накопить несколько до сбора).
- **НЕ в конвейере/worldgen:** система no-op на текущем мире (носителей `AnomalyField` нет
  до 2.16) ⇒ голдены Фазы 1 не сдвинуты. Подключение — задача 2.16.

## Пример

```ts
import { ArtifactSpawn } from '@zona/sim';

// Отдельный планировщик (система пока не в registerPhase1Systems — подключит 2.16).
sched.register(ArtifactSpawn); // копит заряд полям, на пороге рождает артефакт в их лут
```
