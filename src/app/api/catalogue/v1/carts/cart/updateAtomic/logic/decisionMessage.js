/**
 * decisionMessage()
 *
 * Converts mutation decision into UI feedback:
 *  - title
 *  - message
 *  - severity ("success" | "warning" | "error" | "info")
 *
 */

export function decisionMessage(decision) {

    console.log("🧠 decisionMessage INPUT:", JSON.stringify(decision, null, 2));
  
    const { allowed, resolution, reason, suggested_quantity, desiredDelta } = decision || {};
  
    // =========================
    // SPECIAL CASES (REMOVE ITEMS)
    // =========================
    if (desiredDelta < 0) {
      return {
        title: "Removed",
        message: "Item removed successfully.",
        severity: "info"
      };
    }
  
    // =========================
    // SUCCESS PATHS
    // =========================
    if (allowed === true && resolution === "sale") {
      return {
        title: "Sale Applied",
        message: "Item added at sale price.",
        severity: "success"
      };
    }
  
    if (allowed === true && resolution === "rent") {
      return {
        title: "Rental Applied",
        message: "Rental added successfully.",
        severity: "success"
      };
    }
  
    if (allowed === true && resolution === "normal") {
      return {
        title: "Added",
        message: "Item added successfully.",
        severity: "success"
      };
    }
  
    // =========================
    // FAILURE / WARNING PATHS
    // =========================
    if (reason === "SALE_STOCK_TOO_LOW") {
      return {
        title: "Insufficient Sale Stock",
        message: `Only ${suggested_quantity} sale units left.`,
        severity: "warning"
      };
    }
  
    if (reason === "SALE_NO_LONGER_ACTIVE") {
      return {
        title: "Sale Ended",
        message: "Sale no longer active. You may add at normal price.",
        severity: "warning"
      };
    }
  
    if (reason === "RENTAL_STOCK_TOO_LOW") {
      return {
        title: "Insufficient Rental Stock",
        message: `Only ${suggested_quantity} rental units available.`,
        severity: "warning"
      };
    }
  
    if (reason === "RENTAL_NO_LONGER_ACTIVE") {
      return {
        title: "Rental Ended",
        message: "Rental no longer available.",
        severity: "warning"
      };
    }
  
    // =========================
    // FALLBACK
    // =========================
    return {
      title: "Update Blocked",
      message: "Unable to process request.",
      severity: "error"
    };
  }
  