// =============================================================================
// CRASH SCENARIOS — the three curated "Time Travel" replays.
//
// Every frame is a real daily Nifty 50 close (Yahoo Finance ^NSEI).
// Regenerate with `python scripts/build_crash_frames.py`, which also prints
// the summary numbers below; the narrations are hand-written around them and
// must only state figures the frames support.
//
// Model, identical for all three:
// - ₹1,00,000 that moves exactly with the Nifty 50 (no dividends, no costs).
// - The panic-seller sells everything at the close of trading day 3 and sits
//   in cash (no interest) until the end of the window.
// - finalDelta: how far the winner finished ahead, as % of the loser's value.
//   Positive = holding won, negative = panic-selling won.
// - recoveryDays: trading days from the lowest close to the first close back
//   at or above the day-0 close (can fall after the window ends).
// scripts/prerender.py checks these invariants on every build.
// =============================================================================

function frame(day, nifty, held, panic, narrationId = null) {
  return { day, nifty, held, panic, n: narrationId };
}

const COVID_2020 = {
  id: "COVID_2020",
  title: "COVID-19 Crash",
  subtitle: "Feb – Nov 2020",
  description: "The pandemic crash. The Nifty 50 fell 37% in 33 days, then took until November 2020 to climb back.",
  startLabel: "Feb 19, 2020",
  endLabel: "Nov 9, 2020",
  finalDelta: 5.6,
  heldEnd: 102764,
  panicEnd: 97295,
  indexDrop: -37.2,
  recoveryDays: 157,
  frames: [
    frame(0, 12125.9, 100000, 100000, "n_start"),  // 2020-02-19
    frame(1, 12080.85, 99628, 99628),  // 2020-02-20
    frame(2, 11829.4, 97555, 97555, "n_day2"),  // 2020-02-24
    frame(3, 11797.9, 97295, 97295, "n_sold"),  // 2020-02-25
    frame(4, 11678.5, 96310, 97295),  // 2020-02-26
    frame(5, 11633.3, 95938, 97295),  // 2020-02-27
    frame(6, 11201.75, 92379, 97295),  // 2020-02-28
    frame(7, 11132.75, 91810, 97295),  // 2020-03-02
    frame(8, 11303.3, 93216, 97295),  // 2020-03-03
    frame(9, 11251, 92785, 97295),  // 2020-03-04
    frame(10, 11269, 92933, 97295),  // 2020-03-05
    frame(11, 10989.45, 90628, 97295),  // 2020-03-06
    frame(12, 10451.45, 86191, 97295),  // 2020-03-09
    frame(13, 10458.4, 86248, 97295),  // 2020-03-11
    frame(14, 9590.15, 79088, 97295, "n_pandemic"),  // 2020-03-12
    frame(15, 9955.2, 82099, 97295, "n_circuitbreaker"),  // 2020-03-13
    frame(16, 9197.4, 75849, 97295),  // 2020-03-16
    frame(17, 8967.05, 73950, 97295),  // 2020-03-17
    frame(18, 8468.8, 69841, 97295),  // 2020-03-18
    frame(19, 8263.45, 68147, 97295),  // 2020-03-19
    frame(20, 8745.45, 72122, 97295),  // 2020-03-20
    frame(21, 7610.25, 62760, 97295, "n_bottom"),  // 2020-03-23
    frame(22, 7801.05, 64334, 97295),  // 2020-03-24
    frame(23, 8317.85, 68596, 97295, "n_bounce"),  // 2020-03-25
    frame(24, 8641.45, 71264, 97295),  // 2020-03-26
    frame(25, 8660.25, 71419, 97295),  // 2020-03-27
    frame(26, 8281.1, 68293, 97295),  // 2020-03-30
    frame(27, 8597.75, 70904, 97295),  // 2020-03-31
    frame(28, 8253.8, 68068, 97295),  // 2020-04-01
    frame(29, 8083.8, 66666, 97295),  // 2020-04-03
    frame(30, 8792.2, 72508, 97295),  // 2020-04-07
    frame(31, 8748.75, 72149, 97295),  // 2020-04-08
    frame(32, 9111.9, 75144, 97295),  // 2020-04-09
    frame(33, 8993.85, 74171, 97295),  // 2020-04-13
    frame(34, 8925.3, 73605, 97295),  // 2020-04-15
    frame(35, 8992.8, 74162, 97295),  // 2020-04-16
    frame(36, 9266.75, 76421, 97295),  // 2020-04-17
    frame(37, 9261.85, 76381, 97295),  // 2020-04-20
    frame(38, 8981.45, 74068, 97295),  // 2020-04-21
    frame(39, 9187.3, 75766, 97295),  // 2020-04-22
    frame(40, 9313.9, 76810, 97295),  // 2020-04-23
    frame(43, 9380.9, 77363, 97295),  // 2020-04-28
    frame(46, 9293.5, 76642, 97295),  // 2020-05-04
    frame(49, 9199.05, 75863, 97295),  // 2020-05-07
    frame(52, 9196.55, 75842, 97295),  // 2020-05-12
    frame(55, 9136.85, 75350, 97295),  // 2020-05-15
    frame(56, 8823.25, 72764, 97295, "n_twomonths"),  // 2020-05-18
    frame(58, 9066.55, 74770, 97295),  // 2020-05-20
    frame(61, 9029.05, 74461, 97295),  // 2020-05-26
    frame(64, 9580.3, 79007, 97295),  // 2020-05-29
    frame(67, 10061.55, 82976, 97295),  // 2020-06-03
    frame(70, 10167.45, 83849, 97295),  // 2020-06-08
    frame(73, 9902, 81660, 97295),  // 2020-06-11
    frame(76, 9914, 81759, 97295),  // 2020-06-16
    frame(79, 10244.4, 84484, 97295),  // 2020-06-19
    frame(82, 10305.3, 84986, 97295),  // 2020-06-24
    frame(85, 10312.4, 85044, 97295),  // 2020-06-29
    frame(88, 10551.7, 87018, 97295),  // 2020-07-02
    frame(91, 10799.65, 89063, 97295),  // 2020-07-07
    frame(94, 10768.05, 88802, 97295),  // 2020-07-10
    frame(97, 10618.2, 87566, 97295),  // 2020-07-15
    frame(100, 11022.2, 90898, 97295),  // 2020-07-20
    frame(103, 11215.45, 92492, 97295),  // 2020-07-23
    frame(106, 11300.55, 93193, 97295),  // 2020-07-28
    frame(109, 11073.45, 91321, 97295),  // 2020-07-31
    frame(112, 11101.65, 91553, 97295),  // 2020-08-05
    frame(115, 11270.15, 92943, 97295),  // 2020-08-10
    frame(118, 11300.45, 93193, 97295),  // 2020-08-13
    frame(121, 11385.35, 93893, 97295),  // 2020-08-18
    frame(124, 11371.6, 93779, 97295),  // 2020-08-21
    frame(127, 11549.6, 95247, 97295),  // 2020-08-26
    frame(130, 11387.5, 93911, 97295, "n_august"),  // 2020-08-31
    frame(133, 11527.45, 95065, 97295),  // 2020-09-03
    frame(136, 11317.35, 93332, 97295),  // 2020-09-08
    frame(139, 11464.45, 94545, 97295),  // 2020-09-11
    frame(142, 11604.55, 95701, 97295),  // 2020-09-16
    frame(145, 11250.55, 92781, 97295),  // 2020-09-21
    frame(148, 10805.55, 89111, 97295),  // 2020-09-24
    frame(151, 11222.4, 92549, 97295),  // 2020-09-29
    frame(154, 11503.35, 94866, 97295),  // 2020-10-05
    frame(157, 11834.6, 97598, 97295),  // 2020-10-08
    frame(160, 11934.5, 98422, 97295),  // 2020-10-13
    frame(163, 11762.45, 97003, 97295),  // 2020-10-16
    frame(166, 11937.65, 98448, 97295),  // 2020-10-21
    frame(169, 11767.75, 97046, 97295),  // 2020-10-26
    frame(172, 11670.8, 96247, 97295),  // 2020-10-29
    frame(175, 11813.5, 97424, 97295),  // 2020-11-03
    frame(178, 12263.55, 101135, 97295, "n_recovered"),  // 2020-11-06
    frame(179, 12461.05, 102764, 97295, "n_final"),  // 2020-11-09
  ],
  // Real trading date of each frame, same order.
  dates: ["2020-02-19", "2020-02-20", "2020-02-24", "2020-02-25", "2020-02-26", "2020-02-27", "2020-02-28", "2020-03-02", "2020-03-03", "2020-03-04", "2020-03-05", "2020-03-06", "2020-03-09", "2020-03-11", "2020-03-12", "2020-03-13", "2020-03-16", "2020-03-17", "2020-03-18", "2020-03-19", "2020-03-20", "2020-03-23", "2020-03-24", "2020-03-25", "2020-03-26", "2020-03-27", "2020-03-30", "2020-03-31", "2020-04-01", "2020-04-03", "2020-04-07", "2020-04-08", "2020-04-09", "2020-04-13", "2020-04-15", "2020-04-16", "2020-04-17", "2020-04-20", "2020-04-21", "2020-04-22", "2020-04-23", "2020-04-28", "2020-05-04", "2020-05-07", "2020-05-12", "2020-05-15", "2020-05-18", "2020-05-20", "2020-05-26", "2020-05-29", "2020-06-03", "2020-06-08", "2020-06-11", "2020-06-16", "2020-06-19", "2020-06-24", "2020-06-29", "2020-07-02", "2020-07-07", "2020-07-10", "2020-07-15", "2020-07-20", "2020-07-23", "2020-07-28", "2020-07-31", "2020-08-05", "2020-08-10", "2020-08-13", "2020-08-18", "2020-08-21", "2020-08-26", "2020-08-31", "2020-09-03", "2020-09-08", "2020-09-11", "2020-09-16", "2020-09-21", "2020-09-24", "2020-09-29", "2020-10-05", "2020-10-08", "2020-10-13", "2020-10-16", "2020-10-21", "2020-10-26", "2020-10-29", "2020-11-03", "2020-11-06", "2020-11-09"],
  narrations: {
    n_start: "19 Feb 2020. The Nifty 50 closes at 12,125.9, about 2% below the record it set in January. The news mentions a new virus in China, but nobody is selling. Your ₹1,00,000 is invested across the Nifty 50.",
    n_day2: "Day 2. The Nifty falls 2.1% in one session. Cases are rising outside China, and your family WhatsApp group is getting loud.",
    n_sold: "Day 3. The Nifty is 2.7% below where you started. You sell everything at the close and keep ₹97,295 in cash. From here, the panic-sold line stays flat.",
    n_pandemic: "12 Mar. The day after the WHO calls COVID-19 a pandemic, the Nifty falls 8.3% in a single session. It is now 20.9% below your start.",
    n_circuitbreaker: "13 Mar. The market falls 10% within minutes of opening, hits the lower circuit, and trading halts for 45 minutes. Then it turns and closes 3.8% up. Days like this are when most people give up.",
    n_bottom: "23 Mar. The Nifty drops 13% in a day and closes at 7,610.25, 37.2% below your start, 33 days after it began. Held portfolio: ₹62,760. Nobody knows yet that this is the bottom.",
    n_bounce: "25 Mar. The Nifty jumps 6.6% in one session. One green day proves nothing, but this is where the recovery starts.",
    n_twomonths: "18 May. Two months on, the held portfolio is ₹72,764, still 27% down. The panic-seller's ₹97,295 in cash looks like the smart call.",
    n_august: "31 Aug. Held: ₹93,911. The gap to the panic-seller's ₹97,295 has almost closed, and the market has not stopped climbing.",
    n_recovered: "6 Nov. The Nifty closes above its 19 Feb level for the first time, 157 trading days after the bottom. The held portfolio is back above ₹1,00,000.",
    n_final: "9 Nov 2020. The Nifty closes at a record 12,461. Held: ₹1,02,764. Panic-sold: ₹97,295 in cash. Selling on day 3 dodged the crash but missed the whole recovery, and holding finished 5.6% ahead. The gap kept growing: the Nifty ended 2020 at 13,981.75.",
  },
};

