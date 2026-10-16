# wabot — WhatsApp AI Assistant for Businesses

Ek server, kai clients. Har business ki ek JSON file — menu/services, deals, timings, FAQ — aur bot unke WhatsApp pe Urdu / Roman Urdu / English mein reply karta hai, orders/bookings leta hai, aur zaroorat pe owner ko handoff karta hai.

Restaurant, home chef, pet shop, clothing brand, pharmacy-type shops → `"kind": "orders"`
Clinic, salon, gym, tutor, car service → `"kind": "appointments"`
Examples: `businesses/demo-restaurant.json`, `demo-petshop.json.example`, `demo-gym.json.example`, `demo-clinic.json.example`.

## Kya karta hai
- 24/7 replies customer ki zabaan mein (Gemini ya koi bhi OpenAI-compatible model)
- Order / appointment collect → customer confirm kare → DB mein save + **receipt** customer ko + owner ko alert
- **Prices hamesha catalog se** — AI ghalat price bole to bhi total server calculate karta hai; jo item catalog mein nahi woh "verify" flag ho jata hai
- **Deals/offers** (`"deals"` in JSON) — bot sirf wohi deals batata hai, apni taraf se discount nahi deta
- **Coexistence**: client ka WhatsApp Business app chalta rahega. Owner app se reply kare → bot us chat mein khud chup. Owner message ke aakhir mein 🤖 lagaye → bot wapas on
- Complaint / "insaan se baat" → bot chup, owner ko alert
- Customer 3 chhote messages bheje ("bhai" / "menu" / "bhej do") → bot **ek** jawab deta hai (debounce)
- Location pin → delivery address ban jata hai. Image/screenshot (payment proof) → save + owner alert + dashboard pe nazar aata hai. Voice note → polite reply + dashboard pe sun sakte hain
- Current date/time (Pakistan) prompt mein — "abhi open ho?", "kal 5 baje" sahi samajhta hai
- Dashboard `/admin`: orders + status (customer ko auto message: confirmed / raste mein / delivered), chats, **dashboard se reply**, bot on/off, delivery failures ka "Attention" section, client connect link
- Owner commands (owner ke personal WhatsApp se bot number pe): `reply <number> <msg>`, `pause <number>`, `resume <number>`, `orders`
- Production: signature check (production mein lazmi), duplicate protection, AI timeout + fallback, spam rate-limit, dashboard brute-force lockout + CSRF check, daily SQLite backup (14 din), graceful shutdown, Docker healthcheck, non-root container, log rotation, ghalat business JSON baqi clients ko crash nahi karti

## 1. Local test (WhatsApp ke baghair, 5 minute)
```bash
npm install
cp .env.example .env          # AI_API_KEY daalo (aistudio.google.com se Gemini key)
node --no-warnings scripts/chat.js demo-restaurant
```
Terminal mein customer ban ke baat karo. Yahi screen record karke **demo video** bana sakte ho.

Tests: `npm test` (29 tests, koi real API call nahi)

## 2. VPS pe deploy (Hostinger KVM 2)
1. Domain ka **A record** `bot.yourdomain.com` → VPS IP
2. VPS pe:
   ```bash
   git clone <your-repo> wabot && cd wabot
   cp .env.example .env && nano .env      # DOMAIN, WA_APP_SECRET, WA_VERIFY_TOKEN, AI_API_KEY, ADMIN_PASSWORD (12+ chars)
   mkdir -p data && sudo chown 1000:1000 data
   docker compose up -d --build
   ```
   Production mode mein ghalat/missing settings ho to server start hi nahi hota aur wajah log mein likhta hai: `docker compose logs bot`.
   Check: `https://bot.yourdomain.com/health`
3. Dashboard: `https://bot.yourdomain.com/admin` (username kuch bhi, password = ADMIN_PASSWORD)

Client add/edit ke baad dashboard ka ↻ button (ya `docker compose restart bot`).
Backups: `data/backups/` (roz). Manual: `docker compose exec bot node scripts/backup.js`. Off-server copy ke liye `data/backups` ko rclone/scp se kahin aur bhi bhejo.

## 3. Apne secondary number se testing — 3 raste

| | Rasta | Kab | Number ka kya hoga |
|---|---|---|---|
| A | **Meta test number** | Sab se pehle, 10 minute | Aapka number touch nahi hota. Secondary number sirf "To" list mein add karo aur usse bot ko message karo |
| B | **Secondary number seedha API pe** | Real number pe test, coexistence ke baghair | Us number pe WhatsApp app band ho jayega (API-only). Pehle us number ka WhatsApp account delete karna padta hai |
| C | **Coexistence** (secondary number WhatsApp Business app pe) | Woh flow test karna jo clients ko bechna hai | App chalta rahega + bot. Iske liye Embedded Signup chahiye (neeche) |

**Recommended:** A se shuru → phir C. B tab hi jab us number pe app ki zaroorat na ho.

### A. Meta test number
1. developers.facebook.com → **Create App** → type *Business* → **WhatsApp** product add
2. WhatsApp → *API Setup*: test number milega. `Phone number ID` → `businesses/demo-restaurant.json` ke `phone_number_id` mein; temporary token → `.env` `WA_ACCESS_TOKEN`
3. "To" list mein apna secondary number add karo (OTP aayega)
4. WhatsApp → *Configuration* → Webhook: URL `https://bot.yourdomain.com/webhook`, verify token = `WA_VERIFY_TOKEN`, **messages** field subscribe
5. App settings → Basic → **App secret** → `.env` `WA_APP_SECRET`
6. `owner_whatsapp` mein apna **main** number daalo (alerts wahan aayenge), secondary se test number ko "menu dikhao" bhejo 🎉

