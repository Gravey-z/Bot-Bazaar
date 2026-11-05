import { livingTownRecipeIds } from "@bot-bazaar/shared";
import {
  object,
  choice,
  literal,
  bounded,
  parseU64,
  check,
  positiveU64,
} from "../wire.js";
import { livingTownSix } from "./wire.js";

export const livingTownRecipeId = choice(livingTownRecipeIds);
const recipeShape = object({
  recipe_id: livingTownRecipeId,
  version: literal("1"),
  inputs: livingTownSix(bounded(0n, 1000n)),
  output_item: livingTownRecipeId,
  output_per_unit: literal("1"),
  duration_seconds: bounded(1n, 18446744073709551615n),
  max_batch_quantity: literal("10"),
});
export function livingTownRecipe(
  value: unknown,
): ReturnType<typeof recipeShape> {
  const recipe = recipeShape(value),
    potion = recipe.recipe_id === "health_potion";
  const expected = {
    crystal: potion ? "1" : "0",
    wood: potion ? "0" : "1",
    herb: potion ? "2" : "0",
    iron: potion ? "0" : "2",
    health_potion: "0",
    iron_tool: "0",
  };
  check(
    recipe.output_item === recipe.recipe_id &&
      recipe.duration_seconds === (potion ? "120" : "180") &&
      Object.entries(expected).every(
        ([key, n]) => recipe.inputs[key as keyof typeof expected] === n,
      ),
    "Unreviewed recipe version or terms",
  );
  return recipe;
}
const entryShape = object({
  recipe_entry_id: positiveU64,
  recipe: livingTownRecipe,
});
export function livingTownRecipeEntry(
  value: unknown,
): ReturnType<typeof entryShape> {
  const entry = entryShape(value);
  check(
    entry.recipe_entry_id ===
      (entry.recipe.recipe_id === "health_potion" ? "1" : "2"),
    "Recipe entry identity mismatch",
  );
  return entry;
}
const termsShape = object({
  recipe_id: livingTownRecipeId,
  recipe_version: literal("1"),
  config_version: literal("1"),
  quantity: bounded(1n, 10n),
  inputs_consumed: livingTownSix(bounded(0n, 1000n)),
  output_item: livingTownRecipeId,
  output_quantity: bounded(1n, 10n),
  start_at_ns: parseU64,
  ready_at_ns: parseU64,
});
// This previews exact immutable terms; only contract admission may allocate a
// job/slot or consume inputs. Pass chain time, never a browser countdown.
export function planLivingTownProduction(
  recipeValue: unknown,
  configVersion: unknown,
  quantityValue: unknown,
  startValue: unknown,
): ReturnType<typeof termsShape> {
  const recipe = livingTownRecipe(recipeValue),
    config = literal("1")(configVersion),
    quantity = bounded(1n, 10n)(quantityValue),
    start = parseU64(startValue);
  const q = BigInt(quantity),
    max = 18446744073709551615n;
  const duration = q * BigInt(recipe.duration_seconds) * 1_000_000_000n;
  check(
    duration <= max && BigInt(start) + duration <= max,
    "Production time overflow",
  );
  const inputs = livingTownSix(bounded(0n, 1000n))(
    Object.fromEntries(
      Object.entries(recipe.inputs).map(([key, n]) => [
        key,
        (BigInt(n) * q).toString(),
      ]),
    ),
  );
  return Object.freeze({
    recipe_id: recipe.recipe_id,
    recipe_version: recipe.version,
    config_version: config,
    quantity,
    inputs_consumed: Object.freeze(inputs),
    output_item: recipe.output_item,
    output_quantity: bounded(
      1n,
      10n,
    )((q * BigInt(recipe.output_per_unit)).toString()),
    start_at_ns: start,
    ready_at_ns: parseU64((BigInt(start) + duration).toString()),
  });
}
export function livingTownProductionTerms(
  value: unknown,
): ReturnType<typeof termsShape> {
  const terms = termsShape(value),
    potion = terms.recipe_id === "health_potion";
  const expected = planLivingTownProduction(
    {
      recipe_id: terms.recipe_id,
      version: terms.recipe_version,
      inputs: {
        crystal: potion ? "1" : "0",
        wood: potion ? "0" : "1",
        herb: potion ? "2" : "0",
        iron: potion ? "0" : "2",
        health_potion: "0",
        iron_tool: "0",
      },
      output_item: terms.recipe_id,
      output_per_unit: "1",
      duration_seconds: potion ? "120" : "180",
      max_batch_quantity: "10",
    },
    terms.config_version,
    terms.quantity,
    terms.start_at_ns,
  );
  check(
    terms.output_item === expected.output_item &&
      terms.output_quantity === expected.output_quantity &&
      terms.ready_at_ns === expected.ready_at_ns &&
      Object.entries(expected.inputs_consumed).every(
        ([key, n]) =>
          terms.inputs_consumed[key as keyof typeof terms.inputs_consumed] ===
          n,
      ),
    "Production terms mismatch",
  );
  return terms;
}
