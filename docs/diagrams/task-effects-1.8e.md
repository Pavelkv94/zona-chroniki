# TaskEffects (1.8e) — исполнение задач: восстановление нужд

Система `TaskEffects` (`every:1`) исполняет ВЫБРАННУЮ задачу у СТОЯЩЕЙ сущности
(`Position.dest===loc`, D-019): EAT/DRINK/SLEEP/REST/FORAGE восстанавливают Needs;
EAT физически расходует еду из инвентаря (закон №3). Замыкает цикл с Needs 1.5
(рост ↔ восстановление). HUNT/FLEE эффекта не дают (мясо → Encounter 1.10).

Место в тик-порядке: **после Movement** (сущность уже у цели), **до Encounters**.

## Зависимости и поток

```mermaid
graph TD
  TE["systems/task-effects.ts<br/>TaskEffects (every:1)"]
  ECS["core/ecs.ts<br/>queryEntities([Human,Alive,Task,Needs])"]
  COMP["core/components.ts<br/>Task.kind · Position.dest/loc · Home.loc · Needs"]
  RES["ResourceStore<br/>inventory (расход еды)"]
  DATA["data/index.ts<br/>getLocation (water/forage) · getItem (nutrition)"]
  BAL["balance/needs.ts<br/>SLEEP/REST/DRINK/FORAGE_RECOVERY_PER_TICK, NEED_MAX"]

  TE --> ECS --> COMP
  TE --> RES
  TE --> DATA
  TE --> BAL

  TE -->|"стоит? dest===loc"| eff{"Task.kind"}
  eff -->|EAT| eat["съесть 1 питательнейшую еду из inventory<br/>hunger -= nutrition; qty-1 (0⇒удалить); resources.set новый массив (закон №3)"]
  eff -->|DRINK| drink["если loc.water: thirst -= DRINK_RECOVERY (из среды)"]
  eff -->|SLEEP| sleep["если loc===Home: fatigue -= SLEEP_RECOVERY"]
  eff -->|REST| rest["везде: fatigue -= REST_RECOVERY (< SLEEP)"]
  eff -->|FORAGE| forage["hunger -= FORAGE_RECOVERY × loc.forage (подножный корм)"]
  eff -->|HUNT/FLEE| none["без эффекта"]
```

## Инварианты

- **Закон №3 (расход, не создание):** EAT списывает еду из инвентаря (новый массив через `resources.set`, без in-place мутации общей ссылки — изоляция 1.3 сохранена). Вода/собирательство — из СРЕДЫ локации (`loc.water`/`loc.forage`), не предмет → №3 не нарушается.
- **Детерминизм (законы №2/№8):** rng не используется; выбор «питательнейшей» еды — обход инвентаря (сорт. по item) со строгим `>` (тай-брейк = первая); клампы `[0, NEED_MAX]`; resume-safe (Needs в SoA + inventory в ResourceStore сериализуются). Обход `queryEntities` сорт. по eid.
- **D-019:** эффект только у стоящих (`dest===loc`); в пути — нет.
- **Событий нет** (осознанно): расход инвентаря и Needs — состояние, читаемое нисходящими через компоненты/ресурсы; событие без подписчика было бы мёртвой поверхностью (летопись «поел» — Фаза 3+).

## Ставки восстановления (balance/needs.ts)
SLEEP 0.15/тик (fatigue 100 ~667 тиков) · REST 0.06/тик (< сна) · DRINK 20/тик (~5 тиков) ·
FORAGE 0.5×loc.forage/тик · EAT = nutrition предмета (canned 45 / bread 25 / meat 35).

## Хвост для balance/behavior (QA HIGH → фикс в TaskSelection)
«Переедание»: плоский `W.food` в score(EAT) (TaskSelection 1.8) делает EAT выбором даже при
`hunger≈0` → сытый в СУХОЙ локации жжёт запас впустую (потеря ресурса, подрыв экономики еды).
Корень — решение (TaskSelection), не исполнение (TaskEffects исполняет Task верно). Фикс:
гейтить привлекательность EAT голодом (не плоское слагаемое). См. отдельную правку TaskSelection.
