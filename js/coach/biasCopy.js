// =============================================================================
// BIAS COPY — what the quiet after-trade note and its explainer say, in
// English and Hinglish, for each detector in biasCore.js.
//
// Reflection only: the note names the pattern and shows the user's own
// numbers. It never says what to buy or sell (SEBI: no advice). Every number
// comes from the detector's evidence, which is real data.
// =============================================================================

const pct = (x) => `${Math.abs(Number(x) || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
const days = (n) => (n === 1 ? "1 session" : `${n} sessions`);
const ago = (d, hi) => d == null ? null : d <= 0 ? (hi ? "aaj hi kharida" : "bought today")
  : hi ? `${d} din pehle kharida` : `bought ${d} day${d === 1 ? "" : "s"} ago`;
const nifty = (n, hi) => n == null ? null : hi ? `Nifty usi dauran ${n > 0 ? "+" : "−"}${pct(n)}` : `Nifty ${n > 0 ? "+" : "−"}${pct(n)} same days`;

export const BIAS_COPY = {
  panic_sell: {
    term: { en: "Panic selling", hi: "Panic selling" },
    note: (e, s) => ({
      en: `You sold ${e.sold_pct >= 99 ? "the whole position" : `${e.sold_pct}% of it`} right after a ${pct(e.drop_pct)} fall in ${days(e.drop_sessions)}. On a normal day ${s} moves about ±${pct(e.typical_day_pct)}. That pattern has a name.`,
      hi: `Tumne ${e.sold_pct >= 99 ? "poori position" : `${e.sold_pct}% position`} ${days(e.drop_sessions, true)} me ${pct(e.drop_pct)} girne ke turant baad bech di. Normal din me ${s} lagbhag ±${pct(e.typical_day_pct)} hilta hai. Is pattern ka ek naam hai.`,
    }),
    body: {
      en: "Selling because the price dropped fast, out of fear, without checking whether anything changed at the company. It often turns a dip into a locked-in loss.",
      hi: "Jab price tezi se girta hai aur hum dar ke maare bech dete hain, bina check kiye ki company me kuch badla ya nahi. Aksar isi se ek dip pakka loss ban jaata hai.",
    },
    chips: (e, hi) => [
      `−${pct(e.drop_pct)} ${hi ? `${days(e.drop_sessions)} me` : `in ${days(e.drop_sessions)}`}`,
      hi ? `Normal din: ±${pct(e.typical_day_pct)}` : `Usual day: ±${pct(e.typical_day_pct)}`,
      hi ? `Loss pe becha: −${pct(e.pl_pct)}` : `Sold at −${pct(e.pl_pct)}`,
      ago(e.holding_age_days, hi), nifty(e.nifty_pct, hi),
    ],
    question: {
      en: "Ask yourself: did something change at the company, or only the price?",
      hi: "Khud se pucho: company me kuch badla hai, ya sirf price?",
    },
  },

  fomo: {
    term: { en: "FOMO buying", hi: "FOMO buying" },
    note: (e, s) => ({
      en: `You bought ${s} after it ran up ${pct(e.run_up_pct)} in ${days(e.sessions)}. Buying because everyone else seems to be winning has a name.`,
      hi: `Tumne ${s} tab khareeda jab ye ${days(e.sessions, true)} me ${pct(e.run_up_pct)} chadh chuka tha. "Sab kama rahe hain, main reh na jaun" wali feeling ka ek naam hai.`,
    }),
    body: {
      en: "Fear of missing out: buying a stock mainly because its price has been rising fast, not because of what the business is worth. Late buyers often pay the top of the run.",
      hi: "Fear of missing out: kisi stock ko sirf isliye kharidna kyunki uska price tezi se badh raha hai, business ki value dekh ke nahi. Der se aane wale aksar top pe kharidte hain.",
    },
    chips: (e, hi) => [
      hi ? `${days(e.sessions, true)} me +${pct(e.run_up_pct)}` : `+${pct(e.run_up_pct)} in ${days(e.sessions)}`,
      hi ? `Normal din: ±${pct(e.typical_day_pct)}` : `Usual day: ±${pct(e.typical_day_pct)}`,
      nifty(e.nifty_pct, hi),
    ],
    question: {
      en: "If it had not gone up lately, would you still want it at this price?",
      hi: "Agar ye haal me nahi chadha hota, kya tab bhi is price pe lete?",
    },
  },

  pump_chase: {
    term: { en: "Chasing a spike", hi: "Spike ke peeche bhaagna" },
    note: (e, s) => ({
      en: `You bought ${s} on a day it was already up ${pct(e.intraday_gain_pct)}, several times its usual daily move. That is called chasing a spike.`,
      hi: `Tumne ${s} us din khareeda jab ye pehle se ${pct(e.intraday_gain_pct)} upar tha, normal din se kai guna zyada. Isse spike chase karna kehte hain.`,
    }),
    body: {
      en: "Jumping into a stock in the middle of a big one-day jump. Sharp spikes often come from news or hype, and part of the move frequently gives back in the next few days.",
      hi: "Ek din ke bade uchaal ke beech me stock me kood jaana. Aise spikes aksar news ya hype se aate hain, aur agle kuch dino me move ka hissa wapas bhi chala jaata hai.",
    },
    chips: (e, hi) => [
      hi ? `Aaj +${pct(e.intraday_gain_pct)}` : `+${pct(e.intraday_gain_pct)} today`,
      hi ? `Normal din: ±${pct(e.typical_day_pct)}` : `Usual day: ±${pct(e.typical_day_pct)}`,
    ],
    question: {
      en: "Do you know why it jumped today, and was that already in the price?",
      hi: "Pata hai aaj kyun uchla? Aur kya wo baat price me pehle se thi?",
    },
  },

  anchoring: {
    term: { en: "Averaging down", hi: "Averaging down" },
    note: (e, s) => ({
      en: `You bought more ${s} while it is ${pct(e.below_cost_pct)} below what you paid${e.earlier_adds_below_cost ? `, after ${e.earlier_adds_below_cost} earlier add${e.earlier_adds_below_cost === 1 ? "" : "s"} below cost` : ""}. It can be a plan, or anchoring to your buy price.`,
      hi: `Tumne ${s} aur khareeda jab ye tumhari buy price se ${pct(e.below_cost_pct)} neeche hai${e.earlier_adds_below_cost ? `, pehle bhi ${e.earlier_adds_below_cost} baar neeche add kiya` : ""}. Ye plan bhi ho sakta hai, ya apni buy price pe "anchor" ho jaana.`,
    }),
    body: {
      en: "Anchoring is treating the price you paid as the stock's \"real\" value and buying more to get your average down, so you can get back to even sooner. The market does not know or care what you paid.",
      hi: "Anchoring matlab apni buy price ko hi stock ki \"asli\" value maan lena, aur average neeche laane ke liye aur kharidte jaana taaki jaldi break-even ho. Market ko nahi pata tumne kitne me liya tha.",
    },
    chips: (e, hi) => [
      hi ? `Cost se −${pct(e.below_cost_pct)}` : `−${pct(e.below_cost_pct)} vs your cost`,
      e.earlier_adds_below_cost ? (hi ? `Pehle ${e.earlier_adds_below_cost} baar neeche add` : `${e.earlier_adds_below_cost} earlier adds below cost`) : null,
    ],
    question: {
      en: "If you did not own it yet, would you buy it today at this price?",
      hi: "Agar ye pehle se tumhare paas na hota, kya aaj is price pe khareedte?",
    },
  },

  concentration: {
    term: { en: "All eggs in one basket", hi: "Saare ande ek tokri me" },
    note: (e, s) => ({
      en: `${s} is now ${pct(e.concentration_pct)} of everything you have, cash included. One stock that big decides how your whole portfolio goes.`,
      hi: `${s} ab tumhare poore paise (cash milake) ka ${pct(e.concentration_pct)} hai. Itna bada ek stock poore portfolio ka haal tay karta hai.`,
    }),
    body: {
      en: "Concentration means a large share of your money rides on one stock. If that one company has a bad quarter, your whole portfolio feels it. Spreading across several companies softens any single surprise.",
      hi: "Concentration matlab paise ka bada hissa ek hi stock pe. Us ek company ka ek bura quarter aur poora portfolio hil jaata hai. Kai companies me baantne se kisi ek surprise ka jhatka kam lagta hai.",
    },
    chips: (e, hi) => [hi ? `Portfolio ka ${pct(e.concentration_pct)}` : `${pct(e.concentration_pct)} of your portfolio`],
    question: {
      en: "If this stock fell 20% tomorrow, how much of your portfolio would that take?",
      hi: "Agar ye kal 20% gire, to tumhare portfolio ka kitna hissa chala jaayega?",
    },
  },

  sector_concentration: {
    term: { en: "Sector concentration", hi: "Sector concentration" },
    note: (e) => ({
      en: `${pct(e.sector_pct)} of the money you have in stocks is now in ${e.top_sector}, across ${e.stocks_in_sector} stocks. Different names, same bet.`,
      hi: `Stocks me lage paise ka ${pct(e.sector_pct)} ab ${e.top_sector} me hai, ${e.stocks_in_sector} stocks me. Naam alag, bet ek hi.`,
    }),
    body: {
      en: "Companies in one sector rise and fall together: the same interest rates, the same government rules, the same demand. Owning several of them is closer to one big bet than it looks.",
      hi: "Ek sector ki companies saath me chadhti girti hain: wahi interest rates, wahi sarkari rules, wahi demand. Unme se kai lena dikhne se zyada ek hi badi bet jaisa hai.",
    },
    chips: (e, hi) => [hi ? `${e.top_sector}: ${pct(e.sector_pct)}` : `${e.top_sector}: ${pct(e.sector_pct)}`, hi ? `${e.stocks_in_sector} stocks` : `${e.stocks_in_sector} stocks`],
    question: {
      en: "What one piece of news would hit all of these at once?",
      hi: "Aisi kaunsi ek news hai jo in sab ko ek saath hila de?",
    },
  },

  disposition: {
    term: { en: "Selling winners, keeping losers", hi: "Jeetne wale becho, haarne wale rakho" },
    note: (e) => ({
      en: `You sold another winner while ${e.worst_loser} sits ${pct(e.worst_loser_pct)} down. Over 60 days that is ${e.winners_sold} winners sold to ${e.losers_sold} losers.`,
      hi: `Tumne ek aur profit wala stock becha jabki ${e.worst_loser} ${pct(e.worst_loser_pct)} neeche pada hai. 60 din me ${e.winners_sold} winners beche, ${e.losers_sold} losers.`,
    }),
    body: {
      en: "The disposition effect: booking gains early because it feels good, and holding losers because selling would make the loss \"real\". It is the most documented habit in retail investing.",
      hi: "Disposition effect: profit jaldi book karna kyunki accha lagta hai, aur loss wale ko pakde rehna kyunki bechne se loss \"pakka\" ho jaayega. Retail investors ki sabse zyada dekhi gayi aadat.",
    },
    chips: (e, hi) => [
      hi ? `${e.winners_sold} winners vs ${e.losers_sold} losers beche` : `${e.winners_sold} winners vs ${e.losers_sold} losers sold`,
      `${e.worst_loser} −${pct(e.worst_loser_pct)}`,
    ],
    question: {
      en: "Are you keeping the losers because of their prospects, or because selling would make the loss real?",
      hi: "Losers ko unke future ki wajah se rakh rahe ho, ya isliye ki bechne se loss pakka ho jaayega?",
    },
  },

  churning: {
    term: { en: "Churning", hi: "Churning" },
    note: (e, s) => ({
      en: `That is ${e.round_trips_30d} quick in-and-outs of ${s} in 30 days, each held under 5 days.`,
      hi: `30 din me ${s} me ${e.round_trips_30d} baar jaldi andar-bahar, har baar 5 din se kam.`,
    }),
    body: {
      en: "Churning is buying and selling the same stock again and again over short spells. In a real account every round trip pays brokerage and taxes, and short-term swings are mostly noise.",
      hi: "Churning matlab ek hi stock ko chhote time me baar baar khareedna bechna. Asli account me har round trip pe brokerage aur tax lagta hai, aur short-term swings zyaadatar noise hote hain.",
    },
    chips: (e, hi) => [hi ? `30 din me ${e.round_trips_30d} round trips` : `${e.round_trips_30d} round trips in 30 days`],
    question: {
      en: "What did you expect to happen in those few days each time?",
      hi: "Har baar un kuch dino me kya hone ki ummeed thi?",
    },
  },

  overtrading: {
    term: { en: "Overtrading", hi: "Overtrading" },
    note: (e) => ({
      en: `That is your ${e.trades_today}th trade today. Lots of trades in one day usually means reacting to the screen, not to a plan.`,
      hi: `Ye aaj ka tumhara ${e.trades_today}va trade hai. Ek din me itne trades aksar screen pe react karna hota hai, plan pe nahi.`,
    }),
    body: {
      en: "Overtrading is trading more often than your plan needs. Each decision made in a rush is one more chance to act on noise, and in a real account each one costs fees.",
      hi: "Overtrading matlab plan ki zaroorat se zyada trade karna. Har jaldi wala decision noise pe react karne ka ek aur mauka hai, aur asli account me har ek pe fees lagti hai.",
    },
    chips: (e, hi) => [hi ? `Aaj ${e.trades_today} trades` : `${e.trades_today} trades today`],
    question: {
      en: "Which of today's trades would you still make if you had to wait a day?",
      hi: "Agar ek din rukna padta, to aaj ke kaunse trades phir bhi karte?",
    },
  },
};

/** Everything the note and sheet show for one detector result. */
export function biasCopy(result, { name, hi = false } = {}) {
  const c = BIAS_COPY[result?.bias];
  if (!c) return null;
  const e = result.evidence || {};
  const lang = hi ? "hi" : "en";
  const term = c.term[lang];
  return {
    term,
    note: c.note(e, name || e.symbol || (hi ? "ye stock" : "this stock"))[lang],
    learn: hi ? `${term} kya hai?` : `What is ${term.toLowerCase().startsWith("all eggs") ? "\"all eggs in one basket\"" : term.toLowerCase()}?`,
    body: c.body[lang],
    chips: c.chips(e, hi).filter(Boolean),
    question: c.question[lang],
  };
}
