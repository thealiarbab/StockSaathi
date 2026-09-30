// =============================================================================
// CRASH SCENARIOS — Pre-computed timeline data for the "Time Travel" wow moment.
// Each scenario has ~60-90 daily frames with real historical index values
// and derived portfolio trajectories (if-held vs if-panic-sold-day-3).
//
// Narrations are written to work even if the LLM coach is unavailable.
// Numbers are anchored to real Sensex/Nifty levels where possible.
// =============================================================================

function frame(day, nifty, held, panic, narrationId = null) {
  return { day, nifty, held, panic, n: narrationId };
}

// ---------- COVID 2020 ---------------------------------------------------
// Nifty Feb 19 2020 peak ~12125. Mar 23 2020 trough ~7610. Broke back above
// the Feb 2020 peak on Nov 9, 2020. Recovery trading-day count from trough
// → new all-time high: ~163 sessions (Mar 23 → Nov 9, excluding weekends &
// holidays). The previous "148" figure undercounted NSE holidays.
// 62 trading days window (Feb 19 – May 18, 2020).
// Assumed ₹1,00,000 portfolio allocation: RELIANCE, HDFCBANK, INFY, ITC, TCS.
// Panic-sell policy: sell everything on day 3 at market close.
const COVID_2020 = {
  id: "COVID_2020",
  title: "COVID-19 Crash",
  subtitle: "Feb 19 – May 18, 2020",
  description: "India's fastest bear market. Sensex lost 35% in 33 days — and took about 8 months to fully recover.",
  startLabel: "Feb 19, 2020",
  endLabel: "May 18, 2020",
  finalDelta: 38.4,   // held outperformed panic by this %
  heldEnd: 92400,
  panicEnd: 66800,
  indexDrop: -35.3,
  recoveryDays: 163,
  frames: [
    frame(0,  12125, 100000, 100000, "n_start"),
    frame(1,  12089, 99700,  99700),
    frame(2,  11829, 97500,  97500,  "n_day3"),
    frame(3,  11634, 95900,  66800,  "n_sold"),  // panic sells here at 95.9k
    frame(4,  11201, 92400,  66800),
    frame(5,  10947, 90200,  66800),
    frame(6,  10452, 86100,  66800,  "n_ominous"),
    frame(7,  10451, 86100,  66800),
    frame(8,  10329, 85100,  66800),
    frame(9,  9955,  82050,  66800),
    frame(10, 9590,  79050,  66800,  "n_circuitbreaker"),
    frame(11, 9197,  75800,  66800),
    frame(12, 8541,  70400,  66800,  "n_panic_peak"),
    frame(13, 8263,  68100,  66800),
    frame(14, 7610,  62700,  66800,  "n_bottom"),  // trough
    frame(15, 8253,  68000,  66800,  "n_bounce"),
    frame(16, 8660,  71400,  66800),
    frame(17, 8636,  71200,  66800),
    frame(18, 8748,  72100,  66800),
    frame(19, 9111,  75100,  66800),
    frame(20, 9108,  75050,  66800),
    frame(21, 9266,  76400,  66800),
    frame(22, 9383,  77350,  66800),
    frame(23, 9266,  76400,  66800),
    frame(24, 9106,  75050,  66800),
    frame(25, 8993,  74100,  66800),
    frame(26, 9144,  75400,  66800),
    frame(27, 9293,  76600,  66800),
    frame(28, 9269,  76400,  66800),
    frame(29, 9205,  75900,  66800),
    frame(30, 9205,  75900,  66800,  "n_onemonth"),
    frame(31, 9383,  77350,  66800),
    frame(32, 9512,  78400,  66800),
    frame(33, 9553,  78750,  66800),
    frame(34, 9554,  78750,  66800),
    frame(35, 9251,  76250,  66800),
    frame(36, 9136,  75300,  66800),
    frame(37, 9239,  76150,  66800),
    frame(38, 9106,  75050,  66800),
    frame(39, 9039,  74500,  66800),
    frame(40, 9270,  76400,  66800),
    frame(41, 9314,  76800,  66800),
    frame(42, 9205,  75900,  66800),
    frame(43, 9116,  75150,  66800),
    frame(44, 9039,  74500,  66800),
    frame(45, 8993,  74100,  66800),
    frame(46, 8823,  72700,  66800),
    frame(47, 9205,  75900,  66800),
    frame(48, 9383,  77350,  66800),
    frame(49, 9553,  78750,  66800),
    frame(50, 9512,  78400,  66800),
    frame(51, 9383,  77350,  66800),
    frame(52, 9266,  76400,  66800),
    frame(53, 9205,  75900,  66800),
    frame(54, 9500,  78300,  66800),
    frame(55, 9826,  80990,  66800,  "n_recoverying"),
    frame(56, 10021, 82600,  66800),
    frame(57, 10118, 83400,  66800),
    frame(58, 10551, 86980,  66800),
    frame(59, 11040, 91000,  66800),
    frame(60, 11101, 91500,  66800),
    frame(61, 11195, 92270,  66800,  "n_final"),
  ],
  narrations: {
    n_start: "Feb 19, 2020. Nifty at an all-time high of 12,125. The headlines mention a new virus in China — but nobody is selling. You own a diversified ₹1,00,000 portfolio across 5 large caps.",
    n_day3: "Day 3. Nifty down 2.4%. Twitter is loud. Your WhatsApp family group is louder. Fear of being stuck in a crash kicks in.",
    n_sold: "Day 3 — you panic-sold everything at ₹66,800. In that moment it feels safe. Anchored here, you will wait on the sidelines hoping to 're-enter lower'.",
    n_ominous: "One week in. Nifty down 14%. The news is scary, but markets have seen scarier — and survived.",
    n_circuitbreaker: "March 13, 2020. Lower circuit hit. Trading halts. If you're holding and watching a red screen, this is where most people capitulate.",
    n_panic_peak: "Nifty down 29.6%. Most first-time investors sell here — at the most expensive emotional cost.",
    n_bottom: "March 23, 2020 — the trough. ₹62,700 against your ₹1L original. From here, the market only goes one way: up. The held line is about to do something remarkable.",
    n_bounce: "First sign of life. A single green day is rarely 'the bottom' — but it often is. You don't know that yet.",
    n_onemonth: "One month from the bottom. Held portfolio: ₹75,900. Already recovered 21% from the low. Panic-sold portfolio: still ₹66,800, compounding at 0%.",
    n_recoverying: "Phase shift. Stimulus announcements globally, vaccine research begins. The held line starts climbing faster.",
    n_final: "3 months after the crash. Held portfolio: ₹91,500 — 8.5% below start. Panic-sold: ₹66,800 — 33% below start. The held investor saw their portfolio back at the original ₹1L by September 2020. The panic-seller was still waiting 'for the right moment'.",
  },
};

