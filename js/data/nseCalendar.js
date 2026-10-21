// NSE cash-market holidays from the official trading holiday master.
// Update from https://www.nseindia.com/api/holiday-master?type=trading.
export const NSE_HOLIDAYS_2026 = Object.freeze({
  "2026-01-15": "Municipal Corporation Election (Maharashtra)",
  "2026-01-26": "Republic Day",
  "2026-02-15": "Mahashivratri",
  "2026-03-03": "Holi",
  "2026-03-21": "Id-Ul-Fitr (Ramadan Eid)",
  "2026-03-26": "Shri Ram Navami",
  "2026-03-31": "Shri Mahavir Jayanti",
  "2026-04-03": "Good Friday",
  "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
  "2026-05-01": "Maharashtra Day",
  "2026-05-28": "Bakri Id",
  "2026-06-26": "Muharram",
  "2026-08-15": "Independence Day",
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-10-20": "Dussehra",
  "2026-11-08": "Diwali Laxmi Pujan",
  "2026-11-10": "Diwali-Balipratipada",
  "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
  "2026-12-25": "Christmas",
});

export function nseHolidayName(ymd) {
  return NSE_HOLIDAYS_2026[ymd] || "";
}

export function isNseTradingDay(ymd, weekday) {
  const day = String(weekday || "").toLowerCase().slice(0, 3);
  return day !== "sat" && day !== "sun" && !nseHolidayName(ymd);
}

export function formatNseHolidayCalendar() {
  return Object.entries(NSE_HOLIDAYS_2026)
    .map(([date, name]) => `${date}: ${name}`)
    .join("; ");
}
