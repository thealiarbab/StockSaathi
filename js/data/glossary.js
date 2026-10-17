// =============================================================================
// GLOSSARY — fixed, hand-written definitions for every term the stock and fund
// pages mark with termHtml(). aiExplainer.js reads these first and only asks
// /api/ai?op=explain for a term that is not here.
//
// These used to be written by the model, once per term, and served from
// ai_response_cache. Read on 17 Oct 2026, several were wrong for the page they
// sat on: "Option" on a fund page was explained as a derivatives contract,
// "Plan type" (Direct/Regular) as "lump sum or SIP", "AMFI code" as an ID for
// distributors, "Category" as snacks at a kirana store, and the 52-week ones
// quoted made-up Reliance prices. Every hover also cost a database read.
//
// Rules for entries: one or two short sentences a 14-year-old understands, no
// prices or numbers that look like real quotes, say what it means ON THIS
// PAGE. `hi` is Hinglish (Roman script) for the Hinglish setting.
// =============================================================================

const G = {
  // ---- Stock and ETF metrics ----------------------------------------------
  "market cap": {
    en: "The total value of all of a company's shares added together: share price × number of shares. Bigger companies have a bigger market cap.",
    hi: "Company ke saare shares ki total value: share price × shares ki ginti. Badi company, bada market cap.",
  },
  "p/e": {
    en: "Price-to-earnings: how many rupees people pay for every ₹1 the company earns in a year. A high P/E means investors expect a lot of growth (or the stock is pricey).",
    hi: "Price-to-earnings: company ke har ₹1 profit ke liye log kitne rupaye de rahe hain. High P/E matlab log zyada growth expect kar rahe hain (ya stock mehenga hai).",
  },
  "p/e ratio": "p/e",
  "p/e ratio (ttm)": {
    en: "Price-to-earnings using the last 12 months of profit (TTM = trailing twelve months): how many rupees people pay for every ₹1 the company earned.",
    hi: "Pichle 12 mahine ke profit par P/E (TTM = trailing twelve months): har ₹1 kamai ke liye log kitne rupaye de rahe hain.",
  },
  "p/b ratio": {
    en: "Price-to-book: the share price compared with what the company's assets are worth on paper after paying its debts. Below 1 means the market values it at less than its books say.",
    hi: "Price-to-book: share price ko company ki books wali value (assets minus debt) se compare karta hai. 1 se kam matlab market use books se kam aank raha hai.",
  },
  "dividend yield": {
    en: "The cash a company paid out to shareholders over a year, as a percentage of today's share price. It's like the interest you get just for holding the share.",
    hi: "Saal bhar mein company ne shareholders ko jo cash diya, use aaj ke share price ke percent mein. Share rakhne ka 'interest' samjho.",
  },
  "beta": {
    en: "How much the stock tends to swing compared with the whole market. Beta 1 moves with the market, above 1 swings more, below 1 swings less.",
    hi: "Stock poore market ke mukable kitna upar-neeche hota hai. Beta 1 = market jaisa, 1 se zyada = zyada jhatke, 1 se kam = kam jhatke.",
  },
  "52-week high": {
    en: "The highest price the stock traded at in the last 12 months.",
    hi: "Pichle 12 mahino mein stock ka sabse ooncha price.",
  },
  "52-week low": {
    en: "The lowest price the stock traded at in the last 12 months.",
    hi: "Pichle 12 mahino mein stock ka sabse neecha price.",
  },
  "50-day moving average": {
    en: "The average closing price over the last 50 trading days. It smooths out daily noise so you can see the short-term trend.",
    hi: "Pichle 50 trading dino ka average closing price. Roz ke utaar-chadhaav ko smooth karke short-term trend dikhata hai.",
  },
  "200-day moving average": {
    en: "The average closing price over the last 200 trading days, roughly 10 months. It shows the long-term trend.",
    hi: "Pichle 200 trading dino (lagbhag 10 mahine) ka average closing price. Long-term trend dikhata hai.",
  },
  "eps": {
    en: "Earnings per share: the company's profit over the last 12 months divided by its number of shares. It's how much profit each share 'earned'.",
    hi: "Earnings per share: pichle 12 mahine ka profit ÷ shares ki ginti. Har share ne kitna profit 'kamaya'.",
  },
  "risk tier": {
    en: "StockSaathi's rough Low / Med / High label for how much this can swing in value. It's a simple guide to help you compare, not an official rating.",
    hi: "StockSaathi ka simple Low / Med / High label ki iski value kitni upar-neeche ho sakti hai. Compare karne ke liye guide hai, official rating nahi.",
  },
  "type": {
    en: "What kind of investment this is. An ETF (exchange traded fund) is a basket of stocks you can buy and sell on the exchange like a single share.",
    hi: "Yeh kis tarah ka investment hai. ETF (exchange traded fund) stocks ki ek tokri hai jise aap ek share ki tarah exchange par khareed-bech sakte ho.",
  },
  "drawdown": {
    en: "How far the value fell from its highest point before it recovered. A 20% drawdown means it dropped 20% from its peak at the worst moment.",
    hi: "Value apne sabse oonche point se kitna neeche giri. 20% drawdown matlab peak se sabse bure waqt 20% gira.",
  },

  // ---- Mutual fund page ---------------------------------------------------
  "current nav": {
    en: "Net asset value: the price of one unit of the fund, worked out once per business day from the value of everything the fund owns.",
    hi: "Net asset value: fund ki ek unit ki keemat, jo har business day fund ki saari holdings ki value se nikali jaati hai.",
  },
  "nav date": {
    en: "The day the NAV shown here was calculated. Funds publish a new NAV after each business day, not live during the day.",
    hi: "Jis din yeh NAV calculate hua. Funds har business day ke baad naya NAV dete hain, din bhar live nahi.",
  },
  "category": {
    en: "The kind of fund, by what it invests in: for example equity (shares), debt (bonds and loans), hybrid (a mix) or index (copies an index like the Nifty 50).",
    hi: "Fund kis cheez mein paisa lagata hai: jaise equity (shares), debt (bonds/loans), hybrid (mix) ya index (Nifty 50 jaise index ko copy karta hai).",
  },
  "plan type": {
    en: "Direct or Regular. A Direct plan is bought straight from the fund company and charges a lower fee. A Regular plan is sold through an agent, who is paid from a higher fee.",
    hi: "Direct ya Regular. Direct plan seedha fund company se, fee kam. Regular plan agent ke through, jiski commission zyada fee mein se jaati hai.",
  },
  "option": {
    en: "What happens to the fund's profits. Growth keeps them invested so the NAV grows. IDCW (dividend) pays some out to you from time to time.",
    hi: "Fund ke profit ka kya hota hai. Growth mein profit wapas invest hota hai aur NAV badhta hai. IDCW (dividend) mein beech-beech mein kuch paisa aapko milta hai.",
  },
  "amc": {
    en: "Asset management company: the company that runs the mutual fund and decides where its money is invested.",
    hi: "Asset management company: woh company jo mutual fund chalati hai aur decide karti hai paisa kahan lagana hai.",
  },
  "benchmark": {
    en: "The index the fund compares itself with, like the Nifty 50. If the fund does better than its benchmark, the manager beat the market it targets.",
    hi: "Woh index jisse fund apni performance compare karta hai, jaise Nifty 50. Fund benchmark se aage = manager ne apne market ko beat kiya.",
  },
  "amfi code": {
    en: "The fund's ID number from AMFI, the industry body of Indian mutual funds. Every plan and option of every fund has its own code.",
    hi: "AMFI (Indian mutual funds ki industry body) ka diya hua fund ka ID number. Har fund ke har plan aur option ka alag code hota hai.",
  },
  "isin (growth)": {
    en: "The 12-character international ID of this fund's Growth option, used by banks, brokers and depositories to identify it exactly.",
    hi: "Is fund ke Growth option ka 12-character international ID, jisse banks, brokers aur depositories ise exact pehchaante hain.",
  },
  "scheme type": {
    en: "Open-ended funds let you buy or sell units any business day. Close-ended funds take money only at launch and run for a fixed period.",
    hi: "Open-ended fund mein kisi bhi business day units khareed-bech sakte ho. Close-ended fund sirf launch par paisa leta hai aur fixed time tak chalta hai.",
  },
  "risk-o-meter": {
    en: "SEBI's required risk label for every mutual fund, from Low to Very High, based on what the fund holds. Higher means bigger possible ups and downs.",
    hi: "Har mutual fund par SEBI ka zaroori risk label, Low se Very High tak, fund ki holdings ke hisaab se. Jitna upar, utne bade utaar-chadhaav ho sakte hain.",
  },

  // ---- Corporate actions ---------------------------------------------------
  "interim dividend record date": {
    en: "The cut-off date for a dividend paid before the year ends. You get it only if you are on the company's list of shareholders on that date.",
    hi: "Saal khatam hone se pehle diye gaye dividend ki cut-off date. Us din aap company ki shareholders list mein ho tabhi dividend milega.",
  },
};

/** Fixed definition for `term` in `lang` ("hi" or "en"), or null if not in the glossary. */
export function glossaryLookup(term, lang = "en") {
  let e = G[String(term || "").trim().toLowerCase()];
  if (typeof e === "string") e = G[e];
  if (!e) return null;
  return (lang === "hi" && e.hi) || e.en;
}
