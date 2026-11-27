# allto on Cloudflare: sign-in and keys

allto runs as one Cloudflare Worker (`workers/allto`) on your **Turley - app dev** account:
**https://allto.chris-hemsley.workers.dev**. It serves the app, the site agent's `/token`, and the Land Registry
parcels. GitHub Actions deploys it on every push to `main` (`.github/workflows/cloudflare.yml`).

**Who gets in**

| | Who |
|---|---|
| allto, Ultrahand (and its site agent) | Anyone with an `@turley.co.uk` email, via Cloudflare Access: they enter their email and type in a one-time code |
| Consultation and Present | The same, **plus a key** (the Worker secret `TEAM_KEY`). The key is remembered for 30 days on that browser, for that person |

The Worker also checks the Access login itself before issuing agent tokens, so nothing relies on Access alone.

## Set up (about 15 minutes, once)

1. **Let GitHub deploy.** Cloudflare: *My Profile > API Tokens > Create Token*, template **Edit Cloudflare
   Workers**. GitHub: *allto > Settings > Secrets and variables > Actions > Secrets > New repository secret*,
   name `CLOUDFLARE_API_TOKEN`. Then *Actions > Deploy to Cloudflare > Run workflow*. When it's green, allto is at
   the address above.
2. **The Worker's secrets.** Cloudflare: *Workers & Pages > allto > Settings > Variables and Secrets > Add*, type
   **Secret**:
   - `DIRECTLINE_SECRET`: the agent's web channel secret (the same one as before).
   - `TEAM_KEY`: the key for Consultation and Present. Pick something long; share it only with the team.
   - `ANTHROPIC_API_KEY` (optional): an Anthropic API key, for Ultrahand's *Masterplan > Drawing > Draft the
     masterplan*, which reads a masterplan drawing with Claude (Opus 5.5) through the Worker's `/draft-masterplan`
     route. The key stays on the Worker and never reaches the browser. Without it, drawings can still be laid over
     the map and traced; the draft button says the service is not set up. `/health` shows whether it is set.
3. **Sign-in with Cloudflare Access** (Zero Trust, free up to 50 users):
   - Cloudflare: *Zero Trust*. The first time, choose a team name (e.g. `turley`) and the Free plan.
   - *Settings > Authentication*: make sure **One-time PIN** is a login method.
   - *Access > Applications > Add an application > Self-hosted*: name `allto`, domain
     `allto.chris-hemsley.workers.dev`, session duration e.g. 1 week.
   - Policy: **Allow**, *Include* > **Emails ending in** > `@turley.co.uk`.
   - Save. Then from the application's *Overview*, note the **Application Audience (AUD) tag**, and your team
     domain (`<team>.cloudflareaccess.com`).
4. **Let the Worker check the login too.** In `workers/allto/wrangler.toml`, set `ACCESS_TEAM_DOMAIN` and
   `ACCESS_AUD` (they are not secret) and push; the action redeploys.
5. **Mapbox.** In your Mapbox account, add `https://allto.chris-hemsley.workers.dev` to the token's allowed URLs.
6. **Retire the public copy.** Once allto works on Cloudflare: GitHub *allto > Settings > Pages* > unpublish, so the
   GitHub Pages copy (open to anyone) goes away. The old `allto-agent-token` Worker can then be deleted.

## Day to day

- **Change the key:** set a new `TEAM_KEY`. Everyone has to enter the new one; old keys stop working at once.
- **Forget the key on a browser:** visit `/lock`.
- **Sign out:** the *Sign out* link in allto's header.
- **Named people instead of a shared key:** add a second Access application for the paths `/consultation` and
  `/present` with a policy listing those people's emails, then remove `TEAM_KEY`.
