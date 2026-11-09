/** Progressive enhancement only: the existing stage POST form remains the source of truth. */
export const MHP_CRM_CLIENT_SOURCE = `(() => {
  const board = document.querySelector('.mhp-crm .crm-board');
  if (!board) return;
  const interactive = target => target instanceof Element && !!target.closest('a,button,input,select,textarea,label,form');
  const editable = target => target instanceof Element && !!target.closest('button,input,select,textarea,label,form');
  const cardSelector = '.mhp-investor-card,.mhp-marketing-card';
  const cardFor = target => target instanceof Element ? target.closest(cardSelector) : null;
  board.addEventListener('click', event => {
    const card = cardFor(event.target);
    if (card && !interactive(event.target) && card.dataset.contactHref) location.assign(card.dataset.contactHref);
  });
  board.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.matches(cardSelector)) {
      event.preventDefault();
      if (event.target.dataset.contactHref) location.assign(event.target.dataset.contactHref);
    }
  });
  let dragging = null;
  const clear = () => {
    board.querySelectorAll('.mhp-drop-target').forEach(stage => stage.classList.remove('mhp-drop-target'));
    if (dragging) dragging.classList.remove('mhp-dragging');
    dragging = null;
  };
  board.addEventListener('dragstart', event => {
    const card = cardFor(event.target);
    if (!card || card.draggable !== true || editable(event.target) || !event.dataTransfer) { event.preventDefault(); return; }
    dragging = card;
    card.classList.add('mhp-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.opportunityId || '');
  });
  board.addEventListener('dragover', event => {
    const stage = event.target instanceof Element ? event.target.closest('.crm-stage-column[data-stage-id]') : null;
    if (!dragging || !stage || dragging.closest('.crm-stage-column') === stage) return;
    const select = dragging.querySelector('.crm-move-field select');
    if (!select || !Array.from(select.options).some(option => option.value === stage.dataset.stageId)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.mhp-drop-target').forEach(item => item.classList.remove('mhp-drop-target'));
    stage.classList.add('mhp-drop-target');
  });
  board.addEventListener('drop', event => {
    const stage = event.target instanceof Element ? event.target.closest('.crm-stage-column[data-stage-id]') : null;
    const card = dragging;
    if (!card || !stage || !event.dataTransfer || event.dataTransfer.getData('text/plain') !== card.dataset.opportunityId) { clear(); return; }
    const form = card.querySelector('.crm-move-form');
    const select = form && form.querySelector('select[name="target_stage_id"]');
    const submit = form && form.querySelector('button[type="submit"]');
    if (!form || !select || !submit || !Array.from(select.options).some(option => option.value === stage.dataset.stageId)) { clear(); return; }
    event.preventDefault();
    select.value = stage.dataset.stageId;
    clear();
    form.requestSubmit(submit);
  });
  board.addEventListener('dragend', clear);
})();`;
