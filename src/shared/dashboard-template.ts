// SPDX-License-Identifier: Apache-2.0
//
// Dashboard page template. The page and its script are minified into one file
// by scripts/build-templates.mjs.
// The {{NONCE}} and {{BUILD}} placeholders are filled per response by renderDashboardPage().

import page from "./templates/generated/dashboard.html";

export const DASHBOARD_TEMPLATE = page;
