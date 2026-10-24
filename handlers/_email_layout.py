"""The StockSaathi email layout, shared by every email the app sends.

Copied from the account emails Supabase sends through Resend (sign-up code,
password reset; checked against a real sent "Confirm Your Signup" on 24 Oct):
dark ticker tape, green gradient header with the rupee tile and tagline, a big
monospace figure, a mint "ticket" card with monospace rows, amber warning box,
divider, centred footer links. Keep the two in step: if the Supabase
templates change, change this too.

Build a body from the block helpers and pass it to page().
"""
import html

SITE = "https://stocksaathi.co.in"
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
MONO = "'SF Mono', Menlo, Consolas, 'Courier New', monospace"
GREEN = "#00B386"
RED = "#E5484D"

_HEAD_STYLE = """<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
  @media screen and (max-width: 600px) {
    .container { width: 100% !important; }
    .px-40 { padding-left: 22px !important; padding-right: 22px !important; }
    .hero-title { font-size: 22px !important; line-height: 30px !important; }
    .big-fig { font-size: 26px !important; }
    .tape { font-size: 10px !important; letter-spacing: 0.5px !important; }
    .hide-sm { display: none !important; }
  }
</style>"""

_TAPE = """<tr><td bgcolor="#0B1F17" style="background-color:#0B1F17; padding: 10px 24px;">
  <div class="tape" style="font-family: {mono}; font-size: 11px; letter-spacing: 1px; color:#D1FAE5; white-space:nowrap; overflow:hidden;">
    <span style="color:#00D09C;">▲</span> NSE &nbsp; <span style="color:#00D09C;">▲</span> BSE &nbsp;
    <span style="color:#00D09C;">▲</span> NIFTY 50 &nbsp; <span style="color:#00D09C;">▲</span> SENSEX &nbsp;
    <span style="color:#00D09C;">▲</span> ₹1,00,000 VIRTUAL CASH<span class="hide-sm"> &nbsp; <span style="color:#00D09C;">▲</span> ZERO REAL RISK</span>
  </div>
</td></tr>"""


def _hero(label, figure_html, right):
    return f"""<tr><td bgcolor="#00B386" class="px-40" style="background-color:#00B386; background-image: linear-gradient(135deg, #00B386 0%, #00D09C 100%); padding: 26px 40px 26px 40px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="40" height="40" align="center" valign="middle" bgcolor="#FFFFFF" style="width:40px; height:40px; background-color:#FFFFFF; border-radius:10px; font-family: Georgia, serif; font-size: 20px; font-weight: bold; color:#00B386; line-height:40px;">₹</td>
    <td style="vertical-align: middle; padding-left: 12px;">
      <div style="font-family: {FONT}; font-size: 19px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.3px;">StockSaathi</div>
      <div style="font-family: {FONT}; font-size: 12px; color: #E6FBF3; margin-top: 2px;">Invest virtually. <strong style="color:#FFFFFF;">Learn for real.</strong></div>
    </td>
  </tr></table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
    <tr>
      <td style="font-family: {MONO}; font-size:10px; letter-spacing:2px; color:#D4F7EA; font-weight:700;">{html.escape(label)}</td>
      <td align="right" style="font-family: {MONO}; font-size:10px; letter-spacing:1.5px; color:#FFFFFF; font-weight:700;">{html.escape(right)}</td>
    </tr>
    <tr><td colspan="2" class="big-fig" style="padding-top:4px; font-family: {MONO}; font-size:30px; font-weight:700; color:#FFFFFF; letter-spacing:-0.5px;">{figure_html}</td></tr>
  </table>
</td></tr>"""


def heading(title, intro_html=""):
    """Big title and an optional intro line (trusted markup: escape user data first)."""
    intro = (f'<p style="margin:0; font-size:15px; line-height:24px; color:#4B5563;">{intro_html}</p>'
             if intro_html else "")
    return (f'<tr><td class="px-40" style="padding: 36px 40px 8px 40px; font-family: {FONT};">'
            f'<h1 class="hero-title" style="margin:0 0 10px 0; font-size:26px; line-height:34px; color:#111827; '
            f'font-weight:700; letter-spacing:-0.5px;">{html.escape(title)}</h1>{intro}</td></tr>')