const GFC_2008 = {
  id: "GFC_2008",
  title: "Global Financial Crisis",
  subtitle: "Jan – Oct 2008",
  description: "The Lehman-era crash. The Nifty 50 lost 60% between January and October 2008: the replay where selling early really did win.",
  startLabel: "Jan 8, 2008",
  endLabel: "Oct 27, 2008",
  finalDelta: -145.6,
  heldEnd: 40144,
  panicEnd: 98604,
  indexDrop: -59.9,
  recoveryDays: 496,
  frames: [
    frame(0, 6287.85, 100000, 100000, "n_gfc_start"),  // 2008-01-08
    frame(1, 6272, 99748, 99748),  // 2008-01-09
    frame(2, 6156.95, 97918, 97918),  // 2008-01-10
    frame(3, 6200.1, 98604, 98604, "n_gfc_sold"),  // 2008-01-11
    frame(4, 6206.8, 98711, 98604),  // 2008-01-14
    frame(5, 6074.25, 96603, 98604),  // 2008-01-15
    frame(6, 5935.75, 94400, 98604),  // 2008-01-16
    frame(7, 5913.2, 94042, 98604),  // 2008-01-17
    frame(8, 5705.3, 90735, 98604),  // 2008-01-18
    frame(9, 5208.8, 82839, 98604),  // 2008-01-21
    frame(10, 4899.3, 77917, 98604, "n_gfc_halt"),  // 2008-01-22
    frame(11, 5203.4, 82753, 98604),  // 2008-01-23
    frame(12, 5033.45, 80050, 98604),  // 2008-01-24
    frame(13, 5383.35, 85615, 98604),  // 2008-01-25
    frame(14, 5274.1, 83878, 98604),  // 2008-01-28
    frame(15, 5280.8, 83984, 98604),  // 2008-01-29
    frame(16, 5167.6, 82184, 98604),  // 2008-01-30
    frame(20, 5483.9, 87214, 98604),  // 2008-02-05
    frame(24, 4857, 77244, 98604),  // 2008-02-11
    frame(28, 5302.9, 84336, 98604),  // 2008-02-15
    frame(32, 5191.8, 82569, 98604),  // 2008-02-21
    frame(36, 5268.4, 83787, 98604),  // 2008-02-27
    frame(40, 4864.25, 77360, 98604),  // 2008-03-04
    frame(44, 4865.9, 77386, 98604),  // 2008-03-11
    frame(48, 4503.1, 71616, 98604, "n_gfc_bear"),  // 2008-03-17
    frame(52, 4877.5, 77570, 98604),  // 2008-03-25
    frame(56, 4734.5, 75296, 98604),  // 2008-03-31
    frame(60, 4647, 73904, 98604),  // 2008-04-04
    frame(64, 4733, 75272, 98604),  // 2008-04-10
    frame(68, 4958.4, 78857, 98604),  // 2008-04-17
    frame(72, 4999.85, 79516, 98604),  // 2008-04-24
    frame(76, 5165.9, 82157, 98604),  // 2008-04-30
    frame(80, 5135.5, 81673, 98604),  // 2008-05-07
    frame(84, 4957.8, 78847, 98604),  // 2008-05-13
    frame(88, 5104.95, 81188, 98604),  // 2008-05-20
    frame(92, 4875.05, 77531, 98604),  // 2008-05-26
    frame(96, 4870.1, 77453, 98604),  // 2008-05-30
    frame(100, 4676.95, 74381, 98604),  // 2008-06-05
    frame(104, 4523.6, 71942, 98604),  // 2008-06-11
    frame(108, 4653, 74000, 98604),  // 2008-06-17
    frame(112, 4266.4, 67851, 98604),  // 2008-06-23
    frame(116, 4136.65, 65788, 98604),  // 2008-06-27
    frame(120, 3925.75, 62434, 98604),  // 2008-07-03
    frame(124, 4157.1, 66113, 98604),  // 2008-07-09
    frame(128, 3861.1, 61406, 98604),  // 2008-07-15
    frame(132, 4159.5, 66151, 98604),  // 2008-07-21
    frame(136, 4311.85, 68574, 98604),  // 2008-07-25
    frame(140, 4332.95, 68910, 98604),  // 2008-07-31
    frame(144, 4517.55, 71846, 98604),  // 2008-08-06
    frame(148, 4552.25, 72398, 98604),  // 2008-08-12
    frame(152, 4368.25, 69471, 98604),  // 2008-08-19
    frame(156, 4335.35, 68948, 98604),  // 2008-08-25
    frame(160, 4360, 69340, 98604),  // 2008-08-29
    frame(164, 4352.3, 69218, 98604),  // 2008-09-05
    frame(168, 4290.3, 68232, 98604),  // 2008-09-11
    frame(170, 4072.9, 64774, 98604, "n_gfc_lehman"),  // 2008-09-15
    frame(172, 4008.25, 63746, 98604),  // 2008-09-17
    frame(176, 4126.9, 65633, 98604),  // 2008-09-23
    frame(180, 3850.05, 61230, 98604),  // 2008-09-29
    frame(184, 3602.35, 57291, 98604),  // 2008-10-06
    frame(188, 3490.7, 55515, 98604),  // 2008-10-13
    frame(192, 3074.35, 48894, 98604),  // 2008-10-17
    frame(196, 2943.15, 46807, 98604),  // 2008-10-23
    frame(198, 2524.2, 40144, 98604, "n_gfc_bottom"),  // 2008-10-27
  ],
  // Real trading date of each frame, same order.
  dates: ["2008-01-08", "2008-01-09", "2008-01-10", "2008-01-11", "2008-01-14", "2008-01-15", "2008-01-16", "2008-01-17", "2008-01-18", "2008-01-21", "2008-01-22", "2008-01-23", "2008-01-24", "2008-01-25", "2008-01-28", "2008-01-29", "2008-01-30", "2008-02-05", "2008-02-11", "2008-02-15", "2008-02-21", "2008-02-27", "2008-03-04", "2008-03-11", "2008-03-17", "2008-03-25", "2008-03-31", "2008-04-04", "2008-04-10", "2008-04-17", "2008-04-24", "2008-04-30", "2008-05-07", "2008-05-13", "2008-05-20", "2008-05-26", "2008-05-30", "2008-06-05", "2008-06-11", "2008-06-17", "2008-06-23", "2008-06-27", "2008-07-03", "2008-07-09", "2008-07-15", "2008-07-21", "2008-07-25", "2008-07-31", "2008-08-06", "2008-08-12", "2008-08-19", "2008-08-25", "2008-08-29", "2008-09-05", "2008-09-11", "2008-09-15", "2008-09-17", "2008-09-23", "2008-09-29", "2008-10-06", "2008-10-13", "2008-10-17", "2008-10-23", "2008-10-27"],
  narrations: {
    n_gfc_start: "8 Jan 2008. The Nifty 50 closes at a record 6,287.85 after a five-year bull run. Your ₹1,00,000 is invested across the Nifty 50.",
    n_gfc_sold: "Day 3. The Nifty is only 1.4% off its record, but American banks keep reporting losses on subprime loans. You sell everything at the close and keep ₹98,604 in cash.",
    n_gfc_halt: "22 Jan. The market falls so fast at the open that trading is halted for an hour. In two sessions the Nifty has lost 14%. It is now 22% below your start.",
    n_gfc_bear: "17 Mar. The US bank Bear Stearns has been rescued over the weekend. The Nifty closes 28% below your start, and the panic-seller looks like a genius.",
    n_gfc_lehman: "15 Sep. Lehman Brothers files for bankruptcy in New York. The Nifty falls 3.7% and is 35% below your start. The worst is still six weeks away.",
    n_gfc_bottom: "27 Oct 2008. The Nifty closes at 2,524.2, 59.9% below your start. Held: ₹40,144. Panic-sold: ₹98,604, almost two and a half times as much. Here, selling early won. The catch: the Nifty was back above its January 2008 level by 9 Nov 2010, and anyone still waiting in cash for the right moment missed that recovery.",
  },
};

