# GoFoods Ops (admin console / order desk)

Static web app (plain JS + supabase-js) published to https://gilbert-dotcom.github.io/gofoods-app/admin/.
Sign in with a phone number that is an `admin` or `order_desk` account (add numbers under
Settings → Admin accounts, or `insert into admin_invites (phone, role) values ('233…', 'admin')`).
Test admin: +233 24 000 0009 / OTP 123456 (add the test OTP in Supabase Auth).

- Orders desk: live board, accept/ready on a WhatsApp vendor's behalf (with a prefilled WhatsApp message), cancel + refund with a reason, unassign rider, force-deliver with the PIN.
- Vendors: open/close, edit, staff invites, menu (price, sold out, alcohol, size units), pay out, top up.
- Riders: invite, balances, pay out (MoMo reference), suspend.
- Customers: find by phone, wallet, goodwill credit, wallet top-up.
- Money: platform accounts, owed to vendors/riders, payout log. Every figure is a ledger sum.
- Settings: country fees/timeouts/credit, zones + fee bands, admin accounts.

Order-desk role can run orders and vendors but cannot move money.

Local: `cd apps/admin && echo 'window.GOFOODS_CONFIG={url:"…",anon:"…"}' > config.js && python3 -m http.server 8080`.
