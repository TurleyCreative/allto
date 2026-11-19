import '../lib/page.css';
import './home.css';
import { Allto, redLineImage, esc, when } from '../lib/allto';

Allto.mountSwitcher(document.getElementById('alltoBar'), {});
Allto.mountProjectChip(document.getElementById('alltoChip'));

const ACCENT: Record<string, string> = { consultation: '#e77851', present: '#82c0e9', ultrahand: '#78bc43' };
const STATUS: Record<string, string> = { consultation: 'In use', present: 'Starter', ultrahand: 'New' };

function renderProject() {
  const p = Allto.project();
  const img = redLineImage(p);
  const host = document.getElementById('project')!;
  host.innerHTML = p.updatedAt
    ? `${img ? `<img src="${img}" alt="The red line on a map">` : '<div class="noimg">No red line yet</div>'}
       <div>
         <span class="muted">Current project</span>
         <h2>${esc(p.name || 'Untitled project')}</h2>
         <dl>
           ${p.place ? `<dt>Place</dt><dd>${esc(p.place)}</dd>` : ''}
           <dt>Red line</dt><dd>${p.redLine ? 'Drawn, and shared with every product' : 'Not drawn yet'}</dd>
           <dt>Updated</dt><dd>${esc(when(p))}</dd>
         </dl>
         <div class="row">
           <a class="btn" href="${Allto.url(p.source || 'ultrahand')}">Carry on in ${esc(Allto.productLabel(p.source || 'ultrahand'))}</a>
           <button class="btn ghost" id="forget">Start a new project</button>
         </div>
       </div>`
    : `<div class="noimg">Your red line will show here</div>
       <div>
         <span class="muted">No project yet</span>
         <h2>Start with a site</h2>
         <p class="muted">Draw a red line in Ultrahand or Consultation. Every allto product picks it up from there.</p>
         <div class="row"><a class="btn" href="${Allto.url('ultrahand')}">Start in Ultrahand</a><a class="btn ghost" href="${Allto.url('consultation')}">Start in Consultation</a></div>
       </div>`;
  document.getElementById('forget')?.addEventListener('click', () => {
    if (!confirm('Start a new project? The shared red line and name are cleared. Each product keeps its own saved work until you change it there.')) return;
    Allto.clear();
    renderProject();
  });
}

document.getElementById('products')!.innerHTML = Allto.PRODUCTS.map(
  (p) => `<a class="product card" href="${Allto.url(p.id)}" style="--accent:${ACCENT[p.id]}">
      <span class="tag">${STATUS[p.id]}</span>
      <h2><span class="muted">allto:</span> ${esc(p.label)}</h2>
      <p class="muted">${esc(p.blurb)}</p>
      <span class="go">Open ${esc(p.label)} →</span>
    </a>`,
).join('');

renderProject();
Allto.onChange(renderProject);