const DEMO_2016 = {
  id: "DEMO_2016",
  title: "Demonetisation Shock",
  subtitle: "Nov 2016 – Feb 2017",
  description: "The overnight note ban. The Nifty 50 slipped 7% over seven weeks and was back above its 8 November level by late January 2017.",
  startLabel: "Nov 8, 2016",
  endLabel: "Feb 28, 2017",
  finalDelta: 7.0,
  heldEnd: 103933,
  panicEnd: 97106,
  indexDrop: -7.4,
  recoveryDays: 22,
  frames: [
    frame(0, 8543.55, 100000, 100000, "n_demo_start"),  // 2016-11-08
    frame(1, 8432, 98694, 98694, "n_demo_us"),  // 2016-11-09
    frame(2, 8525.75, 99792, 99792),  // 2016-11-10
    frame(3, 8296.3, 97106, 97106, "n_demo_sold"),  // 2016-11-11
    frame(4, 8108.45, 94907, 97106),  // 2016-11-15
    frame(5, 8111.6, 94944, 97106),  // 2016-11-16
    frame(6, 8079.95, 94574, 97106),  // 2016-11-17
    frame(7, 8074.1, 94505, 97106),  // 2016-11-18
    frame(8, 7929.1, 92808, 97106, "n_demo_queues"),  // 2016-11-21
    frame(9, 8002.3, 93665, 97106),  // 2016-11-22
    frame(10, 8033.3, 94028, 97106),  // 2016-11-23
    frame(11, 7965.5, 93234, 97106),  // 2016-11-24
    frame(12, 8114.3, 94976, 97106),  // 2016-11-25
    frame(13, 8126.9, 95123, 97106),  // 2016-11-28
    frame(14, 8142.15, 95302, 97106),  // 2016-11-29
    frame(15, 8224.5, 96266, 97106),  // 2016-11-30
    frame(16, 8192.9, 95896, 97106),  // 2016-12-01
    frame(17, 8086.8, 94654, 97106),  // 2016-12-02
    frame(18, 8128.75, 95145, 97106),  // 2016-12-05
    frame(19, 8143.15, 95313, 97106),  // 2016-12-06
    frame(20, 8102.05, 94832, 97106),  // 2016-12-07
    frame(21, 8246.85, 96527, 97106),  // 2016-12-08
    frame(22, 8261.75, 96702, 97106),  // 2016-12-09
    frame(23, 8170.8, 95637, 97106),  // 2016-12-12
    frame(24, 8221.8, 96234, 97106),  // 2016-12-13
    frame(25, 8182.45, 95773, 97106),  // 2016-12-14
    frame(26, 8153.6, 95436, 97106),  // 2016-12-15
    frame(27, 8139.45, 95270, 97106),  // 2016-12-16
    frame(28, 8104.35, 94859, 97106),  // 2016-12-19
    frame(29, 8082.4, 94602, 97106),  // 2016-12-20
    frame(30, 8061.3, 94355, 97106),  // 2016-12-21
    frame(31, 7979.1, 93393, 97106),  // 2016-12-22
    frame(32, 7985.75, 93471, 97106),  // 2016-12-23
    frame(33, 7908.25, 92564, 97106, "n_demo_low"),  // 2016-12-26
    frame(34, 8032.85, 94022, 97106),  // 2016-12-27
    frame(35, 8034.85, 94046, 97106),  // 2016-12-28
    frame(36, 8103.6, 94851, 97106),  // 2016-12-29
    frame(37, 8185.8, 95813, 97106),  // 2016-12-30
    frame(38, 8179.5, 95739, 97106),  // 2017-01-02
    frame(39, 8192.25, 95888, 97106),  // 2017-01-03
    frame(40, 8190.5, 95868, 97106),  // 2017-01-04
    frame(41, 8273.8, 96843, 97106),  // 2017-01-05
    frame(42, 8243.8, 96492, 97106),  // 2017-01-06
    frame(43, 8236.05, 96401, 97106),  // 2017-01-09
    frame(44, 8288.6, 97016, 97106),  // 2017-01-10
    frame(45, 8380.65, 98093, 97106),  // 2017-01-11
    frame(46, 8407.2, 98404, 97106),  // 2017-01-12
    frame(47, 8400.35, 98324, 97106),  // 2017-01-13
    frame(48, 8412.8, 98470, 97106),  // 2017-01-16
    frame(49, 8398, 98296, 97106),  // 2017-01-17
    frame(50, 8417, 98519, 97106),  // 2017-01-18
    frame(51, 8435.1, 98731, 97106),  // 2017-01-19
    frame(52, 8349.35, 97727, 97106),  // 2017-01-20
    frame(53, 8391.5, 98220, 97106),  // 2017-01-23
    frame(54, 8475.8, 99207, 97106),  // 2017-01-24
    frame(55, 8602.75, 100693, 97106, "n_demo_recovery"),  // 2017-01-25
    frame(56, 8641.25, 101144, 97106),  // 2017-01-27
    frame(57, 8632.75, 101044, 97106),  // 2017-01-30
    frame(58, 8561.3, 100208, 97106),  // 2017-01-31
    frame(59, 8716.4, 102023, 97106),  // 2017-02-01
    frame(60, 8734.25, 102232, 97106),  // 2017-02-02
    frame(61, 8740.95, 102311, 97106),  // 2017-02-03
    frame(62, 8801.05, 103014, 97106),  // 2017-02-06
    frame(63, 8768.3, 102631, 97106),  // 2017-02-07
    frame(64, 8769.05, 102639, 97106),  // 2017-02-08
    frame(65, 8778.4, 102749, 97106),  // 2017-02-09
    frame(66, 8793.55, 102926, 97106),  // 2017-02-10
    frame(67, 8805.05, 103061, 97106),  // 2017-02-13
    frame(68, 8792.3, 102912, 97106),  // 2017-02-14
    frame(69, 8724.7, 102120, 97106),  // 2017-02-15
    frame(70, 8778, 102744, 97106),  // 2017-02-16
    frame(71, 8821.7, 103256, 97106),  // 2017-02-17
    frame(72, 8879.2, 103929, 97106),  // 2017-02-20
    frame(73, 8907.85, 104264, 97106),  // 2017-02-21
    frame(74, 8926.9, 104487, 97106),  // 2017-02-22
    frame(75, 8939.5, 104634, 97106),  // 2017-02-23
    frame(76, 8896.7, 104134, 97106),  // 2017-02-27
    frame(77, 8879.6, 103933, 97106, "n_demo_final"),  // 2017-02-28
  ],
  // Real trading date of each frame, same order.
  dates: ["2016-11-08", "2016-11-09", "2016-11-10", "2016-11-11", "2016-11-15", "2016-11-16", "2016-11-17", "2016-11-18", "2016-11-21", "2016-11-22", "2016-11-23", "2016-11-24", "2016-11-25", "2016-11-28", "2016-11-29", "2016-11-30", "2016-12-01", "2016-12-02", "2016-12-05", "2016-12-06", "2016-12-07", "2016-12-08", "2016-12-09", "2016-12-12", "2016-12-13", "2016-12-14", "2016-12-15", "2016-12-16", "2016-12-19", "2016-12-20", "2016-12-21", "2016-12-22", "2016-12-23", "2016-12-26", "2016-12-27", "2016-12-28", "2016-12-29", "2016-12-30", "2017-01-02", "2017-01-03", "2017-01-04", "2017-01-05", "2017-01-06", "2017-01-09", "2017-01-10", "2017-01-11", "2017-01-12", "2017-01-13", "2017-01-16", "2017-01-17", "2017-01-18", "2017-01-19", "2017-01-20", "2017-01-23", "2017-01-24", "2017-01-25", "2017-01-27", "2017-01-30", "2017-01-31", "2017-02-01", "2017-02-02", "2017-02-03", "2017-02-06", "2017-02-07", "2017-02-08", "2017-02-09", "2017-02-10", "2017-02-13", "2017-02-14", "2017-02-15", "2017-02-16", "2017-02-17", "2017-02-20", "2017-02-21", "2017-02-22", "2017-02-23", "2017-02-27", "2017-02-28"],
  narrations: {
    n_demo_start: "8 Nov 2016. The market has closed with the Nifty 50 at 8,543.55. At 8 PM, the Prime Minister announces that ₹500 and ₹1,000 notes stop being legal tender at midnight. Your ₹1,00,000 is invested across the Nifty 50.",
    n_demo_us: "9 Nov. The Nifty closes 1.3% lower on a day that also brings the surprise US election result.",
    n_demo_sold: "Day 3. The Nifty is 2.9% below where you started, and bank queues fill every news channel. You sell everything at the close and keep ₹97,106 in cash.",
    n_demo_queues: "21 Nov. The Nifty is 7.2% below 8 November. Cash-heavy businesses are struggling, and the headlines predict a slowdown.",
    n_demo_low: "26 Dec. The lowest close of the replay: 7,908.25, 7.4% below your start. Held: ₹92,564. The panic-seller is still ahead.",
    n_demo_recovery: "25 Jan 2017. The Nifty closes above its 8 November level again, 22 trading days after the low.",
    n_demo_final: "28 Feb 2017. Held: ₹1,03,933, up 3.9%. Panic-sold: ₹97,106 in cash. Holding finished 7.0% ahead. By the end of 2017, the Nifty was 33% above its December 2016 low.",
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
