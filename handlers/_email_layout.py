"""The StockSaathi email layout, shared by every email the app sends.

Same design as the account emails and the 17 Oct campaign
(email-drafts-2026-10-17/1-reconfirm-email.html): grey page, white card with
20 px corners, green logo tile, pill button, mint note box, grey footer under
the card, and dark-mode overrides keyed on the inline colours below. Keep the
colours exact: the dark-mode rules match them by string.

Build a body from the block helpers and pass it to page().
"""
import html

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif"
SITE = "https://stocksaathi.co.in"
GREEN = "#00B386"
RED = "#E5484D"

_STYLE = """<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    body, [style*="background:#F1F3F6"] { background: #0A0B0F !important; }
    [style*="background:#FFFFFF"] { background: #13161E !important; }
    [style*="background:#F4FBF8"] { background: #10241D !important; }
    [style*="color:#0A0A0A"] { color: #F1F3F7 !important; }
    [style*="color:#30343B"] { color: #C9CED8 !important; }
    [style*="color:#6B7280"], [style*="color:#8A8F98"] { color: #8F97A8 !important; }
    [style*="border-top:1px solid #E6E8EC"] { border-color: #262A36 !important; }
  }
</style>"""


def heading(text):
    return (f'<tr><td style="padding:28px 32px 0 32px;font:700 24px/1.3 {FONT};color:#0A0A0A;">'
            f"{html.escape(text)}</td></tr>")


def para(inner_html, top=14, size=16):
    """inner_html is trusted markup: escape any user data before passing it."""
    return (f'<tr><td style="padding:{top}px 32px 0 32px;font:400 {size}px/1.6 {FONT};color:#30343B;">'
            f"{inner_html}</td></tr>")


def big_number(text, colour):
    return (f'<tr><td style="padding:10px 32px 0 32px;font:700 32px/1.2 {FONT};color:{colour};">'
            f"{text}</td></tr>")


def subhead(text, top=22):
    return (f'<tr><td style="padding:{top}px 32px 0 32px;font:700 15px/1.4 {FONT};color:#0A0A0A;">'
            f"{html.escape(text)}</td></tr>")


def rows(pairs):
    """Label / value rows with hairlines. Values are escaped here; labels may be markup."""
    cells = "".join(
        f'<tr><td style="padding:11px 0;border-top:1px solid #E6E8EC;font:400 15px/1.45 {FONT};color:#30343B;">{k}</td>'
        f'<td align="right" style="padding:11px 0;border-top:1px solid #E6E8EC;font:700 15px/1.45 {FONT};color:#0A0A0A;">{v}</td></tr>'
        for k, v in pairs)
    return (f'<tr><td style="padding:12px 32px 0 32px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{cells}</table></td></tr>')


def button(label, href):
    return (f'<tr><td style="padding:24px 32px 0 32px;">'
            f'<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>'
            f'<td align="center" style="border-radius:999px;background:#00B386;">'
            f'<a href="{html.escape(href)}" style="display:block;padding:15px 24px;font:700 16px/1 {FONT};'
            f'color:#FFFFFF;text-decoration:none;border-radius:999px;">{html.escape(label)}</a>'
            f"</td></tr></table></td></tr>")


def note(inner_html):
    return (f'<tr><td style="padding:20px 32px 0 32px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4FBF8;border-radius:14px;">'
            f'<tr><td style="padding:14px 16px;font:400 14px/1.55 {FONT};color:#30343B;">{inner_html}</td></tr>'
            f"</table></td></tr>")


def small_print(inner_html):
    return (f'<tr><td style="padding:28px 32px 30px 32px;font:400 13px/1.6 {FONT};color:#6B7280;">'
            f"{inner_html}</td></tr>")


def page(title, preheader, blocks):
    """The full HTML document: header with logo, the blocks, footer."""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{html.escape(title)}</title>
{_STYLE}
</head>
<body style="margin:0;padding:0;background:#F1F3F6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{html.escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F6;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:20px;overflow:hidden;">
      <tr><td style="padding:28px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:36px;height:36px;background:#00B386;border-radius:10px;text-align:center;vertical-align:middle;">
            <img src="{SITE}/images/favicon-48.png" width="22" height="22" alt="" style="display:block;margin:7px auto;border:0;">
          </td>
          <td style="padding-left:10px;font:700 18px/1 {FONT};color:#0A0A0A;">StockSaathi</td>
        </tr></table>
      </td></tr>
      {"".join(blocks)}
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding:18px 32px;font:400 12px/1.6 {FONT};color:#8A8F98;text-align:center;">
        StockSaathi is an educational paper-trading simulator. Virtual money only.<br>
        <a href="{SITE}" style="color:#8A8F98;">stocksaathi.co.in</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""
