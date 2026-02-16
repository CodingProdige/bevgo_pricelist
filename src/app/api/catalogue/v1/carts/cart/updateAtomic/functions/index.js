import { doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { computeLineTotals, computeCartTotals } from "./lineCalculator";
import { capQuantity } from "./stock";
import { ensureCartItemKey } from "./keyManager";
import { buildUiMessage } from "./uiMessage";

const nowIso = () => new Date().toISOString();

const allowedModes = ["add", "increment", "decrement", "set", "remove"];

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function normalizeInventoryReservations(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const location_id = String(entry?.location_id || "").trim();
    const qty = Math.max(0, Number(entry?.qty) || 0);
    if (!location_id || qty <= 0) continue;
    map.set(location_id, (map.get(location_id) || 0) + qty);
  }
  return [...map.entries()].map(([location_id, qty]) => ({ location_id, qty }));
}

function mergeInventoryReservations(...lists) {
  return normalizeInventoryReservations(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
}

function releaseFromReservations(reservations, releaseQty) {
  let remaining = Math.max(0, Number(releaseQty) || 0);
  const released = [];
  const kept = [];

  for (const row of normalizeInventoryReservations(reservations)) {
    if (remaining <= 0) {
      kept.push(row);
      continue;
    }
    const take = Math.min(row.qty, remaining);
    if (take > 0) released.push({ location_id: row.location_id, qty: take });
    const left = row.qty - take;
    if (left > 0) kept.push({ location_id: row.location_id, qty: left });
    remaining -= take;
  }

  return { released, remaining: kept, unresolved: remaining };
}

function applyInventoryDelta(variant, { deltaInventory = 0, reservations = [] } = {}) {
  const delta = Number(deltaInventory) || 0;
  const rows = Array.isArray(variant?.inventory)
    ? variant.inventory.map((row) => ({ ...row }))
    : [];
  const normalizedReservations = normalizeInventoryReservations(reservations);
  const result = {
    consumed: [],
    remainingReservations: normalizedReservations
  };

  if (!delta || !rows.length) return result;

  if (delta > 0) {
    // Consume inventory from rows in order until requested delta is exhausted.
    let remaining = delta;
    for (const row of rows) {
      if (remaining <= 0) break;
      const start = Math.max(0, Number(row?.in_stock_qty) || 0);
      const take = Math.min(start, remaining);
      row.in_stock_qty = start - take;
      remaining -= take;
      if (take > 0) {
        result.consumed.push({ location_id: String(row?.location_id || ""), qty: take });
      }
    }
    result.remainingReservations = mergeInventoryReservations(normalizedReservations, result.consumed);
  } else {
    const releaseQty = Math.abs(delta);
    const { released, remaining, unresolved } = releaseFromReservations(normalizedReservations, releaseQty);

    for (const rel of released) {
      const idx = rows.findIndex((row) => String(row?.location_id || "") === String(rel.location_id || ""));
      const targetIdx = idx >= 0 ? idx : 0;
      const start = Math.max(0, Number(rows[targetIdx]?.in_stock_qty) || 0);
      rows[targetIdx].in_stock_qty = start + rel.qty;
    }

    if (unresolved > 0) {
      const idx = rows.findIndex(() => true);
      if (idx >= 0) {
        const start = Math.max(0, Number(rows[idx]?.in_stock_qty) || 0);
        rows[idx].in_stock_qty = start + unresolved;
      }
    }

    result.remainingReservations = remaining;
  }

  variant.inventory = rows;
  return result;
}

const makeCartItemKey = (productId, variantId) =>
  `cki_${String(productId || "p").slice(-4)}_${String(variantId || "v").slice(-4)}_${Date.now()
    .toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* -------------------------------------------------------
   Main transaction handler. Runs inside Firestore tx.
------------------------------------------------------- */
export async function updateCartAtomic(tx, body) {
  const customerId = String(body?.customerId || "").trim();
  if (!customerId) {
    throw { code: 400, title: "Missing Input", message: "customerId is required." };
  }

  const mode = String(body?.mode || "add").toLowerCase();
  if (!allowedModes.includes(mode)) {
    throw { code: 400, title: "Invalid Mode", message: `mode must be one of: ${allowedModes.join(", ")}` };
  }

  const productId = String(body?.productId || "").trim();
  const variantId = String(body?.variantId || "").trim();
  const channel = String(body?.channel || "unknown").trim() || "unknown";
  const providedKey = String(body?.cart_item_key ?? "").trim();
  const qtyInput = Number(body?.quantity);

  const cartRef = doc(db, "carts", customerId);
  const cartSnap = await tx.get(cartRef);
  const now = nowIso();

  const emptyCart = {
    docId: customerId,
    cart: { cartId: customerId, customerId, channel },
    items: [],
    totals: {
      subtotal_excl: 0,
      sale_savings_excl: 0,
      deposit_total_excl: 0,
      vat_total: 0,
      final_excl: 0,
      final_incl: 0
    },
    item_count: 0,
    cart_corrected: false,
    meta: { notes: null, lastAction: "", source: channel },
    timestamps: { createdAt: now, updatedAt: now }
  };

  const cart = cartSnap.exists() ? cartSnap.data() : emptyCart;
  const baseCartInfo =
    cart && typeof cart.cart === "object" && cart.cart
      ? cart.cart
      : emptyCart.cart;
  const baseMeta =
    cart && typeof cart.meta === "object" && cart.meta
      ? cart.meta
      : emptyCart.meta;
  const baseTimestamps =
    cart && typeof cart.timestamps === "object" && cart.timestamps
      ? cart.timestamps
      : emptyCart.timestamps;

  const items = Array.isArray(cart.items) ? [...cart.items] : [];
  const requireKey = ["increment", "decrement", "set", "remove"].includes(mode);

  /* -------------------------------------------------------
     locate / derive item key + existing line
  ------------------------------------------------------- */
  const allowGenerateKey = mode === "add";
  const cartItemKey = ensureCartItemKey({
    providedKey,
    items,
    productId,
    variantId,
    allowGenerate: allowGenerateKey
  });

  if (requireKey && !cartItemKey) {
    throw { code: 400, title: "Missing cart_item_key", message: "cart_item_key is required for this mode." };
  }

  const existingIndex = items.findIndex((it) => String(it?.cart_item_key || "") === String(cartItemKey));
  const existingItem = existingIndex >= 0 ? items[existingIndex] : null;
  const currentQty = Number(existingItem?.quantity) || 0;
  const existingInventoryReservations = normalizeInventoryReservations(existingItem?.inventory_reservations);

  if (requireKey && !existingItem && mode !== "remove") {
    throw { code: 404, title: "Item Not Found", message: "Cart item not found for provided key." };
  }

  /* -------------------------------------------------------
     shortcut remove if requested and nothing to delete
  ------------------------------------------------------- */
  if (mode === "remove" && !existingItem) {
    const finalCart = {
      ...cart,
      cart: { ...baseCartInfo, channel },
      items,
      totals: computeCartTotals(items),
      item_count: items.reduce((a, it) => a + (Number(it?.quantity) || 0), 0),
      cart_corrected: false,
      meta: { ...baseMeta, lastAction: "remove:none", source: channel || baseMeta?.source || "api" },
      timestamps: { ...baseTimestamps, updatedAt: now }
    };

    tx.set(cartRef, finalCart, { merge: false });
    return { cart: finalCart, warnings: [], _ui: null, _generatedKey: null };
  }

  /* -------------------------------------------------------
     load product + variant snapshot for modes that mutate qty
  ------------------------------------------------------- */
  let productSnapshot = null;
  let variantSnapshot = null;
  let originalVariantSnapshot = null;
  let resolvedProductId = productId;
  let resolvedVariantId = variantId;

  if (!resolvedProductId && existingItem?.product_snapshot) {
    resolvedProductId =
      String(existingItem.product_snapshot?.product?.unique_id || "") ||
      String(existingItem.product_snapshot?.docId || "") ||
      String(existingItem.product_snapshot?.product?.product_id || "");
  }
  if (!resolvedVariantId && existingItem?.selected_variant_snapshot) {
    resolvedVariantId = String(existingItem.selected_variant_snapshot?.variant_id || "");
  }

  const qtyRequired = mode !== "remove";
  if (qtyRequired && !Number.isFinite(qtyInput)) {
    throw { code: 400, title: "Invalid Quantity", message: "quantity must be a number." };
  }

  if (mode === "add" && (!resolvedProductId || !resolvedVariantId)) {
    throw { code: 400, title: "Missing Input", message: "productId and variantId are required for add." };
  }

  const shouldLoadProduct = mode !== "remove" || Boolean(existingItem);
  let productRef = null;
  if (shouldLoadProduct) {
    if (!resolvedProductId || !resolvedVariantId) {
      throw { code: 400, title: "Missing Input", message: "productId and variantId are required." };
    }

    productRef = doc(db, "products_v2", resolvedProductId);
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) {
      throw { code: 404, title: "Product Not Found", message: "No product with this productId." };
    }
    productSnapshot = productSnap.data();

    variantSnapshot = (Array.isArray(productSnapshot.variants) ? productSnapshot.variants : []).find(
      (v) => String(v?.variant_id) === String(resolvedVariantId)
    );

    if (!variantSnapshot) {
      throw { code: 404, title: "Variant Not Found", message: "Variant does not exist on this product." };
    }
    originalVariantSnapshot = existingItem
      ? clone(existingItem.selected_variant_snapshot)
      : clone(variantSnapshot);
  } else if (existingItem) {
    productSnapshot = existingItem.product_snapshot;
    variantSnapshot = existingItem.selected_variant_snapshot;
    originalVariantSnapshot = clone(existingItem.selected_variant_snapshot);
  }

  /* Supplier out of stock guard when trying to increase */
  const supplierOOS = Boolean(productSnapshot?.placement?.supplier_out_of_stock);

  /* -------------------------------------------------------
     compute desired + capped quantity
  ------------------------------------------------------- */
  let desiredQty = 0;
  if (mode === "add") {
    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw { code: 400, title: "Invalid Quantity", message: "quantity must be > 0 for add." };
    }
    desiredQty = currentQty + qtyInput;
  } else if (mode === "increment") {
    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw { code: 400, title: "Invalid Quantity", message: "quantity must be > 0 for increment." };
    }
    desiredQty = currentQty + qtyInput;
  } else if (mode === "decrement") {
    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw { code: 400, title: "Invalid Quantity", message: "quantity must be > 0 for decrement." };
    }
    desiredQty = Math.max(0, currentQty - qtyInput);
  } else if (mode === "set") {
    desiredQty = Math.max(0, Number.isFinite(qtyInput) ? qtyInput : 0);
  } else {
    desiredQty = 0;
  }

  if (supplierOOS && desiredQty > currentQty) {
    throw {
      code: 409,
      title: "Supplier Out of Stock",
      message: "This item cannot be increased because the supplier is out of stock."
    };
  }

  const ignoreSale =
    Boolean(variantSnapshot?.sale?.disabled_by_admin) ||
    !variantSnapshot?.sale?.is_on_sale ||
    (variantSnapshot?.sale?.is_on_sale && Number(variantSnapshot?.sale?.qty_available) <= 0);

  const { quantity: finalQty, capped, available, reason } = capQuantity(variantSnapshot, desiredQty, {
    currentQty,
    ignoreSale,
    supplierOOS
  });
  const attemptedIncrease = Math.max(0, desiredQty - currentQty);
  const actualIncrease = Math.max(0, finalQty - currentQty);
  if (attemptedIncrease > 0 && actualIncrease <= 0) {
    const ui = buildUiMessage({
      type: "error",
      title: "Out of Stock",
      message:
        reason === "supplier_out_of_stock"
          ? "Supplier is out of stock; cannot increase quantity."
          : "Requested item is no longer available.",
      detail: available != null ? `Available: ${available}` : null
    });
    throw {
      code: 409,
      title: "Out of Stock",
      message:
        reason === "supplier_out_of_stock"
          ? "Supplier is out of stock; cannot increase quantity."
          : "Requested item is no longer available.",
      ui
    };
  }

  let _ui = null;
  if (capped) {
    _ui = buildUiMessage({
      type: finalQty === 0 ? "error" : "warning",
      title: finalQty === 0 ? "Out of Stock" : "Quantity Adjusted",
      message:
        finalQty === 0
          ? reason === "supplier_out_of_stock"
            ? "Supplier is out of stock; cannot increase quantity."
            : "Requested item is no longer available."
          : `Quantity reduced to ${finalQty} due to limited ${reason || "stock"}.`,
      detail: available != null ? `Available: ${available}` : null
    });
  } else {
    _ui = buildUiMessage({
      type: "success",
      title: "Cart Updated",
      message:
        mode === "add"
          ? "Item added to cart."
          : mode === "increment"
            ? "Item quantity increased."
            : mode === "decrement"
              ? "Item quantity decreased."
              : mode === "set"
                ? "Item quantity updated."
                : "Item removed."
    });
  }

  /* -------------------------------------------------------
     mutate items array
  ------------------------------------------------------- */
  let generatedKey = null;
  let delta = finalQty - currentQty;
  const isSaleLine = Boolean(existingItem?.selected_variant_snapshot?.sale?.is_on_sale) || Boolean(variantSnapshot?.sale?.is_on_sale);
  const isRentalLine =
    Boolean(existingItem?.selected_variant_snapshot?.rental?.is_rental) ||
    Boolean(variantSnapshot?.rental?.is_rental);

  const saleActiveLive = Boolean(variantSnapshot?.sale?.is_on_sale && !variantSnapshot?.sale?.disabled_by_admin);
  const saleQtyLive = Math.max(0, Number(variantSnapshot?.sale?.qty_available) || 0);

  const increaseAmount = Math.max(0, finalQty - currentQty);

  let salePortion = 0;
  if (increaseAmount > 0 && saleActiveLive) {
    salePortion = Math.min(increaseAmount, saleQtyLive);
  }
  const regularQtyToAdd = Math.max(0, increaseAmount - salePortion);

  let nextExistingQty = finalQty;
  if (increaseAmount > 0) {
    nextExistingQty = currentQty + salePortion;
    delta = nextExistingQty - currentQty;
  }

  // For decrements or set lower, keep previous delta and quantity
  if (mode === "decrement" || (mode === "set" && desiredQty < currentQty)) {
    nextExistingQty = finalQty;
    delta = finalQty - currentQty;
  }

  let deltaSale = 0;
  if (increaseAmount > 0) {
    deltaSale = salePortion;
  } else if (delta < 0 && isSaleLine) {
    deltaSale = delta;
  }

  let deltaInventory = 0;
  if (increaseAmount > 0) {
    deltaInventory = regularQtyToAdd;
  } else if (delta < 0 && !isSaleLine && !isRentalLine) {
    deltaInventory = delta;
  }

  const deltaRental = isRentalLine ? delta : 0;
  let inventoryMutationResult = {
    consumed: [],
    remainingReservations: existingInventoryReservations
  };

  const adjustedVariantSnapshot = (() => {
    const v = clone(variantSnapshot);
    if (!v) return v;

    // Update sale availability unless disabled by admin
    if (v.sale) {
      const adminDisabled = Boolean(v.sale.disabled_by_admin);
      if (!adminDisabled) {
        const startQty = Math.max(0, Number(v.sale.qty_available) || 0);
        const nextQty = Math.max(0, startQty - deltaSale);
        v.sale.qty_available = nextQty;
        v.sale.is_on_sale = nextQty > 0;
      }
    }

    // Update rental availability if limited stock
    if (v.rental && v.rental.is_rental && v.rental.limited_stock) {
      const startRent = Math.max(0, Number(v.rental.qty_available) || 0);
      const nextRent = Math.max(0, startRent - deltaRental);
      v.rental.qty_available = nextRent;
    }

    return v;
  })();

  /* -------------------------------------------------------
     Persist product stock changes when applicable
  ------------------------------------------------------- */
  let updatedVariant = adjustedVariantSnapshot;

  if (productRef && productSnapshot) {
    const updatedProduct = clone(productSnapshot);
    const variantsArr = Array.isArray(updatedProduct.variants) ? [...updatedProduct.variants] : [];
    const vIdx = variantsArr.findIndex((v) => String(v?.variant_id) === String(resolvedVariantId));
    if (vIdx >= 0) {
      const pv = clone(variantsArr[vIdx]) || {};

      if (pv.sale) {
        const adminDisabled = Boolean(pv.sale.disabled_by_admin);
        if (!adminDisabled) {
          const startSale = Math.max(0, Number(pv.sale.qty_available) || 0);
          const nextSale = Math.max(0, startSale - deltaSale);
          pv.sale.qty_available = nextSale;
          pv.sale.is_on_sale = nextSale > 0;
        }
      }

      if (pv.rental && pv.rental.is_rental && pv.rental.limited_stock) {
        const startRent = Math.max(0, Number(pv.rental.qty_available) || 0);
        const nextRent = Math.max(0, startRent - deltaRental);
        pv.rental.qty_available = nextRent;
      }

      if (!pv.rental?.is_rental) {
        inventoryMutationResult = applyInventoryDelta(pv, {
          deltaInventory,
          reservations: existingInventoryReservations
        });
      }

      variantsArr[vIdx] = pv;
      updatedVariant = pv;
      updatedProduct.variants = variantsArr;
      tx.update(productRef, {
        variants: variantsArr,
        "timestamps.updatedAt": now
      });
    }
  }

  if (mode === "remove" || nextExistingQty <= 0) {
    if (existingIndex >= 0) items.splice(existingIndex, 1);
  } else {
    const safeProductSnapshot = clone(productSnapshot);
    const safeVariantSnapshot = clone(originalVariantSnapshot);

    const line = {
      quantity: nextExistingQty,
      cart_item_key: cartItemKey,
      product_snapshot: safeProductSnapshot,
      selected_variant_snapshot: safeVariantSnapshot,
      line_totals: computeLineTotals(safeVariantSnapshot, nextExistingQty)
    };
    if (!safeVariantSnapshot?.sale?.is_on_sale && !safeVariantSnapshot?.rental?.is_rental) {
      line.inventory_reservations =
        deltaInventory < 0
          ? inventoryMutationResult.remainingReservations
          : existingInventoryReservations;
    }

    if (existingIndex >= 0) {
      items[existingIndex] = line;
    } else {
      items.push(line);
      generatedKey = cartItemKey;
    }
  }

  // Add overflow as regular-priced line if sale stock was insufficient
  if (regularQtyToAdd > 0 && (mode === "increment" || mode === "add" || mode === "set")) {
    const regularVariant = clone(variantSnapshot) || {};
    if (!regularVariant.sale) regularVariant.sale = {};
    regularVariant.sale.is_on_sale = false;
    // Try to merge with an existing non-sale line for this variant
    const existingRegularIdx = items.findIndex(
      (it) =>
        String(it?.selected_variant_snapshot?.variant_id || "") === String(resolvedVariantId) &&
        it?.selected_variant_snapshot?.sale?.is_on_sale === false
    );

    if (existingRegularIdx >= 0) {
      const line = items[existingRegularIdx];
      const nextQty = (Number(line?.quantity) || 0) + regularQtyToAdd;
      const mergedLine = {
        ...line,
        quantity: nextQty,
        selected_variant_snapshot: regularVariant,
        line_totals: computeLineTotals(regularVariant, nextQty),
        inventory_reservations: mergeInventoryReservations(
          line?.inventory_reservations,
          inventoryMutationResult.consumed
        )
      };
      items[existingRegularIdx] = mergedLine;
    } else {
      const newKey = makeCartItemKey(resolvedProductId, resolvedVariantId);
      const newLine = {
        quantity: regularQtyToAdd,
        cart_item_key: newKey,
        product_snapshot: clone(productSnapshot),
        selected_variant_snapshot: regularVariant,
        line_totals: computeLineTotals(regularVariant, regularQtyToAdd),
        inventory_reservations: normalizeInventoryReservations(inventoryMutationResult.consumed)
      };
      items.push(newLine);
      if (!generatedKey) generatedKey = newKey;
    }

    _ui = buildUiMessage({
      type: "warning",
      title: "Sale Depleted",
      message: `Sale stock unavailable; added ${regularQtyToAdd} at regular price.`
    });
  }

  /* -------------------------------------------------------
     recompute totals + persist
  ------------------------------------------------------- */
  const totals = computeCartTotals(items);
  const item_count = items.reduce((a, it) => a + (Number(it?.quantity) || 0), 0);

  const finalCart = {
    ...cart,
    cart: { ...baseCartInfo, channel },
    items,
    totals,
    item_count,
    cart_corrected: Boolean(capped && finalQty !== desiredQty) || regularQtyToAdd > 0,
    meta: {
      ...baseMeta,
      lastAction: `${mode}:${resolvedVariantId || cartItemKey || ""}`,
      source: channel || baseMeta?.source || "api"
    },
    timestamps: {
      ...baseTimestamps,
      createdAt: baseTimestamps?.createdAt || now,
      updatedAt: now
    }
  };

  tx.set(cartRef, finalCart, { merge: false });

  return {
    cart: finalCart,
    warnings: [],
    _ui,
    _generatedKey: generatedKey,
    updatedVariant
  };
}
