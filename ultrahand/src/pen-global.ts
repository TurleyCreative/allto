// The Ultrahand pen as a plain script for the consultation editor (public/consultation, served as-is).
// Build: npm run build:pen → public/shared/allto-pen.js (window.AlltoPen). Uses the page's mapboxgl.
import { createPen } from './pen';
import { bezierPath, nodesFrom, autoHandles, cloneNodes, node, isCorner } from './bezier';

(window as unknown as { AlltoPen: unknown }).AlltoPen = { createPen, bezierPath, nodesFrom, autoHandles, cloneNodes, node, isCorner };
