/**
 * Central registry of every DOM selector the scraper relies on.
 *
 * IMPORTANT: these are best-guess starting points based on common UpPromote/
 * affiliate-dashboard UI conventions, NOT confirmed selectors. Per project spec
 * section 33/5, they must be verified against the real authenticated dashboard
 * before the scraper is trusted in production.
 *
 * Workflow to fill these in for real:
 *   1. Fill backend/.env with UPPROMOTE_EMAIL / UPPROMOTE_PASSWORD.
 *   2. Run `npm run inspect` from backend/ (SCRAPER_HEADLESS=false recommended).
 *   3. It logs in, opens the orders/commission section, and dumps:
 *        - backend/logs/inspect-dom.html   (full rendered HTML)
 *        - backend/logs/inspect-summary.json (candidate tables/columns/pagination)
 *   4. Update the values below to match what was actually found, then re-run
 *      `npm run inspect` (or a real sync) to confirm extraction is accurate.
 *
 * Every selector group has a `candidates` array — the scraper tries them in
 * order and uses the first one that matches, so small markup differences
 * don't break the whole pipeline while you dial these in.
 */
export const selectors = {
  login: {
    emailInput: ["input[type=email]", "input[name=email]", "#email"],
    passwordInput: ["input[type=password]", "input[name=password]", "#password"],
    submitButton: [
      "button[type=submit]",
      "text=Log in",
      "text=Login",
      "text=Sign in",
    ],
    loggedInIndicator: [
      "[data-testid=dashboard]",
      "text=Dashboard",
      "nav",
    ],
    mfaIndicator: ["text=verification code", "text=two-factor", "text=OTP"],
    captchaIndicator: ["iframe[src*=recaptcha]", "iframe[src*=hcaptcha]", "text=I'm not a robot"],
  },

  navigation: {
    // Sidebar/menu link(s) that lead to the orders/commission list.
    ordersNavLink: [
      "a:has-text('Orders')",
      "a:has-text('Commission')",
      "a:has-text('Referrals')",
    ],
  },

  ordersTable: {
    container: ["table", "[role=table]", "[data-testid=orders-table]"],
    rows: ["tbody tr", "[role=row]"],
    // Column selectors are resolved relative to a row (row.locator(...)).
    // Prefer header-driven mapping (see parser.js resolveColumnIndexes) over
    // fixed nth-child indexes wherever the header row is inspectable.
    headerRow: ["thead tr", "[role=row]:first-child"],
    headerCell: ["th", "[role=columnheader]"],
  },

  pagination: {
    nextButton: [
      "button:has-text('Next')",
      "a:has-text('Next')",
      "[aria-label='Next page']",
      "[data-testid=pagination-next]",
    ],
    pageNumbers: ["[data-testid=pagination] button", "nav[aria-label=pagination] a"],
    loadMoreButton: ["button:has-text('Load more')", "button:has-text('Show more')"],
    disabledAttr: "disabled",
    // Confirmed on the real hypdshop Commission page: a standard DataTables
    // "Show X entries" length control (`<select name="commission_datatables_length">`).
    // `_length` is DataTables' own fixed naming convention, not a guess.
    pageLengthSelect: ["select[name$='_length']", "div[id$='_length'] select"],
  },

  filters: {
    dateRangeInput: ["input[name*=date]", "[data-testid=date-range]"],
    statusDropdown: ["select[name*=status]", "[data-testid=status-filter]"],
  },
};

// Confirmed against the real hypdshop Commission table (backend/logs/inspect-summary.json,
// captured 2026-08-12): headers are Create at, Referral ID, Order number, Total sales,
// Quantity, Commission, Status, Source, Action. That page has exactly one "Status" column
// (commission status — Pending/Approved/Denied) and no separate order-status column at all.
export const COLUMN_ALIASES = {
  sourceOrderId: ["order id", "order #", "order no", "order number", "order"],
  referralId: ["referral id", "referral", "aff id"],
  orderDate: ["order date", "create at", "created at", "date", "created"],
  productName: ["product", "product name", "item"],
  quantity: ["qty", "quantity"],
  orderAmount: ["order amount", "order value", "sale amount", "total sales", "total"],
  commissionAmount: ["commission", "commission amount", "earning", "earnings"],
  // "status" is intentionally last/bare here so it only catches a lone "Status"
  // column (this page's case) after any more specific label has a chance to match.
  commissionStatus: ["commission status", "payout status", "status"],
  orderStatus: ["order status"],
  customerName: ["customer", "customer name", "buyer"],
  customerEmail: ["customer email", "email"],
  referenceId: ["reference id", "ref id", "reference"],
};