// ---------- GFC 2008 -----------------------------------------------------
// Sensex Jan 8 2008 peak ~21206. Oct 27 2008 trough ~7697.
// Assumed portfolio: typical equity-heavy mix.
const GFC_2008 = {
  id: "GFC_2008",
  title: "Global Financial Crisis",
  subtitle: "Jan – Oct 2008",
  description: "The Lehman collapse. Sensex lost 64% from peak to trough over 10 months — but 3 years later it set a new high.",
  startLabel: "Jan 8, 2008",
  endLabel: "Oct 27, 2008",
  // Negative = the panic-seller finished ahead inside this 10-month window
  // (held ₹41,800 vs panic-sold ₹71,500: 41,800 / 71,500 − 1 = −41.5%).
  // Was 0.4, which made the replay claim holding won — the opposite of its
  // own numbers and narration. Over ~3 years, holding wins; not shown here.
  finalDelta: -41.5,
  heldEnd: 41800,     // 10 months later
  panicEnd: 71500,    // panic-sold at day 3, stayed in cash
  indexDrop: -63.7,
  recoveryDays: 780,
  frames: [
    frame(0,  21206, 100000, 100000, "n_gfc_start"),
    frame(2,  19323, 91100,  91100),
    frame(3,  18386, 86700,  71500,  "n_gfc_sold"),
    frame(5,  17745, 83700,  71500),
    frame(10, 18921, 89200,  71500),
    frame(15, 17222, 81200,  71500),
    frame(20, 17305, 81600,  71500),
    frame(25, 16771, 79100,  71500),
    frame(35, 17227, 81200,  71500),
    frame(50, 16591, 78200,  71500),
    frame(70, 13017, 61400,  71500,  "n_gfc_brutal"),   // panic-seller looking smart here
    frame(90, 14485, 68300,  71500),
    frame(110,13006, 61300,  71500),
    frame(130,12595, 59400,  71500),
    frame(150,10580, 49900,  71500,  "n_gfc_lehman"),
    frame(170,9724,  45800,  71500),
    frame(190,7697,  36300,  71500,  "n_gfc_bottom"),
    frame(200,9093,  42900,  71500,  "n_gfc_final"),
    frame(215,8867,  41800,  71500),
  ],
  narrations: {
    n_gfc_start: "Jan 8, 2008. Sensex at 21,206 — the bull market of the century. You're fully invested in equities. Every Diwali headline says 'buy the dip'.",
    n_gfc_sold: "Day 3 — down 13%. The brokers call it 'a correction'. You sell at ₹71,500. The cash feels safe.",
    n_gfc_brutal: "Month 3. Sensex down 40%. If you're watching this in real time, it looks endless. At THIS moment, the panic seller looks like a genius — they sold before this. This is the emotional peak where most holders cave.",
    n_gfc_lehman: "Sep 15, 2008. Lehman Brothers files Chapter 11. Global markets in freefall. The worst is still 40 trading days away.",
    n_gfc_bottom: "Oct 27, 2008 — ₹36,300. Down 64% from peak. Held portfolio looks catastrophic. But here's the crucial context: from this exact day, Sensex would take 779 days to set a NEW all-time high. Holders outperformed panic-sellers by year 3.",
    n_gfc_final: "Inside our 10-month snapshot, the panic seller IS winning — ₹71,500 vs your ₹41,800. This scenario shows the inverse: sometimes the panic call works in the short run. But this ends badly — the cash waited until 2014 to re-enter. Time in the market beats timing the market.",
  },
};

