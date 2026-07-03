# Death 1.11 — смерть сущности + труп с лутом + ретрофит Needs на lethalCause

Задача 1.11 (Фаза 1). Новая система `@zona/sim/systems/death` (ПОСЛЕДНЯЯ в тике,
B.1) превращает добитого носителя тега `Alive` (`Health.hp <= 0`) в персистентный
ТРУП: снимает `Alive`/`Needs`/`Task`/`Animal`, вешает `Corpse`, оставляет
`Position` + `Health` + `name`/`inventory` (ЛУТ покойника, закон №3) и публикует
`entity/died` (причина наследована из `Health.lethalCause`, D-030) + `corpse/created`.
Ретрофит `Needs` (1.5): при пересечении hunger/thirst критического порога ВВЕРХ
штампует id `needs/threshold` в `Health.lethalCause` — чтобы голодная смерть была
объяснима. Death НЕ создаёт причину — читает её (закон №6). Стрелка A → B = «A
импортирует/зависит от B».

```mermaid
graph TD
  subgraph shared["@zona/shared (чистые типы, закон №5)"]
    ev["events.ts<br/>+ entity/died {eid,name?,cause,killer?}<br/>+ corpse/created {eid,loc,items}"]
  end

  subgraph sim["@zona/sim"]
    needs["systems/needs.ts (РЕТРОФИТ)<br/>при hunger/thirst-пороге ВВЕРХ →<br/>stampCause(Health,'lethalCause',eid,thresholdId)<br/>(только носители Health; fatigue/fear НЕ штампует)"]
    death["systems/death.ts (НОВОЕ, every:1, ПОСЛЕДНЯЯ)<br/>детекция: Alive ∩ hp<=0 (сорт. eid)<br/>снять Alive/Needs/Task/Animal, повесить Corpse<br/>оставить Position/Health/name/inventory<br/>publish entity/died + corpse/created"]
    comps["core/components.ts<br/>Health{hp,lethalCause} · Alive/Corpse/Human теги<br/>Needs · Task · Animal · Position"]
    ecs["core/ecs.ts<br/>queryEntities · hasComponent<br/>removeComponent · addComponent · stampCause"]
    world["core/world.ts<br/>ResourceStore (name+inventory ОСТАЮТСЯ на трупе)"]
    bus["core/events.ts<br/>publish/log (append-only, D-005)"]
  end

  needs --> comps
  needs --> ecs
  needs --> bus
  death --> comps
  death --> ecs
  death --> world
  death --> bus
  death --> ev
  needs --> ev
```

## Причинность смерти — наследование через lethalCause (закон №6, D-030)

```mermaid
graph LR
  subgraph combat["БОЙ (Encounters 1.10b)"]
    es["encounter/started"] --> er["encounter/resolved<br/>stampCause lethalCause=er.id"]
  end
  subgraph hunger["ГОЛОД (Needs 1.5 + ретрофит)"]
    nt["needs/threshold (hunger/thirst)<br/>stampCause lethalCause=nt.id"]
  end
  er -->|"lethalCause"| died["entity/died<br/>causedBy = lethalCause<br/>cause='combat'|'starvation'|'thirst'"]
  nt -->|"lethalCause"| died
  died -->|"causedBy"| corpse["corpse/created<br/>items = inventory трупа"]
```

Метка `cause` выводится РАЗОВО из типа события-причины (committed-лог по id): найдено
`encounter/resolved` → `combat`; `needs/threshold` → `thirst`/`starvation`; id не в
логе (опубликован в ЭТОМ тике — Death последняя, D-005; в Фазе 1 внутритиковый
штамповщик только Encounters) → `combat`; `lethalCause==0` → `unknown`. Связь
`causedBy` авторитетна, метка вторична.

## Resume-безопасность детекции смерти (закон №8, P0)

```mermaid
graph TD
  a["тег Alive + Health.hp<=0"] -->|"Death: обработка"| b["Alive СНЯТ + Corpse повешен"]
  b -->|"serialize / deserialize"| c["Alive снят (сериализовано)<br/>Corpse есть (сериализовано)"]
  c -->|"следующий тик / после load"| d["НЕ в queryEntities([Alive])<br/>⇒ повторного entity/died НЕТ"]
```

Флаг «уже умер» = САМО ОТСУТСТВИЕ тега `Alive` (переживает snapshot), а не
in-memory Set. Прямой аналог prev-детекции порога в Needs. Труп НЕ удаляется
(`destroyEntity`) — персистит с лутом; распад/лутание трупов — будущая фаза.
