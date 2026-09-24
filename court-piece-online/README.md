# Court Piece — online

Pakistan's favourite card game (Rang / Court Piece), playable in any phone or computer browser.
Share a link and a 5-letter code — no app, no sign-up for players.

## Put it online (free, about 15 minutes, one time only)

You need two free accounts: **GitHub** (stores the code) and **Render** (runs the game).

### 1. Upload the code to GitHub
1. Go to <https://github.com/signup> and create a free account.
2. Click the **+** at the top right → **New repository**.
3. Name it `court-piece`, keep it **Public** or **Private** (either works), tick **Add a README file**, then **Create repository**.
4. On the new repository page click **Add file → Upload files**.
5. Unzip `court-piece-online.zip` on your computer. Open the folder and drag **everything inside it**
   (`public` folder, `test` folder, `game.js`, `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `README.md`, `.gitignore`)
   into the upload box. Do **not** upload a `node_modules` folder if you see one.
6. Click **Commit changes**.

### 2. Run it on Render
1. Go to <https://render.com> and click **Get Started** — sign up with your GitHub account.
2. In the Render dashboard click **New + → Blueprint**.
3. Choose your `court-piece` repository (click **Connect** / give Render access to it if asked).
4. Render reads `render.yaml` and shows a service called **court-piece** on the **Free** plan. Click **Apply** / **Deploy**.
5. Wait 2–3 minutes until it says **Live**. Your link is shown at the top, like
   `https://court-piece-abcd.onrender.com`.

That link is your game. Open it, type your name, tap **Create game**, then tap **Share invite** or **WhatsApp**.

> If you prefer not to use Blueprint: **New + → Web Service**, pick the repo, set
> Build Command `npm install`, Start Command `npm start`, Instance Type **Free**, then **Create Web Service**.

## Good to know
- **Free plan sleeps.** After ~15 minutes with nobody playing, Render pauses the game. The next person to open the link
  waits about a minute while it wakes up — then it's fast. Render's paid "Starter" plan (about $7/month) never sleeps.
- **Restarts clear games.** Games live in the server's memory. If Render restarts the server (for example when you
  upload a new version), games in progress end and everyone creates a new one.
- **Updating the game:** upload the changed files to GitHub again (Add file → Upload files). Render redeploys automatically.

## How the game works
- One person creates a game and gets a 5-letter code. Others open the link and enter the code (or tap the invite link,
  which fills the code in).
- Seats opposite each other are partners. Empty seats are played by the computer (Chacha, Mamu, Khala and Phuppo Bot).
- The creator is the **host**: chooses the target (5, 7 or 11 points) and starts the game.
- **Every new game gets a new code.** When a game ends the host taps **New game** — everyone still there moves across,
  and the old code stops working.
- **Leaving:** if someone taps Leave, the computer takes their seat for the rest of that game. They can enter the code
  again to watch, and they'll get a seat automatically when the next game starts.
- **Dropped connection:** if a phone loses signal or the screen locks, that player has 90 seconds to come back to the
  same seat (just reopen the page). Meanwhile the computer plays their turns after 12 seconds. After 90 seconds they're
  treated as having left.
- **Turn timer:** 60 seconds per move (45 to call the rang). After that the computer plays for you.

## Safety
- Players need no account and give no personal data — just a display name.
- The server deals the cards and checks every move; each phone only ever receives its own cards, so nobody can peek or cheat.
- Encrypted connection (HTTPS) on Render, strict browser security headers, no camera/mic/location access,
  message-rate limits and a lock-out for guessing codes.

## Run it on your own computer (optional)
Install Node.js 18 or newer, then in this folder:
```
npm install
npm start
```
Open <http://localhost:3000>. `npm test` plays full simulated games to check everything works.