Temporary token 24 ghante mein expire hota hai — lambi testing ke liye Business Settings → System users → permanent token.

### C. Coexistence (WhatsApp Business app + bot same number pe)
Requirement (Meta ka rule): coexistence sirf **Embedded Signup** se hota hai, aur Meta ke docs ke mutabiq iske liye aap ka app **Tech Provider** (ya Solution Partner) hona chahiye. Development mode mein apne hi business ke saath test ho jata hai ya nahi — ye Meta badalta rehta hai, App Dashboard mein check kar lena.

1. Secondary number pe **WhatsApp Business app** install/update karo, kuch chats rakho
2. Meta Business verification start karo (kuch din lagte hain) aur App Dashboard mein Tech Provider wala setup
3. Facebook Login for Business → WhatsApp **Embedded Signup configuration** banao → Configuration ID → `.env` `ES_CONFIG_ID`; App ID → `META_APP_ID`
4. App settings → JavaScript SDK **Allowed domains** mein `https://bot.yourdomain.com` daalo
5. Webhook fields subscribe: **messages**, **smb_message_echoes**, **history**, **smb_app_state_sync**
6. Business JSON banao (`phone_number_id` khali chhod do) → dashboard mein us business ka **connect link** nazar aayega
7. Link kholo → "WhatsApp Business app wala number" → Facebook login → number chuno → phone pe app mein QR/confirm. Server khud token lega, webhook subscribe karega, contacts + 6 mahine ki history sync shuru karega (24 ghante ke andar hona zaroori hai — ye automatically ho jata hai)
8. Test: kisi aur phone se secondary number ko message karo → bot reply. Ab app se khud reply karo → us chat mein bot chup. Message ke aakhir mein 🤖 → bot wapas on

Coexistence limitations (client ko pehle batana): broadcast lists band (purani read-only), disappearing/view-once/live location off, group chats sync nahi, calls API pe nahi, linked devices (WhatsApp Web) dobara link karne padte hain, throughput 20 msg/sec. Phone pe app ~14 din na khule to connection toot sakta hai. App se bheje messages free hain; bot (API) wale messages Meta pricing pe.

## 4. Naya client add karna
Example file copy → naam, `owner_whatsapp`, timings, `catalog`, `deals`, `faq`, `extra_rules` edit → ↻ reload.
- Client ka number: ya JSON mein `phone_number_id` (+ `access_token`), ya dashboard ka **connect link** client ko bhejo (Embedded Signup — client khud connect karta hai, token DB mein save)
- `"enabled": false` — client ne payment nahi ki to bot band 😉
- `"status_messages"` — order status messages customize (`{id}`, `{name}`, `{notes}`)
- `"timezone"` — default `Asia/Karachi`

**24-ghante ka rule:** customer ke aakhri message ke 24 ghante baad free-form message nahi jata. Status updates / dashboard replies us waqt rok diye jate hain aur "Attention" mein dikhte hain. Owner alerts ke liye: owner roz bot number ko ek message bhej de, ya ek UTILITY template approve karwa ke `OWNER_ALERT_TEMPLATE` set karo (ek body variable `{{1}}`).

## 5. Kharcha (October 2026 tak ki info — khud dobara check karna)
- **VPS:** already hai. KVM 2 pe bohot saare clients chal jayenge.
- **WhatsApp:** customer ke message ke 24h window ke andar service replies ka bara hissa free/sasta; marketing templates hamesha paid. Meta rates badalta rehta hai — live se pehle pricing page dekho.
- **AI:** Gemini Flash-Lite free tier testing ke liye. **Paying clients ke liye paid key** (free tier pe data training mein use ho sakta hai, limits kam). Spam limit (`MAX_MSGS_PER_HOUR`) bill ko bachata hai.
- Provider badalna ho to sirf `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`.

## Production checklist
- [ ] `.env`: `WA_APP_SECRET`, random `WA_VERIFY_TOKEN`, 12+ char `ADMIN_PASSWORD`, **paid** `AI_API_KEY`
- [ ] Permanent token (System User) ya Embedded Signup — temporary token nahi
- [ ] `owner_whatsapp` = owner ka personal number (business number nahi)
- [ ] Har client ke saath 20-30 real sawal `scripts/chat.js` pe test, `extra_rules` tune
- [ ] `data/backups` ki off-server copy
- [ ] Uptime monitor (UptimeRobot free) on `/health`
- [ ] Client ko 24h rule + coexistence limitations samjha diye

## Structure
```
src/server.js      webhook, dashboard, onboarding routes, maintenance, shutdown
src/bot.js         messages, debounce, orders, handoff, echoes, statuses, owner commands
src/onboard.js     Embedded Signup (coexistence + new number)
src/ai.js          OpenAI-compatible client + robust JSON parsing
src/whatsapp.js    Graph API, templates, media, signature check, webhook parsing
src/businesses.js  client configs, validation, catalog pricing, system prompt
src/db.js          SQLite (Node built-in), migrations, backups
src/dashboard.js   /admin HTML
scripts/chat.js    terminal tester      scripts/backup.js  manual backup
```
