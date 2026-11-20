// British National Grid (EPSG:27700) conversions, shared by the exports and the LIDAR tools.
// Uses the standard Helmert transformation: good to a few metres, fine for context and massing.
import proj4 from 'proj4';
import type { Position } from 'geojson';

const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';
const t = proj4('EPSG:4326', BNG);
export const toBNG = (p: Position): [number, number] => t.forward([p[0], p[1]]) as [number, number];
export const fromBNG = (p: Position): [number, number] => t.inverse([p[0], p[1]]) as [number, number];
