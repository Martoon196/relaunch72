/** Fixed, dependency-free progressive enhancement for the Journey Board. */

export const JOURNEY_BOARD_CLIENT_ROUTE = '/portal/assets/journey-board.js' as const;
export const JOURNEY_BOARD_CLIENT_ASSET_PATH = JOURNEY_BOARD_CLIENT_ROUTE;

export const JOURNEY_BOARD_CLIENT_SOURCE = String.raw`(() => {
  'use strict';

  const root = document.querySelector('[data-journey-board]');
  if (!root) return;
  root.classList.add('jb-enhanced');

  const live = root.querySelector('[data-board-live]');
  const board = root.querySelector('.jb-board');
  const lanes = Array.from(root.querySelectorAll('[data-journey-lane]'));
  const cards = Array.from(root.querySelectorAll('[data-journey-card]'));
  const handles = Array.from(root.querySelectorAll('[data-drag-handle]'));
  let lifted = null;
  let targetLane = null;
  let pointerDrag = null;
  const POINTER_DRAG_THRESHOLD = 6;
  const CARD_SWIPE_THRESHOLD = 14;

  const announce = (message) => {
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => { live.textContent = message; }, 20);
  };

  const laneLabel = (lane) => {
    const heading = lane && lane.querySelector('.jb-lane-head h2');
    return heading ? heading.textContent.trim() : 'unknown lane';
  };

  const cardName = (card) => {
    const name = card && card.querySelector('.jb-person');
    return name ? name.textContent.trim() : 'Card';
  };

  const clearTargets = () => {
    lanes.forEach((lane) => lane.removeAttribute('data-drop-target'));
    cards.forEach((card) => card.removeAttribute('data-pointer-target-label'));
    targetLane = null;
  };

  const cancelLift = (message) => {
    if (lifted) {
      lifted.card.removeAttribute('data-dragging');
      lifted.handle.setAttribute('aria-pressed', 'false');
      if (lifted.restoreFocus) lifted.handle.focus();
    }
    clearTargets();
    lifted = null;
    if (message) announce(message);
  };

  const approvedDestination = (card, lane) => {
    const select = card.querySelector('[data-lane-select]');
    if (!select || !lane) return false;
    const laneId = lane.getAttribute('data-lane-id');
    return Array.from(select.options).some((option) => option.value === laneId);
  };

  const chooseLane = (lane) => {
    if (!lifted || !approvedDestination(lifted.card, lane)) return false;
    clearTargets();
    targetLane = lane;
    lane.setAttribute('data-drop-target', 'true');
    lifted.card.setAttribute('data-pointer-target-label', laneLabel(lane));
    announce(cardName(lifted.card) + ' ready for ' + laneLabel(lane) + '. Press Space or Enter to save, or Escape to cancel.');
    return true;
  };

  const submitMove = (card, lane) => {
    const form = card.querySelector('[data-workflow-move-form]');
    const select = form && form.querySelector('[data-lane-select]');
    const laneId = lane && lane.getAttribute('data-lane-id');
    if (!form || !select || !laneId || !approvedDestination(card, lane)) {
      cancelLift('That workflow destination is not available. Nothing changed.');
      return;
    }
    select.value = laneId;
    announce('Saving ' + cardName(card) + ' to ' + laneLabel(lane) + '. This changes team workflow only.');
    form.requestSubmit();
  };

  const beginLift = (handle, restoreFocus = true, instruction = 'Use arrow keys to choose a permitted workflow lane.') => {
    const card = handle.closest('[data-journey-card]');
    if (!card) return;
    if (lifted && lifted.handle !== handle) cancelLift();
    lifted = { handle, card, restoreFocus };
    card.setAttribute('data-dragging', 'true');
    handle.setAttribute('aria-pressed', 'true');
    const current = lanes.indexOf(card.closest('[data-journey-lane]'));
    announce(cardName(card) + ' picked up from ' + laneLabel(lanes[current]) + ', column ' + (current + 1) + ' of ' + lanes.length + '. ' + instruction);
  };

  const stepDestination = (direction) => {
    if (!lifted || !lanes.length) return;
    const origin = lifted.card.closest('[data-journey-lane]');
    let index = targetLane ? lanes.indexOf(targetLane) : lanes.indexOf(origin);
    for (let attempts = 0; attempts < lanes.length; attempts += 1) {
      index = (index + direction + lanes.length) % lanes.length;
      if (chooseLane(lanes[index])) return;
    }
    announce('No permitted workflow destination is available.');
  };

  const laneAtPoint = (clientX, clientY) => {
    const element = document.elementFromPoint(clientX, clientY);
    const lane = element && typeof element.closest === 'function'
      ? element.closest('[data-journey-lane]')
      : null;
    return lane && root.contains(lane) ? lane : null;
  };

  const directionalDestination = (card, direction) => {
    const origin = lanes.indexOf(card.closest('[data-journey-lane]'));
    if (origin < 0) return null;
    for (let index = origin + direction; index >= 0 && index < lanes.length; index += direction) {
      if (approvedDestination(card, lanes[index])) return lanes[index];
    }
    return null;
  };

  const narrowBoard = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 760px)').matches;

  const scrollBoardForPointer = (clientX) => {
    if (!board || typeof board.getBoundingClientRect !== 'function') return;
    const bounds = board.getBoundingClientRect();
    const edge = Math.min(56, bounds.width / 5);
    const amount = clientX < bounds.left + edge
      ? -28
      : clientX > bounds.right - edge
        ? 28
        : 0;
    if (!amount) return;
    if (typeof board.scrollBy === 'function') board.scrollBy({ left: amount, behavior: 'auto' });
    else board.scrollLeft += amount;
  };

  const releasePointer = () => {
    const state = pointerDrag;
    pointerDrag = null;
    root.removeAttribute('data-pointer-dragging');
    if (state && typeof state.captureTarget.hasPointerCapture === 'function'
      && state.captureTarget.hasPointerCapture(state.pointerId)) {
      try { state.captureTarget.releasePointerCapture(state.pointerId); } catch {}
    }
    return state;
  };

  const cancelPointer = (message) => {
    const state = releasePointer();
    if (state && state.active) cancelLift(message);
  };

  const movePointer = (event) => {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.active) {
      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;
      if (state.mode === 'card') {
        if (Math.abs(deltaY) >= POINTER_DRAG_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {
          releasePointer();
          return;
        }
        if (Math.abs(deltaX) < CARD_SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
      } else if (Math.hypot(deltaX, deltaY) < POINTER_DRAG_THRESHOLD) {
        return;
      }
      state.active = true;
      beginLift(
        state.handle,
        false,
        state.mode === 'card'
          ? 'Keep swiping left or right, then release to save the shown team lane.'
          : 'Move over a permitted workflow lane, then release to save.',
      );
      root.setAttribute('data-pointer-dragging', 'true');
      if (typeof state.captureTarget.setPointerCapture === 'function') {
        try { state.captureTarget.setPointerCapture(state.pointerId); } catch {}
      }
    }
    event.preventDefault();
    if (state.mode === 'card') {
      const direction = event.clientX >= state.startX ? 1 : -1;
      const lane = directionalDestination(state.card, direction);
      if (lane) {
        if (targetLane !== lane) chooseLane(lane);
      } else if (targetLane) {
        clearTargets();
      }
      return;
    }
    scrollBoardForPointer(event.clientX);
    const lane = laneAtPoint(event.clientX, event.clientY);
    if (lane && approvedDestination(state.card, lane)) {
      if (targetLane !== lane) chooseLane(lane);
    } else if (targetLane) {
      clearTargets();
    }
  };

  const finishPointer = (event) => {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.active && state.mode === 'handle') {
      const lane = laneAtPoint(event.clientX, event.clientY);
      if (lane && approvedDestination(state.card, lane) && targetLane !== lane) chooseLane(lane);
    }
    const destination = state.active ? targetLane : null;
    releasePointer();
    if (!state.active) return;
    event.preventDefault();
    if (destination) submitMove(state.card, destination);
    else cancelLift(cardName(state.card) + ' movement cancelled. Drop on a permitted workflow lane.');
  };

  handles.forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false || pointerDrag) return;
      const card = handle.closest('[data-journey-card]');
      if (!card) return;
      pointerDrag = {
        handle,
        card,
        captureTarget: handle,
        mode: 'handle',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
    });

    handle.addEventListener('keydown', (event) => {
      const key = event.key;
      if ((key === ' ' || key === 'Enter') && !lifted) {
        event.preventDefault();
        beginLift(handle);
        return;
      }
      if (!lifted || lifted.handle !== handle) return;
      if (key === 'Escape') {
        event.preventDefault();
        cancelLift(cardName(lifted.card) + ' movement cancelled. Nothing changed.');
      } else if (key === 'ArrowRight' || key === 'ArrowDown') {
        event.preventDefault();
        stepDestination(1);
      } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
        event.preventDefault();
        stepDestination(-1);
      } else if (key === 'Home') {
        event.preventDefault();
        lanes.some((lane) => chooseLane(lane));
      } else if (key === 'End') {
        event.preventDefault();
        [...lanes].reverse().some((lane) => chooseLane(lane));
      } else if ((key === ' ' || key === 'Enter') && targetLane) {
        event.preventDefault();
        submitMove(lifted.card, targetLane);
      }
    });

  });

  root.addEventListener('pointerdown', (event) => {
    if (!narrowBoard() || event.button !== 0 || event.isPrimary === false || pointerDrag) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('a, button, input, select, textarea, label, [contenteditable="true"], [data-workflow-move-form]')) return;
    const card = target.closest('[data-journey-card][data-workflow-movable="true"]');
    if (!card || !root.contains(card)) return;
    const handle = card.querySelector('[data-drag-handle]');
    if (!handle) return;
    pointerDrag = {
      handle,
      card,
      captureTarget: card,
      mode: 'card',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  });

  document.addEventListener('pointermove', movePointer, { passive: false });
  document.addEventListener('pointerup', finishPointer);
  document.addEventListener('pointercancel', () => cancelPointer('Workflow movement cancelled. Nothing changed.'));
  window.addEventListener('blur', () => cancelPointer('Workflow movement cancelled. Nothing changed.'));

  const tabs = Array.from(root.querySelectorAll('[data-lane-tab]'));
  const activateMobileLane = (laneId) => {
    tabs.forEach((tab) => tab.setAttribute('aria-pressed', String(tab.getAttribute('data-lane-tab') === laneId)));
    lanes.forEach((lane) => lane.setAttribute('data-mobile-active', String(lane.getAttribute('data-lane-id') === laneId)));
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => activateMobileLane(tab.getAttribute('data-lane-tab'))));

  const drawer = root.querySelector('[data-lead360-drawer]');
  const drawerContent = root.querySelector('[data-drawer-content]');
  const drawerClose = root.querySelector('[data-drawer-close]');
  let drawerReturnFocus = null;
  let drawerRequest = 0;
  let drawerController = null;
  let inertBackground = [];

  const focusableInDrawer = () => {
    if (!drawer) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(drawer.querySelectorAll(selector)).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  };

  const makeBackgroundInert = () => {
    if (!drawer || inertBackground.length) return;
    let branch = drawer;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling === branch || sibling === live) return;
        inertBackground.push({ element: sibling, hadInert: sibling.hasAttribute('inert') });
        sibling.setAttribute('inert', '');
      });
      if (parent === document.body) break;
      branch = parent;
    }
  };

  const restoreBackground = () => {
    inertBackground.forEach(({ element, hadInert }) => {
      if (!hadInert) element.removeAttribute('inert');
    });
    inertBackground = [];
  };

  const closeDrawer = () => {
    if (!drawer || drawer.hidden) return;
    drawerRequest += 1;
    if (drawerController) drawerController.abort();
    drawerController = null;
    drawer.hidden = true;
    document.documentElement.classList.remove('jb-lock-scroll');
    restoreBackground();
    if (drawerContent) drawerContent.replaceChildren();
    if (drawerReturnFocus && drawerReturnFocus.isConnected) drawerReturnFocus.focus();
    drawerReturnFocus = null;
  };

  const openLead = async (link) => {
    if (!drawer || !drawerContent || !drawerClose) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    drawerRequest += 1;
    const request = drawerRequest;
    if (drawerController) drawerController.abort();
    drawerController = typeof AbortController === 'function' ? new AbortController() : null;
    drawerReturnFocus = link;
    drawer.hidden = false;
    document.documentElement.classList.add('jb-lock-scroll');
    makeBackgroundInert();
    const loading = document.createElement('p');
    loading.className = 'jb-drawer-loading';
    loading.textContent = 'Loading the evidence case file…';
    drawerContent.replaceChildren(loading);
    drawerClose.focus();
    try {
      const response = await fetch(url.href, {
        headers: { Accept: 'text/html' },
        credentials: 'same-origin',
        signal: drawerController ? drawerController.signal : undefined,
      });
      if (!response.ok) throw new Error('Lead 360 request failed');
      const body = await response.text();
      if (request !== drawerRequest || drawer.hidden) return;
      const documentView = new DOMParser().parseFromString(body, 'text/html');
      const caseFile = documentView.querySelector('.lead360');
      if (!caseFile) throw new Error('Lead 360 was unavailable');
      const style = documentView.querySelector('style[data-property-predator-lead-360]');
      const nodes = [];
      if (style) nodes.push(style.cloneNode(true));
      nodes.push(caseFile.cloneNode(true));
      drawerContent.replaceChildren(...nodes);
      const title = caseFile.querySelector('h1');
      announce((title ? title.textContent.trim() : 'Lead 360') + ' opened in the evidence drawer.');
    } catch (requestError) {
      if (request !== drawerRequest || (requestError && requestError.name === 'AbortError')) return;
      const error = document.createElement('p');
      error.className = 'jb-drawer-error';
      error.textContent = 'Lead 360 could not be loaded here. Use the full-page link instead.';
      const fallback = document.createElement('a');
      fallback.href = url.href;
      fallback.textContent = 'Open the full Lead 360 case file';
      fallback.className = 'jb-clear';
      drawerContent.replaceChildren(error, fallback);
    } finally {
      if (request === drawerRequest) drawerController = null;
    }
  };

  root.querySelectorAll('[data-lead360-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      openLead(link);
    });
  });
  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  if (drawer) drawer.addEventListener('click', (event) => { if (event.target === drawer) closeDrawer(); });
  document.addEventListener('keydown', (event) => {
    if (!drawer || drawer.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = focusableInDrawer();
      const first = focusable[0] || drawerClose;
      const last = focusable[focusable.length - 1] || drawerClose;
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
})();`;

/** Backward-compatible descriptive alias. */
export const JOURNEY_BOARD_CLIENT_SCRIPT = JOURNEY_BOARD_CLIENT_SOURCE;
