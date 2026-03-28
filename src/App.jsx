import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Pencil, RefreshCw, Unlock, X } from "lucide-react";
import { supabase, supabaseConfigured } from "./supabaseClient.js";

/** Week runs Sunday → Saturday (calendar-aligned). */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const STORAGE_KEY_SAVED_WEEKS = "toddler-menu-planner-saved-weeks-v2";
const STORAGE_KEY_BREAKFAST_STAPLES = "toddler-menu-breakfast-staples-v1";
const STORAGE_KEY_MEAL_FIT = "toddler-menu-meal-fit-v1";
/** Custom catalog rows, full inventory snapshot, history, chip selection — same browser only. */
const STORAGE_KEY_USER_POOL = "toddler-menu-planner-user-pool-v1";

/** Soft nudge: effective meal fit × this is added to pick score (not a ban). */
const MEAL_FIT_WEIGHT = 1.35;
const MEAL_FIT_CLAMP = { min: -3, max: 3 };
/** Editable per meal; applied as soft score nudge only. */
const MEAL_FIT_SELECT_LEVELS = [-3, -2, -1, 0, 1, 2, 3];

function loadBreakfastStaplesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BREAKFAST_STAPLES);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function loadMealFitOverridesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MEAL_FIT);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function startOfWeekSunday(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalDateKey(key) {
  const [y, mo, da] = key.split("-").map(Number);
  if (!y || !mo || !da) return null;
  return new Date(y, mo - 1, da);
}

function addDaysToDateKey(key, deltaDays) {
  const d = parseLocalDateKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + deltaDays);
  return formatLocalDateKey(d);
}

function weekEndKey(weekStartKey) {
  return addDaysToDateKey(weekStartKey, 6);
}

function formatWeekRangeLabel(weekStartKey) {
  const start = parseLocalDateKey(weekStartKey);
  const end = parseLocalDateKey(weekEndKey(weekStartKey));
  if (!start || !end) return weekStartKey;
  const opt = { month: "short", day: "numeric" };
  const yOpt = { ...opt, year: "numeric" };
  const a = start.toLocaleDateString(undefined, start.getFullYear() === end.getFullYear() ? opt : yOpt);
  const b = end.toLocaleDateString(undefined, yOpt);
  return `${a} – ${b}`;
}

function formatRowDateLabel(weekStartKey, dayIndex) {
  const start = parseLocalDateKey(weekStartKey);
  if (!start) return "";
  const d = new Date(start);
  d.setDate(d.getDate() + dayIndex);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function loadSavedWeeksFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SAVED_WEEKS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const MEALS = ["Breakfast", "Lunch", "Dinner"];

const PRIORITY_CLAMP = { min: -5, max: 5 };
const PRIORITY_SCORE_WEIGHT = 2;
/** Auto-plan never assigns more than this many foods to one cell (manual picks should stay within this too). */
const MAX_FOODS_PER_CELL = 6;

/** Exactly one per food. Stored on each item as `category` (id slug). */
const FOOD_CATEGORIES = [
  { id: "fruits", label: "Fruits" },
  { id: "vegetables", label: "Vegetables" },
  { id: "grains", label: "Grains" },
  { id: "protein", label: "Protein" },
  { id: "dairy", label: "Dairy" },
  { id: "sweets", label: "Sweets" },
  { id: "misc", label: "Misc." },
];

const FOOD_CATEGORY_IDS = FOOD_CATEGORIES.map((c) => c.id);

function foodCategoryLabel(categoryId) {
  return FOOD_CATEGORIES.find((c) => c.id === categoryId)?.label ?? categoryId ?? "Misc.";
}

function normalizeFoodCategory(categoryId) {
  return FOOD_CATEGORY_IDS.includes(categoryId) ? categoryId : "misc";
}

/** FOOD_CATEGORIES order; omits categories with no items. */
function groupCatalogByCategoryOrdered(items) {
  const byId = Object.fromEntries(FOOD_CATEGORY_IDS.map((id) => [id, []]));
  for (const item of items) {
    const cat = normalizeFoodCategory(item.category);
    (byId[cat] ?? byId.misc).push(item);
  }
  return FOOD_CATEGORIES.map((c) => ({ category: c, items: byId[c.id] })).filter((col) => col.items.length > 0);
}

/** Lunch/dinner: aim for produce + grain + (protein or dairy); sweets/misc fill only after anchors or if a bucket is missing. */
function macroBucketForFood(item) {
  const c = normalizeFoodCategory(item.category);
  if (c === "fruits" || c === "vegetables") return "produce";
  if (c === "grains") return "grain";
  if (c === "protein" || c === "dairy") return "proteinDairy";
  return "other";
}

function pickLunchDinnerComposed(entries, usage, dayIndex, mealIndex, mealName, mealFitOverrides, count) {
  const ranked = rankEntriesForMeal(entries, usage, dayIndex, mealIndex, mealName, mealFitOverrides);
  const picks = [];
  const used = new Set();

  function takeFirst(predicate) {
    for (const e of ranked) {
      if (used.has(e.item.id)) continue;
      if (predicate(e.item)) {
        picks.push(e);
        used.add(e.item.id);
        return;
      }
    }
  }

  takeFirst((item) => macroBucketForFood(item) === "produce");
  takeFirst((item) => macroBucketForFood(item) === "grain");
  takeFirst((item) => macroBucketForFood(item) === "proteinDairy");

  for (const e of ranked) {
    if (picks.length >= count) break;
    if (used.has(e.item.id)) continue;
    picks.push(e);
    used.add(e.item.id);
  }

  return picks.slice(0, count);
}

const DEFAULT_CATALOG = [
  { id: "banana", name: "Banana", category: "fruits", perishability: 4, toddlerFriendly: 5 },
  { id: "blueberries", name: "Blueberries", category: "fruits", perishability: 4, toddlerFriendly: 5 },
  { id: "grapes", name: "Grapes", category: "fruits", perishability: 4, toddlerFriendly: 4 },
  { id: "cherry-tomatoes", name: "Cherry Tomatoes", category: "vegetables", perishability: 5, toddlerFriendly: 4 },
  { id: "cucumber", name: "Cucumber", category: "vegetables", perishability: 4, toddlerFriendly: 4 },
  { id: "cottage-cheese", name: "Cottage Cheese", category: "dairy", perishability: 5, toddlerFriendly: 4 },
  { id: "tofu", name: "Tofu", category: "protein", perishability: 4, toddlerFriendly: 3 },
  { id: "hummus", name: "Hummus", category: "protein", perishability: 4, toddlerFriendly: 4 },
  { id: "pita", name: "Pita Bread", category: "grains", perishability: 3, toddlerFriendly: 4 },
  { id: "pasta", name: "Pasta", category: "grains", perishability: 1, toddlerFriendly: 5 },
  { id: "peas", name: "Frozen Peas", category: "vegetables", perishability: 1, toddlerFriendly: 5 },
  { id: "broccoli", name: "Frozen Broccoli", category: "vegetables", perishability: 1, toddlerFriendly: 3 },
  { id: "beans", name: "Black Beans", category: "protein", perishability: 1, toddlerFriendly: 4 },
  { id: "mozzerella", name: "Fresh Mozzarella", category: "dairy", perishability: 5, toddlerFriendly: 4 },
  { id: "bread", name: "Whole Grain Bread", category: "grains", perishability: 3, toddlerFriendly: 5 },
];

const DEFAULT_INVENTORY = [
  { itemId: "banana", quantity: 6, zone: "fridge", daysLeft: 4 },
  { itemId: "blueberries", quantity: 1, zone: "fridge", daysLeft: 3 },
  { itemId: "grapes", quantity: 1, zone: "fridge", daysLeft: 3 },
  { itemId: "cherry-tomatoes", quantity: 1, zone: "fridge", daysLeft: 2 },
  { itemId: "cucumber", quantity: 1, zone: "fridge", daysLeft: 4 },
  { itemId: "cottage-cheese", quantity: 1, zone: "fridge", daysLeft: 5 },
  { itemId: "hummus", quantity: 1, zone: "fridge", daysLeft: 4 },
  { itemId: "tofu", quantity: 1, zone: "fridge", daysLeft: 4 },
  { itemId: "pita", quantity: 1, zone: "pantry", daysLeft: 5 },
  { itemId: "pasta", quantity: 1, zone: "pantry", daysLeft: 30 },
  { itemId: "peas", quantity: 1, zone: "freezer", daysLeft: 60 },
  { itemId: "broccoli", quantity: 1, zone: "freezer", daysLeft: 60 },
  { itemId: "beans", quantity: 2, zone: "pantry", daysLeft: 60 },
  { itemId: "mozzerella", quantity: 1, zone: "fridge", daysLeft: 4 },
  { itemId: "bread", quantity: 1, zone: "pantry", daysLeft: 5 },
];

const DEFAULT_HISTORY = {
  banana: 2,
  blueberries: 5,
  grapes: 10,
  "cherry-tomatoes": 8,
  cucumber: 14,
  "cottage-cheese": 7,
  tofu: 21,
  hummus: 6,
  pita: 10,
  pasta: 4,
  peas: 3,
  broccoli: 12,
  beans: 11,
  mozzerella: 15,
  bread: 2,
};

const DEFAULT_CATALOG_IDS = () => new Set(DEFAULT_CATALOG.map((c) => c.id));

function mergeInventoryForCatalog(catalog, persistedInventory) {
  const defaultById = new Map(DEFAULT_INVENTORY.map((r) => [r.itemId, { ...r }]));
  const savedById = new Map();
  if (Array.isArray(persistedInventory)) {
    for (const r of persistedInventory) {
      if (r && typeof r.itemId === "string") savedById.set(r.itemId, r);
    }
  }
  return catalog.map(
    (c) =>
      savedById.get(c.id) ??
      defaultById.get(c.id) ?? {
        itemId: c.id,
        quantity: 1,
        zone: "fridge",
        daysLeft: 5,
      }
  );
}

/** Build pool state from persisted JSON (localStorage shape or Supabase `user_pool`). */
function mergeUserPoolFromPersisted(parsed) {
  let p = parsed;
  if (!p || typeof p !== "object") p = {};
  const defaultIds = DEFAULT_CATALOG_IDS();
  const rawExtra = Array.isArray(p.catalogExtra) ? p.catalogExtra : [];
  const catalogExtra = rawExtra
    .filter((c) => c && typeof c.id === "string" && !defaultIds.has(c.id))
    .map((c) => ({
      ...c,
      category: normalizeFoodCategory(c.category),
    }));
  const catalog = [...DEFAULT_CATALOG, ...catalogExtra];
  const inventory = mergeInventoryForCatalog(catalog, p.inventory);
  const history = {
    ...DEFAULT_HISTORY,
    ...(p.history && typeof p.history === "object" ? p.history : {}),
  };
  const catalogIdSet = new Set(catalog.map((c) => c.id));
  const selectedIds =
    Array.isArray(p.selectedIds) && p.selectedIds.length > 0
      ? [...new Set(p.selectedIds.filter((id) => catalogIdSet.has(id)))]
      : DEFAULT_INVENTORY.map((i) => i.itemId);
  return { catalog, inventory, history, selectedIds };
}

function loadUserPoolFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER_POOL);
    const parsed = raw ? JSON.parse(raw) : null;
    return mergeUserPoolFromPersisted(parsed);
  } catch {
    return mergeUserPoolFromPersisted(null);
  }
}

