import assert from "node:assert/strict";
import {
  formatNseHolidayCalendar,
  isNseTradingDay,
  nseHolidayName,
} from "../js/data/nseCalendar.js";
import { lastSessionIst } from "../api/_session.js";

assert.equal(nseHolidayName("2026-10-20"), "Dussehra");
assert.equal(isNseTradingDay("2026-10-20", "Tue"), false);
assert.equal(nseHolidayName("2026-10-21"), "");
assert.equal(isNseTradingDay("2026-10-21", "Wed"), true);
assert.equal(isNseTradingDay("2026-10-21", "WEDNESDAY"), true);
assert.equal(isNseTradingDay("2026-10-24", "Saturday"), false);
assert.match(formatNseHolidayCalendar(), /2026-10-20: Dussehra/);
assert.doesNotMatch(formatNseHolidayCalendar(), /2026-10-21/);

const afterMidnightOnOct22 = lastSessionIst(new Date("2026-10-22T00:30:00+05:30").getTime());
assert.equal(afterMidnightOnOct22.ymd, "2026-10-21");
const beforeOpenOnOct21 = lastSessionIst(new Date("2026-10-21T08:00:00+05:30").getTime());
assert.equal(beforeOpenOnOct21.ymd, "2026-10-19");

console.log("NSE 2026 calendar regression checks passed.");
