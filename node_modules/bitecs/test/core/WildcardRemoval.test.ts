import { describe, test, expect } from "bun:test";
import {
  Pair,
  addComponent,
  addEntity,
  createWorld,
  createRelation,
  hasComponent,
  removeComponent,
  Wildcard,
  getEntityComponents,
  query,
  withStore,
  getRelationTargets,
  World,
  EntityId,
} from "../../src/core";

// Helper function to remove all relations of a specific type from an entity
// This is what we would need since BitECS doesn't natively support wildcard removal like Flecs
const removeAllRelationsOfType = (
  world: World,
  eid: EntityId,
  relation: any,
) => {
  const targets = getRelationTargets(world, eid, relation);
  for (const target of targets) {
    removeComponent(world, eid, relation(target));
  }
};

describe("Wildcard Relation Removal Tests", () => {
  test("BitECS does NOT natively support wildcard removal like Flecs", () => {
    const world = createWorld();
    const Targeting = createRelation();

    const hero = addEntity(world);
    const rat = addEntity(world);
    const goblin = addEntity(world);
    const orc = addEntity(world);

    // Add multiple targeting relations
    addComponent(world, hero, Targeting(rat));
    addComponent(world, hero, Targeting(goblin));
    addComponent(world, hero, Targeting(orc));

    // Verify all relations exist
    expect(hasComponent(world, hero, Targeting(rat))).toBe(true);
    expect(hasComponent(world, hero, Targeting(goblin))).toBe(true);
    expect(hasComponent(world, hero, Targeting(orc))).toBe(true);
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(true);

    // Try to remove all Targeting relations using wildcard (this WON'T work in BitECS)
    removeComponent(world, hero, Targeting(Wildcard));

    // BitECS only removes the specific Wildcard component, not all relations of that type
    expect(hasComponent(world, hero, Targeting(rat))).toBe(true); // Still there!
    expect(hasComponent(world, hero, Targeting(goblin))).toBe(true); // Still there!
    expect(hasComponent(world, hero, Targeting(orc))).toBe(true); // Still there!
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(false); // Only this is removed
  });

  test("Pair(Relation, Wildcard) also doesn't work for wildcard removal", () => {
    const world = createWorld();
    const ChildOf = createRelation();

    const parent1 = addEntity(world);
    const parent2 = addEntity(world);
    const child = addEntity(world);

    // Add multiple parent-child relations
    addComponent(world, child, ChildOf(parent1));
    addComponent(world, child, ChildOf(parent2));

    // Verify relations exist
    expect(hasComponent(world, child, ChildOf(parent1))).toBe(true);
    expect(hasComponent(world, child, ChildOf(parent2))).toBe(true);
    expect(hasComponent(world, child, Pair(ChildOf, Wildcard))).toBe(true);

    // Try to remove all ChildOf relations using Pair syntax (this also WON'T work)
    removeComponent(world, child, Pair(ChildOf, Wildcard));

    // Only the wildcard pair component itself is removed, not the specific relations
    expect(hasComponent(world, child, ChildOf(parent1))).toBe(true); // Still there!
    expect(hasComponent(world, child, ChildOf(parent2))).toBe(true); // Still there!
    expect(hasComponent(world, child, Pair(ChildOf, Wildcard))).toBe(false); // Only this is removed
  });

  test("helper function CAN achieve wildcard removal behavior", () => {
    const world = createWorld();
    const Contains = createRelation({
      store: () => ({
        amount: [] as number[],
      }),
    });

    const inventory = addEntity(world);
    const gold = addEntity(world);
    const silver = addEntity(world);
    const bronze = addEntity(world);

    // Add items with amounts
    addComponent(world, inventory, Contains(gold));
    Contains(gold).amount[inventory] = 100;

    addComponent(world, inventory, Contains(silver));
    Contains(silver).amount[inventory] = 50;

    addComponent(world, inventory, Contains(bronze));
    Contains(bronze).amount[inventory] = 25;

    // Verify data exists
    expect(Contains(gold).amount[inventory]).toBe(100);
    expect(Contains(silver).amount[inventory]).toBe(50);
    expect(Contains(bronze).amount[inventory]).toBe(25);

    // Remove all Contains relations using our helper function
    removeAllRelationsOfType(world, inventory, Contains);

    // Verify all relations are removed
    expect(hasComponent(world, inventory, Contains(gold))).toBe(false);
    expect(hasComponent(world, inventory, Contains(silver))).toBe(false);
    expect(hasComponent(world, inventory, Contains(bronze))).toBe(false);
    expect(hasComponent(world, inventory, Contains(Wildcard))).toBe(false);
  });

  test("helper function vs manual individual removal should be equivalent", () => {
    const world = createWorld();
    const Likes = createRelation();

    // Entity 1: Manual removal
    const person1 = addEntity(world);
    const pizza = addEntity(world);
    const ice_cream = addEntity(world);
    const chocolate = addEntity(world);

    addComponent(world, person1, Likes(pizza));
    addComponent(world, person1, Likes(ice_cream));
    addComponent(world, person1, Likes(chocolate));

    // Entity 2: Wildcard removal
    const person2 = addEntity(world);
    addComponent(world, person2, Likes(pizza));
    addComponent(world, person2, Likes(ice_cream));
    addComponent(world, person2, Likes(chocolate));

    // Manual removal
    removeComponent(world, person1, Likes(pizza));
    removeComponent(world, person1, Likes(ice_cream));
    removeComponent(world, person1, Likes(chocolate));

    // Helper function removal
    removeAllRelationsOfType(world, person2, Likes);

    // Both should have identical results
    expect(hasComponent(world, person1, Likes(Wildcard))).toBe(false);
    expect(hasComponent(world, person2, Likes(Wildcard))).toBe(false);

    expect(hasComponent(world, person1, Likes(pizza))).toBe(false);
    expect(hasComponent(world, person2, Likes(pizza))).toBe(false);

    // Both should have no relation components
    const person1Components = getEntityComponents(world, person1);
    const person2Components = getEntityComponents(world, person2);

    const person1RelationComponents = person1Components.filter(
      (c) => c.$isPairComponent,
    );
    const person2RelationComponents = person2Components.filter(
      (c) => c.$isPairComponent,
    );

    expect(person1RelationComponents.length).toBe(
      person2RelationComponents.length,
    );
  });

  test("should handle exclusive relations with wildcard removal", () => {
    const world = createWorld();
    const Targeting = createRelation({ exclusive: true });

    const hero = addEntity(world);
    const enemy1 = addEntity(world);
    const enemy2 = addEntity(world);

    // Add target (should replace due to exclusive)
    addComponent(world, hero, Targeting(enemy1));
    addComponent(world, hero, Targeting(enemy2)); // This should replace enemy1

    // Verify only latest target exists
    expect(hasComponent(world, hero, Targeting(enemy1))).toBe(false);
    expect(hasComponent(world, hero, Targeting(enemy2))).toBe(true);

    // Remove all targeting using helper function
    removeAllRelationsOfType(world, hero, Targeting);

    // Should remove the exclusive relation
    expect(hasComponent(world, hero, Targeting(enemy2))).toBe(false);
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(false);
  });

  test("helper function handles edge case: removal on entity with no relations", () => {
    const world = createWorld();
    const SomeRelation = createRelation();

    const entity = addEntity(world);

    // Try to remove relations that don't exist using helper function
    expect(() => {
      removeAllRelationsOfType(world, entity, SomeRelation);
    }).not.toThrow();

    // Entity should still exist and be unaffected
    expect(hasComponent(world, entity, SomeRelation(Wildcard))).toBe(false);
  });

  test("should properly clean up wildcard query components", () => {
    const world = createWorld();
    const ConnectedTo = createRelation();

    const node1 = addEntity(world);
    const node2 = addEntity(world);
    const node3 = addEntity(world);

    // Create a network of connections
    addComponent(world, node1, ConnectedTo(node2));
    addComponent(world, node1, ConnectedTo(node3));

    // Query for entities with any ConnectedTo relation
    let allConnected = query(world, [ConnectedTo(Wildcard)]);
    expect(allConnected.length).toBe(1);
    expect(allConnected).toContain(node1);

    // Query for entities that are targets of ConnectedTo relations
    let allTargets = query(world, [Wildcard(node2)]);
    expect(allTargets.length).toBe(1);
    expect(allTargets).toContain(node1);

    // Remove all ConnectedTo relations from node1 using helper function
    removeAllRelationsOfType(world, node1, ConnectedTo);

    // Queries should now return empty results
    allConnected = query(world, [ConnectedTo(Wildcard)]);
    expect(allConnected.length).toBe(0);

    allTargets = query(world, [Wildcard(node2)]);
    expect(allTargets.length).toBe(0);
  });

  test("should handle mixed relation types with wildcard removal", () => {
    const world = createWorld();
    const Likes = createRelation();
    const Owns = createRelation();

    const person = addEntity(world);
    const pizza = addEntity(world);
    const car = addEntity(world);

    // Add different types of relations
    addComponent(world, person, Likes(pizza));
    addComponent(world, person, Owns(car));

    // Remove only Likes relations using helper function
    removeAllRelationsOfType(world, person, Likes);

    // Only Likes should be removed, Owns should remain
    expect(hasComponent(world, person, Likes(pizza))).toBe(false);
    expect(hasComponent(world, person, Likes(Wildcard))).toBe(false);
    expect(hasComponent(world, person, Owns(car))).toBe(true);
    expect(hasComponent(world, person, Owns(Wildcard))).toBe(true);
  });

  test("native BitECS behavior: removing Wildcard component only removes that specific component", () => {
    const world = createWorld();
    const Targeting = createRelation();

    const hero = addEntity(world);
    const rat = addEntity(world);
    const goblin = addEntity(world);

    // Add multiple targeting relations
    addComponent(world, hero, Targeting(rat));
    addComponent(world, hero, Targeting(goblin));

    // The wildcard component is automatically added when we add specific relations
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(true);

    // Remove the wildcard component specifically
    removeComponent(world, hero, Targeting(Wildcard));

    // Only the wildcard component is removed, specific relations remain
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(false);
    expect(hasComponent(world, hero, Targeting(rat))).toBe(true);
    expect(hasComponent(world, hero, Targeting(goblin))).toBe(true);
  });

  test("demonstration: what Flecs-style wildcard removal would look like", () => {
    const world = createWorld();
    const Targeting = createRelation();

    const hero = addEntity(world);
    const rat = addEntity(world);
    const goblin = addEntity(world);
    const orc = addEntity(world);

    addComponent(world, hero, Targeting(rat));
    addComponent(world, hero, Targeting(goblin));
    addComponent(world, hero, Targeting(orc));

    // In Flecs C, this would be: ecs_remove_id(world, hero, ecs_pair(Targeting, EcsWildcard));
    // In BitECS, we need our helper function to achieve the same result
    removeAllRelationsOfType(world, hero, Targeting);

    // All specific relations should be removed (Flecs-like behavior achieved)
    expect(hasComponent(world, hero, Targeting(rat))).toBe(false);
    expect(hasComponent(world, hero, Targeting(goblin))).toBe(false);
    expect(hasComponent(world, hero, Targeting(orc))).toBe(false);
    expect(hasComponent(world, hero, Targeting(Wildcard))).toBe(false);

    // Cleanup on targets should also happen
    expect(hasComponent(world, rat, Wildcard(hero))).toBe(false);
    expect(hasComponent(world, goblin, Wildcard(hero))).toBe(false);
    expect(hasComponent(world, orc, Wildcard(hero))).toBe(false);
  });
});
