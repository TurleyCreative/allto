# The Ultrahand site agent: setup

Ultrahand's **Ask about this site** panel talks to a Copilot Studio agent. Ultrahand gives the agent everything
it knows about the site, so the agent starts from facts and can dig further with its own tools and Turley's knowledge.

```
Ultrahand (browser) ──POST /token──▶ Cloudflare Worker ──secret──▶ Direct Line   (token, ~1 hour)
        │                                                              │
        └──── Web Chat over Direct Line, with the token ──────────────▶ Copilot Studio agent
              1. event  allto.siteContext  (the site, as JSON)
              2. event  startConversation
              3. the conversation
```

Already built and tested (Friday):

- the panel, the site context and its JSON / copy fallback (`ultrahand/src/agent.ts`)
- the token Worker with its tests (`workers/agent-token`)
- this guide, the [agent instructions](agent-instructions.md), the [site context format](site-context.md)
  with a [real example](example-site-context.json), and a [planning data connector](planning-data.swagger.yaml)

Menu names in Copilot Studio change from time to time; if a label below doesn't match, look for the nearest equivalent.

## Monday, in order

### 1. Create the agent in Copilot Studio (about 20 minutes)

1. Create an agent, e.g. **Ultrahand site agent**, in the environment Turley uses for internal agents.
2. **Instructions:** paste [agent-instructions.md](agent-instructions.md).
3. **Knowledge:** add what the agent should draw on, e.g. Turley's SharePoint of planning statements and
   appraisals, local plan documents, Kaepora's sources. Leave web search off unless you want it.
4. **Tools:**
   - Add [planning-data.swagger.yaml](planning-data.swagger.yaml) as a custom connector (Power Apps or
     Copilot Studio > Tools > New tool > Custom connector > Import an OpenAPI file). It needs no key.
   - If your organisation has MCP servers for planning data (e.g. a planning applications service), add them under
     Tools > Model Context Protocol so the agent can look up applications and appeals near the site.
5. **The site context topic.** Create a topic triggered by an **event**:
   - Trigger: *Event received* (sometimes *A custom client event occurs*), event name **`allto.siteContext`**.
   - Node: *Set a variable value*: a global variable `Global.SiteContext`, value `System.Activity.Value`.
   - Node: *Set a variable value*: a global variable `Global.SiteContextText`, value `JSON(System.Activity.Value)`.
   - End the topic without sending a message (Ultrahand sends this again whenever the site changes).
6. **Use it.** In the agent's instructions, insert `Global.SiteContextText` where the instructions say
   *[site context goes here]* (type `/` to pick the variable). If your version can't put variables in the
   instructions, use a *Create generative answers* node in the topics that answer site questions, with
   `Global.SiteContextText` in its custom prompt.
7. **Greeting.** Edit the *Conversation Start* topic so it says something short, e.g.
   *"I've got the site from Ultrahand. What would you like to know?"*

### 2. Get the agent's web secret

- If the agent should only be reachable through allto (recommended): **Settings > Security > Web channel
  security**, turn on secured access and copy **Secret 1**. This goes into the Worker in step 3; it never goes
  in GitHub or the browser.
- Otherwise (no web channel security): **Channels > Mobile app** shows a **Token endpoint**; the Worker can relay it instead.
- Note the **region**. For an environment in the UK or Europe the Direct Line address is usually
  `https://europe.directline.botframework.com`; check the address shown under **Channels**.

### 3. Deploy the token Worker to Cloudflare (about 10 minutes)

```bash
cd workers/agent-token && npm install
```

```bash
npx wrangler login
```

Edit `wrangler.toml`: set `DIRECTLINE_DOMAIN` to the region from step 2, and check `ALLOWED_ORIGINS`
lists the allto address (`https://turleycreative.github.io`). Then store the secret and deploy:

```bash
npx wrangler secret put DIRECTLINE_SECRET
```

```bash
npx wrangler deploy
```

Wrangler prints the address, e.g. `https://allto-agent-token.<your-subdomain>.workers.dev`. Check it:

```bash
curl https://allto-agent-token.<your-subdomain>.workers.dev/health
```

It should say `"mode":"directline-secret"`. (For the token-endpoint route instead, leave the secret unset and put
the endpoint in `COPILOT_TOKEN_ENDPOINT` in `wrangler.toml`.)

Recommended: in Cloudflare, add a **rate limiting rule** on `/token` (e.g. 30 requests a minute per IP).

### 4. Point allto at the Worker

- **To try it straight away:** open Ultrahand, press **Ask about this site**, paste
  `https://allto-agent-token.<your-subdomain>.workers.dev/token` into *Agent token address*, press **Connect**.
  That address is remembered in your browser only.
- **For everyone:** in GitHub, **Settings > Secrets and variables > Actions > Variables**, add
  `VITE_AGENT_TOKEN_URL` with the same address, then re-run **Actions > Deploy to GitHub Pages**.

### 5. Check it end to end

1. In Ultrahand, try the Castlefield example and press **Analyse the site**.
2. Press **Ask about this site**. The status should read *Connected. The agent has this site.*
3. Try the suggested questions. The agent should quote the site (e.g. the conservation area and listed building
   on the red line) without being told.
4. Select a building, or click a spot to walk from: ask about it. The agent gets the update automatically.

## Also on Monday (optional)

- **Land Registry parcels.** The Worker now also serves the Land Registry's INSPIRE parcel map (its map service doesn't allow
  browsers to call it directly). Deploying the Worker in step 3 turns the *Land Registry parcels* layer on in Ultrahand
  (Planning, in the layers) once the token address is set. Nothing else to configure.
- **Energy certificates (EPC).** The EPC register has moved to a new government service
  (get-energy-performance-data.communities.gov.uk). It needs a free account and an API key in your name; once you have
  one, store it on the Worker (`npx wrangler secret put EPC_KEY`) and Ultrahand can add each building's energy rating,
  age band and floor area to the passport.
- **Public transport frequencies.** Ultrahand gives walking times to stops and stations; service frequencies need the
  Bus Open Data Service (free key) and a routing engine such as r5 or OpenTripPlanner on a small server.

## Later

- **Staff sign-in.** Put Cloudflare Access (Zero Trust, with Microsoft Entra ID) in front of the Worker, or turn on
  Microsoft authentication in Copilot Studio, so only Turley staff can reach the agent.
- **Write back.** Let the agent return a constraints-and-opportunities note that Ultrahand adds to the building
  passport, a Present slide or the consultation site's text.
