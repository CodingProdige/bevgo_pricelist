/**
 * validateDesiredQuantity()
 *
 * Compares LIVE Firestore state vs intended change
 * and determines whether the operation is allowed.
 *
 * Handles:
 *  - increment / add
 *  - decrement / remove
 *  - ignores stock rules when decrementing
 */

export function validateDesiredQuantity({
    liveState,
    snapshotVariant,
    desiredDelta
  }) {
  
    // Convert to number early
    desiredDelta = Number(desiredDelta || 0);
  
    const liveSale   = liveState?.sale   || {};
    const liveRental = liveState?.rental || {};
  
    const snapSale   = snapshotVariant?.sale   || {};
    const snapRental = snapshotVariant?.rental || {};
  
    let isSaleRequest   = liveSale.is_on_sale === true;
    let isRentalRequest = (!isSaleRequest && liveRental.is_rental === true);
  
    console.log("🧪 VALIDATE INPUT:", {
      liveSale,
      liveRental,
      snapSale,
      snapRental,
      desiredDelta
    });
  
    /* ======================================================
     * 1) NEGATIVE DELTA — ALWAYS ALLOWED
     * (remove qty)
     * ======================================================*/
    if (desiredDelta < 0) {
      const out = {
        allowed: true,
        resolution: "normal",
        reason: null,
        suggested_quantity: desiredDelta // don't alter
      };
      console.log("🧪 VALIDATE OUTPUT (DECREMENT):", out);
      return out;
    }
  
    /* ======================================================
     * 2) ZERO DELTA — NO BLOCKING
     * ======================================================*/
    if (desiredDelta === 0) {
      const out = {
        allowed: true,
        resolution: "normal",
        reason: null,
        suggested_quantity: null
      };
      console.log("🧪 VALIDATE OUTPUT:", out);
      return out;
    }
  
    /* ======================================================
     * 3) SALE REQUEST
     * ======================================================*/
    if (isSaleRequest) {
  
      // live sale turned off?
      if (!liveSale.is_on_sale) {
        const out = {
          allowed: false,
          reason: "SALE_NO_LONGER_ACTIVE",
          resolution: "normal",
          suggested_quantity: 0
        };
        console.log("🧪 VALIDATE OUTPUT:", out);
        return out;
      }
  
      // insufficient sale stock?
      if ((liveSale.qty_available ?? 0) < desiredDelta) {
        const out = {
          allowed: false,
          reason: "SALE_STOCK_TOO_LOW",
          resolution: "normal",
          suggested_quantity: liveSale.qty_available ?? 0
        };
        console.log("🧪 VALIDATE OUTPUT:", out);
        return out;
      }
  
      // sale allowed
      const out = {
        allowed: true,
        resolution: "sale",
        reason: null,
        suggested_quantity: desiredDelta
      };
      console.log("🧪 VALIDATE OUTPUT:", out);
      return out;
    }
  
    /* ======================================================
     * 4) RENTAL REQUEST
     * ======================================================*/
    if (isRentalRequest) {
  
      if (!liveRental.is_rental) {
        const out = {
          allowed: false,
          reason: "RENTAL_NO_LONGER_ACTIVE",
          resolution: "block",
          suggested_quantity: 0
        };
        console.log("🧪 VALIDATE OUTPUT:", out);
        return out;
      }
  
      if (liveRental.limited_stock) {
        if ((liveRental.qty_available ?? 0) < desiredDelta) {
          const out = {
            allowed: false,
            reason: "RENTAL_STOCK_TOO_LOW",
            resolution: "block",
            suggested_quantity: liveRental.qty_available ?? 0
          };
          console.log("🧪 VALIDATE OUTPUT:", out);
          return out;
        }
      }
  
      const out = {
        allowed: true,
        resolution: "rent",
        reason: null,
        suggested_quantity: desiredDelta
      };
      console.log("🧪 VALIDATE OUTPUT:", out);
      return out;
    }
  
    /* ======================================================
     * 5) NORMAL PRICING (NON-SALE)
     * ======================================================*/
    const out = {
      allowed: true,
      resolution: "normal",
      reason: null,
      suggested_quantity: desiredDelta
    };
    console.log("🧪 VALIDATE OUTPUT:", out);
    return out;
  }
  