def ticket(tag, status, pairs, footer_html=""):
    """The mint card: a STOCKSAATHI / status bar, then monospace label-value
    rows. Labels and values are trusted markup: escape user data first."""
    body = "".join(
        f'<tr><td style="padding:4px 0;">{k}</td>'
        f'<td align="right" style="padding:4px 0; color:#111827; font-weight:700;">{v}</td></tr>' for k, v in pairs)
    foot = (f'<tr><td style="padding: 6px 20px 16px 20px; font-family: {FONT}; font-size:13px; line-height:20px; '
            f'color:#4B5563;">{footer_html}</td></tr>' if footer_html else "")
    return f"""<tr><td class="px-40" style="padding: 22px 40px 8px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2FCF8" style="background-color:#F2FCF8; border: 1px solid #C7F0DE; border-radius:14px;">
    <tr><td style="padding: 14px 20px; border-bottom: 1px dashed #A7E9CF;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family: {MONO}; font-size: 11px; color: #00875A; letter-spacing: 2px; font-weight: 700;">{html.escape(tag)}</td>
        <td align="right" style="font-family: {MONO}; font-size: 11px; color: #00875A; letter-spacing: 1px; font-weight: 700;"><span style="color:#00B386;">●</span> {html.escape(status)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding: 12px 20px 12px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family: {MONO}; font-size: 12px; color:#4B5563;">{body}</table>
    </td></tr>{foot}
  </table>
</td></tr>"""


def button(label, href):
    return (f'<tr><td class="px-40" style="padding: 22px 40px 8px 40px;">'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
            f'<td align="center" bgcolor="#00B386" style="border-radius:12px; background-color:#00B386;">'
            f'<a href="{html.escape(href)}" target="_blank" style="display:block; padding:15px 24px; font-family: {FONT}; '
            f'font-size:16px; font-weight:700; color:#FFFFFF; text-decoration:none; border-radius:12px;">{html.escape(label)}</a>'
            f"</td></tr></table></td></tr>")


def note(inner_html):
    """Amber box, as used for "Never share this code"."""
    return (f'<tr><td class="px-40" style="padding: 16px 40px 8px 40px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFBEB" '
            f'style="background-color:#FFFBEB; border-left:3px solid #F59E0B; border-radius:8px;"><tr>'
            f'<td style="padding:14px 16px;"><div style="font-family: {FONT}; font-size:13px; line-height:20px; color:#92400E;">'
            f"{inner_html}</div></td></tr></table></td></tr>")


def small(inner_html, bottom=8):
    return (f'<tr><td class="px-40" style="padding: 18px 40px {bottom}px 40px;">'
            f'<p style="margin:0; font-family: {FONT}; font-size:13px; line-height:20px; color:#6B7280;">{inner_html}</p></td></tr>')


def page(title, preheader, hero, blocks, reason):
    """hero = (label, figure_html, right_label). reason = the line under the card."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{html.escape(title)}</title>
{_HEAD_STYLE}
</head>
<body style="margin:0; padding:0; background-color:#F3F6F4; font-family: {FONT};">
<div style="display:none; font-size:1px; color:#F3F6F4; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">{html.escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F6F4" style="background-color:#F3F6F4;">
  <tr><td align="center" style="padding: 32px 16px;">
    <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:560px; max-width:560px; background-color:#ffffff; border-radius:20px; overflow:hidden;">
      {_TAPE.format(mono=MONO)}
      {_hero(*hero)}
      {"".join(blocks)}
      <tr><td style="padding: 28px 40px 0 40px;"><div style="height:1px; background-color:#E5E7EB; line-height:1px; font-size:1px;">&nbsp;</div></td></tr>
      <tr><td class="px-40" style="padding: 26px 40px 34px 40px; text-align:center; font-family: {FONT};">
        <div style="font-size:12px; color:#9CA3AF; line-height:20px;">StockSaathi is a paper-trading simulator. No real money is involved.</div>
        <div style="margin-top:14px;">
          <a href="{SITE}" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">stocksaathi.co.in</a>
          <span style="color:#D1D5DB;">•</span>
          <a href="{SITE}/privacy" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">Privacy</a>
          <span style="color:#D1D5DB;">•</span>
          <a href="{SITE}/terms" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">Terms</a>
        </div>
        <div style="margin-top:16px; font-size:11px; color:#9CA3AF;">© 2026 StockSaathi</div>
      </td></tr>
    </table>
    <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px;">
      <tr><td align="center" style="padding: 20px 16px 0 16px; font-family: {FONT}; font-size:11px; color:#9CA3AF; line-height:18px;">{reason}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""
