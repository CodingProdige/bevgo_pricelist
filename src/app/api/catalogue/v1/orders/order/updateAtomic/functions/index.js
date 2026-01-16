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

const makeCartItemKey = (productId, variantId) =>
  `cki_${String(productId || "p").slice(-4)}_${String(variantId || "v").slice(-4)}_${Date.now()
    .toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* -------------------------------------------------------
   Main transaction handler. Runs inside Firestore tx.
------------------------------------------------------- */
export async function updateOrderAtomic(tx, body) {
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) {
    throw { code: 400, title: "Missing Input", message: "orderId is required." };
  }

  const mode = String(body?.mode || "add").toLowerCase();
  if (!allowedModes.includes(mode)) {
    throw { code: 400, title: "Invalid Mode", message: `mode must be one of: ${allowedModes.join(", ")}` };
  }

  const productId = String(body?.productId || "").trim();
  const variantId = String(body?.variantId || "").trim();
  const providedKey = String(body?.cart_item_key ?? "").trim();
  const qtyInput = Number(body?.quantity);

  const orderRef = doc(db, "orders_v2", orderId);
  const orderSnap = await tx.get(orderRef);
  const now = nowIso();

  if (!orderSnap.exists()) {
    throw { code: 404, title: "Order Not Found", message: "Order could not be located." };
  }

  const order = orderSnap.data();
  if (!order?.order?.editable) {
    throw {
      code: 409,
      title: "Order Locked",
      message: order?.order?.editable_reason || "Order is not editable."
    };
  }

  const items = Array.isArray(order.items) ? [...order.items] : [];
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

  if (requireKey && !existingItem && mode !== "remove") {
    throw { code: 404, title: "Item Not Found", message: "Order item not found for provided key." };
  }

  /* -------------------------------------------------------
     shortcut remove if requested and nothing to delete
  ------------------------------------------------------- */
  if (mode === "remove" && !existingItem) {
    const totals = computeCartTotals(items);
    const finalOrder = {
      ...order,
      items,
      totals,
      timestamps: {
        ...order?.timestamps,
        createdAt: order?.timestamps?.createdAt || now,
        updatedAt: now
      }
    };

    tx.update(orderRef, {
      items,
      totals,
      "payment.required_amount_incl": totals.final_incl,
      "timestamps.updatedAt": now
    });

    return { order: finalOrder, warnings: [], _ui: null, _generatedKey: null };
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

  const shouldLoadProduct = mode !== "remove";
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
  const isRental = Boolean(variantSnapshot?.rental?.is_rental);

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

  if (isRental && desiredQty !== currentQty) {
    throw {
      code: 409,
      title: "Rental Locked",
      message: "Rental items cannot be modified after the order is created."
    };
  }

  const ignoreSale =
    Boolean(variantSnapshot?.sale?.disabled_by_admin) ||
    !variantSnapshot?.sale?.is_on_sale ||
    (variantSnapshot?.sale?.is_on_sale && Number(variantSnapshot?.sale?.qty_available) <= 0);

  const { quantity: finalQty, capped, available, reason } = capQuantity(variantSnapshot, desiredQty, {
    ignoreSale,
    supplierOOS
  });

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
      title: "Order Updated",
      message:
        mode === "add"
          ? "Item added to order."
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
  const increaseAmount =
    mode === "increment" || mode === "add"
      ? Math.max(0, Number(qtyInput) || 0)
      : mode === "set"
        ? Math.max(0, desiredQty - currentQty)
        : 0;

  let salePortion = 0;
  if (increaseAmount > 0 && saleActiveLive) {
    salePortion = Math.min(increaseAmount, saleQtyLive);
  }
  const regularQtyToAdd = increaseAmount > salePortion ? increaseAmount - salePortion : 0;

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
  const deltaRental = isRentalLine ? delta : 0;

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
        line_totals: computeLineTotals(regularVariant, nextQty)
      };
      items[existingRegularIdx] = mergedLine;
    } else {
      const newKey = makeCartItemKey(resolvedProductId, resolvedVariantId);
      const newLine = {
        quantity: regularQtyToAdd,
        cart_item_key: newKey,
        product_snapshot: clone(productSnapshot),
        selected_variant_snapshot: regularVariant,
        line_totals: computeLineTotals(regularVariant, regularQtyToAdd)
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

  const finalOrder = {
    ...order,
    items,
    totals,
    timestamps: {
      ...order?.timestamps,
      createdAt: order?.timestamps?.createdAt || now,
      updatedAt: now
    }
  };

  tx.update(orderRef, {
    items,
    totals,
    "payment.required_amount_incl": totals.final_incl,
    "timestamps.updatedAt": now
  });

  return {
    order: finalOrder,
    warnings: [],
    _ui,
    _generatedKey: generatedKey,
    updatedVariant
  };
}