function readLocalStoragePlannerSeed() {
  let userPool = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER_POOL);
    if (raw) userPool = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {
    savedWeeks: loadSavedWeeksFromStorage(),
    userPool,
    breakfastStapleIds: loadBreakfastStaplesFromStorage(),
    mealFitOverrides: loadMealFitOverridesFromStorage(),
  };
}

/** Checked foods first (in checkbox order), then the rest of the pool. */
function catalogOrderedForOverrideModal(selectedCatalog, manualFoodIds) {
  const pickedSet = new Set(manualFoodIds);
  const pickedOrdered = manualFoodIds
    .map((id) => selectedCatalog.find((c) => c.id === id))
    .filter(Boolean);
  const rest = selectedCatalog.filter((c) => !pickedSet.has(c.id));
  return [...pickedOrdered, ...rest];
}

let cachedInitialPool = null;
function initialPoolState() {
  if (!cachedInitialPool) cachedInitialPool = loadUserPoolFromStorage();
  return cachedInitialPool;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function scoreFood(catalogItem, inventoryItem, daysSinceServed) {
  const spoilUrgency = clamp(8 - (inventoryItem?.daysLeft ?? 30), 0, 8);
  const notServedRecently = clamp((daysSinceServed ?? 14) / 2, 0, 10);
  const toddlerFriendly = catalogItem.toddlerFriendly ?? 3;
  const quantityBonus = clamp(inventoryItem?.quantity ?? 0, 0, 3);
  const score = spoilUrgency * 2.2 + notServedRecently * 1.5 + toddlerFriendly * 1.2 + quantityBonus;
  return Math.round(score * 10) / 10;
}

function buildMealLabel(selectedCatalogItems) {
  if (selectedCatalogItems.length === 0) return "No foods selected";
  return selectedCatalogItems.map((i) => i.name).join(" · ");
}

function slugIdFromFoodName(rawName) {
  return rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Remap ids in slots and rebuild labels from `catalogAfter` (name/category changes). */
function remapWeekPlanFoodIdsAndLabels(weekPlan, idMap, catalogAfter) {
  const remap = Object.keys(idMap).length > 0;
  return weekPlan.map((row) => ({
    ...row,
    meals: Object.fromEntries(
      MEALS.map((meal) => {
        const slot = row.meals[meal];
        let foodIds = [...(slot.foodIds ?? [])];
        if (remap) foodIds = foodIds.map((id) => idMap[id] ?? id);
        const items = foodIds.map((id) => catalogAfter.find((c) => c.id === id)).filter(Boolean);
        const label = items.length ? buildMealLabel(items) : slot.label;
        return [meal, { ...slot, foodIds, label }];
      })
    ),
  }));
}

function mealSlotTargetCount(meal, dayIndex) {
  const target = meal === "Breakfast" ? 2 + (dayIndex % 2) : 4;
  return clamp(target, 0, MAX_FOODS_PER_CELL);
}

function emptyMealsShape() {
  return Object.fromEntries(
    MEALS.map((meal) => [
      meal,
      { foodIds: [], label: "No foods selected", overridden: false, locked: false },
    ])
  );
}

function copyLockedSlot(prevSlot) {
  return {
    foodIds: [...(prevSlot.foodIds ?? [])],
    label: prevSlot.label ?? "No foods selected",
    overridden: prevSlot.overridden ?? false,
    locked: true,
  };
}

function buildAvailableEntries(selectedIds, catalog, inventory, history, priorityBoost) {
  return selectedIds
    .map((id) => {
      const item = catalog.find((c) => c.id === id);
      const inv = inventory.find((i) => i.itemId === id);
      if (!item || !inv) return null;
      const base = scoreFood(item, inv, history[id] ?? 14);
      const boost = (priorityBoost[id] ?? 0) * PRIORITY_SCORE_WEIGHT;
      return { item, inv, score: base + boost };
    })
    .filter(Boolean);
}

function effectiveMealFit(mealFitOverrides, item, mealName) {
  const fromOverride = mealFitOverrides[item.id]?.[mealName];
  if (typeof fromOverride === "number" && !Number.isNaN(fromOverride)) {
    return clamp(Math.round(fromOverride), MEAL_FIT_CLAMP.min, MEAL_FIT_CLAMP.max);
  }
  const fromItem = item.mealFit?.[mealName];
  if (typeof fromItem === "number" && !Number.isNaN(fromItem)) {
    return clamp(Math.round(fromItem), MEAL_FIT_CLAMP.min, MEAL_FIT_CLAMP.max);
  }
  return 0;
}

function adjustedPickScore(entry, usage, dayIndex, mealIndex, mealName, mealFitOverrides) {
  const mealFitBonus = effectiveMealFit(mealFitOverrides, entry.item, mealName) * MEAL_FIT_WEIGHT;
  return (
    entry.score +
    mealFitBonus -
    (usage[entry.item.id] ?? 0) * 3 -
    dayIndex * 0.12 -
    mealIndex * 0.04
  );
}

function rankEntriesForMeal(entries, usage, dayIndex, mealIndex, mealName, mealFitOverrides) {
  return [...entries]
    .map((entry) => ({
      ...entry,
      adjusted: adjustedPickScore(entry, usage, dayIndex, mealIndex, mealName, mealFitOverrides),
    }))
    .sort((a, b) => b.adjusted - a.adjusted);
}

function rankAndPick(entries, usage, dayIndex, mealIndex, count, mealName, mealFitOverrides) {
  return rankEntriesForMeal(entries, usage, dayIndex, mealIndex, mealName, mealFitOverrides).slice(0, count);
}

/** Staples first (in order, when available in pool), then fill with ranked picks. */
function pickBreakfastPicks(stapleIds, count, entries, usage, dayIndex, mealFitOverrides) {
  const mealName = "Breakfast";
  const mealIndex = MEALS.indexOf(mealName);
  const byId = Object.fromEntries(entries.map((e) => [e.item.id, e]));
  const picked = [];
  for (const id of stapleIds) {
    if (picked.length >= count) break;
    const e = byId[id];
    if (e) picked.push(e);
  }
  const need = count - picked.length;
  if (need > 0) {
    const used = new Set(picked.map((p) => p.item.id));
    const rest = entries.filter((e) => !used.has(e.item.id));
    const more = rankAndPick(rest, usage, dayIndex, mealIndex, need, mealName, mealFitOverrides);
    picked.push(...more);
  }
  return picked;
}

function applyPicksToUsage(picks, usage) {
  const next = { ...usage };
  picks.forEach((p) => {
    next[p.item.id] = (next[p.item.id] ?? 0) + 1;
  });
  return next;
}

function countUsageFromPlan(weekPlan, skipDay, skipMeal) {
  const usage = {};
  for (const row of weekPlan) {
    for (const meal of MEALS) {
      if (row.day === skipDay && meal === skipMeal) continue;
      const ids = row.meals[meal]?.foodIds ?? [];
      ids.forEach((id) => {
        usage[id] = (usage[id] ?? 0) + 1;
      });
    }
  }
  return usage;
}

function createWeeklyPlan({
  selectedIds,
  catalog,
  inventory,
  history,
  priorityBoost = {},
  breakfastStapleIds = [],
  mealFitOverrides = {},
  previousPlan = null,
}) {
  const entries = buildAvailableEntries(selectedIds, catalog, inventory, history, priorityBoost);
  let usage = {};
  return DAYS.map((day, dayIndex) => {
    const prevRow = previousPlan?.find((r) => r.day === day);
    const meals = { ...emptyMealsShape() };
    MEALS.forEach((meal, mealIndex) => {
      const prevSlot = prevRow?.meals?.[meal];
      if (prevSlot?.locked) {
        const fakePicks = (prevSlot.foodIds ?? []).map((id) => ({ item: { id } }));
        usage = applyPicksToUsage(fakePicks, usage);
        meals[meal] = copyLockedSlot(prevSlot);
        return;
      }
      const count = mealSlotTargetCount(meal, dayIndex);
      const picks =
        meal === "Breakfast" && breakfastStapleIds.length > 0
          ? pickBreakfastPicks(breakfastStapleIds, count, entries, usage, dayIndex, mealFitOverrides)
          : meal === "Lunch" || meal === "Dinner"
            ? pickLunchDinnerComposed(entries, usage, dayIndex, mealIndex, meal, mealFitOverrides, count)
            : rankAndPick(entries, usage, dayIndex, mealIndex, count, meal, mealFitOverrides);
      usage = applyPicksToUsage(picks, usage);
      meals[meal] = {
        foodIds: picks.map((p) => p.item.id),
        label: buildMealLabel(picks.map((p) => p.item)),
        overridden: false,
        locked: false,
      };
    });
    return { day, meals };
  });
}

function regenerateSlot(
  weekPlan,
  skipDay,
  skipMeal,
  selectedIds,
  catalog,
  inventory,
  history,
  priorityBoost,
  breakfastStapleIds,
  mealFitOverrides
) {
  const row = weekPlan.find((r) => r.day === skipDay);
  if (row?.meals?.[skipMeal]?.locked) return weekPlan;

  const usage = countUsageFromPlan(weekPlan, skipDay, skipMeal);
  const entries = buildAvailableEntries(selectedIds, catalog, inventory, history, priorityBoost);
  const dayIndex = DAYS.indexOf(skipDay);
  const mealIndex = MEALS.indexOf(skipMeal);
  const count = mealSlotTargetCount(skipMeal, Math.max(0, dayIndex));
  const picks =
    skipMeal === "Breakfast" && breakfastStapleIds.length > 0
      ? pickBreakfastPicks(breakfastStapleIds, count, entries, usage, dayIndex, mealFitOverrides)
      : skipMeal === "Lunch" || skipMeal === "Dinner"
        ? pickLunchDinnerComposed(
            entries,
            usage,
            Math.max(0, dayIndex),
            Math.max(0, mealIndex),
            skipMeal,
            mealFitOverrides,
            count
          )
        : rankAndPick(
            entries,
            usage,
            Math.max(0, dayIndex),
            Math.max(0, mealIndex),
            count,
            skipMeal,
            mealFitOverrides
          );
  return weekPlan.map((row) =>
    row.day === skipDay
      ? {
          ...row,
          meals: {
            ...row.meals,
            [skipMeal]: {
              foodIds: picks.map((p) => p.item.id),
              label: buildMealLabel(picks.map((p) => p.item)),
              overridden: false,
              locked: false,
            },
          },
        }
      : row
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "var(--color-neutral-50)",
    padding: "16px 0",
    fontFamily: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
    color: "var(--color-default-font)",
  },
  container: {
    width: "100%",
    maxWidth: "none",
    margin: 0,
    padding: 0,
    boxSizing: "border-box",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
    flexWrap: "wrap",
  },
  topBarUser: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
    fontSize: "13px",
    color: "var(--color-subtext-color)",
  },
  authPanel: {
    maxWidth: "400px",
    margin: "48px auto",
    padding: "28px",
    background: "var(--color-neutral-0)",
    borderRadius: "20px",
    border: "1px solid var(--color-neutral-200)",
    boxShadow: "var(--shadow-tm-lg)",
  },
  authTitle: {
    margin: "0 0 8px",
    fontSize: "22px",
    fontWeight: 600,
    fontFamily: "var(--font-heading-2), ui-sans-serif, system-ui, sans-serif",
    color: "var(--color-default-font)",
    letterSpacing: "-0.02em",
  },
  authSubtitle: {
    margin: "0 0 20px",
    fontSize: "14px",
    color: "var(--color-subtext-color)",
    lineHeight: 1.5,
  },
  authLabel: {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--color-neutral-600)",
    marginBottom: "6px",
  },
  authInput: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--color-neutral-300)",
    borderRadius: "12px",
    padding: "10px 12px",
    fontSize: "15px",
    marginBottom: "14px",
    color: "var(--color-default-font)",
  },
  authError: {
    fontSize: "13px",
    color: "var(--color-error-600)",
    marginBottom: "12px",
  },
  authRow: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: "8px",
  },
  weekNav: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    marginBottom: "12px",
  },
  weekNavBtn: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "10px",
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: "13px",
    color: "var(--color-default-font)",
  },
  weekNavBtnActive: {
    border: "1px solid var(--color-brand-700)",
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
  },
  matrixRowDate: {
    display: "block",
    fontSize: "10px",
    fontWeight: 500,
    color: "var(--color-subtext-color)",
    marginTop: "4px",
  },
  button: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "14px",
    padding: "10px 14px",
    cursor: "pointer",
    fontSize: "14px",
  },
  buttonPrimary: {
    border: "1px solid var(--color-brand-700)",
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
    borderRadius: "14px",
    padding: "10px 14px",
    cursor: "pointer",
    fontSize: "14px",
  },
  tabs: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  tab: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "999px",
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: "14px",
  },
  tabActive: {
    border: "1px solid var(--color-brand-700)",
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
    borderRadius: "999px",
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: "14px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "24px",
  },
  menuMatrixWrap: {
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
  },
  menuMatrix: {
    display: "grid",
    gridTemplateColumns: "minmax(52px, 72px) repeat(3, minmax(0, 1fr))",
    gap: "1px",
    background: "var(--color-neutral-200)",
    border: "1px solid var(--color-neutral-200)",
    borderRadius: "16px",
    overflow: "hidden",
    width: "100%",
  },
  matrixCorner: {
    background: "var(--color-neutral-100)",
    padding: "8px 6px",
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color-subtext-color)",
    textAlign: "center",
  },
  matrixColHead: {
    background: "var(--color-neutral-100)",
    padding: "10px 12px",
    fontSize: "13px",
    fontWeight: 700,
    color: "var(--color-default-font)",
    textAlign: "center",
  },
  matrixRowHead: {
    background: "var(--color-neutral-50)",
    padding: "8px 6px",
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--color-default-font)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    lineHeight: 1.2,
    hyphens: "auto",
    overflowWrap: "break-word",
  },
  matrixCell: {
    background: "var(--color-neutral-0)",
    padding: "10px 12px",
    minHeight: "120px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    justifyContent: "space-between",
  },
  matrixFoodList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  matrixFoodItem: {
    fontSize: "12px",
    lineHeight: 1.35,
    fontWeight: 500,
    color: "var(--color-default-font)",
    padding: "4px 8px",
    background: "var(--color-neutral-50)",
    borderRadius: "8px",
    border: "1px solid var(--color-neutral-200)",
  },
  matrixFoodEmpty: {
    fontSize: "12px",
    color: "var(--color-neutral-400)",
    fontStyle: "italic",
    margin: 0,
  },
  matrixCellMeta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "4px",
  },
  matrixCellActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    alignItems: "center",
  },
  matrixIconBtn: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "8px",
    width: "32px",
    height: "32px",
    padding: 0,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--color-neutral-600)",
    flexShrink: 0,
  },
  matrixIconBtnMuted: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.45)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
    boxSizing: "border-box",
  },
  modalPanel: {
    background: "var(--color-neutral-0)",
    borderRadius: "20px",
    maxWidth: "480px",
    width: "100%",
    boxShadow: "var(--shadow-tm-lg)",
    padding: "22px",
    position: "relative",
  },
  modalFoodList: {
    maxHeight: "min(50vh, 320px)",
    overflowY: "auto",
    border: "1px solid var(--color-neutral-200)",
    borderRadius: "14px",
    padding: "8px",
    marginBottom: "16px",
    background: "var(--color-neutral-50)",
  },
  modalFoodRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    borderRadius: "10px",
    cursor: "pointer",
    fontSize: "14px",
    color: "var(--color-default-font)",
  },
  modalFoodRowDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  modalTitle: {
    margin: "0 0 6px",
    fontSize: "18px",
    fontWeight: 600,
    fontFamily: "var(--font-heading-3), ui-sans-serif, system-ui, sans-serif",
    color: "var(--color-default-font)",
    paddingRight: "36px",
  },
  modalSubtitle: {
    margin: "0 0 16px",
    fontSize: "14px",
    color: "var(--color-subtext-color)",
    lineHeight: 1.4,
  },
  modalCloseBtn: {
    position: "absolute",
    top: "14px",
    right: "14px",
    width: "36px",
    height: "36px",
    border: "none",
    background: "var(--color-neutral-100)",
    borderRadius: "10px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--color-neutral-600)",
  },
  chipPill: {
    display: "inline-flex",
    alignItems: "stretch",
    width: "max-content",
    maxWidth: "100%",
    boxSizing: "border-box",
    borderRadius: "999px",
    border: "1px solid var(--color-neutral-300)",
    overflow: "hidden",
    fontSize: "14px",
  },
  chipPillInPool: {
    borderColor: "var(--color-brand-700)",
  },
  chipPillEnd: {
    border: "none",
    margin: 0,
    padding: "0 12px",
    cursor: "pointer",
    background: "var(--color-neutral-0)",
    color: "var(--color-default-font)",
    fontSize: "17px",
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chipPillEndInPool: {
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
  },
  chipPillCenter: {
    border: "none",
    borderLeft: "1px solid var(--color-neutral-200)",
    borderRight: "1px solid var(--color-neutral-200)",
    margin: 0,
    padding: "8px 12px",
    cursor: "pointer",
    background: "var(--color-neutral-0)",
    color: "var(--color-default-font)",
    fontSize: "14px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    textAlign: "left",
    whiteSpace: "nowrap",
    minWidth: 0,
    maxWidth: "100%",
  },
  chipPillCenterLabel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  chipPillCenterInPool: {
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
    borderLeftColor: "rgba(255, 255, 255, 0.25)",
    borderRightColor: "rgba(255, 255, 255, 0.25)",
  },
  chipPillPriorityHint: {
    fontSize: "12px",
    fontWeight: 600,
    opacity: 0.88,
    flexShrink: 0,
  },
  card: {
    background: "var(--color-neutral-0)",
    borderRadius: "24px",
    padding: "20px",
    border: "1px solid var(--color-neutral-border)",
    boxShadow: "var(--shadow-tm-md)",
  },
  cardTitle: {
    marginTop: 0,
    marginBottom: "16px",
    fontSize: "20px",
    fontWeight: 600,
    fontFamily: "var(--font-heading-2), ui-sans-serif, system-ui, sans-serif",
    color: "var(--color-default-font)",
    letterSpacing: "-0.02em",
    lineHeight: 1.25,
  },
  inputRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "16px",
  },
  input: {
    width: "100%",
    border: "1px solid var(--color-neutral-300)",
    borderRadius: "14px",
    padding: "10px 12px",
    fontSize: "14px",
    color: "var(--color-default-font)",
    background: "var(--color-neutral-0)",
  },
  chip: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "999px",
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: "14px",
  },
  chipSelected: {
    border: "1px solid var(--color-brand-700)",
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
    borderRadius: "999px",
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: "14px",
  },
  chipRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "flex-start",
    gap: "8px",
  },
  poolCategoryGrid: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: "16px",
    alignItems: "flex-start",
    width: "100%",
    boxSizing: "border-box",
  },
  poolCategoryColumn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
    maxWidth: "100%",
  },
  poolCategoryHeading: {
    fontSize: "11px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color-subtext-color)",
    margin: 0,
    paddingBottom: "2px",
    borderBottom: "1px solid var(--color-neutral-200)",
    alignSelf: "stretch",
  },
  chipColumnStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
  },
  chipListColumn: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    maxHeight: "420px",
    overflowY: "auto",
  },
  sectionLabel: {
    margin: "0 0 8px",
    fontSize: "14px",
    color: "var(--color-neutral-700)",
    fontWeight: 600,
  },
  smallText: {
    margin: 0,
    fontSize: "14px",
    color: "var(--color-neutral-600)",
  },
  badge: {
    display: "inline-block",
    fontSize: "12px",
    background: "var(--color-brand-100)",
    color: "var(--color-brand-900)",
    borderRadius: "999px",
    padding: "4px 8px",
    marginLeft: "8px",
  },
  select: {
    width: "100%",
    border: "1px solid var(--color-neutral-300)",
    borderRadius: "14px",
    padding: "10px 12px",
    fontSize: "14px",
    background: "var(--color-neutral-0)",
    marginBottom: "10px",
  },
  textArea: {
    width: "100%",
    minHeight: "120px",
    border: "1px solid var(--color-neutral-300)",
    borderRadius: "14px",
    padding: "10px 12px",
    fontSize: "14px",
    color: "var(--color-default-font)",
    resize: "vertical",
    marginBottom: "10px",
  },
  scoreRow: {
    border: "1px solid var(--color-neutral-200)",
    borderRadius: "18px",
    padding: "14px",
    marginBottom: "12px",
  },
  stapleOrderBtn: {
    border: "1px solid var(--color-neutral-300)",
    background: "var(--color-neutral-0)",
    borderRadius: "8px",
    width: "32px",
    height: "28px",
    padding: 0,
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: 1,
  },
  mealFitSelect: {
    width: "100%",
    maxWidth: "72px",
    border: "1px solid var(--color-neutral-300)",
    borderRadius: "8px",
    padding: "4px 6px",
    fontSize: "12px",
    background: "var(--color-neutral-0)",
  },
  mealFitEditBtn: {
    border: "none",
    background: "var(--color-neutral-100)",
    borderRadius: "8px",
    width: "30px",
    height: "28px",
    padding: 0,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--color-neutral-600)",
  },
  chipPillEditBtn: {
    border: "none",
    borderLeft: "1px solid var(--color-neutral-200)",
    margin: 0,
    padding: "0 8px",
    cursor: "pointer",
    background: "var(--color-neutral-0)",
    color: "var(--color-neutral-600)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chipPillEditBtnInPool: {
    background: "var(--color-brand-700)",
    color: "var(--color-neutral-0)",
    borderLeftColor: "rgba(255, 255, 255, 0.25)",
  },
};

