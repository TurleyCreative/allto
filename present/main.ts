import '../lib/page.css';
import './present.css';
import { Allto, redLineImage, esc, when } from '../lib/allto';

Allto.mountSwitcher(document.getElementById('alltoBar'), { active: 'present' });
Allto.mountProjectChip(document.getElementById('alltoChip'));

function renderProject() {
  const p = Allto.project();
  const img = redLineImage(p);
  document.getElementById('project')!.innerHTML = p.updatedAt
    ? `${img ? `<img src="${img}" alt="The red line on a map">` : '<div class="noimg">No red line yet</div>'}
       <div>
         <span class="muted">Presenting</span>
         <h2>${esc(p.name || 'Untitled project')}</h2>
         <p class="muted">${esc(when(p))}</p>
         <p>This is the project Present will build from. Slides follow the red line and drawings as they change in Consultation and Ultrahand.</p>
       </div>`
    : `<div class="noimg">No project yet</div>
       <div><h2>Nothing to present yet</h2><p class="muted">Draw a red line in Ultrahand or Consultation first.</p>
       <div class="row"><a class="btn" href="${Allto.url('ultrahand')}">Open Ultrahand</a></div></div>`;
}

const PLAN = [
  ['Slides from scenes', "Each consultation scene (camera, layers, words) becomes a slide that flies the map, so the deck and the public site tell the same story."],
  ['Drawings from Ultrahand', 'Drop in the axonometric, the atlas sheet, building passports and the constraints summary as live blocks that update when the site does.'],
  ['Presenter view', 'Speaker notes, a clock and the next slide on your screen; the audience sees the map and drawings full screen.'],
  ['Export', 'Send it on as PDF or PowerPoint, with the drawings kept as crisp vectors.'],
];
document.getElementById('plan')!.innerHTML = PLAN.map(([t, d]) => `<div class="card"><h3>${esc(t)}</h3><p class="muted">${esc(d)}</p></div>`).join('');

renderProject();
Allto.onChange(renderProject);
