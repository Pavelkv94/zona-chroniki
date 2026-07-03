# Needs (1.5) — зависимости и поток

Система Needs — физиология NPC. Для каждого носителя `Needs` копит голод/жажду/
усталость, затухает страх, публикует `needs/threshold` при пересечении критических
порогов и наносит урон истощения в `Health.hp` (только голод/жажда). КОРЕНЬ
причинной цепочки мира (закон №2): растёт из состояния тела, а не по «X% шанс».
Needs НЕ владеет смертью (пишет hp, снятие сущности — Death 1.11) и НЕ
восстанавливает нужды (еда/питьё/сон — TaskSelection 1.8).

## Граф зависимостей

```mermaid
graph TD
  Needs["systems/needs.ts<br/>Needs (every:1)"]
  BAL["balance/needs.ts<br/>*_PER_TICK · *_CRITICAL · *_DAMAGE · NEED_MAX · FEAR_DECAY"]
  NEED["core/components.ts<br/>Needs (hunger,thirst,fatigue,fear)"]
  HP["core/components.ts<br/>Health (hp)"]
  ECS["core/ecs.ts<br/>queryEntities / hasComponent"]
  BUS["core/events.ts (world.bus)<br/>publish"]
  EV["@zona/shared/events.ts<br/>needs/threshold {eid,need,level}"]

  Needs --> BAL
  Needs --> NEED
  Needs --> HP
  Needs --> ECS
  Needs --> BUS
  Needs --> EV
  TS18["TaskSelection 1.8"] -. читает needs/threshold, закрывает нужды .-> BUS
  PER17["Perception 1.7"] -. пишет рост fear, свой порог fear .-> NEED
  DEATH["Death 1.11"] -. читает hp<=0 .-> HP
```

## Поток одного тика (на каждого носителя Needs, сорт. по eid)

```mermaid
flowchart TD
  read["prev = значения нужд (прошлый тик)"]
  read --> accum["hunger/thirst/fatigue += ставка (кламп NEED_MAX)<br/>fear -= FEAR_DECAY (кламп 0)<br/>запись в Needs"]
  accum --> thr{"prev < crit && next >= crit ?<br/>(hunger/thirst/fatigue)"}
  thr -- да --> emit["publish needs/threshold<br/>{eid, need, level:'critical'}<br/>causedBy: null (корень, №2)"]
  thr -- нет --> dmg
  emit --> dmg{"hunger>=HUNGER_CRITICAL<br/>или thirst>=THIRST_CRITICAL ?<br/>и есть Health"}
  dmg -- да --> hurt["hp -= STARVATION (голод)<br/>hp -= DEHYDRATION (жажда)<br/>hp НЕ клампуется снизу"]
  dmg -- нет --> done["конец тика для eid"]
  hurt --> done
```

Детекция «уже сообщено» — без доп. поля: сравнение значения ДО/ПОСЛЕ накопления
(prev = прошлый тик). Пока нужда держится выше порога, prev уже >= crit →
повтора нет; упала ниже и снова выросла → новое пересечение → новое событие.
Усталость даёт порог, но урона не наносит (сон — забота 1.8, не смерть). rng не
используется: физиология здесь чисто арифметическая (закон №2).

## Скорость жизни (стартовый баланс, тюнингует balance-analyst)

1 тик = 1 минута. От нуля до критического порога без закрытия нужды:

| Нужда   | Ставка/тик | Критич. порог | Тиков до критич. | ≈ время      |
|---------|-----------|---------------|------------------|--------------|
| Жажда   | 0.07      | 85            | ~1214            | ~20 ч        |
| Голод   | 0.035     | 80            | ~2286            | ~1.6 сут     |
| Усталость | 0.10    | 90            | ~900             | ~15 ч        |
| Страх   | −0.5 (decay) | —          | 100→0 за ~200    | ~3.3 ч       |

Урон за порогом: голодание 0.02 hp/тик (100 hp ≈ 3.5 сут), обезвоживание
0.04 hp/тик (вдвое быстрее). Смерть эмерджентна, не по таймеру.
