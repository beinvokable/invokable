# Spec — Agent-Native CLI Kit (שם עבודה: `invokable`)

**גרסה:** v0.1 · **שלב:** Phase 1 (SDK בקוד פתוח + שרת אימות מינימלי)
**מודל ייחוס:** `autoreel@0.1.12` — CLI + `skills/` + device-code login + checkpoint protocol.

---

## 1. הצהרת הבעיה

כל מי שבונה "כלי שסוכן קוד מפעיל" (Claude Code, Codex, Cursor, Gemini CLI) כותב מאפס את אותן ארבע שכבות: התקנת הוראות לתוך הסוכן, אימות מכונה מול השרת, פורמט פלט שסוכן יכול לקרוא בלי לטעות, ומנגנון שעוצר את הסוכן לפני פעולה שעולה כסף. אין ספרייה, אין סטנדרט, וכל מימוש נבדל בפרטים שהסוכן נשבר עליהם. התוצאה: 2–4 שבועות עבודה לכל startup, ואיכות חוויית-סוכן לא עקבית.

## 2. מטרות (Phase 1)

| # | מטרה | מדד |
|---|---|---|
| G1 | מפתח מגיע מ-`npx create-invokable` ל-CLI עובד עם login + פקודה אחת אמיתית | ≤ 30 דק', נמדד בסשן onboarding |
| G2 | הסוכן משלים משימת end-to-end דרך ה-CLI בלי שהמשתמש מתקן אותו | ≥ 80% הצלחה על 3 כלי דוגמה, ב-Claude Code וב-Codex |
| G3 | אימוץ | 20 כלים מפורסמים ב-npm שתלויים ב-`@invokable/core` תוך 90 יום |
| G4 | הוכחה לביקוש בשכבת ה-hosted | ≥ 30% מהמאמצים מפעילים את שרת האימות המנוהל במקום self-host |

## 3. לא-מטרות (Phase 1)

- **לא** MCP server generator — נכנס ב-Phase 2 כ-adapter על אותו schema. עכשיו זה מפזר פוקוס.
- **לא** אישורים ב-web/Slack/mobile — זה ה-SaaS של Phase 2; ב-Phase 1 האישור הוא "הדבק פקודה".
- **לא** billing/credits של הלקוח-של-הלקוח — ה-SDK מספק `spend` בצ'קפוינט, לא חשבונאות.
- **לא** Python SDK — Node קודם (רוב הכלים בקטגוריה ב-TS). Python ב-Phase 2.
- **לא** UI לניהול טוקנים — endpoint של revoke מספיק בהתחלה.

## 4. ארכיטקטורה — מה בקוד פתוח ומה בשרת

```
┌───────────────────────── Open Source (MIT) ─────────────────────────┐
│  create-invokable   → סקאפולד פרויקט                                 │
│  @invokable/core    → runtime: output envelope, exit codes,           │
│                      checkpoint(), config, auth client                │
│  @invokable/skills  → מחולל SKILL.md / AGENTS.md / .cursor/rules      │
│                      מ-command schema + מתקין לתיקיות הסוכן          │
│  @invokable/server  → Express/Hono middleware: device-flow endpoints  │
│                      + checkpoint validation (self-host)             │
└──────────────────────────────────────────────────────────────────────┘
┌───────────────────────── Hosted (SaaS) ────────────────────────────┐
│  auth.invokable.dev  → אותו @invokable/server, מנוהל: דף אישור ממותג, │
│                       token store, revoke, orgs, rate limits, audit   │
└──────────────────────────────────────────────────────────────────────┘
```

עיקרון: **הכל שה-CLI צריך כדי לעבוד נמצא בקוד פתוח.** ה-hosted מחליף רק את מה שכואב לתחזק (auth state, דף web, audit). מפתח יכול לעבור self-host ↔ hosted בשינוי URL אחד.

## 5. API Surface — `@invokable/core`

### 5.1 הגדרת כלי

```ts
import { defineTool, command, checkpoint } from '@invokable/core';

export default defineTool({
  name: 'mytool',
  version: pkg.version,
  api: { baseUrl: 'https://api.mytool.com', authUrl: 'https://auth.mytool.com' },
  configDir: '~/.mytool',           // config.json 0600 + token
  telemetry: { endpoint: '/v1/telemetry', optOutEnv: 'MYTOOL_TELEMETRY' },

  commands: {
    'deploy': command({
      description: 'Deploy the current project',
      options: { env: { type: 'string', choices: ['staging','prod'], required: true } },
      spends: true,                    // מסמן לסוכן ולמחולל ה-skill שיש gate
      run: async ({ opts, client, ctx }) => {
        const plan = await client.post('/v1/deploy/plan', { env: opts.env });
        await checkpoint(ctx, {
          gate: 'deploy_review',
          title: 'deployment plan',
          summary: plan,               // fingerprint מונפק בשרת (HMAC) — ראה 5.8
          question: 'Deploy this plan?',
          explain: 'Approving starts the deploy and bills 1 credit per minute.',
          spend: { estimated: plan.credits, balance: plan.balance },
          choices: undefined,          // או [{id,label,detail,recommended}]
          reject: `mytool deploy --env ${opts.env} --dry-run`,
        });
        return client.post('/v1/deploy', { planId: plan.id });
      },
    }),
  },
});
```

