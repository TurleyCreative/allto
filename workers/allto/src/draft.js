/**
 * Draft a masterplan from a drawing (a hand-drawn or consultant's masterplan), for Ultrahand.
 *
 * The drawing goes to Claude, which reads it and returns what it shows as structured data:
 * streets as centrelines, open spaces and building blocks as outlines, and trees as points,
 * all on a 0–1000 grid over the image. Ultrahand places the image on the map first, so it
 * knows where that grid sits on the ground, and turns the result into editable streets,
 * open spaces and massing blocks. It is a first draft to check against the drawing.
 *
 * The API key is the ANTHROPIC_API_KEY Worker secret; it never reaches the browser.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const MODEL = 'claude-opus-5-5';
const MAX_IMAGE_B64 = 6_800_000; // the API takes images up to 5 MB; the app sends them smaller than this

const Point = z.array(z.number()).describe('[x, y] on the 0–1000 grid: x from the left edge, y down from the top edge');
export const MasterplanDraft = z.object({
  summary: z.string().describe('One or two sentences on what the drawing shows'),
  streets: z.array(z.object({
    name: z.string().describe('The street name if labelled, else a short description'),
    type: z.enum(['primary', 'residential', 'shared', 'mews', 'path']),
    points: z.array(Point).describe('The centreline, in order, at least 2 points'),
  })),
  open_spaces: z.array(z.object({
    name: z.string(),
    type: z.enum(['park', 'amenity', 'natural', 'play', 'suds', 'allotment']),
    outline: z.array(Point).describe('The boundary, in order, at least 3 points'),
  })),
  blocks: z.array(z.object({
    name: z.string().describe('A label from the drawing if there is one, else a short description'),
    use: z.enum(['residential', 'office', 'retail', 'community', 'other']),
    storeys: z.number().int(),
    outline: z.array(Point).describe('The footprint, in order, at least 3 points'),
  })),
  trees: z.array(Point),
});

/**
 * With a strip of numbered colour swatches (the drawing's main colours, grouped in the browser), Claude
 * says what each colour is, and Ultrahand traces those shapes from the pixels: far more exact than
 * estimating outlines. Claude still reads the streets, the open spaces that are not water, and trees.
 */
const COLOUR_CATEGORIES = ['residential', 'commercial', 'retail', 'community', 'school', 'care_home', 'water', 'green', 'road', 'path', 'boundary', 'other'];
export const MasterplanTraced = z.object({
  summary: MasterplanDraft.shape.summary,
  colours: z.array(z.object({
    id: z.number().int().describe('The swatch number'),
    category: z.enum(COLOUR_CATEGORIES).describe('What that colour is used for inside the site'),
  })),
  streets: MasterplanDraft.shape.streets,
  open_spaces: MasterplanDraft.shape.open_spaces,
  trees: MasterplanDraft.shape.trees,
});

const SWATCH_NOTE = `The second image is a strip of numbered swatches: the main colours of the drawing (inside its red line, where it has one), grouped automatically. The software will trace every patch of a colour from the pixels, so for each swatch number say what that colour is used for inside the site, using the drawing's key where it has one:
- residential, commercial, retail, community, school, care_home: the fill of development parcels or buildings of that use. Plain white or cream parcels with no other meaning are residential.
- water: ponds, SuDS basins, swales, rivers.
- green: parks, grass, planting and tree canopy.
- road, path: carriageways, footways and paths.
- boundary: the red line or other outlines.
- other: anything else (shadows, text, the surroundings, map background, colours mixed at edges).
Give every swatch a category. In this mode, leave the buildings and parcels out of the lists (they are traced from the colours) and leave water out of open_spaces; still record streets, the open spaces that are not water, and trees.`;

