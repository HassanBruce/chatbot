# wabot: WhatsApp AI Salesman

WhatsApp par customer se baat karta hai, rates batata hai, **bargaining karta hai** (owner ke minimum rate se neeche kabhi nahi jata), order leta hai, aur owner ko WhatsApp par order bhej deta hai.

Ek server, kai businesses: har business ki ek JSON file `businesses/` folder mein hoti hai.

## Bargaining kaise kaam karti hai

Har item ke do rate hote hain:
- `price`: jo customer ko bataya jata hai
- `min_price`: owner ka aakhri rate. **AI ko yeh rate kabhi nahi bheja jata**, decision code karta hai.

Customer "kam karo" kahe to bot har round mein thora neeche aata hai (~30%, ~60%, phir final), aur kabhi wapas upar nahi jata. Agar customer ka offer kaafi ho to bot usi ke rate par deal kar leta hai. Optional `bulk` setting zyada quantity par aur kam rate allow karti hai. Jis item par discount nahi dena, uske liye `min_price` = `price` rakhein.

## VPS par chalana

```bash
# code VPS par le aayein (git ya scp), phir:
cd wabot
cp .env.example .env && nano .env      # tokens bharein
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
docker compose logs -f
curl localhost:3000/health
```

Nginx pehle se `bot.DOMAIN` → `127.0.0.1:3000` par set hai.

## Meta mein webhook lagana

App → WhatsApp → **Configuration**:
- Callback URL: `https://bot.DOMAIN/webhook`
- Verify token: wahi jo `.env` mein `VERIFY_TOKEN` hai
- **Verify and save**, phir Webhook fields mein **messages** → Subscribe

`APP_SECRET`: App settings → Basic → App secret (Show).

## Testing

- **Bina WhatsApp ke:** `npm install && npm run chat` (sirf `GEMINI_API_KEY` chahiye)
- **WhatsApp par:** apne verified number se test number ko message karein
- Chat dobara shuru karni ho to `#reset` likhein
- Tests: `npm test`

## Owner commands (owner apne WhatsApp se bot number par bheje)

| Command | Kaam |
|---|---|
| `#reload` | `businesses/*.json` dobara load (rates badalne ke baad) |
| `#resume 923001234567` | jis customer ko owner ne khud sambhala, wahan bot dobara on |
| `#reset` | apni chat reset |

Jab customer naraz ho ya kuch aisa maange jo list mein nahi, bot owner ko alert bhejta hai aur us customer ke liye chup ho jata hai, jab tak `#resume` na aaye.

**Zaroori:** WhatsApp ke rule ke mutabiq bot owner ko tabhi message kar sakta hai jab owner ne pichhle 24 ghante mein bot number ko koi message kiya ho. Owner roz subah ek "hi" bhej de, ya baad mein order alert ke liye template message approve karwa lein.

## Naya client add karna

1. `businesses/_example-restaurant.json.example` copy karke `client-name.json` banayein
2. `phone_number_id`, `owner_phone`, items aur rates bharein
3. Agar client ka number uske apne WhatsApp account mein hai: `access_token_env` mein ek naam dein aur `.env` mein us naam se token
4. `docker compose restart` ya owner se `#reload`

Orders `data/orders.jsonl` mein save hote hain (ek line = ek order).