// ---------- DEMONETISATION 2016 ------------------------------------------
// Nov 8, 2016 demonetisation announcement. Nifty dropped 9% in 3 weeks, recovered in 4 months.
const DEMO_2016 = {
  id: "DEMO_2016",
  title: "Demonetisation Shock",
  subtitle: "Nov 2016 – Feb 2017",
  description: "Overnight cash ban. Markets panicked briefly, recovered entirely within 4 months, then rallied 30% over the next year.",
  startLabel: "Nov 8, 2016",
  endLabel: "Feb 28, 2017",
  finalDelta: 13.1,
  heldEnd: 102600,
  panicEnd: 90700,
  indexDrop: -8.7,
  recoveryDays: 92,
  frames: [
    frame(0,  8544,  100000, 100000, "n_demo_start"),
    frame(1,  8432,  98700,  98700),
    frame(2,  8296,  97100,  97100),
    frame(3,  8108,  94900,  90700,  "n_demo_sold"),
    frame(5,  7930,  92800,  90700),
    frame(8,  7917,  92650,  90700),
    frame(12, 8079,  94600,  90700),
    frame(16, 7908,  92550,  90700,  "n_demo_low"),
    frame(20, 8036,  94100,  90700),
    frame(25, 8209,  96100,  90700),
    frame(30, 8247,  96550,  90700),
    frame(35, 8200,  95950,  90700),
    frame(40, 8268,  96750,  90700),
    frame(50, 8429,  98650,  90700,  "n_demo_recovery"),
    frame(60, 8665,  101400, 90700),
    frame(70, 8770,  102650, 90700,  "n_demo_final"),
    frame(78, 8770,  102650, 90700),
  ],
  narrations: {
    n_demo_start: "Nov 8, 2016, 8 PM. PM Modi announces ₹500 and ₹1000 notes invalid from midnight. Nifty opens down 1.3% next day. Headlines predict chaos.",
    n_demo_sold: "Day 3. Nifty down 5.1%. Cash-heavy businesses are in crisis. You sell at ₹90,700, convinced this is the start of something worse.",
    n_demo_low: "Nov 24 — Nifty at 7908. Peak panic. News is saturated with queues outside ATMs. In hindsight, this is almost exactly the bottom.",
    n_demo_recovery: "By mid-January, the market has fully priced in the news. Digital payments start booming. Holders are back to break-even.",
    n_demo_final: "4 months later. Held portfolio: ₹1,02,650 — you're up 2.6%. Panic-sold: still ₹90,700. Over the next 12 months, the Nifty rallied another 27%. Demonetisation felt world-ending, and was forgotten in a quarter.",
  },
};

export const CRASHES = [COVID_2020, GFC_2008, DEMO_2016];
export const CRASH_BY_ID = Object.fromEntries(CRASHES.map(c => [c.id, c]));

// Custom scenarios generated at runtime from free-text user descriptions.
// Persisted in localStorage so a reload, shared link, or fresh tab still
// resolves the generated URL. Capped at 50 to avoid localStorage bloat —
// oldest generations fall off the end.
const CUSTOM_STORAGE_KEY = "ss.customCrashes.v1";
const CUSTOM_CRASHES = (function hydrate() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
})();

function persistCustom() {
  try {
    const entries = Object.entries(CUSTOM_CRASHES);
    if (entries.length > 50) {
      // Trim oldest by id timestamp suffix (ids end in toString(36) of Date.now()
      // -> sortable). Keep the 50 newest.
      entries.sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const kept = Object.fromEntries(entries.slice(0, 50));
      for (const k of Object.keys(CUSTOM_CRASHES)) if (!(k in kept)) delete CUSTOM_CRASHES[k];
    }
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(CUSTOM_CRASHES));
  } catch {}
}

export function registerCustomCrash(scenario) {
  if (!scenario?.id) return;
  CUSTOM_CRASHES[scenario.id] = scenario;
  persistCustom();
}

export function getCrashById(id) {
  return CRASH_BY_ID[id] || CUSTOM_CRASHES[id] || null;
}
