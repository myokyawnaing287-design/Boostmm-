# Android ဖုန်းတစ်လုံးတည်းဖြင့် Boostmm ကို Online PWA လုပ်ရန်

## အရေးကြီးဆုံး
- ဒီ project က Node.js + SQLite backend ပါဝင်တဲ့ app ဖြစ်သည်။ Static hosting တစ်ခုတည်းဖြင့် မလုံလောက်ပါ။
- SQLite database ထဲတွင် customer balance, orders နှင့် ledger ရှိသည်။ `/data` ကို Persistent Disk အဖြစ် mount လုပ်ပါ။ Disk မရှိပါက restart/redeploy အပြီး ငွေလက်ကျန်/အော်ဒါမှတ်တမ်း ပျောက်နိုင်သည်။
- AuraBurma API key နှင့် owner password ကို GitHub ထဲ မတင်ပါနှင့်။ Hosting ရဲ့ Environment Variables / Secrets ထဲတွင်သာ ထည့်ပါ။
- Live မတင်မီ AuraBurma API key အသစ်သုံးပြီး upstream account ရဲ့ reseller/API အသုံးပြုခွင့်ကို စစ်ပါ။

## A. GitHub repository ပြင်ဆင်ခြင်း (Android Chrome)
1. `reseller-pwa-ready.zip` ကို ဖုန်းထဲ Download လုပ်ပါ။
2. Android ရဲ့ Files app ဖြင့် ZIP ကို Extract လုပ်ပါ။ အထဲမှာ `reseller/` folder ရှိမည်။
3. GitHub မှာ repository အသစ်လုပ်ပါ။
4. ZIP ကို တိုက်ရိုက်တင်ခြင်းမဟုတ်ဘဲ `reseller/` အတွင်းရှိ project files/folders ကို repository root ထဲ တင်ရမည်။ `src/`, `public/`, `test/`, `Dockerfile`, `package.json`, `render.yaml`, `.env.example`, `README.md` စသည်တို့ ပါရမည်။
5. `.env`၊ `data/`၊ `node_modules/`၊ API key/password ပါသော ဖိုင်များကို မတင်ပါနှင့်။ `.gitignore` က `.env` နှင့် `data/` ကို ignore လုပ်ထားသည်။
6. ဖုန်း browser ဖြင့် ဖိုင်အများအပြား upload လုပ်ရခက်ပါက GitHub Codespaces ကို အသုံးပြုနိုင်သော်လည်း availability/usage limit နှင့် billing ရှိနိုင်သည်။

## B. Render မှာ deploy လုပ်ခြင်း
1. `https://render.com/` ကိုဖွင့်ပြီး GitHub နဲ့ sign in လုပ်ပါ။
2. New > Blueprint ကိုရွေးပြီး အပေါ်က repository ကို ချိတ်ပါ။ Repository root မှာ `render.yaml` ရှိရမည်။
3. Blueprint က `boostmm` web service နှင့် `/data` Persistent Disk ကို ပြမည်။ Persistent Disk ပါဝင်သော plan သည် အခကြေးငွေရှိနိုင်သည်။ Create/Apply မလုပ်မီ လက်ရှိဈေးနှုန်းကို စစ်ပါ။
4. Secret values တောင်းလာလျှင်:
   - `OWNER_EMAIL`: ကိုယ်ပိုင် owner email (ဥပမာ မိမိသုံးမည့် email)
   - `OWNER_PASSWORD`: အနည်းဆုံး 16 လုံး၊ ခန့်မှန်းရခက်သော password အသစ်
   - `UPSTREAM_API_KEY`: AuraBurma မှ ရယူထားသော API key အသစ်
5. Deploy log မှာ `[owner] created owner account` သို့မဟုတ် owner ရှိပြီးသားဆိုတဲ့စာနှင့် server listening log တွေကို စစ်ပါ။ `/healthz` က `{"ok":true}` ပြန်ပေးရမည်။
6. Deploy ပြီးပါက Render ကပေးသော `https://...onrender.com` URL ကို ဖွင့်ပြီး login၊ service list၊ test order မဟုတ်သော အခြေခံ UI ကို စစ်ပါ။ Production ငွေသွင်း/အော်ဒါကို စမ်းသပ်ရာတွင် တကယ့်ငွေမဆုံးရှုံးစေရန် သတိထားပါ။

## C. Android Home Screen မှာ ထည့်ခြင်း
1. Render HTTPS URL ကို Chrome ဖြင့်ဖွင့်ပါ။
2. Chrome `⋮` > `Install app` သို့မဟုတ် `Add to Home screen` ကိုရွေးပါ။
3. Home Screen မှ icon ကိုဖွင့်စမ်းပါ။
4. Install မပေါ်ပါက Manifest (`/manifest.webmanifest`) နှင့် Service Worker (`/sw.js`) ကို browser DevTools ဖြင့် စစ်ရန်လိုနိုင်သည်။ ဒီ project က `.webmanifest` ကို မှန်ကန်သော `application/manifest+json` content type ဖြင့် ပို့ပေးသည်။

## D. Live မတင်မီ စစ်ဆေးရန်
- [ ] `OWNER_EMAIL`, `OWNER_PASSWORD`, `UPSTREAM_API_KEY` ကို hosting secrets ထဲ ထည့်ပြီးပြီ
- [ ] `/data` Persistent Disk တပ်ပြီး `DB_PATH=/data/shop.db` ဖြစ်သည်
- [ ] HTTPS နှင့် `COOKIE_SECURE=true` ဖြစ်သည်
- [ ] API key ကို client JavaScript, README, GitHub commit များထဲ မထည့်ထား
- [ ] owner login နှင့် 2FA ကို စစ်ပြီးပြီ
- [ ] Database backup/restore အစီအစဉ်ရှိသည်
- [ ] AuraBurma API စည်းမျဉ်း၊ reseller ခွင့်ပြုချက်နှင့် အမှန်တကယ် payment flow ကို စစ်ပြီးပြီ

## Troubleshooting
- Deploy fail: Render build/deploy logs ထဲက error ကို screenshot သို့မဟုတ် copy လုပ်ပြီး စစ်ပါ။ Node.js 22.13+ လိုအပ်သည်။
- Owner login မရ: `OWNER_EMAIL`/`OWNER_PASSWORD` ကို မှန်ကန်စွာထည့်ထားမထား စစ်ပါ။ Owner account ကို database ပထမဆုံးဖန်တီးသည့်အချိန်တွင် password သတ်မှတ်သည်။ Existing database ရှိလျှင် environment password ပြောင်းရုံနဲ့ ရှိပြီးသား password မပြောင်းပါ။
- Services မပေါ်: `UPSTREAM_API_KEY`, `UPSTREAM_URL`, AuraBurma balance/API access နှင့် deploy logs ကို စစ်ပါ။
- Balance ပျောက်နိုင်သည့်အန္တရာယ်: Persistent Disk မရှိဘဲ deploy/restart မလုပ်ပါနှင့်။ Database file ကို ဖျက်ခြင်း/အသစ်စခြင်း မလုပ်ပါနှင့်။