function TabButton({ active, children, onClick }) {
  return (
    <button onClick={onClick} style={active ? styles.tabActive : styles.tab}>
      {children}
    </button>
  );
}

export default function ToddlerMenuPlannerPrototype() {
  const [catalog, setCatalog] = useState(() => initialPoolState().catalog);
  const [inventory, setInventory] = useState(() => initialPoolState().inventory);
  const [history, setHistory] = useState(() => initialPoolState().history);
  const [selectedIds, setSelectedIds] = useState(() => initialPoolState().selectedIds);
  const [priorityBoost, setPriorityBoost] = useState({});
  const [breakfastStapleIds, setBreakfastStapleIds] = useState(() => loadBreakfastStaplesFromStorage());
  const [mealFitOverrides, setMealFitOverrides] = useState(() => loadMealFitOverridesFromStorage());
  const [savedWeeks, setSavedWeeks] = useState(() => loadSavedWeeksFromStorage());
  const [activeWeekStartKey, setActiveWeekStartKey] = useState(() =>
    formatLocalDateKey(startOfWeekSunday(new Date()))
  );
  const [weekPlan, setWeekPlan] = useState(() => {
    const pool = initialPoolState();
    const weekKey = formatLocalDateKey(startOfWeekSunday(new Date()));
    const saved = loadSavedWeeksFromStorage();
    const entry = saved[weekKey];
    if (entry?.weekPlan?.length === DAYS.length) return entry.weekPlan;
    return createWeeklyPlan({
      selectedIds: pool.selectedIds,
      catalog: pool.catalog,
      inventory: pool.inventory,
      history: pool.history,
      priorityBoost: {},
      breakfastStapleIds: loadBreakfastStaplesFromStorage(),
      mealFitOverrides: loadMealFitOverridesFromStorage(),
    });
  });
  const [draftFood, setDraftFood] = useState("");
  const [draftFoodCategory, setDraftFoodCategory] = useState("misc");
  const [manualSlot, setManualSlot] = useState(null);
  /** Meal override: ordered food ids from pool, max MAX_FOODS_PER_CELL */
  const [manualFoodIds, setManualFoodIds] = useState([]);
  const [editFoodId, setEditFoodId] = useState(null);
  const [editFoodName, setEditFoodName] = useState("");
  const [editFoodCategory, setEditFoodCategory] = useState("misc");
  const [editFoodError, setEditFoodError] = useState("");
  const [successNote, setSuccessNote] = useState(() => {
    const weekKey = formatLocalDateKey(startOfWeekSunday(new Date()));
    const saved = loadSavedWeeksFromStorage();
    return saved[weekKey]?.reflectionNote ?? "";
  });
  const [activeTab, setActiveTab] = useState("planner");

  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [cloudSyncReady, setCloudSyncReady] = useState(!supabaseConfigured);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authFormError, setAuthFormError] = useState("");
  const [cloudLoadError, setCloudLoadError] = useState("");

  const persistCurrentWeekSnapshot = useCallback(() => {
    setSavedWeeks((prev) => ({
      ...prev,
      [activeWeekStartKey]: {
        weekPlan,
        reflectionNote: successNote,
        updatedAt: new Date().toISOString(),
      },
    }));
  }, [activeWeekStartKey, weekPlan, successNote]);

  const navigateToWeek = useCallback(
    (newKey) => {
      if (newKey === activeWeekStartKey) return;
      setSavedWeeks((prev) => {
        const flushed = {
          ...prev,
          [activeWeekStartKey]: {
            weekPlan,
            reflectionNote: successNote,
            updatedAt: new Date().toISOString(),
          },
        };
        const load = flushed[newKey];
        const nextPlan =
          load?.weekPlan?.length === DAYS.length
            ? load.weekPlan
            : createWeeklyPlan({
                selectedIds,
                catalog,
                inventory,
                history,
                priorityBoost,
                breakfastStapleIds,
                mealFitOverrides,
              });
        Promise.resolve().then(() => {
          setWeekPlan(nextPlan);
          setSuccessNote(load?.reflectionNote ?? "");
          setActiveWeekStartKey(newKey);
        });
        try {
          localStorage.setItem(STORAGE_KEY_SAVED_WEEKS, JSON.stringify(flushed));
        } catch {
          /* ignore quota */
        }
        return flushed;
      });
    },
    [
      activeWeekStartKey,
      weekPlan,
      successNote,
      selectedIds,
      catalog,
      inventory,
      history,
      priorityBoost,
      breakfastStapleIds,
      mealFitOverrides,
    ]
  );

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return;
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return;
    if (!session?.user) {
      setCloudSyncReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setCloudSyncReady(false);
      setCloudLoadError("");
      const thisCal = formatLocalDateKey(startOfWeekSunday(new Date()));
      try {
        const { data, error } = await supabase
          .from("planner_state")
          .select("*")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (cancelled) return;
        if (error) throw error;

        if (!data) {
          const seed = readLocalStoragePlannerSeed();
          const pool = mergeUserPoolFromPersisted(seed.userPool);
          const savedWeeksSeed =
            seed.savedWeeks && typeof seed.savedWeeks === "object" ? seed.savedWeeks : {};
          let activeKey = savedWeeksSeed[thisCal]
            ? thisCal
            : Object.keys(savedWeeksSeed).sort().pop() || thisCal;
          const entry = savedWeeksSeed[activeKey];
          const newWeekPlan =
            entry?.weekPlan?.length === DAYS.length
              ? entry.weekPlan
              : createWeeklyPlan({
                  selectedIds: pool.selectedIds,
                  catalog: pool.catalog,
                  inventory: pool.inventory,
                  history: pool.history,
                  priorityBoost: {},
                  breakfastStapleIds: seed.breakfastStapleIds ?? [],
                  mealFitOverrides: seed.mealFitOverrides ?? {},
                });
          const defaultIds = DEFAULT_CATALOG_IDS();
          const catalogExtra = pool.catalog.filter((c) => !defaultIds.has(c.id));
          const insertPayload = {
            user_id: session.user.id,
            saved_weeks: savedWeeksSeed,
            user_pool: {
              catalogExtra,
              inventory: pool.inventory,
              history: pool.history,
              selectedIds: pool.selectedIds,
            },
            breakfast_staple_ids: seed.breakfastStapleIds ?? [],
            meal_fit_overrides: seed.mealFitOverrides ?? {},
            priority_boost: {},
            active_week_start_key: activeKey,
            updated_at: new Date().toISOString(),
          };
          const { error: insErr } = await supabase
            .from("planner_state")
            .upsert(insertPayload, { onConflict: "user_id" });
          if (insErr) throw insErr;
          if (cancelled) return;
          setCatalog(pool.catalog);
          setInventory(pool.inventory);
          setHistory(pool.history);
          setSelectedIds(pool.selectedIds);
          setSavedWeeks(savedWeeksSeed);
          setBreakfastStapleIds(seed.breakfastStapleIds ?? []);
          setMealFitOverrides(seed.mealFitOverrides ?? {});
          setPriorityBoost({});
          setActiveWeekStartKey(activeKey);
          setWeekPlan(newWeekPlan);
          setSuccessNote(entry?.reflectionNote ?? "");
        } else {
          const pool = mergeUserPoolFromPersisted(data.user_pool);
          const sw = data.saved_weeks && typeof data.saved_weeks === "object" ? data.saved_weeks : {};
          let activeKey =
            typeof data.active_week_start_key === "string" ? data.active_week_start_key : thisCal;
          if (!sw[activeKey]) {
            activeKey = sw[thisCal] ? thisCal : Object.keys(sw).sort().pop() || thisCal;
          }
          const entry = sw[activeKey];
          const prio =
            data.priority_boost && typeof data.priority_boost === "object" ? data.priority_boost : {};
          const staples = Array.isArray(data.breakfast_staple_ids) ? data.breakfast_staple_ids : [];
          const mealFit =
            data.meal_fit_overrides && typeof data.meal_fit_overrides === "object"
              ? data.meal_fit_overrides
              : {};
          const newWeekPlan =
            entry?.weekPlan?.length === DAYS.length
              ? entry.weekPlan
              : createWeeklyPlan({
                  selectedIds: pool.selectedIds,
                  catalog: pool.catalog,
                  inventory: pool.inventory,
                  history: pool.history,
                  priorityBoost: prio,
                  breakfastStapleIds: staples,
                  mealFitOverrides: mealFit,
                });
          if (cancelled) return;
          setCatalog(pool.catalog);
          setInventory(pool.inventory);
          setHistory(pool.history);
          setSelectedIds(pool.selectedIds);
          setSavedWeeks(sw);
          setBreakfastStapleIds(staples);
          setMealFitOverrides(mealFit);
          setPriorityBoost(prio);
          setActiveWeekStartKey(activeKey);
          setWeekPlan(newWeekPlan);
          setSuccessNote(entry?.reflectionNote ?? "");
        }
        if (!cancelled) setCloudSyncReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setCloudLoadError(e.message ?? String(e));
          setCloudSyncReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when Supabase user id changes
  }, [session?.user?.id]);

  useEffect(() => {
    if (!supabaseConfigured || !supabase || !session?.user || !cloudSyncReady) return;
    const t = window.setTimeout(() => {
      const defaultIds = DEFAULT_CATALOG_IDS();
      const catalogExtra = catalog.filter((c) => !defaultIds.has(c.id));
      supabase
        .from("planner_state")
        .upsert(
          {
            user_id: session.user.id,
            saved_weeks: savedWeeks,
            user_pool: { catalogExtra, inventory, history, selectedIds },
            breakfast_staple_ids: breakfastStapleIds,
            meal_fit_overrides: mealFitOverrides,
            priority_boost: priorityBoost,
            active_week_start_key: activeWeekStartKey,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .then(({ error }) => {
          if (error) console.error(error);
        });
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- upsert keyed by session.user.id
  }, [
    session?.user?.id,
    cloudSyncReady,
    savedWeeks,
    catalog,
    inventory,
    history,
    selectedIds,
    breakfastStapleIds,
    mealFitOverrides,
    priorityBoost,
    activeWeekStartKey,
  ]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setSavedWeeks((prev) => ({
        ...prev,
        [activeWeekStartKey]: {
          weekPlan,
          reflectionNote: successNote,
          updatedAt: new Date().toISOString(),
        },
      }));
    }, 400);
    return () => window.clearTimeout(t);
  }, [weekPlan, successNote, activeWeekStartKey]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_WEEKS, JSON.stringify(savedWeeks));
    } catch {
      /* ignore */
    }
  }, [savedWeeks]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_BREAKFAST_STAPLES, JSON.stringify(breakfastStapleIds));
    } catch {
      /* ignore */
    }
  }, [breakfastStapleIds]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_MEAL_FIT, JSON.stringify(mealFitOverrides));
    } catch {
      /* ignore */
    }
  }, [mealFitOverrides]);

  useEffect(() => {
    try {
      const defaultIds = DEFAULT_CATALOG_IDS();
      const catalogExtra = catalog.filter((c) => !defaultIds.has(c.id));
      localStorage.setItem(
        STORAGE_KEY_USER_POOL,
        JSON.stringify({
          catalogExtra,
          inventory,
          history,
          selectedIds,
        })
      );
    } catch {
      /* ignore quota */
    }
  }, [catalog, inventory, history, selectedIds]);

  const selectedCatalog = useMemo(
    () => selectedIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean),
    [selectedIds, catalog]
  );

  const { catalogChipsSelected, catalogChipsUnselected } = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    const selectedItems = selectedIds
      .map((id) => catalog.find((c) => c.id === id))
      .filter(Boolean);
    const unselectedItems = catalog.filter((c) => !selectedSet.has(c.id));
    return { catalogChipsSelected: selectedItems, catalogChipsUnselected: unselectedItems };
  }, [catalog, selectedIds]);

  const rankedFoods = useMemo(() => {
    return selectedCatalog
      .map((item) => {
        const inv = inventory.find((i) => i.itemId === item.id);
        const base = scoreFood(item, inv, history[item.id] ?? 14);
        const boost = (priorityBoost[item.id] ?? 0) * PRIORITY_SCORE_WEIGHT;
        const fitB = effectiveMealFit(mealFitOverrides, item, "Breakfast");
        const fitL = effectiveMealFit(mealFitOverrides, item, "Lunch");
        const fitD = effectiveMealFit(mealFitOverrides, item, "Dinner");
        const mealFitSummary =
          fitB !== 0 || fitL !== 0 || fitD !== 0
            ? `B ${fitB > 0 ? "+" : ""}${fitB} · L ${fitL > 0 ? "+" : ""}${fitL} · D ${fitD > 0 ? "+" : ""}${fitD}`
            : null;
        return {
          ...item,
          daysLeft: inv?.daysLeft ?? 30,
          quantity: inv?.quantity ?? 0,
          baseScore: Math.round(base * 10) / 10,
          score: Math.round((base + boost) * 10) / 10,
          priorityDelta: priorityBoost[item.id] ?? 0,
          mealFitSummary,
        };
      })
      .sort((a, b) => b.score - a.score);
  }, [selectedCatalog, inventory, history, priorityBoost, mealFitOverrides]);

  const editFoodCatalogItem = useMemo(() => {
    if (!editFoodId) return null;
    return catalog.find((c) => c.id === editFoodId) ?? null;
  }, [editFoodId, catalog]);

  const editFoodStapleIndex = useMemo(() => {
    if (!editFoodId) return -1;
    return breakfastStapleIds.indexOf(editFoodId);
  }, [editFoodId, breakfastStapleIds]);

  const editFoodInPool = useMemo(
    () => (editFoodId ? selectedIds.includes(editFoodId) : false),
    [editFoodId, selectedIds]
  );

  const thisCalendarWeekKey = formatLocalDateKey(startOfWeekSunday(new Date()));
  const isViewingThisCalendarWeek = activeWeekStartKey === thisCalendarWeekKey;

  const savedWeekKeysSorted = useMemo(
    () =>
      Object.keys(savedWeeks)
        .filter((k) => Array.isArray(savedWeeks[k]?.weekPlan))
        .sort()
        .reverse(),
    [savedWeeks]
  );

  const generateWeek = () => {
    setWeekPlan((wp) =>
      createWeeklyPlan({
        selectedIds,
        catalog,
        inventory,
        history,
        priorityBoost,
        breakfastStapleIds,
        mealFitOverrides,
        previousPlan: wp,
      })
    );
  };

  const toggleSlotLock = (day, meal) => {
    setWeekPlan((current) =>
      current.map((row) =>
        row.day === day
          ? {
              ...row,
              meals: {
                ...row.meals,
                [meal]: {
                  ...row.meals[meal],
                  locked: !row.meals[meal]?.locked,
                },
              },
            }
          : row
      )
    );
  };

  const refreshSlot = (day, meal) => {
    setWeekPlan((current) =>
      regenerateSlot(
        current,
        day,
        meal,
        selectedIds,
        catalog,
        inventory,
        history,
        priorityBoost,
        breakfastStapleIds,
        mealFitOverrides
      )
    );
  };

  const openManualSlot = (day, meal) => {
    const row = weekPlan.find((r) => r.day === day);
    const current = row?.meals?.[meal];
    const pool = new Set(selectedIds);
    const initial = (current?.foodIds ?? [])
      .filter((id) => pool.has(id))
      .slice(0, MAX_FOODS_PER_CELL);
    setManualSlot({ day, meal });
    setManualFoodIds(initial);
  };

  const toggleManualOverrideFood = (id) => {
    setManualFoodIds((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= MAX_FOODS_PER_CELL) return current;
      return [...current, id];
    });
  };

  const adjustPriority = (id, delta) => {
    setPriorityBoost((prev) => {
      const cur = prev[id] ?? 0;
      const nextVal = clamp(cur + delta, PRIORITY_CLAMP.min, PRIORITY_CLAMP.max);
      const next = { ...prev };
      if (nextVal === 0) delete next[id];
      else next[id] = nextVal;
      return next;
    });
  };

  const toggleChip = (id) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]
    );
  };

  const addBreakfastStaple = (id) => {
    if (!id || breakfastStapleIds.length >= MAX_FOODS_PER_CELL) return;
    if (breakfastStapleIds.includes(id)) return;
    setBreakfastStapleIds((s) => [...s, id]);
  };

  const removeBreakfastStapleAt = (index) => {
    setBreakfastStapleIds((s) => s.filter((_, i) => i !== index));
  };

  const moveBreakfastStaple = (index, delta) => {
    setBreakfastStapleIds((s) => {
      const j = index + delta;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[index], n[j]] = [n[j], n[index]];
      return n;
    });
  };

  const setMealFitValue = (foodId, meal, value) => {
    setMealFitOverrides((prev) => {
      const row = { ...prev[foodId], [meal]: value };
      const allZero = MEALS.every((m) => (row[m] ?? 0) === 0);
      if (allZero) {
        if (!prev[foodId]) return prev;
        const { [foodId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [foodId]: row };
    });
  };

  const addFood = () => {
    const cleaned = draftFood.trim();
    if (!cleaned) return;
    const id = slugIdFromFoodName(cleaned);
    const category = normalizeFoodCategory(draftFoodCategory);
    if (catalog.some((item) => item.id === id)) {
      setSelectedIds((current) => (current.includes(id) ? current : [...current, id]));
      setDraftFood("");
      setDraftFoodCategory("misc");
      return;
    }
    const newItem = {
      id,
      name: cleaned,
      category,
      perishability: 3,
      toddlerFriendly: 3,
    };
    setCatalog((current) => [...current, newItem]);
    setInventory((current) => [...current, { itemId: id, quantity: 1, zone: "fridge", daysLeft: 5 }]);
    setHistory((current) => ({ ...current, [id]: 14 }));
    setSelectedIds((current) => [...current, id]);
    setDraftFood("");
    setDraftFoodCategory("misc");
  };

  const openEditFood = (item) => {
    setEditFoodId(item.id);
    setEditFoodName(item.name);
    setEditFoodCategory(item.category ?? "misc");
    setEditFoodError("");
  };

  const cancelEditFood = useCallback(() => {
    setEditFoodId(null);
    setEditFoodName("");
    setEditFoodCategory("misc");
    setEditFoodError("");
  }, []);

  const saveEditFood = () => {
    if (!editFoodId) return;
    const oldId = editFoodId;
    const name = editFoodName.trim();
    if (!name) {
      setEditFoodError("Name cannot be empty.");
      return;
    }
    const newId = slugIdFromFoodName(name);
    if (!newId) {
      setEditFoodError("Name needs at least one letter or number.");
      return;
    }
    const category = normalizeFoodCategory(editFoodCategory);
    if (catalog.some((c) => c.id === newId && c.id !== oldId)) {
      setEditFoodError("Another food already uses that name.");
      return;
    }
    const catalogAfter = catalog.map((c) =>
      c.id === oldId ? { ...c, id: newId, name, category } : c
    );
    const idMap = oldId !== newId ? { [oldId]: newId } : {};

    setCatalog(catalogAfter);
    if (Object.keys(idMap).length > 0) {
      setInventory((inv) => inv.map((r) => ({ ...r, itemId: idMap[r.itemId] ?? r.itemId })));
      setHistory((h) => {
        const next = { ...h };
        if (oldId in next) {
          next[newId] = next[oldId];
          delete next[oldId];
        }
        return next;
      });
      setSelectedIds((ids) => ids.map((id) => idMap[id] ?? id));
      setBreakfastStapleIds((ids) => ids.map((id) => idMap[id] ?? id));
      setManualFoodIds((ids) => ids.map((id) => idMap[id] ?? id));
      setPriorityBoost((prev) => {
        const next = { ...prev };
        for (const [from, to] of Object.entries(idMap)) {
          if (from in next) {
            next[to] = next[from];
            delete next[from];
          }
        }
        return next;
      });
      setMealFitOverrides((prev) => {
        const next = { ...prev };
        for (const [from, to] of Object.entries(idMap)) {
          if (from in next) {
            next[to] = next[from];
            delete next[from];
          }
        }
        return next;
      });
    }
    setWeekPlan((wp) => remapWeekPlanFoodIdsAndLabels(wp, idMap, catalogAfter));
    setSavedWeeks((sw) => {
      const out = { ...sw };
      for (const k of Object.keys(out)) {
        const e = out[k];
        if (e && Array.isArray(e.weekPlan)) {
          out[k] = { ...e, weekPlan: remapWeekPlanFoodIdsAndLabels(e.weekPlan, idMap, catalogAfter) };
        }
      }
      return out;
    });
    cancelEditFood();
  };

  const renderPoolChipPill = (item, inPool) => {
    const p = priorityBoost[item.id] ?? 0;
    return (
      <div
        key={item.id}
        style={{
          ...styles.chipPill,
          ...(inPool ? styles.chipPillInPool : {}),
        }}
      >
        <button
          type="button"
          style={{
            ...styles.chipPillEnd,
            ...(inPool ? styles.chipPillEndInPool : {}),
          }}
          onClick={() => adjustPriority(item.id, -1)}
          aria-label={`Lower use priority for ${item.name}`}
        >
          −
        </button>
        <button
          type="button"
          style={{
            ...styles.chipPillCenter,
            ...(inPool ? styles.chipPillCenterInPool : {}),
          }}
          onClick={() => toggleChip(item.id)}
          title={p !== 0 ? `${item.name} (priority ${p > 0 ? "+" : ""}${p})` : item.name}
          aria-label={
            inPool ? `Remove ${item.name} from this week's pool` : `Add ${item.name} to this week's pool`
          }
        >
          <span style={styles.chipPillCenterLabel}>{item.name}</span>
          {p !== 0 ? (
            <span style={styles.chipPillPriorityHint}>· {p > 0 ? `+${p}` : p}</span>
          ) : null}
        </button>
        <button
          type="button"
          style={{
            ...styles.chipPillEnd,
            ...(inPool ? styles.chipPillEndInPool : {}),
          }}
          onClick={() => adjustPriority(item.id, 1)}
          aria-label={`Raise use priority for ${item.name}`}
        >
          +
        </button>
        <button
          type="button"
          style={{
            ...styles.chipPillEditBtn,
            ...(inPool ? styles.chipPillEditBtnInPool : {}),
          }}
          onClick={() => openEditFood(item)}
          aria-label={`Edit ${item.name}`}
        >
          <Pencil size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    );
  };

  const applyManualSlotOverride = () => {
    if (!manualSlot || manualFoodIds.length === 0) return;
    const { day, meal } = manualSlot;
    const items = manualFoodIds.map((fid) => catalog.find((c) => c.id === fid)).filter(Boolean);
    const label = buildMealLabel(items);
    const foodIds = manualFoodIds.slice(0, MAX_FOODS_PER_CELL);
    setWeekPlan((current) =>
      current.map((row) =>
        row.day === day
          ? {
              ...row,
              meals: {
                ...row.meals,
                [meal]: {
                  foodIds,
                  label,
                  overridden: true,
                  locked: row.meals[meal]?.locked ?? false,
                },
              },
            }
          : row
      )
    );
    setManualSlot(null);
    setManualFoodIds([]);
  };

  const cancelManualSlot = useCallback(() => {
    setManualSlot(null);
    setManualFoodIds([]);
  }, []);

  useEffect(() => {
    if (!manualSlot) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") cancelManualSlot();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [manualSlot, cancelManualSlot]);

  useEffect(() => {
    if (!editFoodId) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") cancelEditFood();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editFoodId, cancelEditFood]);

  const saveReflectionToWeek = () => {
    persistCurrentWeekSnapshot();
  };

  const submitAuth = async () => {
    if (!supabase) return;
    setAuthFormError("");
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) {
      setAuthFormError("Enter email and password.");
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setAuthFormError(e.message ?? String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOutCloud = async () => {
    if (!supabase) return;
    setAuthFormError("");
    setCloudLoadError("");
    await supabase.auth.signOut();
  };

  if (supabaseConfigured && authReady && !session) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.authPanel}>
            <h1 style={styles.authTitle}>Toddler menu planner</h1>
            <p style={styles.authSubtitle}>
              Sign in with your shared household email. First time? Choose <strong>Create account</strong>, then sign in
              on other devices with the same email and password.
            </p>
            <div style={styles.authRow}>
              <button
                type="button"
                style={authMode === "signin" ? styles.tabActive : styles.tab}
                onClick={() => {
                  setAuthMode("signin");
                  setAuthFormError("");
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                style={authMode === "signup" ? styles.tabActive : styles.tab}
                onClick={() => {
                  setAuthMode("signup");
                  setAuthFormError("");
                }}
              >
                Create account
              </button>
            </div>
            <label style={styles.authLabel} htmlFor="auth-email">
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              autoComplete="username"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={styles.authInput}
            />
            <label style={styles.authLabel} htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete={authMode === "signup" ? "new-password" : "current-password"}
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              style={styles.authInput}
            />
            {authFormError ? <p style={styles.authError}>{authFormError}</p> : null}
            <button
              type="button"
              style={{ ...styles.buttonPrimary, width: "100%", marginTop: "8px" }}
              onClick={submitAuth}
              disabled={authBusy}
            >
              {authBusy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (supabaseConfigured && session && !cloudSyncReady) {
    return (
      <div style={styles.page}>
        <p
          style={{
            textAlign: "center",
            padding: "48px",
            color: "var(--color-subtext-color)",
            fontSize: "16px",
          }}
        >
          Loading your planner…
        </p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.topBar}>
          <div style={styles.tabs}>
            <TabButton active={activeTab === "planner"} onClick={() => setActiveTab("planner")}>Planner</TabButton>
            <TabButton active={activeTab === "history"} onClick={() => setActiveTab("history")}>History</TabButton>
            <TabButton active={activeTab === "logic"} onClick={() => setActiveTab("logic")}>Scoring</TabButton>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {supabaseConfigured && session ? (
              <div style={styles.topBarUser}>
                <span>{session.user.email}</span>
                <button type="button" style={styles.button} onClick={signOutCloud}>
                  Sign out
                </button>
              </div>
            ) : null}
            <button type="button" onClick={generateWeek} style={styles.buttonPrimary}>
              Generate week
            </button>
          </div>
        </div>

        {cloudLoadError ? (
          <p style={{ ...styles.authError, margin: "0 0 12px", padding: "0 4px" }}>
            Cloud sync error: {cloudLoadError}
          </p>
        ) : null}

        {activeTab === "planner" && (
          <div style={styles.grid}>
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>{formatWeekRangeLabel(activeWeekStartKey)}</h2>
              <div style={styles.weekNav}>
                <button
                  type="button"
                  style={styles.weekNavBtn}
                  onClick={() => navigateToWeek(addDaysToDateKey(activeWeekStartKey, -7))}
                  aria-label="Previous week"
                >
                  ‹ Prev
                </button>
                <button
                  type="button"
                  style={styles.weekNavBtn}
                  onClick={() => navigateToWeek(addDaysToDateKey(activeWeekStartKey, 7))}
                  aria-label="Next week"
                >
                  Next ›
                </button>
                <button
                  type="button"
                  style={{
                    ...styles.weekNavBtn,
                    ...(isViewingThisCalendarWeek ? styles.weekNavBtnActive : {}),
                  }}
                  onClick={() => navigateToWeek(thisCalendarWeekKey)}
                  aria-current={isViewingThisCalendarWeek ? "true" : undefined}
                >
                  This week
                </button>
              </div>
              <p style={{ ...styles.smallText, marginTop: 0, marginBottom: "16px" }}>
                Week starts Sunday. <strong>Breakfast</strong> uses staples when set (same lineup), then fills slots.{" "}
                <strong>Lunch &amp; dinner</strong> pick ~4 foods each and try to include{" "}
                <strong>one fruit or veg</strong>, <strong>one grain</strong>, and <strong>one protein or dairy</strong> before
                filling the rest (or if a bucket is missing from your pool). Up to <strong>{MAX_FOODS_PER_CELL} per cell</strong>.
                Lock a cell (padlock) to keep it when you <strong>Generate week</strong> or tap <strong>Refresh</strong>.
                {supabaseConfigured && session
                  ? " Your plan syncs to your account (this device also keeps a local copy)."
                  : " Plans save in your browser."}
              </p>
              <div style={styles.menuMatrixWrap}>
                <div style={styles.menuMatrix} role="grid" aria-label="Weekly meal matrix">
                  <div style={styles.matrixCorner}>Day</div>
                  {MEALS.map((meal) => (
                    <div key={meal} style={styles.matrixColHead}>
                      {meal}
                    </div>
                  ))}
                  {weekPlan.map((row, dayIndex) => (
                    <React.Fragment key={row.day}>
                      <div style={styles.matrixRowHead}>
                        {row.day}
                        <span style={styles.matrixRowDate}>{formatRowDateLabel(activeWeekStartKey, dayIndex)}</span>
                      </div>
                      {MEALS.map((meal) => {
                        const slot = row.meals[meal];
                        const isLocked = !!slot.locked;
                        return (
                          <div key={meal} style={styles.matrixCell} role="gridcell">
                            {slot.overridden || isLocked ? (
                              <div style={styles.matrixCellMeta}>
                                {slot.overridden ? <span style={styles.badge}>Manual</span> : null}
                                {isLocked ? <span style={styles.badge}>Locked</span> : null}
                              </div>
                            ) : null}
                            {slot.foodIds.length === 0 ? (
                              <p style={styles.matrixFoodEmpty}>No foods selected</p>
                            ) : (
                              <ul style={styles.matrixFoodList}>
                                {slot.foodIds.map((foodId) => {
                                  const foodName = catalog.find((c) => c.id === foodId)?.name ?? foodId;
                                  return (
                                    <li key={`${row.day}-${meal}-${foodId}`} style={styles.matrixFoodItem}>
                                      {foodName}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            <div style={styles.matrixCellActions}>
                              <button
                                type="button"
                                style={{
                                  ...styles.matrixIconBtn,
                                  ...(isLocked ? styles.matrixIconBtnMuted : {}),
                                }}
                                onClick={() => refreshSlot(row.day, meal)}
                                disabled={isLocked}
                                aria-label={`Refresh suggested foods for ${row.day} ${meal}`}
                                title={isLocked ? "Unlock this cell to refresh" : "Refresh"}
                              >
                                <RefreshCw size={17} strokeWidth={2} aria-hidden />
                              </button>
                              <button
                                type="button"
                                style={styles.matrixIconBtn}
                                onClick={() => toggleSlotLock(row.day, meal)}
                                aria-label={
                                  isLocked ? `Unlock ${row.day} ${meal}` : `Lock ${row.day} ${meal}`
                                }
                                title={isLocked ? "Unlock (allow generate/refresh to change)" : "Lock (keep when generating)"}
                              >
                                {isLocked ? (
                                  <Unlock size={17} strokeWidth={2} aria-hidden />
                                ) : (
                                  <Lock size={17} strokeWidth={2} aria-hidden />
                                )}
                              </button>
                              <button
                                type="button"
                                style={styles.matrixIconBtn}
                                onClick={() => openManualSlot(row.day, meal)}
                                aria-label={`Edit ${row.day} ${meal} manually`}
                                title="Edit meal"
                              >
                                <Pencil size={17} strokeWidth={2} aria-hidden />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              <div
                style={{
                  marginTop: "28px",
                  paddingTop: "24px",
                  borderTop: "1px solid var(--color-neutral-border)",
                }}
              >
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: "18px",
                  fontWeight: 600,
                  fontFamily: "var(--font-heading-2), ui-sans-serif, system-ui, sans-serif",
                  color: "var(--color-default-font)",
                  letterSpacing: "-0.02em",
                }}
              >
                This week&apos;s foods
              </h3>
              <p style={{ ...styles.smallText, marginTop: 0, marginBottom: "16px" }}>
                <strong>In this week&apos;s pool</strong> — tap the center of a pill to include or exclude; <strong>−</strong> and{" "}
                <strong>+</strong> nudge planner priority for the week; pencil opens the editor (name, category, breakfast
                staple, meal-fit nudges).{" "}
                <strong>Not in this week</strong> — tap the center to add to the pool. Inventory and &quot;last served&quot;{" "}
                {supabaseConfigured && session
                  ? "sync when signed in (this browser keeps a copy)."
                  : "stay in this browser."}
              </p>

              <p style={styles.sectionLabel}>In this week&apos;s pool</p>
              <div style={styles.chipListColumn}>
                {catalogChipsSelected.length === 0 ? (
                  <p style={{ ...styles.smallText, margin: "0 0 16px" }}>
                    None yet — add foods from <strong>Not in this week</strong> below.
                  </p>
                ) : (
                  <div
                    style={styles.poolCategoryGrid}
                    aria-label="Foods in this week's pool, by category"
                  >
                    {groupCatalogByCategoryOrdered(catalogChipsSelected).map(({ category, items }) => (
                      <div key={category.id} style={styles.poolCategoryColumn}>
                        <p style={styles.poolCategoryHeading}>{category.label}</p>
                        <div style={styles.chipColumnStack}>
                          {items.map((item) => renderPoolChipPill(item, true))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {catalogChipsUnselected.length > 0 ? (
                <>
                  <p style={{ ...styles.sectionLabel, marginTop: "20px" }}>Not in this week</p>
                  <div
                    style={styles.poolCategoryGrid}
                    aria-label="Foods not in this week's pool, by category"
                  >
                    {groupCatalogByCategoryOrdered(catalogChipsUnselected).map(({ category, items }) => (
                      <div key={`out-${category.id}`} style={styles.poolCategoryColumn}>
                        <p style={styles.poolCategoryHeading}>{category.label}</p>
                        <div style={styles.chipColumnStack}>
                          {items.map((item) => renderPoolChipPill(item, false))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              <p style={{ ...styles.sectionLabel, marginTop: "24px" }}>Add a new food</p>
              <p style={{ ...styles.smallText, marginTop: "-4px", marginBottom: "10px" }}>
                Pick a category, name it, then <strong>Add</strong>. It joins your catalog and this week&apos;s pool; if that
                name already exists, it&apos;s just added to the pool.
              </p>
              <div style={{ ...styles.inputRow, marginBottom: "4px" }}>
                <input
                  value={draftFood}
                  onChange={(e) => setDraftFood(e.target.value)}
                  placeholder="Food name"
                  style={styles.input}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addFood();
                  }}
                />
                <select
                  value={draftFoodCategory}
                  onChange={(e) => setDraftFoodCategory(e.target.value)}
                  style={{ ...styles.select, flex: "0 0 148px", width: "auto", marginBottom: 0 }}
                  aria-label="Category for new food (one required)"
                >
                  {FOOD_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addFood}
                  className="rounded-xl border border-neutral-300 bg-neutral-0 px-3 py-2 text-sm text-default-font"
                >
                  Add
                </button>
              </div>

              <p style={{ ...styles.sectionLabel, marginTop: "20px" }}>Weekly reflection</p>
              <p style={{ ...styles.smallText, marginTop: "-4px", marginBottom: "10px" }}>
                Saved with this calendar week ({formatWeekRangeLabel(activeWeekStartKey)}). Also auto-saves while you type.
              </p>
              <textarea
                value={successNote}
                onChange={(e) => setSuccessNote(e.target.value)}
                placeholder="Example: They loved blueberries with cottage cheese, refused broccoli twice, pita worked best at lunch."
                style={styles.textArea}
              />
              <button type="button" onClick={saveReflectionToWeek} style={{ ...styles.button, width: "100%" }}>
                Save note now
              </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Past weeks</h2>
            <p style={{ ...styles.smallText, marginTop: "-8px", marginBottom: "16px" }}>
                Each week is keyed by its starting Sunday.
                {supabaseConfigured && session
                  ? " Signed-in data is stored in your Supabase project and synced across devices; this browser also caches a copy."
                  : " Data is stored only in this browser (localStorage)."}
            </p>
            {savedWeekKeysSorted.length === 0 ? (
              <p style={styles.smallText}>No saved weeks yet. Use the planner and your week will be stored automatically.</p>
            ) : (
              savedWeekKeysSorted.map((weekKey) => {
                const entry = savedWeeks[weekKey];
                const when =
                  weekKey === thisCalendarWeekKey
                    ? "Current calendar week"
                    : weekKey < thisCalendarWeekKey
                      ? "Past week"
                      : "Future week";
                return (
                  <div key={weekKey} style={styles.scoreRow}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: "12px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{formatWeekRangeLabel(weekKey)}</div>
                        <p style={{ ...styles.smallText, marginBottom: 0 }}>{when}</p>
                      </div>
                      <button
                        type="button"
                        style={styles.button}
                        onClick={() => {
                          navigateToWeek(weekKey);
                          setActiveTab("planner");
                        }}
                      >
                        Open in planner
                      </button>
                    </div>
                    {entry?.reflectionNote?.trim() ? (
                      <p style={{ margin: "12px 0 0", fontSize: "14px", lineHeight: 1.45 }}>{entry.reflectionNote}</p>
                    ) : (
                      <p style={{ ...styles.smallText, margin: "12px 0 0", marginBottom: 0 }}>No reflection note.</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === "logic" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Why foods are ranked the way they are</h2>
            <p style={{ ...styles.smallText, marginTop: "-8px", marginBottom: "16px" }}>
              Base score blends spoilage, variety, and toddler-friendly defaults, plus chip priority (−5…+5 × {PRIORITY_SCORE_WEIGHT}). At pick time, per-meal &quot;meal fit&quot; (−3…+3 × {MEAL_FIT_WEIGHT}) nudges ranking. Lunch and dinner first reserve top-ranked picks for{" "}
              <strong>produce</strong> (fruit or veg), <strong>grain</strong>, and <strong>protein or dairy</strong>; breakfast uses staples when set.
            </p>
            {rankedFoods.map((item) => (
              <div key={item.id} style={styles.scoreRow}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    <p style={styles.smallText}>
                      {foodCategoryLabel(normalizeFoodCategory(item.category))} • {item.daysLeft} days left • qty {item.quantity} • last served{" "}
                      {history[item.id] ?? 14} days ago
                      {item.priorityDelta !== 0
                        ? ` • chip priority ${item.priorityDelta > 0 ? "+" : ""}${item.priorityDelta}`
                        : ""}
                      {item.mealFitSummary ? ` • meal nudge ${item.mealFitSummary}` : ""}
                    </p>
                  </div>
                  <div style={styles.badge}>
                    Score {item.score}
                    {item.priorityDelta !== 0 ? ` (base ${item.baseScore})` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {manualSlot ? (
          <div style={styles.modalBackdrop} onClick={cancelManualSlot} role="presentation">
            <div
              style={styles.modalPanel}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="override-modal-title"
            >
              <button
                type="button"
                style={styles.modalCloseBtn}
                onClick={cancelManualSlot}
                aria-label="Close"
              >
                <X size={18} strokeWidth={2} aria-hidden />
              </button>
              <h2 id="override-modal-title" style={styles.modalTitle}>
                Override meal
              </h2>
              <p style={styles.modalSubtitle}>
                {formatRowDateLabel(activeWeekStartKey, DAYS.indexOf(manualSlot.day))} · {manualSlot.meal}
              </p>
              <p style={{ ...styles.sectionLabel, marginTop: 0, marginBottom: "8px" }}>Foods from your pool</p>
              <p style={{ ...styles.smallText, marginTop: 0, marginBottom: "10px" }}>
                Pick up to <strong>{MAX_FOODS_PER_CELL}</strong> for this meal ({manualFoodIds.length} selected). Selected foods
                stay at the top; meal order matches how you check them.
              </p>
              <div style={styles.modalFoodList} role="group" aria-label="Foods in pool for this meal">
                {selectedCatalog.length === 0 ? (
                  <p style={{ ...styles.smallText, margin: "12px", textAlign: "center" }}>No foods in your pool. Add foods below first.</p>
                ) : (
                  catalogOrderedForOverrideModal(selectedCatalog, manualFoodIds).map((item) => {
                    const checked = manualFoodIds.includes(item.id);
                    const atMax = manualFoodIds.length >= MAX_FOODS_PER_CELL;
                    const disabled = !checked && atMax;
                    return (
                      <label
                        key={item.id}
                        style={{
                          ...styles.modalFoodRow,
                          ...(disabled ? styles.modalFoodRowDisabled : {}),
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleManualOverrideFood(item.id)}
                        />
                        <span>{item.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button type="button" onClick={cancelManualSlot} style={styles.button}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={applyManualSlotOverride}
                  style={styles.buttonPrimary}
                  disabled={manualFoodIds.length === 0}
                >
                  Apply to slot
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {editFoodId ? (
          <div style={styles.modalBackdrop} onClick={cancelEditFood} role="presentation">
            <div
              style={{ ...styles.modalPanel, maxWidth: "min(100%, 520px)" }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-food-modal-title"
            >
              <button
                type="button"
                style={styles.modalCloseBtn}
                onClick={cancelEditFood}
                aria-label="Close"
              >
                <X size={18} strokeWidth={2} aria-hidden />
              </button>
              <h2 id="edit-food-modal-title" style={styles.modalTitle}>
                Edit food
              </h2>
              <p style={styles.modalSubtitle}>
                Name, category, breakfast staple lineup, and per-meal fit nudges. Renaming updates the internal id everywhere
                (planner, inventory, history, staples, saved weeks). Staple and meal-fit changes apply as soon as you adjust
                them; use <strong>Save</strong> for name and category only.
              </p>
              <label style={{ ...styles.sectionLabel, display: "block", marginBottom: "6px" }} htmlFor="edit-food-name">
                Name
              </label>
              <input
                id="edit-food-name"
                value={editFoodName}
                onChange={(e) => {
                  setEditFoodName(e.target.value);
                  setEditFoodError("");
                }}
                style={{ ...styles.input, width: "100%", boxSizing: "border-box", marginBottom: "12px" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEditFood();
                }}
              />
              <label style={{ ...styles.sectionLabel, display: "block", marginBottom: "6px" }} htmlFor="edit-food-category">
                Category
              </label>
              <select
                id="edit-food-category"
                value={editFoodCategory}
                onChange={(e) => {
                  setEditFoodCategory(e.target.value);
                  setEditFoodError("");
                }}
                style={{ ...styles.select, width: "100%", boxSizing: "border-box", marginBottom: "12px" }}
                aria-label="Category for food"
              >
                {FOOD_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>

              <div
                style={{
                  marginTop: "18px",
                  paddingTop: "16px",
                  borderTop: "1px solid var(--color-neutral-200)",
                }}
              >
                <p style={styles.sectionLabel}>Breakfast staple</p>
                <p style={{ ...styles.smallText, marginTop: "-4px", marginBottom: "10px" }}>
                  When this food is in your pool, breakfast auto-fill uses staples first (in order). Reorder with ↑ ↓; edit
                  other foods to move them in the lineup too.
                </p>
                {editFoodStapleIndex >= 0 ? (
                  <>
                    <p style={{ ...styles.smallText, marginTop: 0, marginBottom: "10px" }}>
                      In lineup — position {editFoodStapleIndex + 1} of {breakfastStapleIds.length}.
                      {!editFoodInPool ? (
                        <>
                          {" "}
                          <strong>Not in this week&apos;s pool</strong> — add it to the pool for breakfast fill to use this
                          staple.
                        </>
                      ) : null}
                    </p>
                    <div style={{ ...styles.inputRow, marginBottom: 0 }}>
                      <button
                        type="button"
                        style={styles.stapleOrderBtn}
                        onClick={() => moveBreakfastStaple(editFoodStapleIndex, -1)}
                        disabled={editFoodStapleIndex === 0}
                        aria-label="Move staple up in order"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        style={styles.stapleOrderBtn}
                        onClick={() => moveBreakfastStaple(editFoodStapleIndex, 1)}
                        disabled={editFoodStapleIndex === breakfastStapleIds.length - 1}
                        aria-label="Move staple down in order"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        style={{ ...styles.button, flex: "1 1 auto", minWidth: "140px" }}
                        onClick={() => removeBreakfastStapleAt(editFoodStapleIndex)}
                      >
                        Remove from staples
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      style={styles.button}
                      onClick={() => addBreakfastStaple(editFoodId)}
                      disabled={
                        breakfastStapleIds.length >= MAX_FOODS_PER_CELL || breakfastStapleIds.includes(editFoodId)
                      }
                    >
                      Add to breakfast staples
                    </button>
                    {breakfastStapleIds.length >= MAX_FOODS_PER_CELL ? (
                      <p style={{ ...styles.smallText, marginTop: "10px", marginBottom: 0 }}>
                        Staple list is full ({MAX_FOODS_PER_CELL} max). Remove a staple from another food&apos;s editor.
                      </p>
                    ) : null}
                    {!editFoodInPool ? (
                      <p style={{ ...styles.smallText, marginTop: "10px", marginBottom: 0 }}>
                        Tip: add this food to <strong>this week&apos;s pool</strong> so breakfast auto-fill can use it.
                      </p>
                    ) : null}
                  </>
                )}
              </div>

              <div
                style={{
                  marginTop: "18px",
                  paddingTop: "16px",
                  borderTop: "1px solid var(--color-neutral-200)",
                }}
              >
                <p style={styles.sectionLabel}>Meal fit (−3…+3)</p>
                <p style={{ ...styles.smallText, marginTop: "-4px", marginBottom: "10px" }}>
                  Soft score nudge for auto-fill and refresh. Negative = less likely; still possible. Ignored for staple slots
                  and manual meal overrides.
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "12px 16px",
                    alignItems: "flex-end",
                  }}
                >
                  {MEALS.map((m) => {
                    const itemForFit = editFoodCatalogItem ?? { id: editFoodId };
                    const short =
                      m === "Breakfast" ? "Brk" : m === "Lunch" ? "Lun" : "Din";
                    return (
                      <div
                        key={m}
                        style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "76px" }}
                      >
                        <label
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "var(--color-subtext-color)",
                          }}
                          htmlFor={`edit-meal-fit-${editFoodId}-${m}`}
                        >
                          {short}
                        </label>
                        <select
                          id={`edit-meal-fit-${editFoodId}-${m}`}
                          value={effectiveMealFit(mealFitOverrides, itemForFit, m)}
                          onChange={(e) => setMealFitValue(editFoodId, m, Number(e.target.value))}
                          style={styles.mealFitSelect}
                          aria-label={`${editFoodName || "Food"} fit for ${m}`}
                        >
                          {MEAL_FIT_SELECT_LEVELS.map((lv) => (
                            <option key={lv} value={lv}>
                              {lv > 0 ? `+${lv}` : String(lv)}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>

              {editFoodError ? (
                <p style={{ ...styles.smallText, color: "var(--color-danger-600, #b91c1c)", margin: "12px 0 0" }}>
                  {editFoodError}
                </p>
              ) : null}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  marginTop: "20px",
                }}
              >
                <button type="button" onClick={cancelEditFood} style={styles.button}>
                  Close
                </button>
                <button type="button" onClick={saveEditFood} style={styles.buttonPrimary}>
                  Save name &amp; category
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