`checkpoint()` — התנהגות:
1. אם `--approve deploy_review@<fp>` הועבר וה-fp תואם → ממשיך.
2. אם fp לא תואם → exit 12 (`checkpoint_stale`) עם remediation.
3. אם `--yes` → ממשיך, כותב ל-stderr `auto-approved …`. `--max-spend <n>` גובר על `--yes`.
4. אחרת: אם TTY אינטראקטיבי ולא `--json` → prompt y/N. אחרת → מדפיס envelope `kind:"checkpoint"` + `display` (פאנל ASCII) + `next.approve` ויוצא ב-**exit 10**.

### 5.2 חוזה הפלט (קבוע, לא ניתן לשינוי ע"י המפתח)

```jsonc
// stdout — מסמך JSON יחיד כשמועבר --json
{ "status": "ok", "data": { ... } }
{ "status": "error", "code": "auth", "message": "…", "remediation": "mytool login", "retryable": false }
{ "status": "ok", "data": { "kind": "checkpoint", "schema": "invokable.checkpoint/v1", "gate": "…",
    "fingerprint": "…", "display": "…", "question": "…", "explain": "…", "spend": {…},
    "next": { "approve": "mytool deploy --env prod --approve deploy_review@a1b2c3d4e5f60718", "reject": "…" } } }
```
- כל progress/log → stderr בלבד.
- קודי יציאה שמורים: `0 ok · 1 error · 2 usage · 3 auth · 4 insufficient_spend · 5 not_found · 6 conflict · 7 rate_limited · 10 checkpoint_pending · 11 timeout · 12 checkpoint_stale · 15 network · 20 declined`. המפתח יכול להוסיף 30–99.
- Headers אוטומטיים: `Authorization: Bearer`, `X-Invokable-Client: mytool/<ver>`, `X-Invokable-Command`, `X-Invokable-Agent` (מזוהה מ-env: `CLAUDECODE`, `CODEX_*`, `CURSOR_*` — best-effort).

### 5.3 פקודות מובנות (מגיעות בחינם)

| פקודה | מה עושה |
|---|---|
| `init [--global] [--dir] [--check] [--force] [--skip-login]` | מתקין skills לתיקיית הסוכן, ואז `login` |
| `login [--no-browser]` | device-code flow (5.4) |
| `logout` | revoke בשרת + מחיקה מקומית |
| `whoami` | `GET /cli/whoami` |
| `doctor --json` | `{api.reachable, auth.ok, config.source, config.worldReadable, skills.installed}` |
| `update [--check]` | בודק npm latest |

### 5.4 Auth — device-code flow (client ↔ `@invokable/server`)

```
POST {authUrl}/device/start   {clientName, hostname, toolVersion}
  ← {deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresIn}
GET  {authUrl}/device?code=XXXX-XXXX     (דף web, משתמש מחובר לוחץ Approve)
POST {authUrl}/device/token   {deviceCode}
  ← 400 {error:"authorization_pending"} | {error:"slow_down", interval} | {error:"expired_token"|"access_denied"}
  ← 200 {token, tokenPrefix, orgId, subject, webOrigin?}
POST {authUrl}/cli/logout     Authorization: Bearer
GET  {authUrl}/cli/whoami     Authorization: Bearer
```
- טוקן: `<prefix>_<32 bytes base62>`, נשמר hashed (sha256) בשרת, גלוי פעם אחת.
- סדר עדיפות טוקן ב-client: `--token` > `MYTOOL_TOKEN` > config file. `--token` מדפיס אזהרת stderr (מופיע ב-`ps`).
- Config: `~/.mytool/config.json`, תיקייה 0700, קובץ 0600, כתיבה אטומית (tmp + rename).

### 5.5 `@invokable/server` (self-host)

```ts
import { invokableAuth } from '@invokable/server';
app.use('/auth', invokableAuth({
  store: postgresStore(db),            // או memoryStore() לדמו
  approvePage: ({ userCode, hostname }) => renderMyPage(...),   // hook לדף ממותג
  requireSession: (req) => getUser(req),                          // הסשן של האתר שלך
  tokenTtl: null,                       // long-lived; revoke בלבד
}));
app.use(verifyCheckpoint({ secret }));  // middleware: מאמת gate@fingerprint מול summary נוכחי
```