const SYSTEM = `You read urban design masterplan drawings (hand-drawn sketches, consultants' plans, illustrative masterplans) and record what they propose as structured data for a site analysis tool.

Coordinates: give every point on a 0–1000 grid laid over the whole image, x across from the left edge and y down from the top edge. Measure against the full image, including any margins, title block or key.

What to record:
- streets: proposed roads, lanes and paths, as centrelines. Type them as primary (main through-routes), residential, shared (shared surfaces), mews (narrow lanes serving a few homes) or path (foot and cycle routes).
- open_spaces: parks, greens, play areas, SuDS ponds and swales, allotments and natural areas, as outlines.
- blocks: proposed buildings and building groups, as footprint outlines. Draw a terrace or a perimeter block as one outline rather than each house. Take use and storeys from the key, labels or colours; where nothing says, use residential at 2 storeys for houses and 4 for apartment blocks.
- trees: proposed tree positions as points. For dense planting, give a representative scatter rather than every tree.

Leave out the site boundary (red line), existing buildings and streets shown only as context, north arrows, scale bars, keys, title blocks and annotations. Simplify curved outlines to enough points to follow the shape. If the image is not a masterplan, return empty lists and say so in the summary.`;

/** Handle POST /draft-masterplan: { image: base64, mediaType, note? } -> the draft. */
export async function draftMasterplan(request, env, json, headers) {
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, headers);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Drafting from drawings is not set up yet: the ANTHROPIC_API_KEY secret needs adding to the allto Worker.' }, 503, headers);
  const body = await request.json().catch(() => null);
  const image = typeof body?.image === 'string' ? body.image.replace(/^data:[^,]*,/, '') : '';
  const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(body?.mediaType) ? body.mediaType : null;
  if (!image || !mediaType) return json({ error: 'Send the drawing as { image: base64, mediaType: image/jpeg | image/png | image/webp }.' }, 400, headers);
  if (image.length > MAX_IMAGE_B64) return json({ error: 'That image is too large. Use one under about 5 MB.' }, 413, headers);
  const note = typeof body?.note === 'string' ? body.note.slice(0, 600) : '';
  const swatch = typeof body?.swatch === 'string' ? body.swatch.replace(/^data:[^,]*,/, '') : '';
  const pal = Array.isArray(body?.palette) ? body.palette.slice(0, 32).filter((p) => Number.isInteger(p?.id) && /^#[0-9a-f]{6}$/i.test(p?.hex || '')) : [];
  const traced = !!(swatch && pal.length && swatch.length < 1_000_000);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  try {
    const msg = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // On a policy decline, the API re-runs the request on a fallback model it picks.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(traced ? MasterplanTraced : MasterplanDraft) },
      system: traced ? `${SYSTEM}\n\n${SWATCH_NOTE}` : SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          ...(traced ? [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: swatch } },
            { type: 'text', text: `Swatches (number, colour, share of the site): ${pal.map((p) => `${p.id} ${p.hex} ${Math.round((+p.share || 0) * 100)}%`).join('; ')}` },
          ] : []),
          { type: 'text', text: `Record the masterplan in this drawing.${note ? `\n\nNote from the designer: ${note}` : ''}` },
        ],
      }],
    });
    if (msg.stop_reason === 'refusal') return json({ error: 'The drawing could not be read. Try a different image.' }, 422, headers);
    if (msg.stop_reason === 'max_tokens') return json({ error: 'The drawing has too much in it to read in one go. Crop it to part of the site and try again.' }, 422, headers);
    if (!msg.parsed_output) return json({ error: 'The drawing could not be turned into a plan. Try a clearer image.' }, 502, headers);
    return json({ draft: msg.parsed_output, traced, model: msg.model }, 200, headers);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Busy just now. Try again in a minute.' }, 429, headers);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'The Anthropic API key on the allto Worker is not working.' }, 502, headers);
    if (e instanceof Anthropic.BadRequestError) return json({ error: 'The drawing could not be sent. Try a PNG or JPEG under 5 MB.' }, 400, headers);
    if (e instanceof Anthropic.APIError) return json({ error: `The drawing service answered ${e.status ?? 'with an error'}. Try again shortly.` }, 502, headers);
    return json({ error: 'Could not reach the drawing service. Try again shortly.' }, 502, headers);
  }
}
