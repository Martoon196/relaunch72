/**
 * Dependency-free, presentation-only enhancement for the TEST content workspace.
 * It never calls fetch, submits a form or persists a provider operation.
 */

export const CONTENT_CALENDAR_CLIENT_ROUTE = '/portal/assets/content-calendar.js' as const;
export const CONTENT_CALENDAR_CLIENT_ASSET_PATH = CONTENT_CALENDAR_CLIENT_ROUTE;

export const CONTENT_CALENDAR_CLIENT_SOURCE = String.raw`(() => {
  'use strict';

  const codePointCount = (value) => Array.from(String(value || '')).length;

  const enhanceCalendar = (root) => {
    root.classList.add('ccal-enhanced');
    const live = root.querySelector('[data-calendar-live]');
    const scroll = root.querySelector('.ccal-scroll');
    const days = Array.from(root.querySelectorAll('[data-calendar-day]'));
    const handles = Array.from(root.querySelectorAll('[data-calendar-move-handle]'));
    const sheet = root.querySelector('[data-calendar-move-sheet]');
    const sheetDate = sheet && sheet.querySelector('[data-calendar-sheet-date]');
    const sheetTime = sheet && sheet.querySelector('[data-calendar-sheet-time]');
    const sheetApply = sheet && sheet.querySelector('[data-calendar-sheet-apply]');
    const sheetCancel = sheet && sheet.querySelector('[data-calendar-sheet-cancel]');
    let lifted = null;
    let pointerState = null;
    let sheetCard = null;
    let sheetReturnFocus = null;
    let sheetInert = [];
    const POINTER_THRESHOLD = 6;

    const announce = (message) => {
      if (!live) return;
      live.textContent = '';
      window.setTimeout(() => { live.textContent = message; }, 20);
    };

    const dayLabel = (day) => day ? (day.getAttribute('aria-label') || day.dataset.date || 'day') : 'day';
    const cardLabel = (card) => {
      const heading = card && card.querySelector('h3');
      return heading ? heading.textContent.trim() : 'TEST plan';
    };
    const dayIndex = (day) => days.indexOf(day);
    const dayForCard = (card) => card && card.closest('[data-calendar-day]');

    const minutesFromCard = (card) => {
      const label = card && card.querySelector('.ccal-time');
      const match = label && /^(\d{2}):(\d{2})$/.exec(label.textContent.trim());
      return match ? (Number(match[1]) * 60) + Number(match[2]) : 9 * 60;
    };

    const clampMinutes = (value) => Math.max(0, Math.min(23 * 60 + 30, value));
    const timeValue = (minutes) => {
      const safe = clampMinutes(minutes);
      return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
    };

    const clearTargets = () => {
      days.forEach((day) => day.removeAttribute('data-preview-drop-target'));
      if (lifted && lifted.card) lifted.card.removeAttribute('data-preview-target-label');
    };

    const setTarget = (day, minutes) => {
      if (!lifted || !day || dayIndex(day) < 0) return false;
      const nextMinutes = clampMinutes(minutes);
      if (lifted.targetDay === day && lifted.minutes === nextMinutes
        && day.hasAttribute('data-preview-drop-target')) return true;
      clearTargets();
      lifted.targetDay = day;
      lifted.minutes = nextMinutes;
      day.setAttribute('data-preview-drop-target', 'true');
      lifted.card.setAttribute('data-preview-target-label', dayLabel(day) + ' at ' + timeValue(lifted.minutes));
      announce(cardLabel(lifted.card) + ' preview target: ' + dayLabel(day) + ' at ' + timeValue(lifted.minutes) + '. Press Space or Enter to place, or Escape to cancel.');
      return true;
    };

    const beginLift = (handle, restoreFocus) => {
      const card = handle && handle.closest('[data-calendar-slot]');
      const originDay = dayForCard(card);
      if (!card || !originDay) return false;
      if (lifted) {
        lifted.card.removeAttribute('data-preview-moving');
        lifted.handle.setAttribute('aria-pressed', 'false');
        clearTargets();
      }
      lifted = {
        card,
        handle,
        originDay,
        targetDay: null,
        minutes: minutesFromCard(card),
        restoreFocus: restoreFocus !== false,
      };
      card.setAttribute('data-preview-moving', 'true');
      handle.setAttribute('aria-pressed', 'true');
      setTarget(originDay, lifted.minutes);
      announce(cardLabel(card) + ' picked up for a browser-only TEST preview. Use Left and Right for day, Up and Down for 30-minute time steps, then Space or Enter to place.');
      return true;
    };

    const finishLift = (message) => {
      if (!lifted) return;
      const state = lifted;
      lifted = null;
      state.card.removeAttribute('data-preview-moving');
      state.card.removeAttribute('data-preview-target-label');
      state.handle.setAttribute('aria-pressed', 'false');
      clearTargets();
      if (state.restoreFocus && state.handle.isConnected) state.handle.focus();
      if (message) announce(message);
    };

    const ensureEmptyState = (day) => {
      const container = day && day.querySelector('.ccal-day-slots');
      if (!container) return;
      const hasCards = Boolean(container.querySelector('[data-calendar-slot]'));
      const empty = container.querySelector('.ccal-empty-day');
      if (hasCards && empty) empty.remove();
      if (!hasCards && !empty) {
        const placeholder = document.createElement('div');
        placeholder.className = 'ccal-empty-day';
        const text = document.createElement('span');
        text.textContent = root.dataset.calendarMode === 'month' ? '—' : 'No TEST plans';
        placeholder.appendChild(text);
        container.appendChild(placeholder);
      }
    };

    const applyMove = (card, targetDay, minutes, restoreFocus) => {
      const originDay = dayForCard(card);
      const targetContainer = targetDay && targetDay.querySelector('.ccal-day-slots');
      const date = targetDay && targetDay.dataset.date;
      if (!originDay || !targetContainer || !date) {
        announce('That preview destination is unavailable. Nothing changed.');
        return false;
      }
      const label = timeValue(minutes);
      const wallTime = date + 'T' + label;
      targetContainer.appendChild(card);
      card.dataset.scheduledFor = wallTime;
      card.dataset.previewWallTime = 'true';
      const time = card.querySelector('.ccal-time');
      if (time) {
        time.textContent = label;
        time.setAttribute('datetime', wallTime);
      }
      ensureEmptyState(originDay);
      ensureEmptyState(targetDay);
      root.setAttribute('data-preview-dirty', 'true');
      if (restoreFocus) {
        const handle = card.querySelector('[data-calendar-move-handle]');
        if (handle) handle.focus();
      }
      announce(cardLabel(card) + ' moved to ' + dayLabel(targetDay) + ' at ' + label + ' workspace wall time in this browser preview only. It is not saved; reload restores the source snapshot.');
      return true;
    };

    const commitLift = () => {
      if (!lifted) return;
      const state = lifted;
      applyMove(state.card, state.targetDay, state.minutes, false);
      finishLift();
    };

    const moveTargetDay = (delta) => {
      if (!lifted) return;
      const current = dayIndex(lifted.targetDay);
      const next = Math.max(0, Math.min(days.length - 1, current + delta));
      if (next === current) {
        announce('That is the edge of this loaded TEST calendar. Nothing moved.');
        return;
      }
      setTarget(days[next], lifted.minutes);
      if (scroll && days[next] && typeof days[next].scrollIntoView === 'function') {
        days[next].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
    };

    const dayAtPoint = (x, y) => {
      const element = document.elementFromPoint(x, y);
      const day = element && typeof element.closest === 'function' ? element.closest('[data-calendar-day]') : null;
      return day && root.contains(day) ? day : null;
    };

    const scrollForPointer = (x) => {
      if (!scroll || typeof scroll.getBoundingClientRect !== 'function') return;
      const bounds = scroll.getBoundingClientRect();
      const edge = Math.min(62, bounds.width / 5);
      const amount = x < bounds.left + edge ? -30 : x > bounds.right - edge ? 30 : 0;
      if (!amount) return;
      if (typeof scroll.scrollBy === 'function') scroll.scrollBy({ left: amount, behavior: 'auto' });
      else scroll.scrollLeft += amount;
    };

    const releasePointer = () => {
      const state = pointerState;
      pointerState = null;
      root.removeAttribute('data-pointer-moving');
      if (state && typeof state.handle.hasPointerCapture === 'function' && state.handle.hasPointerCapture(state.pointerId)) {
        try { state.handle.releasePointerCapture(state.pointerId); } catch {}
      }
      return state;
    };

    handles.forEach((handle) => {
      handle.addEventListener('keydown', (event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !lifted) {
          event.preventDefault();
          beginLift(handle, true);
          return;
        }
        if (!lifted || lifted.handle !== handle) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          finishLift(cardLabel(lifted.card) + ' preview movement cancelled. Nothing changed.');
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          moveTargetDay(1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          moveTargetDay(-1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setTarget(lifted.targetDay, lifted.minutes - 30);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setTarget(lifted.targetDay, lifted.minutes + 30);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setTarget(days[0], lifted.minutes);
        } else if (event.key === 'End') {
          event.preventDefault();
          setTarget(days[days.length - 1], lifted.minutes);
        } else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          commitLift();
        }
      });

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.isPrimary === false || pointerState) return;
        pointerState = {
          handle,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
      });
    });

    document.addEventListener('pointermove', (event) => {
      const state = pointerState;
      if (!state || state.pointerId !== event.pointerId) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < POINTER_THRESHOLD) return;
        state.active = beginLift(state.handle, false);
        if (!state.active) {
          releasePointer();
          return;
        }
        root.setAttribute('data-pointer-moving', 'true');
        if (typeof state.handle.setPointerCapture === 'function') {
          try { state.handle.setPointerCapture(state.pointerId); } catch {}
        }
      }
      event.preventDefault();
      scrollForPointer(event.clientX);
      const day = dayAtPoint(event.clientX, event.clientY);
      if (day) setTarget(day, lifted ? lifted.minutes : minutesFromCard(state.handle.closest('[data-calendar-slot]')));
    }, { passive: false });

    const endPointer = (event, cancelled) => {
      const state = pointerState;
      if (!state || (event && state.pointerId !== event.pointerId)) return;
      const active = state.active;
      let validDrop = !cancelled;
      if (active && !cancelled && event) {
        const day = dayAtPoint(event.clientX, event.clientY);
        validDrop = Boolean(day);
        if (day && lifted) setTarget(day, lifted.minutes);
      }
      releasePointer();
      if (!active) return;
      if (event) event.preventDefault();
      if (!validDrop || !lifted || !lifted.targetDay) finishLift('TEST preview movement cancelled. Nothing changed.');
      else commitLift();
    };
    document.addEventListener('pointerup', (event) => endPointer(event, false));
    document.addEventListener('pointercancel', (event) => endPointer(event, true));
    window.addEventListener('blur', () => {
      if (pointerState) endPointer(null, true);
      else if (lifted) finishLift('TEST preview movement cancelled. Nothing changed.');
    });

    const closeSheet = () => {
      if (!sheet || sheet.hidden) return;
      sheet.hidden = true;
      sheetInert.forEach(({ element, hadInert }) => {
        if (!hadInert) element.removeAttribute('inert');
      });
      sheetInert = [];
      sheetCard = null;
      if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus();
      sheetReturnFocus = null;
    };

    root.querySelectorAll('[data-calendar-sheet-open]').forEach((button) => {
      button.addEventListener('click', () => {
        const card = button.closest('[data-calendar-slot]');
        const day = dayForCard(card);
        if (!sheet || !sheetDate || !sheetTime || !card || !day) return;
        // A keyboard user can tab from a lifted handle into this button. The
        // sheet is a separate movement mode, so retire the stale lift first.
        if (lifted) finishLift();
        sheetCard = card;
        sheetReturnFocus = button;
        sheetDate.value = day.dataset.date || '';
        sheetTime.value = timeValue(minutesFromCard(card));
        sheetInert = Array.from(root.children)
          // Keep the aria-live node active while the rest of the calendar is
          // inert so sheet-open and validation announcements remain audible.
          .filter((element) => element !== sheet && !element.hasAttribute('data-calendar-live'))
          .map((element) => ({ element, hadInert: element.hasAttribute('inert') }));
        sheetInert.forEach(({ element }) => element.setAttribute('inert', ''));
        sheet.hidden = false;
        sheetDate.focus();
        announce('Move preview opened for ' + cardLabel(card) + '. Choose a loaded date and time.');
      });
    });
    if (sheetCancel) sheetCancel.addEventListener('click', closeSheet);
    if (sheetApply) sheetApply.addEventListener('click', () => {
      if (!sheetCard || !sheetDate || !sheetTime) return;
      const target = days.find((day) => day.dataset.date === sheetDate.value);
      const match = /^(\d{2}):(\d{2})$/.exec(sheetTime.value);
      if (!target || !match) {
        announce('Choose a date visible in this loaded TEST calendar and a valid time. Nothing changed.');
        return;
      }
      const minutes = (Number(match[1]) * 60) + Number(match[2]);
      const card = sheetCard;
      closeSheet();
      applyMove(card, target, minutes, true);
    });
    if (sheet) {
      sheet.addEventListener('click', (event) => { if (event.target === sheet) closeSheet(); });
      sheet.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSheet();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(sheet.querySelectorAll('input,button:not([disabled])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
  };

  const enhanceComposer = (root) => {
    root.classList.add('scomp-enhanced');
    const fields = Array.from(root.querySelectorAll('[data-composer-field]'));
    const reset = root.querySelector('[data-composer-reset]');
    const status = root.querySelector('[data-composer-local-status]');
    const originals = new Map(fields.map((field) => [field, field.value]));
    let dirtyAnnounced = false;

    const announce = (message) => {
      if (!status) return;
      status.textContent = '';
      window.setTimeout(() => { status.textContent = message; }, 20);
    };

    const update = (field, announceChange) => {
      const key = field.dataset.composerField;
      if (!key) return;
      root.querySelectorAll('[data-composer-preview="' + key + '"]').forEach((target) => {
        target.textContent = field.value;
      });
      root.querySelectorAll('[data-composer-count-for="' + key + '"]').forEach((target) => {
        const limit = Number(target.dataset.limit || 0);
        const count = codePointCount(field.value);
        target.textContent = limit > 0
          ? count.toLocaleString('en-GB') + ' / ' + limit.toLocaleString('en-GB')
          : count.toLocaleString('en-GB') + ' characters';
        target.setAttribute('data-over-limit', String(limit > 0 && count > limit));
      });
      const dirty = fields.some((entry) => entry.value !== originals.get(entry));
      root.setAttribute('data-local-dirty', String(dirty));
      if (reset) {
        reset.disabled = !dirty;
        reset.setAttribute('aria-disabled', String(!dirty));
      }
      if (!dirty) dirtyAnnounced = false;
      if (announceChange && dirty && !dirtyAnnounced) {
        dirtyAnnounced = true;
        announce('Unsaved browser preview updated. Nothing is saved or sent; reload discards these changes.');
      }
    };

    fields.forEach((field) => {
      field.addEventListener('input', () => update(field, true));
      update(field, false);
    });
    if (reset) {
      reset.addEventListener('click', () => {
        fields.forEach((field) => {
          field.value = originals.get(field) || '';
          update(field, false);
        });
        announce('Local preview reset to the loaded TEST snapshot. Nothing was persisted.');
        const first = fields[0];
        if (first) first.focus();
      });
    }
  };

  document.querySelectorAll('[data-content-calendar]').forEach(enhanceCalendar);
  document.querySelectorAll('[data-social-composer]').forEach(enhanceComposer);
})();`;

/** Backward-compatible descriptive alias for tests and asset composition. */
export const CONTENT_CALENDAR_CLIENT_SCRIPT = CONTENT_CALENDAR_CLIENT_SOURCE;