### 5.6 `@invokable/skills` — מחולל ההוראות לסוכן

קלט: ה-`defineTool` schema. פלט:
- `skills/<tool>/SKILL.md` — frontmatter (`name`, `description` עם טריגרים, `allowed-tools: Bash, Read`), פרק "check auth first", טבלת פקודות, טבלת exit codes, פרק **Never** (לא `--yes`, לא `--token` בשורת פקודה, לא retry על 7).
- `skills/<tool>/references/checkpoints.md` + `errors.md` — נוצרים אוטומטית מה-gates ומקודי השגיאה שהמפתח הגדיר.
- Adapters: `.claude/skills/`, `AGENTS.md` (Codex), `.cursor/rules/<tool>.mdc`, `GEMINI.md`. המפתח יכול לערוך sections ידנית בין markers `<!-- invokable:custom -->`; regenerate שומר אותם.

### 5.7 `create-invokable`

```
npx create-invokable my-tool
  ? Auth server:   (o) hosted — auth.invokable.dev   ( ) self-host
  ? First command: [deploy]
  ? Does it spend money / need approval?  [Y/n]
→ my-tool/ {package.json (bin), src/tool.ts, skills/, README.md, .github/release.yml}
→ npm run dev && npx my-tool doctor --json
```

### 5.8 Fingerprint — HMAC מונפק בשרת (החלטה: 3.9.2026)

הבעיה עם sha256 של ה-summary (הגישה של autoreel): כל מי שראה את ה-summary — כולל הסוכן — יכול לחשב את ה-fp בעצמו ולזייף `--approve`. לכן ה-fp **לא ניתן לחישוב ב-client**.

```
client:  POST /checkpoints            {gate, summary, subject: {videoId…}}
server:  canonical = stable-json(summary)              // מפתחות ממוינים, בלי רווחים
         mac = HMAC-SHA256(secret, gate | subject | sha256(canonical) | issuedAt)
         store {gate, subject, summaryHash, issuedAt, expiresAt: +24h, consumed: false}
         ← {fingerprint: base32(mac).slice(0,16), expiresAt}

client:  … --approve deploy_review@<fp>
server:  verifyCheckpoint middleware:
           1. מוצא רשומה לפי (gate, subject, fp)         → אין → 409 checkpoint_stale (exit 12)
           2. מחשב מחדש את ה-mac מהמצב הנוכחי → לא תואם → 409 checkpoint_stale
           3. expired או consumed                          → 409 checkpoint_stale
           4. מסמן consumed=true (one-shot), ממשיך
```

- **המפתח לא נוגע בזה**: `checkpoint()` ב-core קורא ל-`POST /checkpoints` אוטומטית; ב-`@invokable/server` ה-middleware עושה את 1–4. Self-host מספק `secret` ב-env; hosted מחזיק אותו per-tool.
- **Rotation**: השרת מחזיק `secret` + `previousSecret` ל-24 שעות — fp ישן עדיין מאומת בזמן החלפה.
- **One-shot**: fp נצרך פעם אחת. הרצה חוזרת של אותה פקודת approve → exit 12 עם remediation "re-run without --approve".
- **`--yes` לא עוקף את זה** — הוא רק גורם ל-client לבקש fp ולאשר אותו באותה ריצה; השרת עדיין רואה checkpoint תקין ב-audit.
- 16 תווי base32 = 80 ביט; מספיק כי כל fp קשור ל-(gate, subject) ונצרך פעם אחת.

## 6. User Stories (לפי עדיפות)

**מפתח הכלי**
- כמפתח, אני רוצה `npx create-invokable` שייצר CLI עם login עובד, כדי לא לכתוב device-flow בעצמי.
- כמפתח, אני רוצה להגדיר gate בשורה אחת (`checkpoint()`), כדי שהסוכן לא יבזבז כסף של הלקוח שלי בלי אישור.
- כמפתח, אני רוצה SKILL.md שמתעדכן אוטומטית כשאני מוסיף פקודה, כדי שההוראות לסוכן לא יתיישנו.
- כמפתח, אני רוצה לעבור מ-self-host ל-hosted בלי לשנות קוד, כדי לא להינעל.

**המשתמש הסופי (מריץ סוכן)**
- כמשתמש, אני רוצה ש-`init` אחד יתקין ויחבר, כדי שהסוכן יעבוד תוך דקה.
- כמשתמש, אני רוצה לראות בדיוק מה עומד לקרות ומה זה עולה לפני שהסוכן ממשיך, כדי לא לגלות חיוב בדיעבד.
- כמשתמש, אני רוצה שטוקן שנשמר במחשב שלי לא יהיה קריא לאחרים, ואוכל לבטל אותו מהאתר.

