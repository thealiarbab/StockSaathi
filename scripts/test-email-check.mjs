// Email typo suggestions: every typo domain seen in auth.users must be caught,
// and real domains must be left alone.
import { suggestEmail } from "../js/auth/emailCheck.js";

const fix = {
  "ananya@gamil.com": "ananya@gmail.com",
  "ananya@gmal.com": "ananya@gmail.com",
  "ananya@gail.com": "ananya@gmail.com",
  "ananya@gimale.com": "ananya@gmail.com",
  "ananya@gmaill.com": "ananya@gmail.com",
  "ananya@gmail.co": "ananya@gmail.com",
  "ananya@gmail.comm": "ananya@gmail.com",
  "ananya@gmail.coms": "ananya@gmail.com",
  "ananya@gmail.cim": "ananya@gmail.com",
  "ananya@gmail.con": "ananya@gmail.com",
  "ananya@gmail.comgmail.com": "ananya@gmail.com",
  "ananya@3333gmail.com": "ananya3333@gmail.com",
  "ananya@1211gmail.com": "ananya1211@gmail.com",
  "ananya@kushwahaariteshgmail.com": "ananyakushwahaaritesh@gmail.com",
  "ananya@gmail.zisra": "ananya@gmail.com",
  "ananyagmail.com": "ananya@gmail.com",
  "ananya@gmial.com": "ananya@gmail.com",
  "ananya@gnail.com": "ananya@gmail.com",
  "ananya@email.com": "ananya@gmail.com",
  "ananya@yaho.com": "ananya@yahoo.com",
  "ananya@yahoo.co": "ananya@yahoo.co.in",
  "ananya@yahooo.co.in": "ananya@yahoo.co.in",
  "ananya@hotmial.com": "ananya@hotmail.com",
  "ananya@outlok.com": "ananya@outlook.com",
  "ananya@rediffmal.com": "ananya@rediffmail.com",
  "ananya@icloud.co": "ananya@icloud.com",
  "Ananya.Sharma@GMAIL.COM ": null,
  "ananya@gmail..com": "ananya@gmail.com",
  "ananya@gmail,com": "ananya@gmail.com",
};
const keep = ["ananya@gmail.com", "ananya@yahoo.co.in", "ananya@outlook.com", "ananya@dpsnashik.in", "ananya@dpsnagpurcity.com",
  "ananya@care.ac.in", "ananya@myamu.ac.in", "ananya@sis.edu.in", "ananya@jgis.in", "ananya@stocksaathi.co.in",
  "ananya@dpsvaranasi.com", "ananya@globalschoolsalumni.org", "ananya@iitb.ac.in", "ananya@gmx.de", "ananya@zohomail.in",
  "ananya@company.com", "ananya@live.in", "ananya@protonmail.ch", "ananya@ritepost.com", "ananya@tangvlog.com"];

let bad = 0;
for (const [input, want] of Object.entries(fix)) {
  const got = suggestEmail(input);
  if (got !== want) { bad++; console.log(`FIX  ${input} -> ${got} (want ${want})`); }
}
for (const input of keep) {
  const got = suggestEmail(input);
  if (got !== null) { bad++; console.log(`KEEP ${input} -> ${got} (want no suggestion)`); }
}
console.log(`email check: ${Object.keys(fix).length + keep.length - bad}/${Object.keys(fix).length + keep.length} passing`);
process.exit(bad ? 1 : 0);
