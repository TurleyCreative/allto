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

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  try {
    const msg = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // On a policy decline, the API re-runs the request on a fallback model it picks.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(MasterplanDraft) },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: `Record the masterplan in this drawing.${note ? `\n\nNote from the designer: ${note}` : ''}` },
        ],
      }],
    });
    if (msg.stop_reason === 'refusal') return json({ error: 'The drawing could not be read. Try a different image.' }, 422, headers);
    if (msg.stop_reason === 'max_tokens') return json({ error: 'The drawing has too much in it to read in one go. Crop it to part of the site and try again.' }, 422, headers);
    if (!msg.parsed_output) return json({ error: 'The drawing could not be turned into a plan. Try a clearer image.' }, 502, headers);
    return json({ draft: msg.parsed_output, model: msg.model }, 200, headers);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Busy just now. Try again in a minute.' }, 429, headers);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'The Anthropic API key on the allto Worker is not working.' }, 502, headers);
    if (e instanceof Anthropic.BadRequestError) return json({ error: 'The drawing could not be sent. Try a PNG or JPEG under 5 MB.' }, 400, headers);
    if (e instanceof Anthropic.APIError) return json({ error: `The drawing service answered ${e.status ?? 'with an error'}. Try again shortly.` }, 502, headers);
    return json({ error: 'Could not reach the drawing service. Try again shortly.' }, 502, headers);
  }
}