**הסוכן (persona לגיטימית כאן)**
- כסוכן, אני רוצה JSON אחד ב-stdout וקוד יציאה סמנטי, כדי לדעת מה קרה בלי לפרסר טקסט חופשי.
- כסוכן, אני רוצה `remediation` בכל שגיאה, כדי לדעת מה הפקודה הבאה.

## 7. דרישות

**P0 — בלי זה אין מוצר**
- [ ] `@invokable/core`: defineTool, output envelope, exit codes, config store, auth client, `checkpoint()` עם fingerprint + display + interactive fallback.
- [ ] `@invokable/server`: 5 endpoints של device flow + `verifyCheckpoint` middleware + memory/postgres stores.
- [ ] `@invokable/skills`: SKILL.md generator + מתקין ל-`.claude/skills` ו-`AGENTS.md`.
- [ ] `create-invokable` עם שני templates (hosted / self-host).
- [ ] Hosted auth (MVP): דף אישור גנרי עם לוגו + שם כלי, token store, revoke endpoint. ללא UI ניהול.
- [ ] 3 כלי דוגמה מפורסמים ב-npm (מוצע: `llmagnet` כ-agent CLI, כלי deploy דמו, כלי image-gen דמו).
- [ ] Conformance test: `npx invokable-test ./bin` — מריץ את הכלי ובודק envelope, exit codes, `doctor`, `--json` purity (stdout ריק מ-log).

**P1 — fast-follow**
- [ ] Adapters ל-Cursor rules ו-GEMINI.md.
- [ ] `X-Invokable-Agent` detection + דשבורד "איזה סוכן מריץ אותך".
- [ ] `--max-spend` גלובלי.
- [ ] Postgres store רשמי + Docker image ל-self-host.

**P2 — ארכיטקטורה מכינה**
- [ ] MCP adapter מאותו schema (stdio server, כל command → tool, checkpoint → elicitation).
- [ ] אישור מרחוק (web/Slack/push): `next.approve` מקבל גם `approveUrl`; ה-CLI יכול `--wait-approval`.
- [ ] Python SDK.
- [ ] Local worker primitive (מה ש-autoreel עושים ב-`agent run`): claim/heartbeat/progress/complete + presigned uploads.

## 8. מדדי הצלחה

**Leading (2–4 שבועות)**
- זמן median מ-`create-invokable` ל-`doctor --json` ירוק: יעד ≤ 15 דק', stretch ≤ 8.
- שיעור מפתחים שמפרסמים ל-npm תוך 14 יום: ≥ 25%.
- Conformance pass rate של כלים בקהילה: ≥ 90% (מעיד שהחוזה ברור).
- Task-completion של סוכן על כלי הדוגמה (בנצ'מרק פנימי, 20 משימות × 3 סוכנים): ≥ 80%.

**Lagging (90 יום)**
- 20 חבילות תלויות ב-`@invokable/core`.
- ≥ 30% מהן על hosted auth; ≥ 3 משלמות (הופעת plan ≥ $49).
- GitHub stars כפרוקסי לביקוש: 500.

## 9. שאלות פתוחות

| שאלה | מי | חוסם? |
|---|---|---|
| ~~fingerprint: sha256 או HMAC?~~ **הוחלט: HMAC מונפק בשרת, one-shot** (5.8) | — | סגור |
| שם ומיצוב: "invokable" מול "Clerk for agent tools" — האם ה-hosted הוא auth-first או approvals-first? | מוצר/Ido | לא |
| הפורמט של SKILL.md משתנה בין Claude Code ל-Codex — מה נעול ומה פורמט תואם? | הנדסה, בדיקה מול הדוקומנטציה העדכנית | כן לפני 5.6 |
| רישוי: MIT להכל בקוד פתוח, או Apache-2 עם patent grant? | משפטי | לא |
| האם להציע גם "invokable-hosted-API" (proxy מלא) או רק auth? נטייה: רק auth ב-Phase 1. | מוצר | לא |

## 10. ציר זמן מוצע

| שבוע | אבן דרך |
|---|---|
| 1–2 | `@invokable/core` + `@invokable/server` (memory store) + conformance test. כלי דוגמה #1 עובד ב-Claude Code. |
| 3 | `@invokable/skills` + `create-invokable`. בדיקה ב-Codex. |
| 4 | Hosted auth MVP על דומיין. כלי דוגמה #2–3. |
| 5 | Launch: README, וידאו 90 שניות (אפשר להשתמש ב-autoreel — אירוני ומשווק), פוסט "why CLI+skills beats MCP for money-spending workflows". |
| 6–8 | מדידה מול G1–G4, החלטה על Phase 2 (approvals SaaS vs MCP adapter). |

תלות חיצונית יחידה: יציבות פורמט ה-skills של הסוכנים — לכן ה-adapters מבודדים בחבילה נפרדת.
